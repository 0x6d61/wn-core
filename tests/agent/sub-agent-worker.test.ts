import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { ok, err } from '../../src/result.js'
import type { LLMProvider } from '../../src/providers/types.js'
import type { ProviderConfig } from '../../src/loader/types.js'
import type { SubAgentWorkerData, WorkerMessage } from '../../src/agent/types.js'

// ---------------------------------------------------------------------------
// モック: プロバイダーファクトリ
// ---------------------------------------------------------------------------
vi.mock('../../src/providers/claude.js', () => ({
  createClaudeProvider: vi.fn(),
}))
vi.mock('../../src/providers/openai.js', () => ({
  createOpenAIProvider: vi.fn(),
}))
vi.mock('../../src/providers/ollama.js', () => ({
  createOllamaProvider: vi.fn(),
}))
vi.mock('../../src/providers/gemini.js', () => ({
  createGeminiProvider: vi.fn(),
}))

// ---------------------------------------------------------------------------
// モック: AgentLoop / createNoopHandler
// ---------------------------------------------------------------------------
const mockStep = vi.fn()

vi.mock('../../src/agent/agent-loop.js', () => ({
  AgentLoop: vi.fn().mockImplementation(function () {
    return { step: mockStep }
  }),
  createNoopHandler: vi.fn(() => ({
    onResponse: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onStateChange: vi.fn(),
    onError: vi.fn(),
    onUsage: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// モック: ToolRegistry
// ---------------------------------------------------------------------------
vi.mock('../../src/tools/types.js', () => ({
  ToolRegistry: vi.fn().mockImplementation(function () {
    return {
      register: vi.fn(() => ({ ok: true, data: undefined })),
      list: vi.fn(() => []),
      get: vi.fn(),
    }
  }),
}))

// ---------------------------------------------------------------------------
// モック: ビルトインツール
// ---------------------------------------------------------------------------
vi.mock('../../src/tools/read.js', () => ({
  createReadTool: vi.fn(() => ({
    name: 'read',
    description: 'Read a file',
    parameters: {},
    execute: vi.fn(),
  })),
}))
vi.mock('../../src/tools/write.js', () => ({
  createWriteTool: vi.fn(() => ({
    name: 'write',
    description: 'Write a file',
    parameters: {},
    execute: vi.fn(),
  })),
}))
vi.mock('../../src/tools/grep.js', () => ({
  createGrepTool: vi.fn(() => ({
    name: 'grep',
    description: 'Search files',
    parameters: {},
    execute: vi.fn(),
  })),
}))
vi.mock('../../src/tools/shell.js', () => ({
  createShellTool: vi.fn(() => ({
    name: 'shell',
    description: 'Run shell command',
    parameters: {},
    execute: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// テスト対象のインポート（vi.mock の後に配置）
// ---------------------------------------------------------------------------
import { createProviderByName, runSubAgent } from '../../src/agent/sub-agent-worker.js'
import { createClaudeProvider } from '../../src/providers/claude.js'
import { createOpenAIProvider } from '../../src/providers/openai.js'
import { createOllamaProvider } from '../../src/providers/ollama.js'
import { createGeminiProvider } from '../../src/providers/gemini.js'

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** ダミーの LLMProvider */
function createDummyProvider(): LLMProvider {
  return {
    complete: vi.fn(),
  }
}

/** テスト用 SubAgentWorkerData を生成する */
function createWorkerData(overrides?: Partial<SubAgentWorkerData>): SubAgentWorkerData {
  return {
    id: 'sub-1',
    task: 'Do something useful',
    systemMessage: 'You are an assistant.',
    providerName: 'claude',
    providerConfig: { apiKey: 'test-key' },
    model: 'claude-sonnet-4-20250514',
    mcpServers: [],
    ...overrides,
  }
}

/** スパイ付き MessageSender を生成する */
function createMockSender(): {
  postMessage: Mock<(msg: WorkerMessage) => void>
} {
  return {
    postMessage: vi.fn<(msg: WorkerMessage) => void>(),
  }
}

// ===========================================================================
// テスト本体
// ===========================================================================

describe('createProviderByName', () => {
  const config: ProviderConfig = { apiKey: 'test-key' }
  const model = 'test-model'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('claude プロバイダーを生成できる', () => {
    const dummyProvider = createDummyProvider()
    ;(createClaudeProvider as Mock).mockReturnValue(ok(dummyProvider))

    const result = createProviderByName('claude', config, model)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBe(dummyProvider)
    }
    expect(createClaudeProvider).toHaveBeenCalledWith(config, model)
    expect(createClaudeProvider).toHaveBeenCalledTimes(1)
  })

  it('openai プロバイダーを生成できる', () => {
    const dummyProvider = createDummyProvider()
    ;(createOpenAIProvider as Mock).mockReturnValue(ok(dummyProvider))

    const result = createProviderByName('openai', config, model)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBe(dummyProvider)
    }
    expect(createOpenAIProvider).toHaveBeenCalledWith(config, model)
    expect(createOpenAIProvider).toHaveBeenCalledTimes(1)
  })

  it('ollama プロバイダーを生成できる', () => {
    const dummyProvider = createDummyProvider()
    ;(createOllamaProvider as Mock).mockReturnValue(ok(dummyProvider))

    const result = createProviderByName('ollama', config, model)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBe(dummyProvider)
    }
    expect(createOllamaProvider).toHaveBeenCalledWith(config, model)
    expect(createOllamaProvider).toHaveBeenCalledTimes(1)
  })

  it('未知のプロバイダー名でエラーを返す', () => {
    const result = createProviderByName('unknown-provider', config, model)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Unknown provider: unknown-provider')
    }
    // どのファクトリも呼ばれない
    expect(createClaudeProvider).not.toHaveBeenCalled()
    expect(createOpenAIProvider).not.toHaveBeenCalled()
    expect(createOllamaProvider).not.toHaveBeenCalled()
    expect(createGeminiProvider).not.toHaveBeenCalled()
  })
})

describe('runSubAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStep.mockReset()
  })

  it('正常系: AgentLoop.step が成功し result メッセージを送信する', async () => {
    // プロバイダー生成成功
    const dummyProvider = createDummyProvider()
    ;(createClaudeProvider as Mock).mockReturnValue(ok(dummyProvider))

    // AgentLoop.step が成功結果を返す
    mockStep.mockResolvedValue(ok('Task completed successfully'))

    const sender = createMockSender()
    const data = createWorkerData()

    await runSubAgent(data, sender)

    // result メッセージが送信される
    expect(sender.postMessage).toHaveBeenCalledWith({
      type: 'result',
      data: 'Task completed successfully',
    })
    // error メッセージは送信されない
    const errorCalls = sender.postMessage.mock.calls.filter((call) => call[0].type === 'error')
    expect(errorCalls).toHaveLength(0)
  })

  it('プロバイダー生成失敗時に error メッセージを送信する', async () => {
    // プロバイダー生成失敗
    ;(createClaudeProvider as Mock).mockReturnValue(err('API key is required'))

    const sender = createMockSender()
    const data = createWorkerData()

    await runSubAgent(data, sender)

    // error メッセージが送信される
    expect(sender.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
      }),
    )
    // result メッセージは送信されない
    const resultCalls = sender.postMessage.mock.calls.filter((call) => call[0].type === 'result')
    expect(resultCalls).toHaveLength(0)
    // AgentLoop.step は呼ばれない
    expect(mockStep).not.toHaveBeenCalled()
  })
})
