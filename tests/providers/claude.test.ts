import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type { ProviderConfig } from '../../src/loader/types.js'
import type { StreamChunk } from '../../src/providers/types.js'

// --- Anthropic SDK モック ---
const mockCreate = vi.fn()
const mockStream = vi.fn()
const mockConstructor = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: mockCreate,
        stream: mockStream,
      }
      constructor(opts?: Record<string, unknown>) {
        mockConstructor(opts)
      }
    },
  }
})

// SUT は mock 設定後にインポート
const { createClaudeProvider } = await import('../../src/providers/claude.js')

// --- ヘルパー型（Anthropic SDK の Message 型を模倣） ---

interface MockTextBlock {
  type: 'text'
  text: string
  citations: null
}

interface MockToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  caller: { type: 'direct' }
}

interface MockUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
  cache_creation: null
  inference_geo: null
}

interface MockMessage {
  id: string
  type: 'message'
  role: 'assistant'
  content: (MockTextBlock | MockToolUseBlock)[]
  model: string
  stop_reason: string | null
  stop_sequence: string | null
  usage: MockUsage
  container: null
}

// --- ヘルパー ---

/** テキストレスポンスの Message を生成する */
function makeMessage(
  textBlocks: string[],
  toolUseBlocks?: { id: string; name: string; input: unknown }[],
  usage?: { input_tokens: number; output_tokens: number },
): MockMessage {
  const content: (MockTextBlock | MockToolUseBlock)[] = textBlocks.map((text) => ({
    type: 'text' as const,
    text,
    citations: null,
  }))

  if (toolUseBlocks) {
    for (const tool of toolUseBlocks) {
      content.push({
        type: 'tool_use' as const,
        id: tool.id,
        name: tool.name,
        input: tool.input,
        caller: { type: 'direct' },
      })
    }
  }

  return {
    id: 'msg_test123',
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude-sonnet-4-20250514',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage?.input_tokens ?? 10,
      output_tokens: usage?.output_tokens ?? 20,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
    },
    container: null,
  }
}

/** MessageStream モックを作成する。AsyncIterable として動作し、finalMessage() で最終メッセージを返す */
function makeMockMessageStream(
  events: unknown[],
  finalMsg?: MockMessage,
  errorToThrow?: Error,
): {
  finalMessage: () => Promise<MockMessage>
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>
} {
  return {
    finalMessage: vi
      .fn<() => Promise<MockMessage>>()
      .mockResolvedValue(finalMsg ?? makeMessage(['done'])),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock AsyncIterator that doesn't need real async
    async *[Symbol.asyncIterator]() {
      if (errorToThrow) {
        throw errorToThrow
      }
      for (const event of events) {
        yield event
      }
    },
  }
}

// --- テスト ---

