import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LLMResponse, Message, Tool, TokenUsage } from '../../src/providers/types.js'
import type { ToolDefinition, ToolResult } from '../../src/tools/types.js'
import { ToolRegistry } from '../../src/tools/types.js'
import type { AgentLoopState } from '../../src/agent/types.js'
import { AgentLoop, createNoopHandler } from '../../src/agent/agent-loop.js'
import type { Result } from '../../src/result.js'
import { ok, err } from '../../src/result.js'

// ---------------------------------------------------------------------------
// ヘルパー: モック LLMProvider を生成
// ---------------------------------------------------------------------------
type CompleteFn = (
  messages: readonly Message[],
  tools?: readonly Tool[],
) => Promise<Result<LLMResponse>>

function createMockProvider(): { complete: ReturnType<typeof vi.fn<CompleteFn>> } {
  return {
    complete: vi.fn<CompleteFn>(),
  }
}

// ---------------------------------------------------------------------------
// ヘルパー: スパイ付き AgentLoopHandler を生成
// ---------------------------------------------------------------------------
function createSpyHandler(): {
  onResponse: ReturnType<typeof vi.fn<(content: string) => void>>
  onToolStart: ReturnType<typeof vi.fn<(name: string, args: Record<string, unknown>) => void>>
  onToolEnd: ReturnType<typeof vi.fn<(name: string, result: ToolResult) => void>>
  onStateChange: ReturnType<typeof vi.fn<(state: AgentLoopState) => void>>
  onError: ReturnType<typeof vi.fn<(error: string) => void>>
  onUsage: ReturnType<typeof vi.fn<(usage: TokenUsage) => void>>
} {
  return {
    onResponse: vi.fn<(content: string) => void>(),
    onToolStart: vi.fn<(name: string, args: Record<string, unknown>) => void>(),
    onToolEnd: vi.fn<(name: string, result: ToolResult) => void>(),
    onStateChange: vi.fn<(state: AgentLoopState) => void>(),
    onError: vi.fn<(error: string) => void>(),
    onUsage: vi.fn<(usage: TokenUsage) => void>(),
  }
}

// ---------------------------------------------------------------------------
// ヘルパー: ダミー ToolDefinition を生成
// ---------------------------------------------------------------------------
function createDummyTool(
  name: string,
  executeFn?: (args: Record<string, unknown>) => Promise<ToolResult>,
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: {},
    execute:
      executeFn ??
      ((): Promise<ToolResult> => Promise.resolve({ ok: true, output: `${name} done` })),
  }
}

// ---------------------------------------------------------------------------
// ヘルパー: AsyncIterable<string> を配列から生成
// ---------------------------------------------------------------------------
async function* arrayToAsyncIterable(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield await Promise.resolve(item)
  }
}

// ===========================================================================
// テスト本体
// ===========================================================================

