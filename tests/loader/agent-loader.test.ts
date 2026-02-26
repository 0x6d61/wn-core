import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadAgents } from '../../src/loader/agent-loader.js'

describe('loadAgents', () => {
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

  it('エージェント定義の frontmatter から全フィールドを抽出する', async () => {
    const agentsDir = path.join(globalDir, 'agents')
    fs.mkdirSync(agentsDir)
    fs.writeFileSync(
      path.join(agentsDir, 'reviewer.md'),
      [
        '---',
        'name: reviewer',
        'persona: code-reviewer',
        'skills: [read, grep]',
        'provider: claude',
        'model: claude-sonnet-4-20250514',
        '---',
        'コードレビューを行うサブエージェントです。',
      ].join('\n'),
      'utf-8',
    )

    const result = await loadAgents(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(1)
      const agent = result.data.get('reviewer')
      expect(agent).toBeDefined()
      expect(agent?.name).toBe('reviewer')
      expect(agent?.persona).toBe('code-reviewer')
      expect(agent?.skills).toEqual(['read', 'grep'])
      expect(agent?.provider).toBe('claude')
      expect(agent?.model).toBe('claude-sonnet-4-20250514')
      expect(agent?.description).toBe('コードレビューを行うサブエージェントです。')
    }
  })

  it('ボディを description として取得する', async () => {
    const agentsDir = path.join(globalDir, 'agents')
    fs.mkdirSync(agentsDir)
    fs.writeFileSync(
      path.join(agentsDir, 'helper.md'),
      [
        '---',
        'name: helper',
        '---',
        'これはヘルパーエージェントです。',
        '複数行の説明も可能です。',
      ].join('\n'),
      'utf-8',
    )

    const result = await loadAgents(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      const agent = result.data.get('helper')
      expect(agent).toBeDefined()
      expect(agent?.description).toBe('これはヘルパーエージェントです。\n複数行の説明も可能です。')
    }
  })

  it('ローカルのエージェントがグローバルの同名エージェントを上書きする', async () => {
    const globalAgentsDir = path.join(globalDir, 'agents')
    const localAgentsDir = path.join(localDir, 'agents')
    fs.mkdirSync(globalAgentsDir)
    fs.mkdirSync(localAgentsDir)
    fs.writeFileSync(
      path.join(globalAgentsDir, 'reviewer.md'),
      ['---', 'name: reviewer', 'provider: openai', '---', 'Global reviewer'].join('\n'),
      'utf-8',
    )
    fs.writeFileSync(
      path.join(localAgentsDir, 'reviewer.md'),
      ['---', 'name: reviewer', 'provider: claude', '---', 'Local reviewer'].join('\n'),
      'utf-8',
    )

    const result = await loadAgents(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(1)
      const agent = result.data.get('reviewer')
      expect(agent).toBeDefined()
      expect(agent?.provider).toBe('claude')
      expect(agent?.description).toBe('Local reviewer')
    }
  })

  it('異なる名前のエージェントは両方マージされる', async () => {
    const globalAgentsDir = path.join(globalDir, 'agents')
    const localAgentsDir = path.join(localDir, 'agents')
    fs.mkdirSync(globalAgentsDir)
    fs.mkdirSync(localAgentsDir)
    fs.writeFileSync(
      path.join(globalAgentsDir, 'a.md'),
      ['---', 'name: a', '---', 'Agent A'].join('\n'),
      'utf-8',
    )
    fs.writeFileSync(
      path.join(localAgentsDir, 'b.md'),
      ['---', 'name: b', '---', 'Agent B'].join('\n'),
      'utf-8',
    )

    const result = await loadAgents(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(2)
      expect(result.data.get('a')?.description).toBe('Agent A')
      expect(result.data.get('b')?.description).toBe('Agent B')
    }
  })

  it('agents/ ディレクトリが存在しない場合に空 Map を返す', async () => {
    // globalDir と localDir には agents/ サブディレクトリを作成しない
    const result = await loadAgents(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(0)
    }
  })

  it('name が frontmatter にない場合、ファイル名をフォールバックする', async () => {
    const agentsDir = path.join(globalDir, 'agents')
    fs.mkdirSync(agentsDir)
    fs.writeFileSync(
      path.join(agentsDir, 'fallback.md'),
      ['---', 'persona: default', '---', 'No name in frontmatter'].join('\n'),
      'utf-8',
    )

    const result = await loadAgents(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      const agent = result.data.get('fallback')
      expect(agent).toBeDefined()
      expect(agent?.name).toBe('fallback')
      expect(agent?.persona).toBe('default')
    }
  })

  it('.md 以外のファイルを無視する', async () => {
    const agentsDir = path.join(globalDir, 'agents')
    fs.mkdirSync(agentsDir)
    fs.writeFileSync(
      path.join(agentsDir, 'valid.md'),
      ['---', 'name: valid', '---', 'Valid agent'].join('\n'),
      'utf-8',
    )
    fs.writeFileSync(path.join(agentsDir, 'notes.txt'), 'Not an agent', 'utf-8')

    const result = await loadAgents(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(1)
      expect(result.data.has('valid')).toBe(true)
      expect(result.data.has('notes')).toBe(false)
    }
  })
})
