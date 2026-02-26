/**
 * 共通 Result 型
 *
 * 例外スローの代わりに成功/失敗を型安全に表現する。
 * CLAUDE.md の Result パターンに準拠。
 */
export type Result<T, E = string> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: E }

/** 成功 Result を生成する */
export function ok<T>(data: T): Result<T, never> {
  return { ok: true, data }
}

/** 失敗 Result を生成する */
export function err<E = string>(error: E): Result<never, E> {
  return { ok: false, error }
}
