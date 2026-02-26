/**
 * サブエージェントのステータス
 */
export type SubAgentStatus = 'running' | 'completed' | 'failed'

/** サブエージェントのハンドル */
export interface SubAgentHandle {
  readonly id: string
  readonly status: SubAgentStatus
  readonly result?: unknown
}

/** エージェント設定 */
export interface AgentConfig {
  readonly persona: string
  readonly skills: readonly string[]
  readonly provider: string
  readonly model: string
  readonly task: string
}

/**
 * サブエージェントランナーインターフェース
 *
 * Worker Threads を使用してサブエージェントを並列実行する。
 */
export interface SubAgentRunner {
  /** サブエージェントを生成する */
  spawn(config: AgentConfig): Promise<SubAgentHandle>

  /** 実行中のサブエージェント一覧を取得する */
  list(): SubAgentHandle[]

  /** サブエージェントを停止する */
  stop(id: string): Promise<void>
}
