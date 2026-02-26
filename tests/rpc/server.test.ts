/**
 * rpc/server モジュール テスト
 *
 * RPC サーバー、リクエストハンドラ、トランスポート、エージェントハンドラの検証。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  MethodNotFoundError,
  createRpcRequestHandler,
  createRpcServer,
  createStdioTransport,
  createRpcAgentHandler,
} from '../../src/rpc/server.js'
import type { RpcTransport, RpcServer as RpcServerType } from '../../src/rpc/types.js'
import { RPC_METHODS, JSON_RPC_ERROR_CODES } from '../../src/rpc/types.js'
import { PassThrough } from 'node:stream'

// ─── MockTransport ヘルパー ───

interface MockTransportResult {
  readonly transport: RpcTransport
  readonly pushLine: (line: string) => void
  readonly close: () => void
  readonly written: string[]
}

function createMockTransport(): MockTransportResult {
  let resolve: ((value: IteratorResult<string>) => void) | null = null
  const queue: string[] = []
  let done = false

  const input: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          const queued = queue.shift()
          if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
          if (done) return Promise.resolve({ value: undefined as unknown as string, done: true })
          return new Promise<IteratorResult<string>>((r) => {
            resolve = r
          })
        },
      }
    },
  }

  const written: string[] = []

  const pushLine = (line: string): void => {
    if (resolve) {
      const r = resolve
      resolve = null
      r({ value: line, done: false })
    } else {
      queue.push(line)
    }
  }

  const close = (): void => {
    done = true
    if (resolve) {
      const r = resolve
      resolve = null
      r({ value: undefined as unknown as string, done: true })
    }
  }

  const transport: RpcTransport = {
    input,
    write(line: string): void {
      written.push(line)
    },
  }

  return { transport, pushLine, close, written }
}

/** written 配列から安全にパースする */
function parseWritten(written: string[], index: number): Record<string, unknown> {
  const line = written[index]
  expect(line).toBeDefined()
  return JSON.parse(line ?? '') as Record<string, unknown>
}

// ─── テスト ───

