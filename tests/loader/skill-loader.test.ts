import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSkills } from '../../src/loader/skill-loader.js'

describe('loadSkills', () => {
  let globalDir: string
  let localDir: string

  beforeEach(() => {
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-global-'))
    localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-local-'))
  })

  afterEach(() => {
    fs.rmSync(globalDir, { recursive: true, force: true })
    fs.rmSync(localDir, { recursive: true, force: true })
  })

  it('SKILL.md の frontmatter から name, description, tools を抽出する', async () => {
    const skillDir = path.join(globalDir, 'skills', 'my-skill')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: A test skill\ntools: [shell, read]\n---\n# Steps\n1. Do something\n',
      'utf-8',
    )

    const result = await loadSkills(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(1)
      const skill = result.data.get('my-skill')
      expect(skill).toBeDefined()
      expect(skill?.name).toBe('my-skill')
      expect(skill?.description).toBe('A test skill')
      expect(skill?.tools).toEqual(['shell', 'read'])
      expect(skill?.body).toContain('# Steps')
    }
  })

  it('SKILL.md のボディを body として取得する', async () => {
    const skillDir = path.join(globalDir, 'skills', 'body-test')
    fs.mkdirSync(skillDir, { recursive: true })
    const multiLineBody = '# Title\n\nParagraph one.\n\nParagraph two.\n'
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: body-test\ndescription: Body test skill\n---\n${multiLineBody}`,
      'utf-8',
    )

    const result = await loadSkills(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      const skill = result.data.get('body-test')
      expect(skill).toBeDefined()
      expect(skill?.body).toBe(multiLineBody)
    }
  })

  it('ローカルのスキルがグローバルの同名スキルを上書きする', async () => {
    const globalSkillDir = path.join(globalDir, 'skills', 'my-skill')
    const localSkillDir = path.join(localDir, 'skills', 'my-skill')
    fs.mkdirSync(globalSkillDir, { recursive: true })
    fs.mkdirSync(localSkillDir, { recursive: true })
    fs.writeFileSync(
      path.join(globalSkillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: Global version\n---\nGlobal body\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(localSkillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: Local version\n---\nLocal body\n',
      'utf-8',
    )

    const result = await loadSkills(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(1)
      const skill = result.data.get('my-skill')
      expect(skill).toBeDefined()
      expect(skill?.description).toBe('Local version')
      expect(skill?.body).toBe('Local body\n')
    }
  })

  it('異なる名前のスキルは両方マージされる', async () => {
    const globalSkillDir = path.join(globalDir, 'skills', 'skill-a')
    const localSkillDir = path.join(localDir, 'skills', 'skill-b')
    fs.mkdirSync(globalSkillDir, { recursive: true })
    fs.mkdirSync(localSkillDir, { recursive: true })
    fs.writeFileSync(
      path.join(globalSkillDir, 'SKILL.md'),
      '---\nname: skill-a\ndescription: Skill A\n---\nBody A\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(localSkillDir, 'SKILL.md'),
      '---\nname: skill-b\ndescription: Skill B\n---\nBody B\n',
      'utf-8',
    )

    const result = await loadSkills(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(2)
      expect(result.data.get('skill-a')?.description).toBe('Skill A')
      expect(result.data.get('skill-b')?.description).toBe('Skill B')
    }
  })

  it('skills/ ディレクトリが存在しない場合に空 Map を返す', async () => {
    // globalDir と localDir には skills/ サブディレクトリを作成しない
    const result = await loadSkills(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(0)
    }
  })

  it('name が frontmatter にない場合、ディレクトリ名をフォールバックする', async () => {
    const skillDir = path.join(globalDir, 'skills', 'fallback-name')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\ndescription: No name field\n---\nSome body\n',
      'utf-8',
    )

    const result = await loadSkills(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(1)
      const skill = result.data.get('fallback-name')
      expect(skill).toBeDefined()
      expect(skill?.name).toBe('fallback-name')
    }
  })

  it('description が未指定の場合にバリデーションエラーを返す', async () => {
    const skillDir = path.join(globalDir, 'skills', 'no-desc')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: no-desc\n---\nSome body\n',
      'utf-8',
    )

    const result = await loadSkills(globalDir, localDir)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('SKILL.md が存在しないディレクトリを無視する', async () => {
    const emptyDir = path.join(globalDir, 'skills', 'empty-dir')
    const validDir = path.join(globalDir, 'skills', 'valid-skill')
    fs.mkdirSync(emptyDir, { recursive: true })
    fs.mkdirSync(validDir, { recursive: true })
    // empty-dir には SKILL.md を配置しない
    fs.writeFileSync(
      path.join(validDir, 'SKILL.md'),
      '---\nname: valid-skill\ndescription: A valid skill\n---\nBody\n',
      'utf-8',
    )

    const result = await loadSkills(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(1)
      expect(result.data.has('valid-skill')).toBe(true)
      expect(result.data.has('empty-dir')).toBe(false)
    }
  })
})
