import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ToolDefinition, ToolResult } from './types.js'
import { requireString, optionalString } from './validate.js'

/** grep 出力の最大行数 */
const MAX_RESULTS = 1000

/** バイナリ判定のために読み取るバイト数 */
const BINARY_CHECK_BYTES = 8192

/** 正規表現パターンの最大長（ReDoS 緩和策） */
const MAX_PATTERN_LENGTH = 1000

/** glob パターンの最大長（ReDoS 緩和策） */
const MAX_GLOB_LENGTH = 500

/**
 * glob パターンを正規表現に変換する
 *
 * 入力は globToRegex 呼び出し前に長さチェック済み。
 * 変換処理は全メタ文字をエスケープした上で `*`, `?`, `**` のみを
 * 限定的な正規表現パーツに置換するため、生成される正規表現は
 * catastrophic backtracking を引き起こすパターンにはならない。
 *
 * サポートするワイルドカード:
 * - `**` → 任意のパス（`.*`）
 * - `*`  → ディレクトリ区切り以外の任意文字列
 * - `?`  → ディレクトリ区切り以外の任意1文字
 */
function globToRegex(glob: string): RegExp {
  // Step 1: 全メタ文字をエスケープ（*, ? 以外の正規表現特殊文字を無害化）
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0GLOBSTAR\0')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .replace(/\0GLOBSTAR\0/g, '.*')
  // nosemgrep: detect-non-literal-regexp -- glob は長さ制限 + エスケープ済みで安全
  return new RegExp(`^${escaped}$`)
}

/**
 * ファイルがバイナリかどうかを判定する
 *
 * 先頭の BINARY_CHECK_BYTES バイトにヌルバイトが含まれていればバイナリと判定する。
 */
async function isBinaryFile(filePath: string): Promise<boolean> {
  let fd: fs.promises.FileHandle | undefined
  try {
    fd = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(BINARY_CHECK_BYTES)
    const { bytesRead } = await fd.read(buf, 0, BINARY_CHECK_BYTES, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true
    }
    return false
  } finally {
    if (fd) await fd.close()
  }
}

/**
 * 1ファイルを検索し、マッチ行を results に追加する
 */
async function searchFile(
  filePath: string,
  regex: RegExp,
  results: string[],
  basePath: string,
): Promise<void> {
  if (results.length >= MAX_RESULTS) return

  const binary = await isBinaryFile(filePath)
  if (binary) return

  const content = await fs.promises.readFile(filePath, 'utf-8')
  const lines = content.split('\n')

  // 末尾の空行を除去（改行で終わるファイル対策）
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  const relativePath = path.relative(basePath, filePath)

  for (let i = 0; i < lines.length; i++) {
    if (results.length >= MAX_RESULTS) break
    const line = lines[i]
    if (line !== undefined && regex.test(line)) {
      results.push(`${relativePath}:${String(i + 1)}:${line}`)
    }
  }
}

/**
 * ユーザー入力の正規表現パターンを安全にコンパイルする
 *
 * ReDoS 緩和策:
 * - パターン長を MAX_PATTERN_LENGTH に制限
 * - 無効な正規表現は try/catch で捕捉
 *
 * このツールは LLM エージェントが使用するビルトインツールであり、
 * エンドユーザーの Web 入力を直接受け取るものではない。
 * LLM が生成するパターンは一般的に短く単純であるため、
 * 長さ制限で十分な緩和策となる。
 */
function compilePattern(pattern: string): RegExp | ToolResult {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      output: '',
      error: `Pattern too long (max ${String(MAX_PATTERN_LENGTH)} characters)`,
    }
  }
  try {
    // nosemgrep: detect-non-literal-regexp -- grep ツールの本質的機能。長さ制限で ReDoS を緩和。
    return new RegExp(pattern)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, output: '', error: `Invalid regex pattern: ${msg}` }
  }
}

/** RegExp かどうかを判定する型ガード */
function isRegExp(value: RegExp | ToolResult): value is RegExp {
  return value instanceof RegExp
}

/**
 * Dirent から親ディレクトリパスを取得する
 *
 * Node.js 20+ では parentPath プロパティが存在する。
 * それ以前のバージョンでは fallback を返す。
 * `as` キャスト禁止のため、Object.getOwnPropertyDescriptor で安全にアクセスする。
 */
function getDirentParentPath(entry: fs.Dirent, fallback: string): string {
  // parentPath は Node.js 20.12+ / 21.4+ で追加
  const desc = Object.getOwnPropertyDescriptor(entry, 'parentPath')
  if (desc !== undefined && typeof desc.value === 'string') {
    return desc.value
  }
  // 古い Node.js では entry.path にディレクトリパスが入っていた
  const pathDesc = Object.getOwnPropertyDescriptor(entry, 'path')
  if (pathDesc !== undefined && typeof pathDesc.value === 'string') {
    return pathDesc.value
  }
  return fallback
}

/** grep ビルトインツールを生成する */
export function createGrepTool(): ToolDefinition {
  return {
    name: 'grep',
    description:
      'Search for a regex pattern in files. Supports recursive directory search and glob filtering.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression pattern to search for',
        },
        path: {
          type: 'string',
          description: 'File or directory path to search in (absolute or relative)',
        },
        glob: {
          type: 'string',
          description: 'Optional glob pattern to filter files (e.g. "*.ts")',
        },
      },
      required: ['pattern', 'path'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      // --- validate pattern ---
      const patternResult = requireString(args, 'pattern')
      if ('error' in patternResult) return patternResult.error

      // --- validate path ---
      const pathResult = requireString(args, 'path')
      if ('error' in pathResult) return pathResult.error

      // --- validate glob (optional) ---
      const globPattern = optionalString(args, 'glob')

      // --- compile regex with safety checks ---
      const regexOrError = compilePattern(patternResult.value)
      if (!isRegExp(regexOrError)) return regexOrError
      const regex = regexOrError

      const resolvedPath = path.resolve(pathResult.value)

      try {
        const stat = await fs.promises.stat(resolvedPath)
        const results: string[] = []

        if (stat.isFile()) {
          // 単一ファイル検索
          const basePath = path.dirname(resolvedPath)
          await searchFile(resolvedPath, regex, results, basePath)
        } else if (stat.isDirectory()) {
          // ディレクトリ再帰検索
          let globRegex: RegExp | undefined
          if (globPattern !== undefined) {
            if (globPattern.length > MAX_GLOB_LENGTH) {
              return {
                ok: false,
                output: '',
                error: `Glob pattern too long (max ${String(MAX_GLOB_LENGTH)} characters)`,
              }
            }
            globRegex = globToRegex(globPattern)
          }

          const entries = await fs.promises.readdir(resolvedPath, {
            recursive: true,
            withFileTypes: true,
          })

          for (const entry of entries) {
            if (!entry.isFile()) continue

            // glob フィルタ
            if (globRegex !== undefined && !globRegex.test(entry.name)) continue

            // Node.js 20+ では parentPath が利用可能
            // それ以前のバージョンではフォールバックとして resolvedPath を使う
            const parentDir = getDirentParentPath(entry, resolvedPath)
            const fullPath = path.join(parentDir, entry.name)

            await searchFile(fullPath, regex, results, resolvedPath)

            if (results.length >= MAX_RESULTS) break
          }
        } else {
          return {
            ok: false,
            output: '',
            error: `Path is neither a file nor a directory: ${resolvedPath}`,
          }
        }

        return { ok: true, output: results.join('\n') }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return { ok: false, output: '', error: msg }
      }
    },
  }
}
