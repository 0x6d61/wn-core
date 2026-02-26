import type { ToolResult } from './types.js'

export function requireString(
  args: Record<string, unknown>,
  key: string,
): { value: string } | { error: ToolResult } {
  const val = args[key]
  if (typeof val !== 'string' || val.length === 0) {
    return {
      error: {
        ok: false,
        output: '',
        error: `Parameter '${key}' is required and must be a non-empty string`,
      },
    }
  }
  return { value: val }
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key]
  return typeof val === 'string' ? val : undefined
}

export function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  min?: number,
): { value: number | undefined } | { error: ToolResult } {
  const val = args[key]
  if (val === undefined || val === null) return { value: undefined }
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    return {
      error: { ok: false, output: '', error: `Parameter '${key}' must be a number` },
    }
  }
  if (min !== undefined && val < min) {
    return {
      error: { ok: false, output: '', error: `Parameter '${key}' must be >= ${String(min)}` },
    }
  }
  return { value: val }
}
