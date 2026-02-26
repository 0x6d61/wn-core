import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions'
import type { ProviderConfig } from '../../src/loader/types.js'
import type { StreamChunk } from '../../src/providers/types.js'

// --- OpenAI SDK モック ---
const mockCreate = vi.fn()

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate,
        },
      }
    },
  }
})

// SUT は mock 設定後にインポート
const { createOpenAIProvider } = await import('../../src/providers/openai.js')

// --- ヘルパー ---

/** テキストのみのレスポンスを生成する */
function makeChatCompletion(
  content: string | null,
  toolCalls?: ChatCompletion.Choice['message']['tool_calls'],
  usage?: ChatCompletion['usage'],
): ChatCompletion {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          tool_calls: toolCalls,
          refusal: null,
        },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: usage ?? { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }
}

/** AsyncIterable を作成する */
function* toAsyncIterable<T>(items: T[]): Generator<T> {
  for (const item of items) {
    yield item
  }
}

/** ストリームチャンクを生成する */
function makeStreamChunk(
  delta: ChatCompletionChunk.Choice['delta'],
  finishReason: ChatCompletionChunk.Choice['finish_reason'] = null,
  usage?: ChatCompletionChunk['usage'],
): ChatCompletionChunk {
  return {
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: usage ?? null,
  }
}

// --- テスト ---