describe('rpc/server', () => {
  // ─── createRpcRequestHandler ───

  describe('createRpcRequestHandler', () => {
    it('登録済みメソッドを正しくディスパッチする', async () => {
      const handler = createRpcRequestHandler({
        greet: (params: unknown) => {
          const p = params as { name: string }
          return Promise.resolve(`Hello, ${p.name}`)
        },
      })
      const result = await handler('greet', { name: 'Alice' })
      expect(result).toBe('Hello, Alice')
    })

    it('未登録メソッドで MethodNotFoundError をスローする', async () => {
      const handler = createRpcRequestHandler({})
      await expect(handler('nonexistent', {})).rejects.toThrow(MethodNotFoundError)
    })

    it('ハンドラの戻り値を返す', async () => {
      const handler = createRpcRequestHandler({
        add: (params: unknown) => {
          const p = params as { a: number; b: number }
          return Promise.resolve(p.a + p.b)
        },
      })
      const result = await handler('add', { a: 3, b: 7 })
      expect(result).toBe(10)
    })
  })

  // ─── MethodNotFoundError ───

  describe('MethodNotFoundError', () => {
    it('name が "MethodNotFoundError"', () => {
      const error = new MethodNotFoundError('testMethod')
      expect(error.name).toBe('MethodNotFoundError')
    })

    it('method プロパティを持つ', () => {
      const error = new MethodNotFoundError('testMethod')
      expect(error.method).toBe('testMethod')
    })
  })

  // ─── createRpcServer ───

  describe('createRpcServer', () => {
    it('request を受信してハンドラを呼び、success response を返す', async () => {
      const mock = createMockTransport()
      const handler = vi.fn().mockResolvedValue({ answer: 42 })
      const server = createRpcServer({ transport: mock.transport, handler })

      const startPromise = server.start()
      mock.pushLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test', params: { x: 1 } }))
      mock.close()
      await startPromise

      expect(handler).toHaveBeenCalledWith('test', { x: 1 })
      expect(mock.written.length).toBe(1)
      const response = parseWritten(mock.written, 0)
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { answer: 42 },
      })
    })

    it('不正 JSON を受信して Parse Error を返す', async () => {
      const mock = createMockTransport()
      const handler = vi.fn()
      const server = createRpcServer({ transport: mock.transport, handler })

      const startPromise = server.start()
      mock.pushLine('{invalid json}')
      mock.close()
      await startPromise

      expect(handler).not.toHaveBeenCalled()
      expect(mock.written.length).toBe(1)
      const response = parseWritten(mock.written, 0) as { error: { code: number } }
      expect(response.error.code).toBe(JSON_RPC_ERROR_CODES.PARSE_ERROR)
    })

    it('ハンドラが MethodNotFoundError をスローした場合 Method Not Found を返す', async () => {
      const mock = createMockTransport()
      const handler = vi.fn().mockRejectedValue(new MethodNotFoundError('unknown'))
      const server = createRpcServer({ transport: mock.transport, handler })

      const startPromise = server.start()
      mock.pushLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'unknown' }))
      mock.close()
      await startPromise

      expect(mock.written.length).toBe(1)
      const response = parseWritten(mock.written, 0) as { error: { code: number; message: string } }
      expect(response.error.code).toBe(JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND)
      expect(response.error.message).toContain('unknown')
    })

    it('ハンドラが一般エラーをスローした場合 Internal Error を返す', async () => {
      const mock = createMockTransport()
      const handler = vi.fn().mockRejectedValue(new Error('something broke'))
      const server = createRpcServer({ transport: mock.transport, handler })

      const startPromise = server.start()
      mock.pushLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'fail' }))
      mock.close()
      await startPromise

      expect(mock.written.length).toBe(1)
      const response = parseWritten(mock.written, 0) as { error: { code: number; message: string } }
      expect(response.error.code).toBe(JSON_RPC_ERROR_CODES.INTERNAL_ERROR)
      expect(response.error.message).toContain('something broke')
    })

    it('notification (id なし) を受信した場合はレスポンスを返さない', async () => {
      const mock = createMockTransport()
      const handler = vi.fn().mockResolvedValue(undefined)
      const server = createRpcServer({ transport: mock.transport, handler })

      const startPromise = server.start()
      mock.pushLine(JSON.stringify({ jsonrpc: '2.0', method: 'notify' }))
      mock.close()
      await startPromise

      expect(handler).toHaveBeenCalledWith('notify', undefined)
      expect(mock.written.length).toBe(0)
    })

    it('notify() で通知を送信する', () => {
      const mock = createMockTransport()
      const handler = vi.fn()
      const server = createRpcServer({ transport: mock.transport, handler })

      server.notify('update', { value: 99 })

      expect(mock.written.length).toBe(1)
      const parsed = parseWritten(mock.written, 0)
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        method: 'update',
        params: { value: 99 },
      })
    })

    it('stop() で受信ループを停止する (close)', async () => {
      const mock = createMockTransport()
      const handler = vi.fn().mockResolvedValue('ok')
      const server = createRpcServer({ transport: mock.transport, handler })

      const startPromise = server.start()

      // Send one request, then stop
      mock.pushLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'first' }))

      // Give the loop time to process the first message
      await new Promise((r) => setTimeout(r, 10))

      server.stop()
      await startPromise

      // The first request should have been processed
      expect(mock.written.length).toBeGreaterThanOrEqual(1)
    })

    it('複数 request を順次処理する', async () => {
      const mock = createMockTransport()
      let callCount = 0
      const handler = vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({ count: callCount })
      })
      const server = createRpcServer({ transport: mock.transport, handler })

      const startPromise = server.start()
      mock.pushLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'a' }))
      mock.pushLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'b' }))
      mock.pushLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'c' }))
      mock.close()
      await startPromise

      expect(handler).toHaveBeenCalledTimes(3)
      expect(mock.written.length).toBe(3)

      const r1 = parseWritten(mock.written, 0) as { id: number; result: { count: number } }
      const r2 = parseWritten(mock.written, 1) as { id: number; result: { count: number } }
      const r3 = parseWritten(mock.written, 2) as { id: number; result: { count: number } }
      expect(r1.id).toBe(1)
      expect(r2.id).toBe(2)
      expect(r3.id).toBe(3)
      expect(r1.result.count).toBe(1)
      expect(r2.result.count).toBe(2)
      expect(r3.result.count).toBe(3)
    })
  })

  // ─── createStdioTransport ───

  describe('createStdioTransport', () => {
    it('readline で行を読み取り、output.write で書き込む', async () => {
      const input = new PassThrough()
      const output = new PassThrough()

      // Collect output data
      const outputData: string[] = []
      output.on('data', (chunk: Buffer) => {
        outputData.push(chunk.toString())
      })

      const transport = createStdioTransport(input, output)

      // Write via transport and verify it reaches output
      transport.write('test line')
      await new Promise((r) => setTimeout(r, 10))
      expect(outputData.join('')).toContain('test line')
      expect(outputData.join('')).toContain('\n')

      // Write lines to the input stream asynchronously
      const lines: string[] = []
      const readPromise = (async (): Promise<void> => {
        for await (const line of transport.input) {
          lines.push(line)
        }
      })()

      // Feed data after the iterator is waiting
      await new Promise((r) => setTimeout(r, 10))
      input.write('hello world\n')
      input.end()

      await readPromise
      expect(lines).toEqual(['hello world'])
    })
  })

  // ─── createRpcAgentHandler ───

  describe('createRpcAgentHandler', () => {
    function createMockServer(): RpcServerType & {
      readonly notifications: Array<{ method: string; params?: unknown }>
    } {
      const notifications: Array<{ method: string; params?: unknown }> = []
      return {
        start: () => Promise.resolve(),
        stop: () => undefined,
        notify(method: string, params?: unknown): void {
          notifications.push({ method, params })
        },
        notifications,
      }
    }

    it("onResponse -> 'response' notification を送信", () => {
      const server = createMockServer()
      const handler = createRpcAgentHandler(server)

      void handler.onResponse('Hello from LLM')

      expect(server.notifications.length).toBe(1)
      expect(server.notifications[0]).toEqual({
        method: RPC_METHODS.RESPONSE,
        params: { content: 'Hello from LLM' },
      })
    })

    it("onToolStart -> 'toolExec' notification (event: 'start') を送信", () => {
      const server = createMockServer()
      const handler = createRpcAgentHandler(server)

      void handler.onToolStart('readFile', { path: '/tmp/test.txt' })

      expect(server.notifications.length).toBe(1)
      expect(server.notifications[0]).toEqual({
        method: RPC_METHODS.TOOL_EXEC,
        params: {
          event: 'start',
          name: 'readFile',
          args: { path: '/tmp/test.txt' },
        },
      })
    })

    it("onToolEnd -> 'toolExec' notification (event: 'end') を送信", () => {
      const server = createMockServer()
      const handler = createRpcAgentHandler(server)

      const toolResult = { ok: true, output: 'file contents' }
      void handler.onToolEnd('readFile', toolResult)

      expect(server.notifications.length).toBe(1)
      expect(server.notifications[0]).toEqual({
        method: RPC_METHODS.TOOL_EXEC,
        params: {
          event: 'end',
          name: 'readFile',
          result: toolResult,
        },
      })
    })

    it("onStateChange -> 'stateChange' notification を送信", () => {
      const server = createMockServer()
      const handler = createRpcAgentHandler(server)

      void handler.onStateChange('thinking')

      expect(server.notifications.length).toBe(1)
      expect(server.notifications[0]).toEqual({
        method: RPC_METHODS.STATE_CHANGE,
        params: { state: 'thinking' },
      })
    })

    it("onError -> 'log' notification (level: 'error') を送信", () => {
      const server = createMockServer()
      const handler = createRpcAgentHandler(server)

      void handler.onError('Something went wrong')

      expect(server.notifications.length).toBe(1)
      expect(server.notifications[0]).toEqual({
        method: RPC_METHODS.LOG,
        params: {
          level: 'error',
          message: 'Something went wrong',
        },
      })
    })

    it('onUsage は定義されている（undefined でない）', () => {
      const server = createMockServer()
      const handler = createRpcAgentHandler(server)

      expect(handler.onUsage).toBeDefined()
      expect(typeof handler.onUsage).toBe('function')
    })
  })
})
