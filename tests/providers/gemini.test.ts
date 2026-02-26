import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type { ProviderConfig } from '../../src/loader/types.js'
import type { StreamChunk } from '../../src/providers/types.js'

// --- Gemini SDK モック ---
const mockGenerateContent = vi.fn()
const mockGenerateContentStream = vi.fn()

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class MockGoogleGenerativeAI {
      getGenerativeModel(): {
        generateContent: typeof mockGenerateContent
        generateContentStream: typeof mockGenerateContentStream
      } {
        return {
          generateContent: mockGenerateContent,
          generateContentStream: mockGenerateContentStream,
        }
      }
    },
  }
})

// crypto.randomUUID のモック（ToolCall の id 生成用）
const mockUUID = '550e8400-e29b-41d4-a716-446655440000'
vi.mock('node:crypto', () => ({
  randomUUID: () => mockUUID,
}))

// SUT は mock 設定後にインポート
const { createGeminiProvider } = await import('../../src/providers/gemini.js')

// --- ヘルパー型 ---

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: object }
}

interface GeminiCandidate {
  content: { role: string; parts: GeminiPart[] }
}

interface GeminiUsageMetadata {
  promptTokenCount: number
  candidatesTokenCount: number
  totalTokenCount: number
}

interface GeminiResponseWrapper {
  response: {
    candidates: GeminiCandidate[]
    usageMetadata: GeminiUsageMetadata
  }
}

interface GeminiStreamChunk {
  candidates: GeminiCandidate[]
}

// --- ヘルパー ---

/** テキストレスポンスを生成する */
function makeGeminiResponse(
  parts: GeminiPart[],
  usageMetadata?: GeminiUsageMetadata,
): GeminiResponseWrapper {
  return {
    response: {
      candidates: [
        {
          content: {
            role: 'model',
            parts,
          },
        },
      ],
      usageMetadata: usageMetadata ?? {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      },
    },
  }
}

/** ストリームチャンクを生成する */
function makeStreamChunk(parts: GeminiPart[]): GeminiStreamChunk {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts,
        },
      },
    ],
  }
}

/** Generator を作成する（for await で消費可能） */
function* toAsyncGenerator<T>(items: T[]): Generator<T> {
  for (const item of items) {
    yield item
  }
}

// --- テスト ---