describe('OpenAI Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 1. APIキーなし→err
  describe('createOpenAIProvider', () => {
    it('APIキーが設定されていない場合、err を返す', () => {
      const config: ProviderConfig = {}
      const result = createOpenAIProvider(config, 'gpt-4o')
      expect(result).toStrictEqual({
        ok: false,
        error: 'OpenAI provider requires an API key',
      })
    })

    // 2. 正常作成→ok(LLMProvider)
    it('APIキーが設定されている場合、ok(LLMProvider) を返す', () => {
      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveProperty('complete')
        expect(result.data).toHaveProperty('stream')
      }
    })
  })

  describe('complete()', () => {
    // 3. テキストレスポンス→LLMResponse変換
    it('テキストレスポンスを LLMResponse に正しく変換する', async () => {
      mockCreate.mockResolvedValueOnce(
        makeChatCompletion('Hello, world!', undefined, {
          prompt_tokens: 5,
          completion_tokens: 10,
          total_tokens: 15,
        }),
      )
      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
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
        makeChatCompletion('', [
          {
            id: 'call_abc123',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"city":"Tokyo","unit":"celsius"}',
            },
          },
        ]),
      )
      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
      if (!result.ok) throw new Error('provider creation failed')

      const response = await result.data.complete([{ role: 'user', content: 'Weather?' }])
      expect(response.ok).toBe(true)
      if (response.ok) {
        expect(response.data.toolCalls).toStrictEqual([
          {
            id: 'call_abc123',
            name: 'get_weather',
            arguments: { city: 'Tokyo', unit: 'celsius' },
          },
        ])
      }
    })

    // 5. systemメッセージ→messages配列にそのまま含める
    it('system メッセージを messages 配列にそのまま含める', async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion('I am a helpful assistant.'))
      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
      if (!result.ok) throw new Error('provider creation failed')

      await result.data.complete([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ])

      expect(mockCreate).toHaveBeenCalledOnce()
      const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
      expect(callArgs['messages']).toStrictEqual([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ])
    })

    // 6. ツール定義→OpenAI固有形式に変換
    it('ツール定義を OpenAI 固有形式に変換する', async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion('result'))
      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
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
          type: 'function',
          function: {
            name: 'search',
            description: 'Search the web',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
          },
        },
      ])
    })

    // 7. APIエラー→Result.err
    it('API エラー発生時に Result.err を返す', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'))
      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
      if (!result.ok) throw new Error('provider creation failed')

      const response = await result.data.complete([{ role: 'user', content: 'Hi' }])
      expect(response).toStrictEqual({
        ok: false,
        error: 'API rate limit exceeded',
      })
    })

    // 8. TokenUsageの正しいマッピング
    it('TokenUsage を正しくマッピングする (prompt_tokens→inputTokens, completion_tokens→outputTokens)', async () => {
      mockCreate.mockResolvedValueOnce(
        makeChatCompletion('ok', undefined, {
          prompt_tokens: 42,
          completion_tokens: 58,
          total_tokens: 100,
        }),
      )
      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
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

    // 12. tool_calls.arguments の JSON.parse 失敗→空オブジェクトにフォールバック
    it('tool_calls.arguments の JSON.parse が失敗した場合、空オブジェクトにフォールバックする', async () => {
      mockCreate.mockResolvedValueOnce(
        makeChatCompletion('', [
          {
            id: 'call_bad',
            type: 'function',
            function: {
              name: 'broken_tool',
              arguments: '{invalid json!!!}',
            },
          },
        ]),
      )
      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
      if (!result.ok) throw new Error('provider creation failed')

      const response = await result.data.complete([{ role: 'user', content: 'call' }])
      expect(response.ok).toBe(true)
      if (response.ok) {
        expect(response.data.toolCalls).toStrictEqual([
          {
            id: 'call_bad',
            name: 'broken_tool',
            arguments: {},
          },
        ])
      }
    })
  })

  describe('ツール結果メッセージマッピング', () => {
    // 13. toolCallId 付きメッセージが role: 'tool' に変換される
    it('toolCallId 付きメッセージが role: "tool" で API に送信される', async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion('OK'))
      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
      if (!result.ok) throw new Error('provider creation failed')

      await result.data.complete([
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_abc', name: 'get_weather', arguments: { city: 'Tokyo' } }],
        },
        {
          role: 'user',
          content: '{"temp": 20}',
          toolCallId: 'call_abc',
          name: 'get_weather',
        },
      ])

      expect(mockCreate).toHaveBeenCalledOnce()
      const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
      const messages = callArgs['messages'] as Array<Record<string, unknown>>

      // ツール結果メッセージが role: 'tool' に変換されていること
      expect(messages[2]).toStrictEqual({
        role: 'tool',
        content: '{"temp": 20}',
        tool_call_id: 'call_abc',
      })
    })

    // 14. toolCalls 付き assistant メッセージが tool_calls 付きで送信される
    it('toolCalls 付き assistant メッセージが tool_calls 付きで API に送信される', async () => {
      mockCreate.mockResolvedValueOnce(makeChatCompletion('OK'))
      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
      if (!result.ok) throw new Error('provider creation failed')

      await result.data.complete([
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: 'Let me check.',
          toolCalls: [{ id: 'call_abc', name: 'get_weather', arguments: { city: 'Tokyo' } }],
        },
        {
          role: 'user',
          content: '{"temp": 20}',
          toolCallId: 'call_abc',
          name: 'get_weather',
        },
      ])

      expect(mockCreate).toHaveBeenCalledOnce()
      const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
      const messages = callArgs['messages'] as Array<Record<string, unknown>>

      // assistant メッセージに tool_calls が含まれていること
      expect(messages[1]).toStrictEqual({
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"city":"Tokyo"}',
            },
          },
        ],
      })
    })
  })

  describe('stream()', () => {
    // 9. テキストdelta→StreamChunk.delta
    it('テキスト delta を StreamChunk.delta に変換する', async () => {
      const chunks = [
        makeStreamChunk({ role: 'assistant', content: '' }),
        makeStreamChunk({ content: 'Hello' }),
        makeStreamChunk({ content: ', world!' }),
        makeStreamChunk({}, 'stop', {
          prompt_tokens: 5,
          completion_tokens: 3,
          total_tokens: 8,
        }),
      ]
      mockCreate.mockResolvedValueOnce(toAsyncIterable(chunks))

      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
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
      const chunks = [
        makeStreamChunk({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              id: 'call_stream1',
              type: 'function',
              function: { name: 'get_weather', arguments: '' },
            },
          ],
        }),
        makeStreamChunk({
          tool_calls: [
            {
              index: 0,
              function: { arguments: '{"city":' },
            },
          ],
        }),
        makeStreamChunk({
          tool_calls: [
            {
              index: 0,
              function: { arguments: '"Tokyo"}' },
            },
          ],
        }),
        makeStreamChunk({}, 'stop', {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        }),
      ]
      mockCreate.mockResolvedValueOnce(toAsyncIterable(chunks))

      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
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
        id: 'call_stream1',
        name: 'get_weather',
        arguments: { city: 'Tokyo' },
      })
    })

    // 11. 完了→StreamChunk.done(usage)
    it('ストリーム完了時に StreamChunk.done(usage) を返す', async () => {
      const chunks = [
        makeStreamChunk({ role: 'assistant', content: '' }),
        makeStreamChunk({ content: 'Hi' }),
        makeStreamChunk({}, 'stop', {
          prompt_tokens: 15,
          completion_tokens: 25,
          total_tokens: 40,
        }),
      ]
      mockCreate.mockResolvedValueOnce(toAsyncIterable(chunks))

      const config: ProviderConfig = { apiKey: 'sk-test-key' }
      const result = createOpenAIProvider(config, 'gpt-4o')
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
  })
})
