import type { LLMProvider, TokenUsage } from '../providers/types.js'
import type { ToolRegistry, ToolResult } from '../tools/types.js'
import type { McpServerConfig, Persona, ProviderConfig, Skill, WnConfig } from '../loader/types.js'

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

// --- SubAgent Worker 関連 ---

/** Worker に渡すシリアライズ可能なデータ */
export interface SubAgentWorkerData {
  readonly id: string
  readonly task: string
  readonly systemMessage: string
  readonly providerName: string
  readonly providerConfig: ProviderConfig
  readonly model: string
  readonly mcpServers: readonly McpServerConfig[]
}

/** Worker → Main メッセージ */
export type WorkerMessage =
  | { readonly type: 'result'; readonly data: string }
  | { readonly type: 'error'; readonly error: string }
  | { readonly type: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }

/** WorkerSubAgentRunner のコンストラクタオプション */
export interface SubAgentRunnerOptions {
  readonly config: WnConfig
  readonly personas: ReadonlyMap<string, Persona>
  readonly skills: ReadonlyMap<string, Skill>
  readonly workerUrl?: string | URL
}

/** Worker 内メッセージ送信インターフェース（テスト用に分離） */
export interface MessageSender {
  postMessage(msg: WorkerMessage): void
}

// --- AgentLoop 関連 ---

/** AgentLoop の状態 */
export type AgentLoopState = 'idle' | 'waiting_input' | 'thinking' | 'tool_running'

/** AgentLoop イベントハンドラ */
export interface AgentLoopHandler {
  readonly onResponse: (content: string) => void | Promise<void>
  readonly onToolStart: (name: string, args: Record<string, unknown>) => void | Promise<void>
  readonly onToolEnd: (name: string, result: ToolResult) => void | Promise<void>
  readonly onStateChange: (state: AgentLoopState) => void | Promise<void>
  readonly onError: (error: string) => void | Promise<void>
  readonly onUsage?: (usage: TokenUsage) => void | Promise<void>
}

/** AgentLoop コンストラクタオプション */
export interface AgentLoopOptions {
  readonly provider: LLMProvider
  readonly tools: ToolRegistry
  readonly handler: AgentLoopHandler
  readonly systemMessage?: string
  /** ツール呼び出しラウンドの上限。省略時は無制限（Infinity） */
  readonly maxToolRounds?: number
  readonly signal?: AbortSignal
}
