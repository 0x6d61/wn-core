/**
 * サブエージェントランナー
 *
 * AgentConfig から SubAgentWorkerData を解決する純粋関数と、
 * Worker メッセージの型ガードを提供する。
 */
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { Result } from '../result.js'
import { ok, err } from '../result.js'
import type {
  AgentConfig,
  SubAgentHandle,
  SubAgentRunner,
  SubAgentRunnerOptions,
  SubAgentStatus,
  SubAgentWorkerData,
  WorkerMessage,
} from './types.js'
import type { Persona, Skill, WnConfig } from '../loader/types.js'

/**
 * AgentConfig と各種マスターデータから SubAgentWorkerData を組み立てる。
 *
 * persona / skills / provider いずれかの解決に失敗した場合は err を返す。
 */
export function resolveWorkerData(
  id: string,
  agentConfig: AgentConfig,
  wnConfig: WnConfig,
  personas: ReadonlyMap<string, Persona>,
  skills: ReadonlyMap<string, Skill>,
): Result<SubAgentWorkerData> {
  // 1. Persona の解決
  const persona = personas.get(agentConfig.persona)
  if (persona === undefined) {
    return err(`Persona not found: ${agentConfig.persona}`)
  }

  // 2. Skills の解決
  const resolvedSkills: Skill[] = []
  for (const skillName of agentConfig.skills) {
    const skill = skills.get(skillName)
    if (skill === undefined) {
      return err(`Skill not found: ${skillName}`)
    }
    resolvedSkills.push(skill)
  }

  // 3. Provider の解決
  const providerConfig = wnConfig.providers[agentConfig.provider]
  if (providerConfig === undefined) {
    return err(`Provider not found: ${agentConfig.provider}`)
  }

  // 4. systemMessage の組み立て
  const systemMessage =
    resolvedSkills.length === 0
      ? persona.content
      : [persona.content, ...resolvedSkills.map((s) => s.body)].join('\n\n')

  // 5. mcpServers
  const mcpServers = wnConfig.mcp?.servers ?? []

  // 6. 成功
  return ok({
    id,
    task: agentConfig.task,
    systemMessage,
    providerName: agentConfig.provider,
    providerConfig,
    model: agentConfig.model,
    mcpServers,
  })
}

/**
 * unknown な値が WorkerMessage 型かどうかを判定する型ガード。
 */
export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const obj = value as Record<string, unknown>
  const { type } = obj

  switch (type) {
    case 'result':
      return typeof obj['data'] === 'string'

    case 'error':
      return typeof obj['error'] === 'string'

    case 'log':
      return (
        (obj['level'] === 'info' || obj['level'] === 'warn' || obj['level'] === 'error') &&
        typeof obj['message'] === 'string'
      )

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// 内部ミュータブルハンドル（Worker イベントで status/result を更新）
// ---------------------------------------------------------------------------

interface MutableHandle {
  readonly id: string
  status: SubAgentStatus
  result?: unknown
  worker?: Worker
}

function toReadonly(h: MutableHandle): SubAgentHandle {
  return { id: h.id, status: h.status, result: h.result }
}

// ---------------------------------------------------------------------------
// WorkerSubAgentRunner
// ---------------------------------------------------------------------------

const DEFAULT_WORKER_URL = new URL('./sub-agent-worker.js', import.meta.url)

/**
 * Worker Threads で AgentLoop を並列実行するサブエージェントランナー。
 */
export class WorkerSubAgentRunner implements SubAgentRunner {
  private readonly handles = new Map<string, MutableHandle>()
  private readonly options: SubAgentRunnerOptions

  constructor(options: SubAgentRunnerOptions) {
    this.options = options
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- インターフェース準拠のため async を維持
  async spawn(config: AgentConfig): Promise<SubAgentHandle> {
    const id = randomUUID()

    // 名前解決
    const resolved = resolveWorkerData(
      id,
      config,
      this.options.config,
      this.options.personas,
      this.options.skills,
    )

    if (!resolved.ok) {
      const handle: MutableHandle = { id, status: 'failed', result: resolved.error }
      this.handles.set(id, handle)
      return toReadonly(handle)
    }

    // Worker 起動
    const workerUrl = this.options.workerUrl ?? DEFAULT_WORKER_URL
    const worker = new Worker(workerUrl, { workerData: resolved.data })

    const handle: MutableHandle = { id, status: 'running', worker }
    this.handles.set(id, handle)

    // message イベント
    worker.on('message', (msg: unknown) => {
      if (!isWorkerMessage(msg)) return

      switch (msg.type) {
        case 'result':
          handle.status = 'completed'
          handle.result = msg.data
          break
        case 'error':
          handle.status = 'failed'
          handle.result = msg.error
          break
        case 'log':
          // 将来の拡張ポイント（現在は無視）
          break
      }
    })

    // error イベント
    worker.on('error', () => {
      handle.status = 'failed'
    })

    // exit イベント（異常終了のみ）
    worker.on('exit', (code: number) => {
      if (code !== 0 && handle.status === 'running') {
        handle.status = 'failed'
      }
    })

    return toReadonly(handle)
  }

  list(): SubAgentHandle[] {
    return [...this.handles.values()].map(toReadonly)
  }

  async stop(id: string): Promise<void> {
    const handle = this.handles.get(id)
    if (!handle?.worker) return

    await handle.worker.terminate()
    handle.status = 'failed'
  }
}
