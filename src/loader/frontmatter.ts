import type { Result } from '../result.js'
import { ok, err } from '../result.js'
import type { FrontmatterResult, LoaderError } from './types.js'

const LINE_REGEX = /^(\w[\w-]*)\s*:\s*(.*)$/
const ARRAY_REGEX = /^\[([^\]]*)\]$/

/**
 * Markdown frontmatter をパースする
 *
 * `---` デリミタで囲まれた YAML-like なキー・値ペアを抽出し、
 * 残りをボディ文字列として返す。
 */
export function parseFrontmatter(raw: string): Result<FrontmatterResult, LoaderError> {
  // Normalize CRLF to LF
  const content = raw.replace(/\r\n/g, '\n')
  const lines = content.split('\n')

  // Check for opening delimiter
  if (lines[0] !== '---') {
    return ok({ attributes: {}, body: content })
  }

  // Find closing delimiter
  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endIndex = i
      break
    }
  }

  if (endIndex === -1) {
    return err({
      code: 'PARSE_ERROR',
      message: 'Frontmatter opening delimiter found but no closing delimiter',
    })
  }

  // Parse YAML lines
  const attributes: Record<string, string | readonly string[]> = {}
  for (let i = 1; i < endIndex; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const match = LINE_REGEX.exec(trimmed)
    if (match === null) continue

    const key = match[1]
    const rawVal = match[2]
    if (key === undefined || rawVal === undefined) continue

    const val = rawVal.trim()
    const arrayMatch = ARRAY_REGEX.exec(val)
    if (arrayMatch !== null) {
      const inner = arrayMatch[1]
      if (inner === undefined || inner.trim() === '') {
        attributes[key] = []
      } else {
        attributes[key] = inner
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      }
    } else {
      attributes[key] = val
    }
  }

  // Body: everything after the closing delimiter, strip leading newline
  const bodyLines = lines.slice(endIndex + 1)
  const body = bodyLines.join('\n').replace(/^\n/, '')

  return ok({ attributes, body })
}