describe('AgentLoop', () => {
  let mockProvider: ReturnType<typeof createMockProvider>
  let tools: ToolRegistry
  let handler: ReturnType<typeof createSpyHandler>

  beforeEach(() => {
    mockProvider = createMockProvider()
    tools = new ToolRegistry()
    handler = createSpyHandler()
  })

  // -------------------------------------------------------------------------
  // constructor
  // -------------------------------------------------------------------------
  describe('constructor', () => {
    it('デフォルトではラウンド制限なし（maxToolRounds 省略時）', () => {
      // maxToolRounds を指定せずに構築 → デフォルトは Infinity（無制限）。
      // constructor レベルではオプション省略時にエラーにならないことを検証。
      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })
      expect(loop).toBeDefined()
      expect(loop.getState()).toBe('idle')
    })

    it('systemMessage ありの場合、messages 先頭に system メッセージ', () => {
      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
        systemMessage: 'You are a helpful assistant.',
      })
      const messages = loop.getMessages()
      expect(messages).toHaveLength(1)
      expect(messages[0]).toStrictEqual({
        role: 'system',
        content: 'You are a helpful assistant.',
      })
    })

    it('systemMessage なしの場合、messages は空', () => {
      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })
      const messages = loop.getMessages()
      expect(messages).toHaveLength(0)
    })

    it('初期状態は idle', () => {
      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })
      expect(loop.getState()).toBe('idle')
    })
  })

  // -------------------------------------------------------------------------
  // step() — basic path
  // -------------------------------------------------------------------------
  describe('step() — basic path', () => {
    it('テキスト応答→ok(content) + onResponse', async () => {
      mockProvider.complete.mockResolvedValueOnce(ok<LLMResponse>({ content: 'Hello, world!' }))

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      const result = await loop.step('Hi')
      expect(result).toStrictEqual(ok('Hello, world!'))
      expect(handler.onResponse).toHaveBeenCalledWith('Hello, world!')
      expect(handler.onResponse).toHaveBeenCalledTimes(1)
    })

    it('ユーザー入力と応答が messages 履歴に追加される', async () => {
      mockProvider.complete.mockResolvedValueOnce(ok<LLMResponse>({ content: 'Reply 1' }))

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      await loop.step('Input 1')
      const messages = loop.getMessages()

      // user メッセージ + assistant メッセージ
      expect(messages).toHaveLength(2)
      expect(messages[0]).toStrictEqual({ role: 'user', content: 'Input 1' })
      expect(messages[1]).toStrictEqual({ role: 'assistant', content: 'Reply 1' })
    })

    it('usage があれば onUsage が呼ばれる', async () => {
      const usage: TokenUsage = { inputTokens: 100, outputTokens: 50 }
      mockProvider.complete.mockResolvedValueOnce(ok<LLMResponse>({ content: 'Response', usage }))

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      await loop.step('Hello')
      expect(handler.onUsage).toHaveBeenCalledWith(usage)
      expect(handler.onUsage).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // step() — tool calls
  // -------------------------------------------------------------------------
  describe('step() — tool calls', () => {
    it('ツール呼び出し→ツール実行→再度 LLM', async () => {
      const echoTool = createDummyTool('echo', (args) =>
        Promise.resolve({
          ok: true,
          output: `echoed: ${String(args['text'])}`,
        }),
      )
      tools.register(echoTool)

      // 1st call: LLM returns tool call
      mockProvider.complete.mockResolvedValueOnce(
        ok<LLMResponse>({
          content: '',
          toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
        }),
      )
      // 2nd call: LLM returns text after tool result
      mockProvider.complete.mockResolvedValueOnce(ok<LLMResponse>({ content: 'Done echoing.' }))

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      const result = await loop.step('Echo hello')
      expect(result).toStrictEqual(ok('Done echoing.'))
      expect(mockProvider.complete).toHaveBeenCalledTimes(2)
    })

    it('複数ツール呼び出しを順番に実行', async () => {
      const executionOrder: string[] = []

      const toolA = createDummyTool('toolA', () => {
        executionOrder.push('toolA')
        return Promise.resolve({ ok: true, output: 'A done' })
      })
      const toolB = createDummyTool('toolB', () => {
        executionOrder.push('toolB')
        return Promise.resolve({ ok: true, output: 'B done' })
      })
      tools.register(toolA)
      tools.register(toolB)

      // 1st call: LLM returns two tool calls
      mockProvider.complete.mockResolvedValueOnce(
        ok<LLMResponse>({
          content: '',
          toolCalls: [
            { id: 'tc-a', name: 'toolA', arguments: {} },
            { id: 'tc-b', name: 'toolB', arguments: {} },
          ],
        }),
      )
      // 2nd call: LLM returns text
      mockProvider.complete.mockResolvedValueOnce(ok<LLMResponse>({ content: 'Both done.' }))

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      await loop.step('Run both')
      expect(executionOrder).toStrictEqual(['toolA', 'toolB'])
    })

    it('ツール結果が toolCallId + name 付きで messages に追加', async () => {
      const greetTool = createDummyTool('greet', () =>
        Promise.resolve({
          ok: true,
          output: 'Greetings!',
        }),
      )
      tools.register(greetTool)

      mockProvider.complete.mockResolvedValueOnce(
        ok<LLMResponse>({
          content: '',
          toolCalls: [{ id: 'tc-greet', name: 'greet', arguments: {} }],
        }),
      )
      mockProvider.complete.mockResolvedValueOnce(
        ok<LLMResponse>({ content: 'Greeting complete.' }),
      )

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      await loop.step('Greet me')
      const messages = loop.getMessages()

      // Find the tool result message
      const toolResultMsg = messages.find((m) => m.role === 'user' && m.toolCallId !== undefined)
      if (toolResultMsg === undefined) {
        expect.fail('Tool result message not found in messages')
      }
      expect(toolResultMsg.toolCallId).toBe('tc-greet')
      expect(toolResultMsg.name).toBe('greet')
      expect(toolResultMsg.content).toBe('Greetings!')
    })

    it('ツール呼び出し後にテキスト応答→ループ終了', async () => {
      const calcTool = createDummyTool('calc', () =>
        Promise.resolve({
          ok: true,
          output: '42',
        }),
      )
      tools.register(calcTool)

      // 1st call: tool call with accompanying text
      mockProvider.complete.mockResolvedValueOnce(
        ok<LLMResponse>({
          content: 'Let me calculate...',
          toolCalls: [{ id: 'tc-calc', name: 'calc', arguments: {} }],
        }),
      )
      // 2nd call: final text response (no tool calls) → loop ends
      mockProvider.complete.mockResolvedValueOnce(ok<LLMResponse>({ content: 'The answer is 42.' }))

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      const result = await loop.step('What is the answer?')
      expect(result).toStrictEqual(ok('The answer is 42.'))
      // onResponse should be called for both the intermediate text and final response
      expect(handler.onResponse).toHaveBeenCalledWith('Let me calculate...')
      expect(handler.onResponse).toHaveBeenCalledWith('The answer is 42.')
    })

    it('onToolStart / onToolEnd が正しい順序', async () => {
      const callOrder: string[] = []

      handler.onToolStart.mockImplementation((name: string) => {
        callOrder.push(`start:${name}`)
      })
      handler.onToolEnd.mockImplementation((name: string) => {
        callOrder.push(`end:${name}`)
      })

      const myTool = createDummyTool('myTool', () =>
        Promise.resolve({
          ok: true,
          output: 'result',
        }),
      )
      tools.register(myTool)

      mockProvider.complete.mockResolvedValueOnce(
        ok<LLMResponse>({
          content: '',
          toolCalls: [{ id: 'tc-1', name: 'myTool', arguments: { x: 1 } }],
        }),
      )
      mockProvider.complete.mockResolvedValueOnce(ok<LLMResponse>({ content: 'Finished.' }))

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      await loop.step('Go')

      expect(callOrder).toStrictEqual(['start:myTool', 'end:myTool'])
      expect(handler.onToolStart).toHaveBeenCalledWith('myTool', { x: 1 })
      expect(handler.onToolEnd).toHaveBeenCalledWith('myTool', { ok: true, output: 'result' })
    })
  })

  // -------------------------------------------------------------------------
  // step() — error/guard
  // -------------------------------------------------------------------------
  describe('step() — error/guard', () => {
    it('未登録ツール→エラーメッセージをツール結果として返す', async () => {
      // LLM requests a tool that does not exist in the registry
      mockProvider.complete.mockResolvedValueOnce(
        ok<LLMResponse>({
          content: '',
          toolCalls: [{ id: 'tc-unknown', name: 'nonexistent', arguments: {} }],
        }),
      )
      // After the error tool result is fed back, LLM responds with text
      mockProvider.complete.mockResolvedValueOnce(
        ok<LLMResponse>({ content: 'I could not find that tool.' }),
      )

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      const result = await loop.step('Use nonexistent tool')
      expect(result).toStrictEqual(ok('I could not find that tool.'))

      // The tool result message should contain an error about the unknown tool
      const messages = loop.getMessages()
      const toolResultMsg = messages.find((m) => m.role === 'user' && m.toolCallId === 'tc-unknown')
      if (toolResultMsg === undefined) {
        expect.fail('Tool result message not found in messages')
      }
      expect(toolResultMsg.content).toContain('nonexistent')
    })

    it('maxToolRounds 到達→err', async () => {
      const loopTool = createDummyTool('loopTool')
      tools.register(loopTool)

      // LLM always returns a tool call (never a plain text response)
      mockProvider.complete.mockImplementation(() =>
        Promise.resolve(
          ok<LLMResponse>({
            content: '',
            toolCalls: [{ id: 'tc-loop', name: 'loopTool', arguments: {} }],
          }),
        ),
      )

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
        maxToolRounds: 3,
      })

      const result = await loop.step('Loop forever')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBeDefined()
      }
      expect(handler.onError).toHaveBeenCalled()
    })

    it('LLM エラー→onError + err', async () => {
      mockProvider.complete.mockResolvedValueOnce(err('LLM service unavailable'))

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      const result = await loop.step('Hello')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('LLM service unavailable')
      }
      expect(handler.onError).toHaveBeenCalledWith('LLM service unavailable')
    })

    it('onStateChange が thinking → tool_running → thinking → idle の順', async () => {
      const stateSequence: AgentLoopState[] = []
      handler.onStateChange.mockImplementation((state: AgentLoopState) => {
        stateSequence.push(state)
      })

      const simpleTool = createDummyTool('simpleTool')
      tools.register(simpleTool)

      // 1st: tool call
      mockProvider.complete.mockResolvedValueOnce(
        ok<LLMResponse>({
          content: '',
          toolCalls: [{ id: 'tc-s', name: 'simpleTool', arguments: {} }],
        }),
      )
      // 2nd: text response
      mockProvider.complete.mockResolvedValueOnce(ok<LLMResponse>({ content: 'All done.' }))

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      await loop.step('Do it')

      expect(stateSequence).toStrictEqual(['thinking', 'tool_running', 'thinking', 'idle'])
    })
  })

  // -------------------------------------------------------------------------
  // step() — abort
  // -------------------------------------------------------------------------
  describe('step() — abort', () => {
    it("signal abort → err('Aborted')", async () => {
      const controller = new AbortController()
      controller.abort() // abort immediately

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
        signal: controller.signal,
      })

      const result = await loop.step('Hello')
      expect(result).toStrictEqual(err('Aborted'))
      // Provider should not have been called
      expect(mockProvider.complete).not.toHaveBeenCalled()
    })

    it('ツール実行中の abort → 残りスキップ', async () => {
      const controller = new AbortController()
      const executedTools: string[] = []

      const slowTool = createDummyTool('slowTool', () => {
        executedTools.push('slowTool')
        // Abort after this tool executes
        controller.abort()
        return Promise.resolve({ ok: true, output: 'slow done' })
      })
      const nextTool = createDummyTool('nextTool', () => {
        executedTools.push('nextTool')
        return Promise.resolve({ ok: true, output: 'next done' })
      })
      tools.register(slowTool)
      tools.register(nextTool)

      // LLM returns two tool calls; abort happens during first
      mockProvider.complete.mockResolvedValueOnce(
        ok<LLMResponse>({
          content: '',
          toolCalls: [
            { id: 'tc-slow', name: 'slowTool', arguments: {} },
            { id: 'tc-next', name: 'nextTool', arguments: {} },
          ],
        }),
      )

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
        signal: controller.signal,
      })

      const result = await loop.step('Run tools')
      expect(result).toStrictEqual(err('Aborted'))
      // slowTool was executed but nextTool should be skipped
      expect(executedTools).toContain('slowTool')
      expect(executedTools).not.toContain('nextTool')
    })
  })

  // -------------------------------------------------------------------------
  // run()
  // -------------------------------------------------------------------------
  describe('run()', () => {
    it('複数入力を順番に処理', async () => {
      // Each input gets a simple text response
      mockProvider.complete
        .mockResolvedValueOnce(ok<LLMResponse>({ content: 'Reply 1' }))
        .mockResolvedValueOnce(ok<LLMResponse>({ content: 'Reply 2' }))
        .mockResolvedValueOnce(ok<LLMResponse>({ content: 'Reply 3' }))

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      const inputSource = arrayToAsyncIterable(['Input 1', 'Input 2', 'Input 3'])
      const result = await loop.run(inputSource)

      expect(result).toStrictEqual(ok(undefined))
      expect(mockProvider.complete).toHaveBeenCalledTimes(3)
      expect(handler.onResponse).toHaveBeenCalledWith('Reply 1')
      expect(handler.onResponse).toHaveBeenCalledWith('Reply 2')
      expect(handler.onResponse).toHaveBeenCalledWith('Reply 3')
    })

    it('loopHook が true → 正常終了', async () => {
      mockProvider.complete
        .mockResolvedValueOnce(ok<LLMResponse>({ content: 'Reply 1' }))
        .mockResolvedValueOnce(ok<LLMResponse>({ content: 'Reply 2' }))

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      let stepCount = 0
      const loopHook = (): Promise<boolean> => {
        stepCount++
        // Return true (= stop) after the first step
        return Promise.resolve(stepCount >= 1)
      }

      const inputSource = arrayToAsyncIterable(['Input 1', 'Input 2'])
      const result = await loop.run(inputSource, loopHook)

      expect(result).toStrictEqual(ok(undefined))
      // Only one step should have been processed because loopHook returned true
      expect(mockProvider.complete).toHaveBeenCalledTimes(1)
    })

    it('signal abort → err', async () => {
      const controller = new AbortController()

      mockProvider.complete.mockImplementation(() => {
        // Abort after the first complete call
        controller.abort()
        return Promise.resolve(ok<LLMResponse>({ content: 'Reply' }))
      })

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
        signal: controller.signal,
      })

      const inputSource = arrayToAsyncIterable(['Input 1', 'Input 2', 'Input 3'])
      const result = await loop.run(inputSource)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('Aborted')
      }
    })

    it('step エラーでもループ続行', async () => {
      // 1st step: LLM error
      mockProvider.complete.mockResolvedValueOnce(err('Temporary error'))
      // 2nd step: success
      mockProvider.complete.mockResolvedValueOnce(
        ok<LLMResponse>({ content: 'Success on second try' }),
      )

      const loop = new AgentLoop({
        provider: mockProvider,
        tools,
        handler,
      })

      const inputSource = arrayToAsyncIterable(['Input 1', 'Input 2'])
      const result = await loop.run(inputSource)

      expect(result).toStrictEqual(ok(undefined))
      // Both inputs should have been processed
      expect(mockProvider.complete).toHaveBeenCalledTimes(2)
      expect(handler.onError).toHaveBeenCalledWith('Temporary error')
      expect(handler.onResponse).toHaveBeenCalledWith('Success on second try')
    })
  })
})

// ---------------------------------------------------------------------------
// createNoopHandler
// ---------------------------------------------------------------------------
describe('createNoopHandler', () => {
  it('全コールバックが関数として存在する', () => {
    const handler = createNoopHandler()
    expect(typeof handler.onResponse).toBe('function')
    expect(typeof handler.onToolStart).toBe('function')
    expect(typeof handler.onToolEnd).toBe('function')
    expect(typeof handler.onStateChange).toBe('function')
    expect(typeof handler.onError).toBe('function')
  })

  it('呼び出してもエラーにならない', async () => {
    const handler = createNoopHandler()
    // All callbacks should be callable without throwing
    await handler.onResponse('test')
    await handler.onToolStart('tool', {})
    await handler.onToolEnd('tool', { ok: true, output: 'out' })
    await handler.onStateChange('idle')
    await handler.onError('err')
    if (handler.onUsage) {
      await handler.onUsage({ inputTokens: 0, outputTokens: 0 })
    }
  })
})
