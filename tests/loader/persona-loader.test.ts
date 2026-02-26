import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadPersonas } from '../../src/loader/persona-loader.js'

describe('loadPersonas', () => {
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

  it('グローバルディレクトリから .md ファイルを読み込む', async () => {
    const personasDir = path.join(globalDir, 'personas')
    fs.mkdirSync(personasDir)
    fs.writeFileSync(path.join(personasDir, 'default.md'), 'You are a helpful assistant.', 'utf-8')

    const result = await loadPersonas(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(1)
      const persona = result.data.get('default')
      expect(persona).toBeDefined()
      expect(persona?.name).toBe('default')
      expect(persona?.content).toBe('You are a helpful assistant.')
    }
  })

  it('ファイル名（拡張子なし）を persona 名として使う', async () => {
    const personasDir = path.join(globalDir, 'personas')
    fs.mkdirSync(personasDir)
    fs.writeFileSync(path.join(personasDir, 'test-persona.md'), 'Test content', 'utf-8')

    const result = await loadPersonas(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      const persona = result.data.get('test-persona')
      expect(persona).toBeDefined()
      expect(persona?.name).toBe('test-persona')
    }
  })

  it('ファイル全文を content として使う', async () => {
    const personasDir = path.join(globalDir, 'personas')
    fs.mkdirSync(personasDir)
    const multiLineContent = 'Line 1\nLine 2\nLine 3'
    fs.writeFileSync(path.join(personasDir, 'multi.md'), multiLineContent, 'utf-8')

    const result = await loadPersonas(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      const persona = result.data.get('multi')
      expect(persona).toBeDefined()
      expect(persona?.content).toBe(multiLineContent)
    }
  })

  it('ローカルの persona がグローバルの同名 persona を上書きする', async () => {
    const globalPersonasDir = path.join(globalDir, 'personas')
    const localPersonasDir = path.join(localDir, 'personas')
    fs.mkdirSync(globalPersonasDir)
    fs.mkdirSync(localPersonasDir)
    fs.writeFileSync(path.join(globalPersonasDir, 'default.md'), 'Global content', 'utf-8')
    fs.writeFileSync(path.join(localPersonasDir, 'default.md'), 'Local content', 'utf-8')

    const result = await loadPersonas(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(1)
      const persona = result.data.get('default')
      expect(persona).toBeDefined()
      expect(persona?.content).toBe('Local content')
    }
  })

  it('異なる名前の persona は両方マージされる', async () => {
    const globalPersonasDir = path.join(globalDir, 'personas')
    const localPersonasDir = path.join(localDir, 'personas')
    fs.mkdirSync(globalPersonasDir)
    fs.mkdirSync(localPersonasDir)
    fs.writeFileSync(path.join(globalPersonasDir, 'a.md'), 'Content A', 'utf-8')
    fs.writeFileSync(path.join(localPersonasDir, 'b.md'), 'Content B', 'utf-8')

    const result = await loadPersonas(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(2)
      expect(result.data.get('a')?.content).toBe('Content A')
      expect(result.data.get('b')?.content).toBe('Content B')
    }
  })

  it('personas/ ディレクトリが存在しない場合に空 Map を返す', async () => {
    // globalDir と localDir には personas/ サブディレクトリを作成しない
    const result = await loadPersonas(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(0)
    }
  })

  it('.md 以外のファイルを無視する', async () => {
    const personasDir = path.join(globalDir, 'personas')
    fs.mkdirSync(personasDir)
    fs.writeFileSync(path.join(personasDir, 'valid.md'), 'Valid persona', 'utf-8')
    fs.writeFileSync(path.join(personasDir, 'notes.txt'), 'Not a persona', 'utf-8')

    const result = await loadPersonas(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(1)
      expect(result.data.has('valid')).toBe(true)
      expect(result.data.has('notes')).toBe(false)
    }
  })

  it('空のディレクトリに対して空 Map を返す', async () => {
    const personasDir = path.join(globalDir, 'personas')
    fs.mkdirSync(personasDir)
    // personas/ ディレクトリは存在するが中身は空

    const result = await loadPersonas(globalDir, localDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.size).toBe(0)
    }
  })
})
