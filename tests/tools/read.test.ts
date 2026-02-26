import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createReadTool } from '../../src/tools/read.js'
import type { ToolDefinition } from '../../src/tools/types.js'

describe('createReadTool', () => {
  let tmpDir: string
  const originalCwd = process.cwd()

  function setup(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-read-test-'))
    return dir
  }

  afterEach(() => {
    process.chdir(originalCwd)
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ファイルの内容を読み取れる', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'hello.txt')
    fs.writeFileSync(filePath, 'Hello\nWorld\n', 'utf-8')

    const tool = createReadTool()
    const result = await tool.execute({ path: filePath })

    expect(result.ok).toBe(true)
    expect(result.output).toContain('Hello')
    expect(result.output).toContain('World')
  })

  it('存在しないファイルに対してエラーを返す', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'nonexistent.txt')

    const tool = createReadTool()
    const result = await tool.execute({ path: filePath })

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('offset を指定して途中から読み取れる', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'lines.txt')
    fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5\n', 'utf-8')

    const tool = createReadTool()
    // offset=3 means start from line 3 (1-based)
    const result = await tool.execute({ path: filePath, offset: 3 })

    expect(result.ok).toBe(true)
    expect(result.output).not.toContain('line1')
    expect(result.output).not.toContain('line2')
    expect(result.output).toContain('line3')
    expect(result.output).toContain('line4')
    expect(result.output).toContain('line5')
  })

  it('limit を指定して行数を制限できる', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'lines.txt')
    fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5\n', 'utf-8')

    const tool = createReadTool()
    const result = await tool.execute({ path: filePath, limit: 2 })

    expect(result.ok).toBe(true)
    expect(result.output).toContain('line1')
    expect(result.output).toContain('line2')
    expect(result.output).not.toContain('line3')
  })

  it('offset と limit を組み合わせて使える', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'lines.txt')
    fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5\n', 'utf-8')

    const tool = createReadTool()
    // offset=2 (start from line 2), limit=2 (read 2 lines) → line2, line3
    const result = await tool.execute({ path: filePath, offset: 2, limit: 2 })

    expect(result.ok).toBe(true)
    expect(result.output).not.toContain('line1')
    expect(result.output).toContain('line2')
    expect(result.output).toContain('line3')
    expect(result.output).not.toContain('line4')
  })

  it('空ファイルを読み取ると空文字列を返す', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'empty.txt')
    fs.writeFileSync(filePath, '', 'utf-8')

    const tool = createReadTool()
    const result = await tool.execute({ path: filePath })

    expect(result.ok).toBe(true)
    expect(result.output).toBe('')
  })

  it('ディレクトリを指定するとエラーを返す', async () => {
    tmpDir = setup()

    const tool = createReadTool()
    const result = await tool.execute({ path: tmpDir })

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('path パラメータが不足するとバリデーションエラーを返す', async () => {
    const tool = createReadTool()
    const result = await tool.execute({})

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('path')
  })

  it('相対パスが正しく解決される', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'relative.txt')
    fs.writeFileSync(filePath, 'relative content\n', 'utf-8')

    process.chdir(tmpDir)

    const tool = createReadTool()
    const result = await tool.execute({ path: 'relative.txt' })

    expect(result.ok).toBe(true)
    expect(result.output).toContain('relative content')
  })

  it('ToolDefinition インターフェースに準拠している', () => {
    const tool: ToolDefinition = createReadTool()

    expect(tool.name).toBe('read')
    expect(tool.description).toBeDefined()
    expect(tool.description.length).toBeGreaterThan(0)
    expect(tool.parameters).toBeDefined()
    expect(tool.parameters).toHaveProperty('required')
    expect(typeof tool.execute).toBe('function')
  })
})
