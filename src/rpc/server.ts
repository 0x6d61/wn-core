/**
 * RPC サーバー実装
 *
 * JSON-RPC 2.0 over stdin/stdout のサーバー、リクエストハンドラ、
 * トランスポート抽象、AgentLoopHandler との統合を提供する。
 */
import readline from 'node:readline'
import type {
  RpcTransport,
  RpcRequestHandler,
  RpcServer,
  RpcServerOptions,
  AgentLoopHandler,
  AgentLoopState,
  ToolResult,
} from './types.js'
import { RPC_METHODS } from './types.js'
import {
  decodeJsonRpc,
  isJsonRpcRequest,
  encodeSuccessResponse,
  encodeNotification,
  encodeParseError,
  encodeMethodNotFound,
  encodeInternalError,
} from './protocol.js'

// ─── MethodNotFoundError ───

/**
 * メソッドが見つからなかった場合にスローされるエラー
 */
export class MethodNotFoundError extends Error {
  readonly method: string

  constructor(method: string) {
    super(`Method not found: ${method}`)
    this.name = 'MethodNotFoundError'
    this.method = method
  }
}

// ─── createRpcRequestHandler ───

/**
 * メソッド名 → ハンドラ関数のマップからリクエストハンドラを生成する
 *
 * 未登録メソッドの呼び出しに対しては MethodNotFoundError をスローする。
 */
export function createRpcRequestHandler(
  methods: Record<string, (params: unknown) => Promise<unknown>>,
): RpcRequestHandler {
  return async (method: string, params: unknown): Promise<unknown> => {
    const fn = methods[method]
    if (!fn) {
      throw new MethodNotFoundError(method)
    }
    return fn(params)
  }
}

// ─── createRpcServer ───

/**
 * RPC サーバーを生成する
 *
 * transport.input から JSON-RPC メッセージを受信し、ハンドラにディスパッチする。
 * start() は入力ストリームが終了するまでブロックし、stop() で中断できる。
 */
export function createRpcServer(options: RpcServerOptions): RpcServer {
  const { transport, handler } = options
  let stopped = false
  let stopResolve: ((value: IteratorResult<string>) => void) | null = null

  /**
   * transport.input をラップし、stop() が呼ばれたときに
   * 待機中の next() を即座に完了させる AsyncIterable を返す。
   */
  function createStoppableInput(): AsyncIterable<string> {
    const iterator = transport.input[Symbol.asyncIterator]()
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            if (stopped) {
              return Promise.resolve({ value: undefined as unknown as string, done: true })
            }
            // Race between the real iterator and a stop signal
            return new Promise<IteratorResult<string>>((resolve) => {
              stopResolve = resolve
              void iterator.next().then((result) => {
                stopResolve = null
                resolve(result)
              })
            })
          },
        }
      },
    }
  }

  async function start(): Promise<void> {
    for await (const line of createStoppableInput()) {
      if (stopped) break

      const decoded = decodeJsonRpc(line)

      if (!decoded.ok) {
        // Parse error — write error response and continue
        transport.write(encodeParseError())
        continue
      }

      const msg = decoded.data

      if (isJsonRpcRequest(msg)) {
        // Request with id — dispatch and write response
        try {
          const result = await handler(msg.method, msg.params)
          transport.write(encodeSuccessResponse(msg.id, result))
        } catch (error: unknown) {
          if (error instanceof MethodNotFoundError) {
            transport.write(encodeMethodNotFound(msg.id, error.method))
          } else {
            const message = error instanceof Error ? error.message : String(error)
            transport.write(encodeInternalError(msg.id, message))
          }
        }
      } else {
        // Notification (no id) — dispatch but don't write response
        try {
          await handler(msg.method, msg.params)
        } catch {
          // Notifications don't get responses, swallow errors
        }
      }
    }
  }

  function notify(method: string, params?: unknown): void {
    transport.write(encodeNotification(method, params))
  }

  function stop(): void {
    stopped = true
    if (stopResolve) {
      const r = stopResolve
      stopResolve = null
      r({ value: undefined as unknown as string, done: true })
    }
  }

  return { start, notify, stop }
}

// ─── createStdioTransport ───

/**
 * stdin/stdout ベースの RPC トランスポートを生成する
 *
 * readline.createInterface を使って入力ストリームを行単位の AsyncIterable に変換する。
 * write() は出力ストリームに改行付きで書き込む。
 */
export function createStdioTransport(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): RpcTransport {
  const rl = readline.createInterface({ input })

  const asyncInput: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return rl[Symbol.asyncIterator]()
    },
  }

  return {
    input: asyncInput,
    write(line: string): void {
      output.write(line + '\n')
    },
  }
}

// ─── createRpcAgentHandler ───

/**
 * RPC サーバーを AgentLoopHandler にブリッジする
 *
 * AgentLoop のイベントを JSON-RPC 通知としてクライアント（TUI）に送信する。
 */
export function createRpcAgentHandler(server: RpcServer): AgentLoopHandler {
  return {
    onResponse(content: string): void {
      server.notify(RPC_METHODS.RESPONSE, { content })
    },
    onToolStart(name: string, args: Record<string, unknown>): void {
      server.notify(RPC_METHODS.TOOL_EXEC, { event: 'start', name, args })
    },
    onToolEnd(name: string, result: ToolResult): void {
      server.notify(RPC_METHODS.TOOL_EXEC, { event: 'end', name, result })
    },
    onStateChange(state: AgentLoopState): void {
      server.notify(RPC_METHODS.STATE_CHANGE, { state })
    },
    onError(error: string): void {
      server.notify(RPC_METHODS.LOG, { level: 'error', message: error })
    },
    onUsage(): void {
      // no-op — usage tracking is handled elsewhere
    },
  }
}
