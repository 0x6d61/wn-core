import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOllamaProvider } from '../../src/providers/ollama.js'
import type { Message, Tool, StreamChunk } from '../../src/providers/types.js'
import type { ProviderConfig } from '../../src/loader/types.js'

// ─── helpers ──────────────────────────────────────────────

/** vi.stubGlobal で差し替える mock fetch を生成する */
function makeMockFetch(
  response: unknown,
  options?: { ok?: boolean; status?: number },
): typeof fetch {
  const ok = options?.ok ?? true
  const status = options?.status ?? 200
  return vi.fn<typeof fetch>().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(response),
    text: () => Promise.resolve(JSON.stringify(response)),
  } as Response)
}

/** NDJSON ストリームを ReadableStream として返す mock fetch を生成する */
function makeMockStreamFetch(chunks: unknown[]): typeof fetch {
  const ndjson = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n'
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(encoder.encode(ndjson))
      controller.close()
    },
  })
  return vi.fn<typeof fetch>().mockResolvedValue({
    ok: true,
    status: 200,
    body: stream,
  } as Response)
}

/** NDJSON ストリーム中にエラーを発生させる mock fetch を生成する */
function makeMockErrorStreamFetch(): typeof fetch {
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.error(new Error('network failure'))
    },
  })
  return vi.fn<typeof fetch>().mockResolvedValue({
    ok: true,
    status: 200,
    body: stream,
  } as Response)
}

const BASE_CONFIG: ProviderConfig = { baseUrl: 'http://localhost:11434' }
const MODEL = 'llama3'

// ─── tests ────────────────────────────────────────────────

