import { describe, it, expect, vi, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'
import { ok, err } from '../../src/result.js'
import type {
  AgentConfig,
  SubAgentWorkerData,
  SubAgentRunnerOptions,
} from '../../src/agent/types.js'
import type { Persona, Skill, WnConfig } from '../../src/loader/types.js'
import {
  resolveWorkerData,
  isWorkerMessage,
  WorkerSubAgentRunner,
} from '../../src/agent/sub-agent-runner.js'

// ---------------------------------------------------------------------------
// ヘルパー: テスト用のデフォルトデータを生成
// ---------------------------------------------------------------------------

function createDefaultPersonas(): ReadonlyMap<string, Persona> {
  return new Map<string, Persona>([
    ['pentester', { name: 'pentester', content: 'You are a penetration tester.' }],
    ['analyst', { name: 'analyst', content: 'You are a security analyst.' }],
  ])
}

function createDefaultSkills(): ReadonlyMap<string, Skill> {
  return new Map<string, Skill>([
    [
      'recon',
      {
        name: 'recon',
        description: 'Reconnaissance skill',
        tools: ['nmap', 'whois'],
        body: 'Perform reconnaissance on the target.',
      },
    ],
    [
      'exploit',
      {
        name: 'exploit',
        description: 'Exploitation skill',
        tools: ['metasploit'],
        body: 'Attempt to exploit discovered vulnerabilities.',
      },
    ],
  ])
}

function createDefaultWnConfig(overrides?: Partial<WnConfig>): WnConfig {
  return {
    defaultProvider: 'claude',
    defaultModel: 'claude-sonnet-4-20250514',
    defaultPersona: 'pentester',
    providers: {
      claude: { apiKey: 'sk-test-key', baseUrl: 'https://api.anthropic.com' },
      openai: { apiKey: 'sk-openai-key' },
    },
    mcp: {
      servers: [
        {
          name: 'filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
      ],
    },
    ...overrides,
  }
}

function createDefaultAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    persona: 'pentester',
    skills: ['recon', 'exploit'],
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    task: 'Scan the target network',
    ...overrides,
  }
}

// ===========================================================================
// テスト本体
// ===========================================================================

describe('resolveWorkerData', () => {
  it('正常系: persona + skills + provider が全て解決できる', () => {
    const personas = createDefaultPersonas()
    const skills = createDefaultSkills()
    const wnConfig = createDefaultWnConfig()
    const agentConfig = createDefaultAgentConfig()

    const result = resolveWorkerData('agent-1', agentConfig, wnConfig, personas, skills)

    expect(result).toStrictEqual(
      ok<SubAgentWorkerData>({
        id: 'agent-1',
        task: 'Scan the target network',
        systemMessage:
          'You are a penetration tester.\n\n' +
          'Perform reconnaissance on the target.\n\n' +
          'Attempt to exploit discovered vulnerabilities.',
        providerName: 'claude',
        providerConfig: { apiKey: 'sk-test-key', baseUrl: 'https://api.anthropic.com' },
        model: 'claude-sonnet-4-20250514',
        mcpServers: [
          {
            name: 'filesystem',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
          },
        ],
      }),
    )
  })

  it('persona が見つからない場合エラーを返す', () => {
    const personas = createDefaultPersonas()
    const skills = createDefaultSkills()
    const wnConfig = createDefaultWnConfig()
    const agentConfig = createDefaultAgentConfig({ persona: 'nonexistent' })

    const result = resolveWorkerData('agent-2', agentConfig, wnConfig, personas, skills)

    expect(result).toStrictEqual(err('Persona not found: nonexistent'))
  })

  it('skill が見つからない場合エラーを返す', () => {
    const personas = createDefaultPersonas()
    const skills = createDefaultSkills()
    const wnConfig = createDefaultWnConfig()
    const agentConfig = createDefaultAgentConfig({ skills: ['recon', 'unknown-skill'] })

    const result = resolveWorkerData('agent-3', agentConfig, wnConfig, personas, skills)

    expect(result).toStrictEqual(err('Skill not found: unknown-skill'))
  })

  it('provider が見つからない場合エラーを返す', () => {
    const personas = createDefaultPersonas()
    const skills = createDefaultSkills()
    const wnConfig = createDefaultWnConfig()
    const agentConfig = createDefaultAgentConfig({ provider: 'gemini' })

    const result = resolveWorkerData('agent-4', agentConfig, wnConfig, personas, skills)

    expect(result).toStrictEqual(err('Provider not found: gemini'))
  })

  it('skills が空配列の場合は persona.content のみが systemMessage になる', () => {
    const personas = createDefaultPersonas()
    const skills = createDefaultSkills()
    const wnConfig = createDefaultWnConfig()
    const agentConfig = createDefaultAgentConfig({ skills: [] })

    const result = resolveWorkerData('agent-5', agentConfig, wnConfig, personas, skills)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.systemMessage).toBe('You are a penetration tester.')
    }
  })

  it('mcp 設定がない場合は空配列になる', () => {
    const personas = createDefaultPersonas()
    const skills = createDefaultSkills()
    // mcp プロパティを省略した WnConfig
    const wnConfig: WnConfig = {
      defaultProvider: 'claude',
      defaultModel: 'claude-sonnet-4-20250514',
      defaultPersona: 'pentester',
      providers: {
        claude: { apiKey: 'sk-test-key' },
      },
    }
    const agentConfig = createDefaultAgentConfig()

    const result = resolveWorkerData('agent-6', agentConfig, wnConfig, personas, skills)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.mcpServers).toStrictEqual([])
    }
  })
})

