import fs from 'node:fs'
import path from 'node:path'
import type { Result } from '../result.js'
import { ok, err } from '../result.js'
import type { Skill, LoaderError } from './types.js'
import { parseFrontmatter } from './frontmatter.js'

/**
 * NodeJS.ErrnoException 型ガード
 */
function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e
}

/**
 * frontmatter の属性値を文字列として安全に取得する。
 * 値が string でなければ undefined を返す。
 */
function getStringAttr(
  attributes: Readonly<Record<string, string | readonly string[]>>,
  key: string,
): string | undefined {
  const value = attributes[key]
  if (typeof value === 'string') {
    return value
  }
  return undefined
}

/**
 * frontmatter の属性値を文字列配列として安全に取得する。
 * 値が readonly string[] であればそのまま返し、存在しなければ空配列を返す。
 */
function getStringArrayAttr(
  attributes: Readonly<Record<string, string | readonly string[]>>,
  key: string,
): readonly string[] {
  const value = attributes[key]
  if (Array.isArray(value)) {
    return value as readonly string[]
  }
  return []
}

/**
 * 指定ディレクトリ内のスキルサブディレクトリから SKILL.md を読み込み、
 * Skill の Map を返す。
 * ディレクトリが存在しない場合（ENOENT）は空 Map を返す。
 */
async function loadSkillsFromDir(dir: string): Promise<Result<Map<string, Skill>, LoaderError>> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (e: unknown) {
    if (isNodeError(e) && e.code === 'ENOENT') {
      return ok(new Map<string, Skill>())
    }
    return err({
      code: 'IO_ERROR',
      message: isNodeError(e) ? e.message : 'Unknown IO error',
      path: dir,
    })
  }

  const skills = new Map<string, Skill>()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const dirName = entry.name
    const skillFilePath = path.join(dir, dirName, 'SKILL.md')

    // SKILL.md が存在しないディレクトリはスキップ
    let rawContent: string
    try {
      rawContent = await fs.promises.readFile(skillFilePath, 'utf-8')
    } catch (e: unknown) {
      if (isNodeError(e) && e.code === 'ENOENT') {
        continue
      }
      return err({
        code: 'IO_ERROR',
        message: isNodeError(e) ? e.message : 'Failed to read file',
        path: skillFilePath,
      })
    }

    // frontmatter をパース
    const parseResult = parseFrontmatter(rawContent)
    if (!parseResult.ok) {
      return parseResult
    }

    const { attributes, body } = parseResult.data

    // name: frontmatter に指定があればそれを使い、なければディレクトリ名をフォールバック
    const name = getStringAttr(attributes, 'name') ?? dirName

    // description: 必須フィールド
    const description = getStringAttr(attributes, 'description')
    if (description === undefined || description === '') {
      return err({
        code: 'VALIDATION_ERROR',
        message: `Skill "${name}" is missing required field: description`,
        path: skillFilePath,
      })
    }

    // tools: オプション、デフォルトは空配列
    const tools = getStringArrayAttr(attributes, 'tools')

    skills.set(name, { name, description, tools, body })
  }

  return ok(skills)
}

/**
 * グローバルとローカルのスキルディレクトリから SKILL.md を読み込み、
 * マージした Skill の Map を返す。
 * ローカル側の同名スキルがグローバル側を上書きする。
 */
export async function loadSkills(
  globalDir: string,
  localDir: string,
): Promise<Result<Map<string, Skill>, LoaderError>> {
  const globalResult = await loadSkillsFromDir(path.join(globalDir, 'skills'))
  if (!globalResult.ok) {
    return globalResult
  }

  const localResult = await loadSkillsFromDir(path.join(localDir, 'skills'))
  if (!localResult.ok) {
    return localResult
  }

  // グローバルを基盤とし、ローカルで上書き
  const merged = new Map<string, Skill>(globalResult.data)
  for (const [name, skill] of localResult.data) {
    merged.set(name, skill)
  }

  return ok(merged)
}