describe('Ollama provider', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // 1. API キー不要 → 常に ok
  it('APIキー不要 → 常にokを返す', () => {
    const configWithoutKey: ProviderConfig = { baseUrl: 'http://localhost:11434' }
    const result = createOllamaProvider(configWithoutKey, MODEL)
    expect(result.ok).toBe(true)
  })

  // 2. 正常作成 → ok(LLMProvider)
  it('正常作成 → ok(LLMProvider)', () => {
    const result = createOllamaProvider(BASE_CONFIG, MODEL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveProperty('complete')
    expect(result.data).toHaveProperty('stream')
  })

  // 3. テキストレスポンス → LLMResponse 変換
  it('テキストレスポンス → LLMResponse 変換', async () => {
    const mockResponse = {
      message: { role: 'assistant', content: 'Hello from Ollama' },
      prompt_eval_count: 10,
      eval_count: 20,
    }
    const mockFetch = makeMockFetch(mockResponse)
    vi.stubGlobal('fetch', mockFetch)

    const result = createOllamaProvider(BASE_CONFIG, MODEL)
    if (!result.ok) throw new Error('provider creation failed')

    const messages: Message[] = [{ role: 'user', content: 'Hi' }]
    const response = await result.data.complete(messages)

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.content).toBe('Hello from Ollama')
    expect(response.data.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  // 4. ツール呼び出し → ToolCall[] 変換
  it('ツール呼び出し → ToolCall[] 変換', async () => {
    const mockResponse = {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Tokyo' } } }],
      },
      prompt_eval_count: 15,
      eval_count: 25,
    }
    const mockFetch = makeMockFetch(mockResponse)
    vi.stubGlobal('fetch', mockFetch)

    const result = createOllamaProvider(BASE_CONFIG, MODEL)
    if (!result.ok) throw new Error('provider creation failed')

    const messages: Message[] = [{ role: 'user', content: 'What is the weather?' }]
    const response = await result.data.complete(messages)

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.toolCalls).toBeDefined()
    expect(response.data.toolCalls).toHaveLength(1)
    if (!response.data.toolCalls) throw new Error('expected toolCalls')

    const tc = response.data.toolCalls[0]
    if (!tc) throw new Error('expected at least one toolCall')
    expect(tc.name).toBe('get_weather')
    expect(tc.arguments).toEqual({ city: 'Tokyo' })
    // Ollama は id を返さないので UUID が生成されること
    expect(tc.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  // 5. system メッセージ → messages 配列にそのまま含める（OpenAI 互換）
  it('systemメッセージ → messages配列にそのまま含める', async () => {
    const mockResponse = {
      message: { role: 'assistant', content: 'OK' },
      prompt_eval_count: 5,
      eval_count: 10,
    }
    const mockFetch = makeMockFetch(mockResponse)
    vi.stubGlobal('fetch', mockFetch)

    const result = createOllamaProvider(BASE_CONFIG, MODEL)
    if (!result.ok) throw new Error('provider creation failed')

    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]
    await result.data.complete(messages)

    // fetch に渡されたリクエストボディを検証
    const fetchMock = mockFetch as ReturnType<typeof vi.fn>
    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(callArgs[1].body as string) as {
      messages: Array<{ role: string; content: string }>
    }

    expect(body.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ])
  })

  // 6. ツール定義 → OpenAI 互換形式に変換
  it('ツール定義 → OpenAI互換形式に変換', async () => {
    const mockResponse = {
      message: { role: 'assistant', content: 'OK' },
      prompt_eval_count: 5,
      eval_count: 10,
    }
    const mockFetch = makeMockFetch(mockResponse)
    vi.stubGlobal('fetch', mockFetch)

    const result = createOllamaProvider(BASE_CONFIG, MODEL)
    if (!result.ok) throw new Error('provider creation failed')

    const tools: Tool[] = [
      {
        name: 'get_weather',
        description: 'Get weather info',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]
    const messages: Message[] = [{ role: 'user', content: 'Weather?' }]
    await result.data.complete(messages, tools)

    const fetchMock = mockFetch as ReturnType<typeof vi.fn>
    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(callArgs[1].body as string) as {
      tools: Array<{
        type: string
        function: { name: string; description: string; parameters: Record<string, unknown> }
      }>
    }

    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather info',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ])
  })

  // 7. fetch エラー → Result.err
  it('fetchエラー → Result.err', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection refused'))
    vi.stubGlobal('fetch', mockFetch)

    const result = createOllamaProvider(BASE_CONFIG, MODEL)
    if (!result.ok) throw new Error('provider creation failed')

    const messages: Message[] = [{ role: 'user', content: 'Hi' }]
    const response = await result.data.complete(messages)

    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error).toContain('connection refused')
  })

  // 8. TokenUsage の正しいマッピング
  it('TokenUsageの正しいマッピング（prompt_eval_count→inputTokens, eval_count→outputTokens）', async () => {
    const mockResponse = {
      message: { role: 'assistant', content: 'test' },
      prompt_eval_count: 42,
      eval_count: 99,
    }
    const mockFetch = makeMockFetch(mockResponse)
    vi.stubGlobal('fetch', mockFetch)

    const result = createOllamaProvider(BASE_CONFIG, MODEL)
    if (!result.ok) throw new Error('provider creation failed')

    const messages: Message[] = [{ role: 'user', content: 'test' }]
    const response = await result.data.complete(messages)

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.usage).toEqual({ inputTokens: 42, outputTokens: 99 })
  })

  // ─── stream tests ─────────────────────────────────

  // 9. テキスト delta → StreamChunk.delta（NDJSON ストリーム）
  it('テキストdelta → StreamChunk.delta（NDJSONストリーム）', async () => {
    const chunks = [
      { message: { content: 'Hello' }, done: false },
      { message: { content: ' world' }, done: false },
      { done: true, prompt_eval_count: 10, eval_count: 20 },
    ]
    const mockFetch = makeMockStreamFetch(chunks)
    vi.stubGlobal('fetch', mockFetch)

    const result = createOllamaProvider(BASE_CONFIG, MODEL)
    if (!result.ok) throw new Error('provider creation failed')
    if (!result.data.stream) throw new Error('stream not implemented')

    const messages: Message[] = [{ role: 'user', content: 'Hi' }]
    const collected: StreamChunk[] = []
    for await (const chunk of result.data.stream(messages)) {
      collected.push(chunk)
    }

    expect(collected).toEqual([
      { type: 'delta', content: 'Hello' },
      { type: 'delta', content: ' world' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } },
    ])
  })

  // 10. ツール呼び出し → StreamChunk.tool_call
  it('ツール呼び出し → StreamChunk.tool_call', async () => {
    const chunks = [
      {
        message: {
          tool_calls: [{ function: { name: 'search', arguments: { query: 'test' } } }],
        },
        done: false,
      },
      { done: true, prompt_eval_count: 5, eval_count: 15 },
    ]
    const mockFetch = makeMockStreamFetch(chunks)
    vi.stubGlobal('fetch', mockFetch)

    const result = createOllamaProvider(BASE_CONFIG, MODEL)
    if (!result.ok) throw new Error('provider creation failed')
    if (!result.data.stream) throw new Error('stream not implemented')

    const messages: Message[] = [{ role: 'user', content: 'search for test' }]
    const collected: StreamChunk[] = []
    for await (const chunk of result.data.stream(messages)) {
      collected.push(chunk)
    }

    expect(collected).toHaveLength(2)
    const toolChunk = collected[0]
    if (!toolChunk) throw new Error('expected at least one chunk')
    expect(toolChunk.type).toBe('tool_call')
    if (toolChunk.type !== 'tool_call') return
    expect(toolChunk.toolCall.name).toBe('search')
    expect(toolChunk.toolCall.arguments).toEqual({ query: 'test' })
    expect(toolChunk.toolCall.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    const doneChunk = collected[1]
    if (!doneChunk) throw new Error('expected done chunk')
    expect(doneChunk.type).toBe('done')
  })

  // 11. 完了（done: true）→ StreamChunk.done(usage)
  it('完了（done: true）→ StreamChunk.done(usage)', async () => {
    const chunks = [
      { message: { content: 'hi' }, done: false },
      { done: true, prompt_eval_count: 100, eval_count: 200 },
    ]
    const mockFetch = makeMockStreamFetch(chunks)
    vi.stubGlobal('fetch', mockFetch)

    const result = createOllamaProvider(BASE_CONFIG, MODEL)
    if (!result.ok) throw new Error('provider creation failed')
    if (!result.data.stream) throw new Error('stream not implemented')

    const messages: Message[] = [{ role: 'user', content: 'hi' }]
    const collected: StreamChunk[] = []
    for await (const chunk of result.data.stream(messages)) {
      collected.push(chunk)
    }

    const doneChunk = collected[collected.length - 1]
    if (!doneChunk) throw new Error('expected at least one chunk')
    expect(doneChunk.type).toBe('done')
    if (doneChunk.type !== 'done') return
    expect(doneChunk.usage).toEqual({ inputTokens: 100, outputTokens: 200 })
  })

  // 12. ネットワークエラー → throw (stream中)
  it('ネットワークエラー → throw（stream中）', async () => {
    const mockFetch = makeMockErrorStreamFetch()
    vi.stubGlobal('fetch', mockFetch)

    const result = createOllamaProvider(BASE_CONFIG, MODEL)
    if (!result.ok) throw new Error('provider creation failed')
    if (!result.data.stream) throw new Error('stream not implemented')

    const messages: Message[] = [{ role: 'user', content: 'Hi' }]

    await expect(async () => {
      if (!result.data.stream) throw new Error('stream not available')
      const collected: StreamChunk[] = []
      for await (const chunk of result.data.stream(messages)) {
        collected.push(chunk)
      }
    }).rejects.toThrow()
  })
})
