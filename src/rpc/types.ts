/**
 * RPC Server 型定義
 *
 * JSON-RPC 2.0 over stdin/stdout の基本型、
 * wn-core 固有の RPC メソッド型、およびサーバーインターフェースを定義する。
 */

import type { AgentLoopState } from '../agent/types.js'
import type { ToolResult } from '../tools/types.js'

// ─── JSON-RPC 2.0 基本型 ───

/** JSON-RPC 2.0 リクエスト */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: string | number
  readonly method: string
  readonly params?: unknown
}

/** JSON-RPC 2.0 通知（id なし） */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

/** Core が受信しうる JSON-RPC メッセージ（Request or Notification） */
export type JsonRpcIncoming = JsonRpcRequest | JsonRpcNotification

/** JSON-RPC 2.0 成功レスポンス */
export interface JsonRpcSuccessResponse {
  readonly jsonrpc: '2.0'
  readonly id: string | number
  readonly result: unknown
}

/** JSON-RPC 2.0 エラーオブジェクト */
export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

/** JSON-RPC 2.0 エラーレスポンス */
export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly error: JsonRpcErrorObject
}

// ─── JSON-RPC 2.0 標準エラーコード ───

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

// ─── wn-core RPC メソッド名 ───

export const RPC_METHODS = {
  // Core → TUI (Notification)
  RESPONSE: 'response',
  TOOL_EXEC: 'toolExec',
  STATE_CHANGE: 'stateChange',
  LOG: 'log',
  // TUI → Core (Request)
  INPUT: 'input',
  ABORT: 'abort',
  CONFIG_UPDATE: 'configUpdate',
} as const

// ─── Notification パラメータ型（Core → TUI） ───

export interface RpcResponseParams {
  readonly content: string
}

export interface RpcToolExecStartParams {
  readonly event: 'start'
  readonly name: string
  readonly args: Record<string, unknown>
}

export interface RpcToolExecEndParams {
  readonly event: 'end'
  readonly name: string
  readonly result: ToolResult
}

export type RpcToolExecParams = RpcToolExecStartParams | RpcToolExecEndParams

export interface RpcStateChangeParams {
  readonly state: AgentLoopState
}

export interface RpcLogParams {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
}

// ─── Request パラメータ / 結果型（TUI → Core） ───

export interface RpcInputParams {
  readonly text: string
}

export interface RpcInputResult {
  readonly accepted: boolean
}

export type RpcAbortParams = Record<string, never>

export interface RpcAbortResult {
  readonly aborted: boolean
}

export interface RpcConfigUpdateParams {
  readonly persona?: string
  readonly provider?: string
  readonly model?: string
}

export interface RpcConfigUpdateResult {
  readonly applied: boolean
}

// ─── Transport / Server インターフェース ───

/** I/O 抽象（テスト用にモック差し替え可能） */
export interface RpcTransport {
  readonly input: AsyncIterable<string>
  write(line: string): void
}

/** リクエストハンドラ関数シグネチャ */
export type RpcRequestHandler = (method: string, params: unknown) => Promise<unknown>

/** RPC サーバーインターフェース */
export interface RpcServer {
  /** サーバーを開始しメッセージ受信ループを回す */
  start(): Promise<void>
  /** 通知を送信する */
  notify(method: string, params?: unknown): void
  /** サーバーを停止する */
  stop(): void
}

/** createRpcServer に渡すオプション */
export interface RpcServerOptions {
  readonly transport: RpcTransport
  readonly handler: RpcRequestHandler
}
