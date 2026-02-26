import type { Result } from '../result.js'

/**
 * JSON Schema を表す型エイリアス
 *
 * 将来的に Zod スキーマ等への置換を想定し、
 * Record<string, unknown> に別名を付けて可読性を確保する。
 */
export type JsonSchema = Record<string, unknown>

/** LLM メッセージ */
export interface Message {
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: string
  readonly toolCallId?: string
  readonly name?: string
  readonly toolCalls?: readonly ToolCall[]
}

/** LLM に渡すツール定義 */
export interface Tool {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
}

/** LLM が返すツール呼び出し */
export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/** トークン使用量 */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/** LLM レスポンス */
export interface LLMResponse {
  readonly content: string
  readonly toolCalls?: readonly ToolCall[]
  readonly usage?: TokenUsage
}

/**
 * LLM プロバイダーインターフェース
 *
 * Claude, OpenAI, Ollama, Gemini の4プロバイダーが実装する。
 */
export interface LLMProvider {
  /** 同期的にメッセージを送信し、レスポンスを取得する */
  complete(messages: readonly Message[], tools?: readonly Tool[]): Promise<Result<LLMResponse>>

  /** ストリーミングでレスポンスを取得する（オプション） */
  stream?(messages: readonly Message[], tools?: readonly Tool[]): AsyncIterable<string>
}
