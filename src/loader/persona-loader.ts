import fs from 'node:fs'
import path from 'node:path'
import type { Result } from '../result.js'
import { ok, err } from '../result.js'
import type { Persona, LoaderError } from './types.js'

/**
 * NodeJS.ErrnoException 型ガード
 */
function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e
}

/**
 * 指定ディレクトリから .md ファイルを読み込み、Persona の Map を返す。
 * ディレクトリが存在しない場合（ENOENT）は空 Map を返す。
 */
async function loadPersonasFromDir(
  dir: string,
): Promise<Result<Map<string, Persona>, LoaderError>> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (e: unknown) {
    if (isNodeError(e) && e.code === 'ENOENT') {
      return ok(new Map<string, Persona>())
    }
    return err({
      code: 'IO_ERROR',
      message: isNodeError(e) ? e.message : 'Unknown IO error',
      path: dir,
    })
  }

  const personas = new Map<string, Persona>()

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.md')) continue

    const name = path.basename(entry.name, '.md')
    const filePath = path.join(dir, entry.name)

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8')
      personas.set(name, { name, content })
    } catch (e: unknown) {
      return err({
        code: 'IO_ERROR',
        message: isNodeError(e) ? e.message : 'Failed to read file',
        path: filePath,
      })
    }
  }

  return ok(personas)
}

/**
 * グローバルとローカルのペルソナディレクトリから .md ファイルを読み込み、
 * マージした Persona の Map を返す。
 * ローカル側の同名ペルソナがグローバル側を上書きする。
 */
export async function loadPersonas(
  globalDir: string,
  localDir: string,
): Promise<Result<Map<string, Persona>, LoaderError>> {
  const globalResult = await loadPersonasFromDir(path.join(globalDir, 'personas'))
  if (!globalResult.ok) {
    return globalResult
  }

  const localResult = await loadPersonasFromDir(path.join(localDir, 'personas'))
  if (!localResult.ok) {
    return localResult
  }

  // グローバルを基盤とし、ローカルで上書き
  const merged = new Map<string, Persona>(globalResult.data)
  for (const [name, persona] of localResult.data) {
    merged.set(name, persona)
  }

  return ok(merged)
}
