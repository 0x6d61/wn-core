/**
 * RPC サーバー実装
 *
 * JSON-RPC 2.0 over stdin/stdout のサーバー、リクエストハンドラ、
 * トランスポート抽象、AgentLoopHandler との統合を提供する。
 */
import readline from 'node:readline'
import type { RpcTransport, RpcRequestHandler, RpcServer, RpcServerOptions } from './types.js'
import type { AgentLoopHandler, AgentLoopState } from '../agent/types.js'
import type { ToolResult } from '../tools/types.js'
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

  const DONE_RESULT: IteratorResult<string> = {
    value: undefined as unknown as string,
    done: true,
  }

  /**
   * transport.input をラップし、stop() が呼ばれたときに
   * 待機中の next() を即座に完了させる AsyncIterable を返す。
   * return() で内部イテレータのリソースも解放する。
   */
  function createStoppableInput(): AsyncIterable<string> {
    const iterator = transport.input[Symbol.asyncIterator]()
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            if (stopped) {
              return Promise.resolve(DONE_RESULT)
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
          return(): Promise<IteratorResult<string>> {
            // 内部イテレータのリソースを解放する
            void iterator.return?.(DONE_RESULT)
            return Promise.resolve(DONE_RESULT)
          },
        }
      },
    }
  }

  async function start(): Promise<void> {
    // stop() 後の再起動を可能にする
    stopped = false

    for await (const line of createStoppableInput()) {
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
        } catch (error: unknown) {
          // Notification にはレスポンスを返せないが、ログ通知で報告する
          const message = error instanceof Error ? error.message : String(error)
          transport.write(encodeNotification(RPC_METHODS.LOG, { level: 'warn', message }))
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
      r(DONE_RESULT)
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
      const inner = rl[Symbol.asyncIterator]()
      return {
        next(): Promise<IteratorResult<string>> {
          return inner.next()
        },
        return(): Promise<IteratorResult<string>> {
          // readline インターフェースを閉じてリソースを解放する
          rl.close()
          return Promise.resolve({ value: undefined as unknown as string, done: true })
        },
      }
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
