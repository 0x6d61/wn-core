/**
 * JSON-RPC 2.0 プロトコルユーティリティ
 *
 * メッセージのエンコード / デコード / 型ガード関数を提供する。
 * Core ↔ TUI 間の stdin/stdout 通信で使用。
 */
import type { JsonRpcRequest, JsonRpcNotification, JsonRpcIncoming } from './types.js'
import { JSON_RPC_ERROR_CODES } from './types.js'
import type { Result } from '../result.js'
import { ok, err } from '../result.js'

// ─── 内部ヘルパー ───

/** 値が非 null のオブジェクトかどうかを判定する */
function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** id フィールドが JSON-RPC 2.0 で有効な型かどうかを判定する */
function isValidId(id: unknown): id is string | number {
  return typeof id === 'string' || typeof id === 'number'
}

// ─── 型ガード ───

/**
 * JSON-RPC 2.0 Request の型ガード
 *
 * jsonrpc === '2.0'、method が string、id が string | number であることを検証する。
 */
export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (!isNonNullObject(msg)) return false
  if (msg['jsonrpc'] !== '2.0') return false
  if (typeof msg['method'] !== 'string') return false
  if (!isValidId(msg['id'])) return false
  return true
}

/**
 * JSON-RPC 2.0 Notification の型ガード
 *
 * jsonrpc === '2.0'、method が string、id が存在しないことを検証する。
 */
export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  if (!isNonNullObject(msg)) return false
  if (msg['jsonrpc'] !== '2.0') return false
  if (typeof msg['method'] !== 'string') return false
  if ('id' in msg) return false
  return true
}

/**
 * JSON-RPC 2.0 Incoming (Request | Notification) の型ガード
 *
 * Request または Notification のいずれかであれば true を返す。
 * Response（result / error フィールドを持つもの）は false。
 */
export function isJsonRpcIncoming(msg: unknown): msg is JsonRpcIncoming {
  return isJsonRpcRequest(msg) || isJsonRpcNotification(msg)
}

// ─── デコード ───

/**
 * 1 行の文字列を JSON パースし、JsonRpcIncoming として検証する
 *
 * 不正な JSON や JSON-RPC でないメッセージは err で返す（例外はスローしない）。
 */
export function decodeJsonRpc(line: string): Result<JsonRpcIncoming> {
  if (line === '') {
    return err('Failed to parse JSON-RPC: empty input')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return err('Failed to parse JSON-RPC: invalid JSON')
  }

  if (!isJsonRpcIncoming(parsed)) {
    return err('Invalid JSON-RPC message: not a valid request or notification')
  }

  return ok(parsed)
}

// ─── エンコード ───

/**
 * JSON-RPC 2.0 Notification をエンコードする
 *
 * @returns 単一行の JSON 文字列（末尾改行なし）
 */
export function encodeNotification(method: string, params?: unknown): string {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', method }
  if (params !== undefined) {
    msg['params'] = params
  }
  return JSON.stringify(msg)
}

/**
 * JSON-RPC 2.0 成功レスポンスをエンコードする
 *
 * @returns 単一行の JSON 文字列（末尾改行なし）
 */
export function encodeSuccessResponse(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

/**
 * JSON-RPC 2.0 エラーレスポンスをエンコードする
 *
 * @returns 単一行の JSON 文字列（末尾改行なし）
 */
export function encodeErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): string {
  const errorObj: Record<string, unknown> = { code, message }
  if (data !== undefined) {
    errorObj['data'] = data
  }
  return JSON.stringify({ jsonrpc: '2.0', id, error: errorObj })
}

// ─── 便利関数（よくあるエラーの短縮形） ───

/**
 * Parse Error (-32700) レスポンスをエンコードする
 *
 * JSON パースに失敗した場合に使用。id は null。
 */
export function encodeParseError(data?: unknown): string {
  return encodeErrorResponse(null, JSON_RPC_ERROR_CODES.PARSE_ERROR, 'Parse error', data)
}

/**
 * Method Not Found (-32601) レスポンスをエンコードする
 *
 * メッセージにメソッド名を含める。
 */
export function encodeMethodNotFound(id: string | number, method: string): string {
  return encodeErrorResponse(
    id,
    JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
    `Method not found: ${method}`,
  )
}

/**
 * Internal Error (-32603) レスポンスをエンコードする
 */
export function encodeInternalError(id: string | number, message: string): string {
  return encodeErrorResponse(id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, message)
}