describe('isWorkerMessage', () => {
  it('有効な WorkerMessage を正しく判定する', () => {
    // --- 有効なメッセージ ---

    // result メッセージ
    expect(isWorkerMessage({ type: 'result', data: 'some output' })).toBe(true)

    // error メッセージ
    expect(isWorkerMessage({ type: 'error', error: 'something went wrong' })).toBe(true)

    // log メッセージ (各 level)
    expect(isWorkerMessage({ type: 'log', level: 'info', message: 'info msg' })).toBe(true)
    expect(isWorkerMessage({ type: 'log', level: 'warn', message: 'warn msg' })).toBe(true)
    expect(isWorkerMessage({ type: 'log', level: 'error', message: 'error msg' })).toBe(true)

    // --- 無効な値 ---

    // null / undefined / プリミティブ
    expect(isWorkerMessage(null)).toBe(false)
    expect(isWorkerMessage(undefined)).toBe(false)
    expect(isWorkerMessage(42)).toBe(false)
    expect(isWorkerMessage('string')).toBe(false)

    // type プロパティが不正
    expect(isWorkerMessage({ type: 'unknown' })).toBe(false)
    expect(isWorkerMessage({})).toBe(false)

    // result だが data が string でない
    expect(isWorkerMessage({ type: 'result', data: 123 })).toBe(false)
    expect(isWorkerMessage({ type: 'result' })).toBe(false)

    // error だが error が string でない
    expect(isWorkerMessage({ type: 'error', error: 123 })).toBe(false)
    expect(isWorkerMessage({ type: 'error' })).toBe(false)

    // log だが level が不正
    expect(isWorkerMessage({ type: 'log', level: 'debug', message: 'msg' })).toBe(false)
    expect(isWorkerMessage({ type: 'log', level: 'info' })).toBe(false)
    expect(isWorkerMessage({ type: 'log', message: 'msg' })).toBe(false)
    expect(isWorkerMessage({ type: 'log', level: 'info', message: 123 })).toBe(false)
  })
})

// ===========================================================================
// WorkerSubAgentRunner テスト
// ===========================================================================

// Worker モック
vi.mock('node:worker_threads', () => {
  return {
    Worker: vi.fn(),
    isMainThread: true,
    parentPort: null,
    workerData: null,
  }
})

const { Worker } = await import('node:worker_threads')

class MockWorker extends EventEmitter {
  terminate = vi.fn<() => Promise<number>>().mockResolvedValue(0)
}

function createMockWorker(): MockWorker {
  const mw = new MockWorker()
  ;(Worker as unknown as Mock).mockImplementation(function () {
    return mw
  })
  return mw
}

function createRunnerOptions(overrides?: Partial<SubAgentRunnerOptions>): SubAgentRunnerOptions {
  return {
    config: createDefaultWnConfig(),
    personas: createDefaultPersonas(),
    skills: createDefaultSkills(),
    workerUrl: new URL('file:///fake-worker.js'),
    ...overrides,
  }
}

