import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Result } from '../src/result.js'
import type { LLMProvider } from '../src/providers/types.js'
import type { AgentLoopHandler } from '../src/agent/types.js'
import { ToolRegistry } from '../src/tools/types.js'

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
import {
  createProvider,
  createDefaultToolRegistry,
  createServeHandler,
  type ServeHandlerDeps,
} from '../src/cli.js'
import { createClaudeProvider } from '../src/providers/claude.js'
import { createOpenAIProvider } from '../src/providers/openai.js'
import { createOllamaProvider } from '../src/providers/ollama.js'
import { createGeminiProvider } from '../src/providers/gemini.js'

// --- テスト用ヘルパー ---

function createMockAgentHandler(): AgentLoopHandler {
  return {
    onResponse: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onStateChange: vi.fn(),
    onError: vi.fn(),
    onUsage: vi.fn(),
  }
}

function createMockDeps(overrides?: Partial<ServeHandlerDeps>): ServeHandlerDeps {
  const mockStep = vi.fn().mockResolvedValue({ ok: true, data: 'response' })
  return {
    config: {
      defaultProvider: 'claude',
      defaultModel: 'claude-sonnet-4-20250514',
      defaultPersona: 'default',
      providers: { claude: { apiKey: 'test-key' }, openai: { apiKey: 'oai-key' } },
    },
    agentLoopRef: { current: { step: mockStep } as unknown as import('../src/agent/agent-loop.js').AgentLoop },
    abortController: new AbortController(),
    toolRegistry: new ToolRegistry(),
    agentHandlerRef: { current: createMockAgentHandler() },
    systemMessage: undefined,
    ...overrides,
  }
}

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
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('input', () => {
    it('agentLoopRef.current が存在する場合 step を呼び accepted を返す', async () => {
      const mockStep = vi.fn().mockResolvedValue({ ok: true, data: 'response' })
      const deps = createMockDeps({
        agentLoopRef: { current: { step: mockStep } as unknown as import('../src/agent/agent-loop.js').AgentLoop },
      })

      const handler = createServeHandler(deps)
      const result = await handler('input', { text: 'hello' })

      expect(mockStep).toHaveBeenCalledWith('hello')
      expect(result).toEqual({ accepted: true })
    })

    it('step が失敗した場合 accepted: false を返す', async () => {
      const mockStep = vi.fn().mockResolvedValue({ ok: false, error: 'fail' })
      const deps = createMockDeps({
        agentLoopRef: { current: { step: mockStep } as unknown as import('../src/agent/agent-loop.js').AgentLoop },
      })

      const handler = createServeHandler(deps)
      const result = await handler('input', { text: 'hello' })

      expect(result).toEqual({ accepted: false })
    })

    it('agentLoopRef.current が undefined の場合 accepted: false を返す', async () => {
      const deps = createMockDeps({ agentLoopRef: { current: undefined } })

      const handler = createServeHandler(deps)
      const result = await handler('input', { text: 'hello' })

      expect(result).toEqual({ accepted: false })
    })
  })

  describe('abort', () => {
    it('abortController.abort() を呼び { aborted: true } を返す', async () => {
      const deps = createMockDeps()
      const abortSpy = vi.spyOn(deps.abortController, 'abort')

      const handler = createServeHandler(deps)
      const result = await handler('abort', {})

      expect(abortSpy).toHaveBeenCalled()
      expect(result).toEqual({ aborted: true })
    })
  })

  describe('configUpdate', () => {
    it('provider と model を指定して新しい AgentLoop を生成し applied: true を返す', async () => {
      const deps = createMockDeps()
      const handler = createServeHandler(deps)

      const result = await handler('configUpdate', { provider: 'openai', model: 'gpt-4o' })

      expect(result).toEqual({ applied: true })
      expect(createOpenAIProvider).toHaveBeenCalledWith({ apiKey: 'oai-key' }, 'gpt-4o')
      expect(deps.agentLoopRef.current).toBeDefined()
    })

    it('provider のみ指定した場合 model は config.defaultModel を使う', async () => {
      const deps = createMockDeps()
      const handler = createServeHandler(deps)

      const result = await handler('configUpdate', { provider: 'ollama' })

      expect(result).toEqual({ applied: true })
      expect(createOllamaProvider).toHaveBeenCalledWith({}, 'claude-sonnet-4-20250514')
    })

    it('model のみ指定した場合 provider は config.defaultProvider を使う', async () => {
      const deps = createMockDeps()
      const handler = createServeHandler(deps)

      const result = await handler('configUpdate', { model: 'claude-opus-4-20250514' })

      expect(result).toEqual({ applied: true })
      expect(createClaudeProvider).toHaveBeenCalledWith(
        { apiKey: 'test-key' },
        'claude-opus-4-20250514',
      )
    })

    it('provider 生成に失敗した場合 applied: false を返しクラッシュしない', async () => {
      const deps = createMockDeps()
      const oldLoop = deps.agentLoopRef.current
      const handler = createServeHandler(deps)

      const result = await handler('configUpdate', { provider: 'unknown-provider' })

      expect(result).toEqual({ applied: false })
      // 元の agentLoopRef は変更されていない
      expect(deps.agentLoopRef.current).toBe(oldLoop)
    })

    it('providers に設定がない provider を指定した場合 空の config で生成する', async () => {
      const deps = createMockDeps({
        config: {
          defaultProvider: 'claude',
          defaultModel: 'claude-sonnet-4-20250514',
          defaultPersona: 'default',
          providers: {},
        },
      })
      const handler = createServeHandler(deps)

      const result = await handler('configUpdate', { provider: 'ollama', model: 'llama3' })

      expect(result).toEqual({ applied: true })
      expect(createOllamaProvider).toHaveBeenCalledWith({}, 'llama3')
    })

    it('成功時に agentLoopRef.current が新しいインスタンスに差し替わる', async () => {
      const deps = createMockDeps()
      const oldLoop = deps.agentLoopRef.current
      const handler = createServeHandler(deps)

      await handler('configUpdate', { provider: 'claude', model: 'claude-opus-4-20250514' })

      expect(deps.agentLoopRef.current).not.toBe(oldLoop)
    })

    it('パラメータなし(空オブジェクト)の場合 現在のデフォルト設定で再生成する', async () => {
      const deps = createMockDeps()
      const handler = createServeHandler(deps)

      const result = await handler('configUpdate', {})

      expect(result).toEqual({ applied: true })
      expect(createClaudeProvider).toHaveBeenCalledWith(
        { apiKey: 'test-key' },
        'claude-sonnet-4-20250514',
      )
    })
  })
})