describe('Claude Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 1. APIキーなし→err
  describe('createClaudeProvider', () => {
    it('apiKey も authToken も環境変数もない場合はエラーを返す', () => {
      const saved = { ...process.env }
      delete process.env['ANTHROPIC_API_KEY']
      delete process.env['ANTHROPIC_AUTH_TOKEN']
      try {
        const config: ProviderConfig = {}
        const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
        expect(result).toStrictEqual({
          ok: false,
          error:
            'Claude provider requires an API key or auth token. Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN environment variable, or configure in config.json',
        })
      } finally {
        process.env = saved
      }
    })

    // 2. 正常作成→ok(LLMProvider)
    it('APIキーが設定されている場合、ok(LLMProvider) を返す', () => {
      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveProperty('complete')
        expect(result.data).toHaveProperty('stream')
      }
    })

    it('authToken のみで ok(LLMProvider) を返す', () => {
      const config: ProviderConfig = { authToken: 'oauth-token-test' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveProperty('complete')
        expect(result.data).toHaveProperty('stream')
      }
    })
  })

  describe('環境変数フォールバック', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
      delete process.env['ANTHROPIC_API_KEY']
      delete process.env['ANTHROPIC_AUTH_TOKEN']
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('ANTHROPIC_AUTH_TOKEN 環境変数のみでプロバイダーを作成できる', () => {
      process.env['ANTHROPIC_AUTH_TOKEN'] = 'env-oauth-token'
      const config: ProviderConfig = {}
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveProperty('complete')
        expect(result.data).toHaveProperty('stream')
      }
    })

    it('ANTHROPIC_API_KEY 環境変数のみでプロバイダーを作成できる', () => {
      process.env['ANTHROPIC_API_KEY'] = 'env-api-key'
      const config: ProviderConfig = {}
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveProperty('complete')
        expect(result.data).toHaveProperty('stream')
      }
    })

    it('config の値が環境変数より優先される', () => {
      process.env['ANTHROPIC_API_KEY'] = 'env-api-key'
      const config: ProviderConfig = { apiKey: 'config-api-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      expect(result.ok).toBe(true)
    })

    it('config も環境変数も未設定の場合はエラーを返す', () => {
      const config: ProviderConfig = {}
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      expect(result.ok).toBe(false)
    })

    it('ANTHROPIC_AUTH_TOKEN 使用時に ANTHROPIC_API_KEY が環境変数にあっても apiKey を SDK に渡さない', () => {
      process.env['ANTHROPIC_AUTH_TOKEN'] = 'env-oauth-token'
      process.env['ANTHROPIC_API_KEY'] = 'env-invalid-api-key'
      mockConstructor.mockClear()

      const config: ProviderConfig = {}
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      expect(result.ok).toBe(true)

      // SDK コンストラクタに渡された引数を検証
      const constructorArgs = mockConstructor.mock.calls[0]?.[0] as Record<string, unknown>
      // apiKey は null であること（SDK の env var 自動検出を抑制するため）
      expect(constructorArgs['apiKey']).toBeNull()
      // authToken は渡されていること
      expect(constructorArgs['authToken']).toBe('env-oauth-token')
    })

    it('ANTHROPIC_AUTH_TOKEN のみ設定時に apiKey: null が SDK に渡される（自動検出抑制）', () => {
      process.env['ANTHROPIC_AUTH_TOKEN'] = 'env-oauth-token'
      mockConstructor.mockClear()

      const config: ProviderConfig = {}
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      expect(result.ok).toBe(true)

      const constructorArgs = mockConstructor.mock.calls[0]?.[0] as Record<string, unknown>
      expect(constructorArgs['apiKey']).toBeNull()
      expect(constructorArgs['authToken']).toBe('env-oauth-token')
    })

    it('config.apiKey 明示指定時は authToken があっても apiKey が SDK に渡される', () => {
      process.env['ANTHROPIC_AUTH_TOKEN'] = 'env-oauth-token'
      mockConstructor.mockClear()

      const config: ProviderConfig = { apiKey: 'explicit-api-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      expect(result.ok).toBe(true)

      const constructorArgs = mockConstructor.mock.calls[0]?.[0] as Record<string, unknown>
      expect(constructorArgs['apiKey']).toBe('explicit-api-key')
      expect(constructorArgs['authToken']).toBe('env-oauth-token')
    })
  })

  describe('complete()', () => {
    // 3. テキストレスポンス→LLMResponse変換
    it('テキストレスポンスを LLMResponse に正しく変換する', async () => {
      mockCreate.mockResolvedValueOnce(
        makeMessage(['Hello, world!'], undefined, {
          input_tokens: 5,
          output_tokens: 10,
        }),
      )
      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')

      const response = await result.data.complete([{ role: 'user', content: 'Hi' }])
      expect(response).toStrictEqual({
        ok: true,
        data: {
          content: 'Hello, world!',
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 10 },
        },
      })
    })

    // 4. ツール呼び出し→ToolCall[]変換
    it('ツール呼び出しレスポンスを ToolCall[] に正しく変換する', async () => {
      mockCreate.mockResolvedValueOnce(
        makeMessage(
          [],
          [
            {
              id: 'toolu_abc123',
              name: 'get_weather',
              input: { city: 'Tokyo', unit: 'celsius' },
            },
          ],
        ),
      )
      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')

      const response = await result.data.complete([{ role: 'user', content: 'Weather?' }])
      expect(response.ok).toBe(true)
      if (response.ok) {
        expect(response.data.toolCalls).toStrictEqual([
          {
            id: 'toolu_abc123',
            name: 'get_weather',
            arguments: { city: 'Tokyo', unit: 'celsius' },
          },
        ])
      }
    })

    // 5. systemメッセージ→APIのsystemパラメータに分離
    it('system メッセージを API の system パラメータに分離する（messages に含めない）', async () => {
      mockCreate.mockResolvedValueOnce(makeMessage(['I am a helpful assistant.']))
      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')

      await result.data.complete([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ])

      expect(mockCreate).toHaveBeenCalledOnce()
      const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
      // system メッセージは \n 区切りで system パラメータに結合
      expect(callArgs['system']).toBe('You are a helpful assistant.\nBe concise.')
      // messages には system メッセージを含めない
      expect(callArgs['messages']).toStrictEqual([{ role: 'user', content: 'Hello' }])
    })

    // 6. ツール定義→Claude API固有形式に変換
    it('ツール定義を Claude API 固有形式に変換する', async () => {
      mockCreate.mockResolvedValueOnce(makeMessage(['result']))
      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')

      const tools = [
        {
          name: 'search',
          description: 'Search the web',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      ]

      await result.data.complete([{ role: 'user', content: 'search' }], tools)

      expect(mockCreate).toHaveBeenCalledOnce()
      const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
      expect(callArgs['tools']).toStrictEqual([
        {
          name: 'search',
          description: 'Search the web',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      ])
    })

    // 7. APIエラー→Result.err
    it('API エラー発生時に Result.err を返す', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'))
      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')

      const response = await result.data.complete([{ role: 'user', content: 'Hi' }])
      expect(response).toStrictEqual({
        ok: false,
        error: 'API rate limit exceeded',
      })
    })

    // 8. TokenUsageの正しいマッピング
    it('TokenUsage を正しくマッピングする (input_tokens→inputTokens, output_tokens→outputTokens)', async () => {
      mockCreate.mockResolvedValueOnce(
        makeMessage(['ok'], undefined, {
          input_tokens: 42,
          output_tokens: 58,
        }),
      )
      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')

      const response = await result.data.complete([{ role: 'user', content: 'count' }])
      expect(response.ok).toBe(true)
      if (response.ok) {
        expect(response.data.usage).toStrictEqual({
          inputTokens: 42,
          outputTokens: 58,
        })
      }
    })
  })

  describe('ツール結果メッセージマッピング', () => {
    // 13. toolCallId 付きメッセージが tool_result 形式に変換される
    it('toolCallId 付きメッセージが tool_result 形式で API に送信される', async () => {
      mockCreate.mockResolvedValueOnce(makeMessage(['OK']))
      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')

      await result.data.complete([
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_abc', name: 'get_weather', arguments: { city: 'Tokyo' } }],
        },
        {
          role: 'user',
          content: '{"temp": 20}',
          toolCallId: 'toolu_abc',
          name: 'get_weather',
        },
      ])

      expect(mockCreate).toHaveBeenCalledOnce()
      const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
      const messages = callArgs['messages'] as Array<Record<string, unknown>>

      // ツール結果メッセージが tool_result 形式に変換されていること
      expect(messages[2]).toStrictEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: '{"temp": 20}' }],
      })
    })

    // 14. toolCalls 付き assistant メッセージが tool_use ブロック形式に変換される
    it('toolCalls 付き assistant メッセージが tool_use ブロック形式で API に送信される', async () => {
      mockCreate.mockResolvedValueOnce(makeMessage(['OK']))
      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')

      await result.data.complete([
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: 'Let me check.',
          toolCalls: [{ id: 'toolu_abc', name: 'get_weather', arguments: { city: 'Tokyo' } }],
        },
        {
          role: 'user',
          content: '{"temp": 20}',
          toolCallId: 'toolu_abc',
          name: 'get_weather',
        },
      ])

      expect(mockCreate).toHaveBeenCalledOnce()
      const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
      const messages = callArgs['messages'] as Array<Record<string, unknown>>

      // assistant メッセージが content ブロック配列に変換されていること
      expect(messages[1]).toStrictEqual({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'get_weather',
            input: { city: 'Tokyo' },
          },
        ],
      })
    })
  })

  describe('stream()', () => {
    // 9. テキストdelta→StreamChunk.delta
    it('テキスト delta を StreamChunk.delta に変換する', async () => {
      const streamEvents = [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '', citations: null },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ', world!' },
        },
        {
          type: 'content_block_stop',
          index: 0,
        },
        {
          type: 'message_stop',
        },
      ]

      const finalMsg = makeMessage(['Hello, world!'], undefined, {
        input_tokens: 5,
        output_tokens: 3,
      })

      const mockStreamInstance = makeMockMessageStream(streamEvents, finalMsg)
      mockStream.mockReturnValueOnce(mockStreamInstance)

      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')
      if (!result.data.stream) throw new Error('stream not implemented')

      const collected: StreamChunk[] = []
      for await (const chunk of result.data.stream([{ role: 'user', content: 'Hi' }])) {
        collected.push(chunk)
      }

      expect(collected).toContainEqual({ type: 'delta', content: 'Hello' })
      expect(collected).toContainEqual({ type: 'delta', content: ', world!' })
    })

    // 10. ツール呼び出し→StreamChunk.tool_call
    it('ツール呼び出しストリームを StreamChunk.tool_call に変換する', async () => {
      const streamEvents = [
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_stream1',
            name: 'get_weather',
            input: {},
            caller: { type: 'direct' },
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"city":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"Tokyo"}' },
        },
        {
          type: 'content_block_stop',
          index: 0,
        },
        {
          type: 'message_stop',
        },
      ]

      const finalMsg = makeMessage(
        [],
        [{ id: 'toolu_stream1', name: 'get_weather', input: { city: 'Tokyo' } }],
        { input_tokens: 10, output_tokens: 5 },
      )

      const mockStreamInstance = makeMockMessageStream(streamEvents, finalMsg)
      mockStream.mockReturnValueOnce(mockStreamInstance)

      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')
      if (!result.data.stream) throw new Error('stream not implemented')

      const collected: StreamChunk[] = []
      for await (const chunk of result.data.stream([{ role: 'user', content: 'weather' }])) {
        collected.push(chunk)
      }

      const toolCallChunk = collected.find((c) => c.type === 'tool_call')
      expect(toolCallChunk).toBeDefined()
      if (!toolCallChunk) throw new Error('expected tool_call chunk')
      expect(toolCallChunk.toolCall).toStrictEqual({
        id: 'toolu_stream1',
        name: 'get_weather',
        arguments: { city: 'Tokyo' },
      })
    })

    // 11. 完了→StreamChunk.done(usage)
    it('ストリーム完了時に StreamChunk.done(usage) を返す', async () => {
      const streamEvents = [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '', citations: null },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi' },
        },
        {
          type: 'content_block_stop',
          index: 0,
        },
        {
          type: 'message_stop',
        },
      ]

      const finalMsg = makeMessage(['Hi'], undefined, {
        input_tokens: 15,
        output_tokens: 25,
      })

      const mockStreamInstance = makeMockMessageStream(streamEvents, finalMsg)
      mockStream.mockReturnValueOnce(mockStreamInstance)

      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')
      if (!result.data.stream) throw new Error('stream not implemented')

      const collected: StreamChunk[] = []
      for await (const chunk of result.data.stream([{ role: 'user', content: 'Hi' }])) {
        collected.push(chunk)
      }

      const doneChunk = collected.find((c) => c.type === 'done')
      expect(doneChunk).toBeDefined()
      if (!doneChunk) throw new Error('expected done chunk')
      expect(doneChunk.usage).toStrictEqual({
        inputTokens: 15,
        outputTokens: 25,
      })
    })

    // 12. stream中のエラー→throw
    it('ストリーム中にエラーが発生した場合、throw する', async () => {
      const mockStreamInstance = makeMockMessageStream(
        [],
        undefined,
        new Error('Stream connection lost'),
      )
      mockStream.mockReturnValueOnce(mockStreamInstance)

      const config: ProviderConfig = { apiKey: 'sk-ant-test-key' }
      const result = createClaudeProvider(config, 'claude-sonnet-4-20250514')
      if (!result.ok) throw new Error('provider creation failed')
      if (!result.data.stream) throw new Error('stream not implemented')

      const collected: StreamChunk[] = []
      await expect(async () => {
        if (!result.data.stream) throw new Error('stream not available')
        for await (const chunk of result.data.stream([{ role: 'user', content: 'Hi' }])) {
          collected.push(chunk)
        }
      }).rejects.toThrow('Stream connection lost')
    })
  })
})
