import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWriteTool } from '../../src/tools/write.js'

describe('createWriteTool', () => {
  let tmpDir: string

  // 各テスト前に一時ディレクトリを作成
  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-write-test-'))
    return tmpDir
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ファイルに内容を書き込める', async () => {
    const dir = makeTmpDir()
    const tool = createWriteTool()
    const filePath = path.join(dir, 'hello.txt')

    const result = await tool.execute({ path: filePath, content: 'Hello, World!' })

    expect(result.ok).toBe(true)
    const written = fs.readFileSync(filePath, 'utf-8')
    expect(written).toBe('Hello, World!')
  })

  it('既存ファイルを上書きできる', async () => {
    const dir = makeTmpDir()
    const tool = createWriteTool()
    const filePath = path.join(dir, 'overwrite.txt')

    await tool.execute({ path: filePath, content: 'first' })
    await tool.execute({ path: filePath, content: 'second' })

    const written = fs.readFileSync(filePath, 'utf-8')
    expect(written).toBe('second')
  })

  it('存在しない親ディレクトリを自動作成する', async () => {
    const dir = makeTmpDir()
    const tool = createWriteTool()
    const filePath = path.join(dir, 'nested', 'deep', 'file.txt')

    const result = await tool.execute({ path: filePath, content: 'nested content' })

    expect(result.ok).toBe(true)
    const written = fs.readFileSync(filePath, 'utf-8')
    expect(written).toBe('nested content')
  })

  it('空文字列を書き込める', async () => {
    const dir = makeTmpDir()
    const tool = createWriteTool()
    const filePath = path.join(dir, 'empty.txt')

    const result = await tool.execute({ path: filePath, content: '' })

    expect(result.ok).toBe(true)
    expect(fs.existsSync(filePath)).toBe(true)
    const written = fs.readFileSync(filePath, 'utf-8')
    expect(written).toBe('')
  })

  it('path パラメータが不足するとバリデーションエラーを返す', async () => {
    const tool = createWriteTool()

    const result = await tool.execute({ content: 'x' })

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('content パラメータが不足するとバリデーションエラーを返す', async () => {
    const tool = createWriteTool()

    const result = await tool.execute({ path: '/tmp/x' })

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('出力メッセージにバイト数とパスが含まれる', async () => {
    const dir = makeTmpDir()
    const tool = createWriteTool()
    const filePath = path.join(dir, 'msg.txt')
    const content = 'test content'

    const result = await tool.execute({ path: filePath, content })

    expect(result.ok).toBe(true)
    const byteCount = Buffer.byteLength(content, 'utf-8')
    expect(result.output).toContain(String(byteCount))
    expect(result.output).toContain(path.resolve(filePath))
  })

  it('ToolDefinition インターフェースに準拠している', () => {
    const tool = createWriteTool()

    expect(tool.name).toBe('write')
    expect(tool.description).toBeDefined()
    expect(typeof tool.description).toBe('string')
    expect(tool.description.length).toBeGreaterThan(0)
    expect(tool.parameters).toBeDefined()
    expect(typeof tool.execute).toBe('function')
  })
})
