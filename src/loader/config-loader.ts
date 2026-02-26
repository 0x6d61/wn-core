import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Result } from '../result.js'
import { ok, err } from '../result.js'
import type { WnConfig, ProviderConfig, McpConfig, McpServerConfig, LoaderError } from './types.js'

const DEFAULT_PROVIDER = 'claude'
const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_PERSONA = 'default'

/**
 * Node.js のファイルシステムエラーかどうかを判定する型ガード
 */
function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e
}

/**
 * 値がプレーンオブジェクト（Record<string, unknown>）かどうかを判定する型ガード
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * JSON ファイルを読み込み、パース結果を返す。
 * ファイルが存在しない場合 (ENOENT) は空オブジェクトを返す。
 * パースエラーの場合は LoaderError を返す。
 */
async function readJsonFile(
  filePath: string,
): Promise<Result<Record<string, unknown>, LoaderError>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const parsed: unknown = JSON.parse(content)
    if (!isPlainObject(parsed)) {
      return err({
        code: 'PARSE_ERROR',
        message: `config.json must be a JSON object: ${filePath}`,
        path: filePath,
      })
    }
    return ok(parsed)
  } catch (e: unknown) {
    if (isNodeError(e) && e.code === 'ENOENT') {
      return ok({})
    }
    if (e instanceof SyntaxError) {
      return err({
        code: 'PARSE_ERROR',
        message: `Invalid JSON in ${filePath}: ${e.message}`,
        path: filePath,
      })
    }
    if (isNodeError(e)) {
      return err({
        code: 'IO_ERROR',
        message: `Failed to read ${filePath}: ${e.message}`,
        path: filePath,
      })
    }
    return err({
      code: 'IO_ERROR',
      message: `Failed to read ${filePath}: unknown error`,
      path: filePath,
    })
  }
}

/**
 * 2 つのオブジェクトを再帰的にディープマージする。
 * 配列は上書き（マージしない）。オブジェクトは再帰的にマージ。
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }

  for (const key of Object.keys(override)) {
    const baseVal = base[key]
    const overrideVal = override[key]

    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMerge(baseVal, overrideVal)
    } else {
      result[key] = overrideVal
    }
  }

  return result
}

/**
 * オブジェクト内の全文字列値に対して ${VAR_NAME} パターンを
 * process.env の値で置換する。未定義の環境変数は元の文字列のまま残す。
 */
function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      const envValue = process.env[varName]
      return envValue !== undefined ? envValue : _match
    })
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => substituteEnvVars(item))
  }

  if (isPlainObject(obj)) {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(obj)) {
      result[key] = substituteEnvVars(obj[key])
    }
    return result
  }

  // number, boolean, null など — そのまま返す
  return obj
}

/**
 * unknown 値が ProviderConfig の形状かどうかを判定する型ガード
 */
function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!isPlainObject(value)) return false
  if ('apiKey' in value && typeof value['apiKey'] !== 'string') return false
  if ('baseUrl' in value && typeof value['baseUrl'] !== 'string') return false
  return true
}

/**
 * unknown 値が McpServerConfig の形状かどうかを判定する型ガード
 */
function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!isPlainObject(value)) return false
  if (typeof value['name'] !== 'string') return false
  if (typeof value['command'] !== 'string') return false
  if (!Array.isArray(value['args'])) return false
  return value['args'].every((a) => typeof a === 'string')
}

/**
 * unknown 値が McpConfig の形状かどうかを判定する型ガード
 */
function isMcpConfig(value: unknown): value is McpConfig {
  if (!isPlainObject(value)) return false
  if (!Array.isArray(value['servers'])) return false
  return value['servers'].every((s) => isMcpServerConfig(s))
}

/**
 * unknown な providers オブジェクトを WnConfig['providers'] に安全に変換する
 */
function toProviders(value: unknown): WnConfig['providers'] {
  if (!isPlainObject(value)) return {}
  const result: Record<string, ProviderConfig> = {}
  for (const key of Object.keys(value)) {
    const entry = value[key]
    if (isProviderConfig(entry)) {
      result[key] = entry
    }
  }
  return result
}

/**
 * 設定ファイルを読み込み、マージし、環境変数を置換して WnConfig を返す。
 *
 * 優先順位: CLI オーバーライド > ローカル config.json > グローバル config.json > デフォルト値
 */
export async function loadConfig(
  globalDir: string,
  localDir: string,
  cliOverrides?: Partial<Pick<WnConfig, 'defaultProvider' | 'defaultModel' | 'defaultPersona'>>,
): Promise<Result<WnConfig, LoaderError>> {
  // 1. グローバル config.json を読み込む
  const globalResult = await readJsonFile(path.join(globalDir, 'config.json'))
  if (!globalResult.ok) {
    return globalResult
  }

  // 2. ローカル config.json を読み込む
  const localResult = await readJsonFile(path.join(localDir, 'config.json'))
  if (!localResult.ok) {
    return localResult
  }

  // 3. ディープマージ: グローバル ← ローカル
  let merged = deepMerge(globalResult.data, localResult.data)

  // 4. CLI オーバーライドを適用（undefined でないもののみ）
  if (cliOverrides) {
    if (cliOverrides.defaultProvider !== undefined) {
      merged = { ...merged, defaultProvider: cliOverrides.defaultProvider }
    }
    if (cliOverrides.defaultModel !== undefined) {
      merged = { ...merged, defaultModel: cliOverrides.defaultModel }
    }
    if (cliOverrides.defaultPersona !== undefined) {
      merged = { ...merged, defaultPersona: cliOverrides.defaultPersona }
    }
  }

  // 5. 環境変数を置換
  const substituted = substituteEnvVars(merged)

  if (!isPlainObject(substituted)) {
    return err({
      code: 'PARSE_ERROR',
      message: 'Unexpected: substituted config is not an object',
    })
  }

  // 6. デフォルト値を適用
  const config: WnConfig = {
    defaultProvider:
      typeof substituted['defaultProvider'] === 'string'
        ? substituted['defaultProvider']
        : DEFAULT_PROVIDER,
    defaultModel:
      typeof substituted['defaultModel'] === 'string' ? substituted['defaultModel'] : DEFAULT_MODEL,
    defaultPersona:
      typeof substituted['defaultPersona'] === 'string'
        ? substituted['defaultPersona']
        : DEFAULT_PERSONA,
    providers: toProviders(substituted['providers']),
    ...(isMcpConfig(substituted['mcp']) ? { mcp: substituted['mcp'] } : {}),
  }

  return ok(config)
}
