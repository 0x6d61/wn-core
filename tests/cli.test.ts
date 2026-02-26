import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Result } from '../src/result.js'
import type { LLMProvider } from '../src/providers/types.js'

// --- Provider ファクトリのモック ---

const mockProvider: LLMProvider = {
  complete() {
    return Promise.resolve({ ok: true, data: { content: 'mock', toolCalls: [] } })
  },
}

vi.mock('../src/providers/claude.js', () => ({
  createClaudeProvider: vi.fn((): Result<LLMProvider> => ({ ok: true, data: mockProvider })),
}))

vi.mock('../src/providers/openai.js', () => ({
  createOpenAIProvider: vi.fn((): Result<LLMProvider> => ({ ok: true, data: mockProvider })),
}))

vi.mock('../src/providers/ollama.js', () => ({
  createOllamaProvider: vi.fn((): Result<LLMProvider> => ({ ok: true, data: mockProvider })),
}))

vi.mock('../src/providers/gemini.js', () => ({
  createGeminiProvider: vi.fn((): Result<LLMProvider> => ({ ok: true, data: mockProvider })),
}))

// テスト対象をインポート（モック定義後）
import { createProvider, createDefaultToolRegistry, createServeHandler } from '../src/cli.js'
import { createClaudeProvider } from '../src/providers/claude.js'
import { createOpenAIProvider } from '../src/providers/openai.js'
import { createOllamaProvider } from '../src/providers/ollama.js'
import { createGeminiProvider } from '../src/providers/gemini.js'

// ─── createProvider ───

describe('createProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('claude を指定すると createClaudeProvider を呼ぶ', () => {
    const config = { apiKey: 'test-key' }
    const result = createProvider('claude', config, 'claude-sonnet-4-20250514')

    expect(result.ok).toBe(true)
    expect(createClaudeProvider).toHaveBeenCalledWith(config, 'claude-sonnet-4-20250514')
  })

  it('openai を指定すると createOpenAIProvider を呼ぶ', () => {
    const config = { apiKey: 'test-key' }
    const result = createProvider('openai', config, 'gpt-4o')

    expect(result.ok).toBe(true)
    expect(createOpenAIProvider).toHaveBeenCalledWith(config, 'gpt-4o')
  })

  it('ollama を指定すると createOllamaProvider を呼ぶ', () => {
    const config = {}
    const result = createProvider('ollama', config, 'llama3')

    expect(result.ok).toBe(true)
    expect(createOllamaProvider).toHaveBeenCalledWith(config, 'llama3')
  })

  it('gemini を指定すると createGeminiProvider を呼ぶ', () => {
    const config = { apiKey: 'test-key' }
    const result = createProvider('gemini', config, 'gemini-pro')

    expect(result.ok).toBe(true)
    expect(createGeminiProvider).toHaveBeenCalledWith(config, 'gemini-pro')
  })

  it('未知のプロバイダー名で err を返す', () => {
    const result = createProvider('unknown', {}, 'model')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Unknown provider')
      expect(result.error).toContain('unknown')
    }
  })
})

// ─── createDefaultToolRegistry ───

describe('createDefaultToolRegistry', () => {
  it('4つのビルトインツールを持つ ToolRegistry を返す', () => {
    const registry = createDefaultToolRegistry()
    const tools = registry.list()

    expect(tools).toHaveLength(4)
  })

  it('read ツールが取得できる', () => {
    const registry = createDefaultToolRegistry()
    const tool = registry.get('read')

    expect(tool).toBeDefined()
    expect(tool?.name).toBe('read')
  })

  it('write ツールが取得できる', () => {
    const registry = createDefaultToolRegistry()
    const tool = registry.get('write')

    expect(tool).toBeDefined()
    expect(tool?.name).toBe('write')
  })

  it('shell ツールが取得できる', () => {
    const registry = createDefaultToolRegistry()
    const tool = registry.get('shell')

    expect(tool).toBeDefined()
    expect(tool?.name).toBe('shell')
  })

  it('grep ツールが取得できる', () => {
    const registry = createDefaultToolRegistry()
    const tool = registry.get('grep')

    expect(tool).toBeDefined()
    expect(tool?.name).toBe('grep')
  })
})

// ─── createServeHandler ───

describe('createServeHandler', () => {
  it('input メソッドで agentLoop.step(text) を呼び、 { accepted: boolean } を返す', async () => {
    const mockStep = vi.fn().mockResolvedValue({ ok: true, data: 'response' })
    const mockAgentLoop = { step: mockStep } as unknown as Parameters<typeof createServeHandler>[0]
    const abortController = new AbortController()

    const handler = createServeHandler(mockAgentLoop, abortController)
    const result = await handler('input', { text: 'hello' })

    expect(mockStep).toHaveBeenCalledWith('hello')
    expect(result).toEqual({ accepted: true })
  })

  it('input メソッドで step が失敗した場合 accepted: false を返す', async () => {
    const mockStep = vi.fn().mockResolvedValue({ ok: false, error: 'fail' })
    const mockAgentLoop = { step: mockStep } as unknown as Parameters<typeof createServeHandler>[0]
    const abortController = new AbortController()

    const handler = createServeHandler(mockAgentLoop, abortController)
    const result = await handler('input', { text: 'hello' })

    expect(result).toEqual({ accepted: false })
  })

  it('abort メソッドで abortController.abort() を呼び { aborted: true } を返す', async () => {
    const mockAgentLoop = { step: vi.fn() } as unknown as Parameters<typeof createServeHandler>[0]
    const abortController = new AbortController()
    const abortSpy = vi.spyOn(abortController, 'abort')

    const handler = createServeHandler(mockAgentLoop, abortController)
    const result = await handler('abort', {})

    expect(abortSpy).toHaveBeenCalled()
    expect(result).toEqual({ aborted: true })
  })

  it('configUpdate メソッドで { applied: true } を返す', async () => {
    const mockAgentLoop = { step: vi.fn() } as unknown as Parameters<typeof createServeHandler>[0]
    const abortController = new AbortController()

    const handler = createServeHandler(mockAgentLoop, abortController)
    const result = await handler('configUpdate', {})

    expect(result).toEqual({ applied: true })
  })
})
