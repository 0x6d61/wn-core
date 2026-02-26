import fs from 'node:fs'
import path from 'node:path'
import type { Result } from '../result.js'
import { ok, err } from '../result.js'
import type { AgentDef, LoaderError } from './types.js'
import { parseFrontmatter } from './frontmatter.js'

/**
 * NodeJS.ErrnoException 型ガード
 */
function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e
}

/**
 * attributes から文字列値を安全に取得する。
 * 値が string でなければ fallback を返す。
 */
function getString(
  attrs: Readonly<Record<string, string | readonly string[]>>,
  key: string,
  fallback: string,
): string {
  const val = attrs[key]
  return typeof val === 'string' ? val : fallback
}

/**
 * attributes から文字列配列を安全に取得する。
 * 値が配列でなければ空配列を返す。
 */
function getStringArray(
  attrs: Readonly<Record<string, string | readonly string[]>>,
  key: string,
): readonly string[] {
  const val = attrs[key]
  if (Array.isArray(val)) {
    const arr: readonly string[] = val
    return arr
  }
  return []
}

/**
 * 指定ディレクトリから .md ファイルを読み込み、AgentDef の Map を返す。
 * ディレクトリが存在しない場合（ENOENT）は空 Map を返す。
 */
async function loadAgentsFromDir(dir: string): Promise<Result<Map<string, AgentDef>, LoaderError>> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (e: unknown) {
    if (isNodeError(e) && e.code === 'ENOENT') {
      return ok(new Map<string, AgentDef>())
    }
    return err({
      code: 'IO_ERROR',
      message: isNodeError(e) ? e.message : 'Unknown IO error',
      path: dir,
    })
  }

  const agents = new Map<string, AgentDef>()

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.md')) continue

    const fileBaseName = path.basename(entry.name, '.md')
    const filePath = path.join(dir, entry.name)

    let content: string
    try {
      content = await fs.promises.readFile(filePath, 'utf-8')
    } catch (e: unknown) {
      return err({
        code: 'IO_ERROR',
        message: isNodeError(e) ? e.message : 'Failed to read file',
        path: filePath,
      })
    }

    const fmResult = parseFrontmatter(content)
    if (!fmResult.ok) {
      return fmResult
    }

    const { attributes, body } = fmResult.data
    const name = getString(attributes, 'name', fileBaseName)
    const persona = getString(attributes, 'persona', '')
    const skills = getStringArray(attributes, 'skills')
    const provider = getString(attributes, 'provider', '')
    const model = getString(attributes, 'model', '')
    const description = body

    agents.set(name, { name, persona, skills, provider, model, description })
  }

  return ok(agents)
}

/**
 * グローバルとローカルのエージェントディレクトリから .md ファイルを読み込み、
 * マージした AgentDef の Map を返す。
 * ローカル側の同名エージェントがグローバル側を上書きする。
 */
export async function loadAgents(
  globalDir: string,
  localDir: string,
): Promise<Result<Map<string, AgentDef>, LoaderError>> {
  const globalResult = await loadAgentsFromDir(path.join(globalDir, 'agents'))
  if (!globalResult.ok) {
    return globalResult
  }

  const localResult = await loadAgentsFromDir(path.join(localDir, 'agents'))
  if (!localResult.ok) {
    return localResult
  }

  // グローバルを基盤とし、ローカルで上書き
  const merged = new Map<string, AgentDef>(globalResult.data)
  for (const [name, agent] of localResult.data) {
    merged.set(name, agent)
  }

  return ok(merged)
}