describe('Gemini Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 1. APIキーなし→err
  describe('createGeminiProvider', () => {
    it('APIキーが設定されていない場合、err を返す', () => {
      const savedEnv = process.env['GEMINI_API_KEY']
      try {
        delete process.env['GEMINI_API_KEY']
        const config: ProviderConfig = {}
        const result = createGeminiProvider(config, 'gemini-pro')
        expect(result).toStrictEqual({
          ok: false,
          error:
            'Gemini provider requires an API key. Set GEMINI_API_KEY environment variable, or configure in config.json',
        })
      } finally {
        if (savedEnv !== undefined) {
          process.env['GEMINI_API_KEY'] = savedEnv
        }
      }
    })

    // 2. 正常作成→ok(LLMProvider)
    it('APIキーが設定されている場合、ok(LLMProvider) を返す', () => {
      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
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
      delete process.env['GEMINI_API_KEY']
    })
    afterAll(() => {
      process.env = originalEnv
    })

    it('GEMINI_API_KEY 環境変数のみでプロバイダーを作成できる', () => {
      process.env['GEMINI_API_KEY'] = 'env-gemini-key'
      const config: ProviderConfig = {}
      const result = createGeminiProvider(config, 'gemini-pro')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveProperty('complete')
        expect(result.data).toHaveProperty('stream')
      }
    })

    it('config の値が環境変数より優先される', () => {
      process.env['GEMINI_API_KEY'] = 'env-gemini-key'
      const config: ProviderConfig = { apiKey: 'config-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
      expect(result.ok).toBe(true)
    })

    it('config も環境変数も未設定の場合はエラーを返す', () => {
      const config: ProviderConfig = {}
      const result = createGeminiProvider(config, 'gemini-pro')
      expect(result).toStrictEqual({
        ok: false,
        error:
          'Gemini provider requires an API key. Set GEMINI_API_KEY environment variable, or configure in config.json',
      })
    })
  })

  describe('complete()', () => {
    // 3. テキストレスポンス→LLMResponse変換
    it('テキストレスポンスを LLMResponse に正しく変換する', async () => {
      mockGenerateContent.mockResolvedValueOnce(
        makeGeminiResponse([{ text: 'Hello, world!' }], {
          promptTokenCount: 5,
          candidatesTokenCount: 10,
          totalTokenCount: 15,
        }),
      )
      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
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

    // 4. ツール呼び出し→ToolCall[]変換（idはcrypto.randomUUID()で生成）
    it('ツール呼び出しレスポンスを ToolCall[] に正しく変換する', async () => {
      mockGenerateContent.mockResolvedValueOnce(
        makeGeminiResponse([
          {
            functionCall: {
              name: 'get_weather',
              args: { city: 'Tokyo', unit: 'celsius' },
            },
          },
        ]),
      )
      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
      if (!result.ok) throw new Error('provider creation failed')

      const response = await result.data.complete([{ role: 'user', content: 'Weather?' }])
      expect(response.ok).toBe(true)
      if (response.ok) {
        expect(response.data.toolCalls).toStrictEqual([
          {
            id: mockUUID,
            name: 'get_weather',
            arguments: { city: 'Tokyo', unit: 'celsius' },
          },
        ])
      }
    })

    // 5. systemメッセージ→systemInstructionに分離（messages配列に含めない）
    it('system メッセージを systemInstruction に分離する', async () => {
      mockGenerateContent.mockResolvedValueOnce(
        makeGeminiResponse([{ text: 'I am a helpful assistant.' }]),
      )
      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
      if (!result.ok) throw new Error('provider creation failed')

      await result.data.complete([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ])

      expect(mockGenerateContent).toHaveBeenCalledOnce()
      const callArgs = mockGenerateContent.mock.calls[0]?.[0] as Record<string, unknown>

      // systemInstruction に分離されている
      expect(callArgs['systemInstruction']).toStrictEqual({
        role: 'system',
        parts: [{ text: 'You are a helpful assistant.' }],
      })

      // contents に system メッセージが含まれていない
      const contents = callArgs['contents'] as Array<{ role: string }>
      expect(contents.every((c) => c.role !== 'system')).toBe(true)
      expect(contents).toStrictEqual([{ role: 'user', parts: [{ text: 'Hello' }] }])
    })

    // 6. ツール定義→Gemini固有形式に変換
    it('ツール定義を Gemini 固有形式に変換する', async () => {
      mockGenerateContent.mockResolvedValueOnce(makeGeminiResponse([{ text: 'result' }]))
      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
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

      expect(mockGenerateContent).toHaveBeenCalledOnce()
      const callArgs = mockGenerateContent.mock.calls[0]?.[0] as Record<string, unknown>
      expect(callArgs['tools']).toStrictEqual([
        {
          functionDeclarations: [
            {
              name: 'search',
              description: 'Search the web',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
              },
            },
          ],
        },
      ])
    })

    // 7. APIエラー→Result.err
    it('API エラー発生時に Result.err を返す', async () => {
      mockGenerateContent.mockRejectedValueOnce(new Error('API rate limit exceeded'))
      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
      if (!result.ok) throw new Error('provider creation failed')

      const response = await result.data.complete([{ role: 'user', content: 'Hi' }])
      expect(response).toStrictEqual({
        ok: false,
        error: 'API rate limit exceeded',
      })
    })

    // 8. TokenUsageの正しいマッピング
    it('TokenUsage を正しくマッピングする (promptTokenCount→inputTokens, candidatesTokenCount→outputTokens)', async () => {
      mockGenerateContent.mockResolvedValueOnce(
        makeGeminiResponse([{ text: 'ok' }], {
          promptTokenCount: 42,
          candidatesTokenCount: 58,
          totalTokenCount: 100,
        }),
      )
      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
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
    // 13. toolCallId 付きメッセージが functionResponse 形式に変換される
    it('toolCallId 付きメッセージが functionResponse 形式で API に送信される', async () => {
      mockGenerateContent.mockResolvedValueOnce(
        makeGeminiResponse([{ text: 'The temperature is 20C.' }]),
      )
      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
      if (!result.ok) throw new Error('provider creation failed')

      await result.data.complete([
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: mockUUID, name: 'get_weather', arguments: { city: 'Tokyo' } }],
        },
        {
          role: 'user',
          content: '{"temp": 20}',
          toolCallId: mockUUID,
          name: 'get_weather',
        },
      ])

      expect(mockGenerateContent).toHaveBeenCalledOnce()
      const callArgs = mockGenerateContent.mock.calls[0]?.[0] as Record<string, unknown>
      const contents = callArgs['contents'] as Array<Record<string, unknown>>

      // ツール結果メッセージが functionResponse 形式に変換されていること
      expect(contents[2]).toStrictEqual({
        role: 'function',
        parts: [
          {
            functionResponse: {
              name: 'get_weather',
              response: { content: '{"temp": 20}' },
            },
          },
        ],
      })
    })

    // 14. toolCalls 付き assistant メッセージが functionCall 形式に変換される
    it('toolCalls 付き assistant メッセージが functionCall 形式で API に送信される', async () => {
      mockGenerateContent.mockResolvedValueOnce(
        makeGeminiResponse([{ text: 'The temperature is 20C.' }]),
      )
      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
      if (!result.ok) throw new Error('provider creation failed')

      await result.data.complete([
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: 'Let me check.',
          toolCalls: [{ id: mockUUID, name: 'get_weather', arguments: { city: 'Tokyo' } }],
        },
        {
          role: 'user',
          content: '{"temp": 20}',
          toolCallId: mockUUID,
          name: 'get_weather',
        },
      ])

      expect(mockGenerateContent).toHaveBeenCalledOnce()
      const callArgs = mockGenerateContent.mock.calls[0]?.[0] as Record<string, unknown>
      const contents = callArgs['contents'] as Array<Record<string, unknown>>

      // assistant メッセージが functionCall 形式に変換されていること
      expect(contents[1]).toStrictEqual({
        role: 'model',
        parts: [
          { text: 'Let me check.' },
          {
            functionCall: {
              name: 'get_weather',
              args: { city: 'Tokyo' },
            },
          },
        ],
      })
    })
  })

  describe('stream()', () => {
    // 9. テキストdelta→StreamChunk.delta
    it('テキスト delta を StreamChunk.delta に変換する', async () => {
      const streamChunks = [
        makeStreamChunk([{ text: 'Hello' }]),
        makeStreamChunk([{ text: ', world!' }]),
      ]
      const finalResponse = {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hello, world!' }] } }],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 3,
          totalTokenCount: 8,
        },
      }
      mockGenerateContentStream.mockResolvedValueOnce({
        stream: toAsyncGenerator(streamChunks),
        response: Promise.resolve(finalResponse),
      })

      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
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
      const streamChunks = [
        makeStreamChunk([
          {
            functionCall: {
              name: 'get_weather',
              args: { city: 'Tokyo' },
            },
          },
        ]),
      ]
      const finalResponse = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      }
      mockGenerateContentStream.mockResolvedValueOnce({
        stream: toAsyncGenerator(streamChunks),
        response: Promise.resolve(finalResponse),
      })

      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
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
        id: mockUUID,
        name: 'get_weather',
        arguments: { city: 'Tokyo' },
      })
    })

    // 11. 完了→StreamChunk.done(usage)
    it('ストリーム完了時に StreamChunk.done(usage) を返す', async () => {
      const streamChunks = [makeStreamChunk([{ text: 'Hi' }])]
      const finalResponse = {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] } }],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 25,
          totalTokenCount: 40,
        },
      }
      mockGenerateContentStream.mockResolvedValueOnce({
        stream: toAsyncGenerator(streamChunks),
        response: Promise.resolve(finalResponse),
      })

      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
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
    it('ストリーム中にエラーが発生した場合 throw する', async () => {
      function* errorStream(): Generator<GeminiStreamChunk> {
        yield makeStreamChunk([{ text: 'partial' }])
        throw new Error('Stream connection lost')
      }
      const rejectedResponse = Promise.reject(new Error('Stream connection lost'))
      // unhandled rejection を防止（stream エラーで response には到達しない）
      rejectedResponse.catch(() => {})
      mockGenerateContentStream.mockResolvedValueOnce({
        stream: errorStream(),
        response: rejectedResponse,
      })

      const config: ProviderConfig = { apiKey: 'test-api-key' }
      const result = createGeminiProvider(config, 'gemini-pro')
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