describe('WorkerSubAgentRunner', () => {
  describe('spawn', () => {
    it('名前解決成功時に Worker を起動し running ハンドルを返す', async () => {
      createMockWorker()
      const runner = new WorkerSubAgentRunner(createRunnerOptions())
      const agentConfig = createDefaultAgentConfig()

      const handle = await runner.spawn(agentConfig)

      expect(handle.id).toEqual(expect.any(String))
      expect(handle.status).toBe('running')
      // Worker コンストラクタが呼ばれたことを確認
      expect(Worker).toHaveBeenCalledOnce()
    })

    it('persona 解決失敗時に即座に failed ハンドルを返す（Worker は起動しない）', async () => {
      ;(Worker as unknown as Mock).mockClear()
      const runner = new WorkerSubAgentRunner(createRunnerOptions())
      const agentConfig = createDefaultAgentConfig({ persona: 'nonexistent' })

      const handle = await runner.spawn(agentConfig)

      expect(handle.status).toBe('failed')
      expect(handle.result).toEqual(expect.stringContaining('Persona not found'))
      // Worker は起動しない
      expect(Worker).not.toHaveBeenCalled()
    })

    it('Worker の result メッセージで status が completed になる', async () => {
      const mw = createMockWorker()
      const runner = new WorkerSubAgentRunner(createRunnerOptions())
      const agentConfig = createDefaultAgentConfig()

      const handle = await runner.spawn(agentConfig)
      expect(handle.status).toBe('running')

      // Worker から result メッセージを送信
      mw.emit('message', { type: 'result', data: 'scan completed' })

      // list() 経由で最新の handle を取得
      const handles = runner.list()
      const updated = handles.find((h) => h.id === handle.id)
      expect(updated).toBeDefined()
      expect(updated?.status).toBe('completed')
      expect(updated?.result).toBe('scan completed')
    })

    it('Worker の error メッセージで status が failed になる', async () => {
      const mw = createMockWorker()
      const runner = new WorkerSubAgentRunner(createRunnerOptions())
      const agentConfig = createDefaultAgentConfig()

      const handle = await runner.spawn(agentConfig)

      // Worker から error メッセージを送信
      mw.emit('message', { type: 'error', error: 'provider timeout' })

      const handles = runner.list()
      const updated = handles.find((h) => h.id === handle.id)
      expect(updated).toBeDefined()
      expect(updated?.status).toBe('failed')
      expect(updated?.result).toBe('provider timeout')
    })

    it('Worker の error イベントで status が failed になる', async () => {
      const mw = createMockWorker()
      const runner = new WorkerSubAgentRunner(createRunnerOptions())
      const agentConfig = createDefaultAgentConfig()

      const handle = await runner.spawn(agentConfig)

      // Worker の error イベントを発火
      mw.emit('error', new Error('worker crashed'))

      const handles = runner.list()
      const updated = handles.find((h) => h.id === handle.id)
      expect(updated).toBeDefined()
      expect(updated?.status).toBe('failed')
    })

    it('Worker の異常終了（exit code !== 0）で status が failed になる', async () => {
      const mw = createMockWorker()
      const runner = new WorkerSubAgentRunner(createRunnerOptions())
      const agentConfig = createDefaultAgentConfig()

      const handle = await runner.spawn(agentConfig)

      // Worker が異常終了
      mw.emit('exit', 1)

      const handles = runner.list()
      const updated = handles.find((h) => h.id === handle.id)
      expect(updated).toBeDefined()
      expect(updated?.status).toBe('failed')
    })

    it('Worker の正常終了（exit code === 0）で status は変わらない', async () => {
      const mw = createMockWorker()
      const runner = new WorkerSubAgentRunner(createRunnerOptions())
      const agentConfig = createDefaultAgentConfig()

      const handle = await runner.spawn(agentConfig)
      expect(handle.status).toBe('running')

      // Worker が正常終了
      mw.emit('exit', 0)

      const handles = runner.list()
      const updated = handles.find((h) => h.id === handle.id)
      expect(updated).toBeDefined()
      // running のまま（result メッセージで completed に遷移済みのはず）
      // 正常終了だけでは status を変えない
      expect(updated?.status).toBe('running')
    })
  })

  describe('list', () => {
    it('空の状態では空配列を返す', () => {
      const runner = new WorkerSubAgentRunner(createRunnerOptions())

      expect(runner.list()).toStrictEqual([])
    })

    it('spawn した全ハンドルを返す（完了分含む）', async () => {
      const runner = new WorkerSubAgentRunner(createRunnerOptions())

      // 1つ目: running のまま
      createMockWorker()
      const handle1 = await runner.spawn(createDefaultAgentConfig({ task: 'task-1' }))

      // 2つ目: completed にする
      const mw2 = createMockWorker()
      const handle2 = await runner.spawn(createDefaultAgentConfig({ task: 'task-2' }))
      mw2.emit('message', { type: 'result', data: 'done' })

      const handles = runner.list()
      expect(handles).toHaveLength(2)

      const ids = handles.map((h) => h.id)
      expect(ids).toContain(handle1.id)
      expect(ids).toContain(handle2.id)

      // completed 分も含まれることを確認
      const completedHandle = handles.find((h) => h.id === handle2.id)
      expect(completedHandle?.status).toBe('completed')
    })
  })

  describe('stop', () => {
    it('指定 ID の Worker を terminate する', async () => {
      const mw = createMockWorker()
      const runner = new WorkerSubAgentRunner(createRunnerOptions())
      const agentConfig = createDefaultAgentConfig()

      const handle = await runner.spawn(agentConfig)

      await runner.stop(handle.id)

      expect(mw.terminate).toHaveBeenCalledOnce()

      // status が failed になる
      const handles = runner.list()
      const updated = handles.find((h) => h.id === handle.id)
      expect(updated).toBeDefined()
      expect(updated?.status).toBe('failed')
    })

    it('存在しない ID で呼んでもエラーにならない', async () => {
      const runner = new WorkerSubAgentRunner(createRunnerOptions())

      // 例外が投げられないことを確認
      await expect(runner.stop('nonexistent-id')).resolves.toBeUndefined()
    })
  })
})
