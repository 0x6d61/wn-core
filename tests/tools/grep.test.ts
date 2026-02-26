import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createGrepTool } from '../../src/tools/grep.js'

describe('createGrepTool', () => {
  let tmpDir: string

  function setup(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-grep-test-'))
    return dir
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ファイル内のパターンにマッチする行を返す', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'sample.txt')
    fs.writeFileSync(filePath, 'hello world\nfoo bar\nhello again\n', 'utf-8')

    const tool = createGrepTool()
    const result = await tool.execute({ pattern: 'hello', path: filePath })

    expect(result.ok).toBe(true)
    expect(result.output).toContain('hello world')
    expect(result.output).toContain('hello again')
    expect(result.output).not.toContain('foo bar')
  })

  it('マッチしない場合は空の出力を返す', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'sample.txt')
    fs.writeFileSync(filePath, 'hello world\nfoo bar\n', 'utf-8')

    const tool = createGrepTool()
    const result = await tool.execute({ pattern: 'nonexistent', path: filePath })

    expect(result.ok).toBe(true)
    expect(result.output).toBe('')
  })

  it('正規表現パターンで検索できる', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'numbers.txt')
    fs.writeFileSync(filePath, 'abc\n123\ndef456\n78\n999\n', 'utf-8')

    const tool = createGrepTool()
    const result = await tool.execute({ pattern: '\\d{3}', path: filePath })

    expect(result.ok).toBe(true)
    expect(result.output).toContain('123')
    expect(result.output).toContain('def456')
    expect(result.output).toContain('999')
    expect(result.output).not.toContain('abc')
    // 78 is only 2 digits, should not match \d{3}
    const lines = result.output.split('\n').filter((l: string) => l.length > 0)
    const has78Only = lines.some(
      (l: string) => l.includes(':78') && !l.includes('def456') && !l.includes('999'),
    )
    expect(has78Only).toBe(false)
  })

  it('ディレクトリ内を再帰的に検索できる', async () => {
    tmpDir = setup()
    // Create nested directory structure
    const subDir = path.join(tmpDir, 'sub')
    const deepDir = path.join(subDir, 'deep')
    fs.mkdirSync(deepDir, { recursive: true })

    fs.writeFileSync(path.join(tmpDir, 'root.txt'), 'target line\n', 'utf-8')
    fs.writeFileSync(path.join(subDir, 'mid.txt'), 'another target\n', 'utf-8')
    fs.writeFileSync(path.join(deepDir, 'deep.txt'), 'deep target here\n', 'utf-8')

    const tool = createGrepTool()
    const result = await tool.execute({ pattern: 'target', path: tmpDir })

    expect(result.ok).toBe(true)
    expect(result.output).toContain('target line')
    expect(result.output).toContain('another target')
    expect(result.output).toContain('deep target here')
  })

  it('glob フィルタでファイルを絞り込める', async () => {
    tmpDir = setup()
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'const x = 1\n', 'utf-8')
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'const x = 1\n', 'utf-8')
    fs.writeFileSync(path.join(tmpDir, 'util.ts'), 'const y = 2\n', 'utf-8')

    const tool = createGrepTool()
    const result = await tool.execute({ pattern: 'const', path: tmpDir, glob: '*.ts' })

    expect(result.ok).toBe(true)
    expect(result.output).toContain('app.ts')
    expect(result.output).toContain('util.ts')
    expect(result.output).not.toContain('app.js')
  })

  it('無効な正規表現に対してエラーを返す', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'sample.txt')
    fs.writeFileSync(filePath, 'hello\n', 'utf-8')

    const tool = createGrepTool()
    const result = await tool.execute({ pattern: '[unclosed', path: filePath })

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('存在しないパスに対してエラーを返す', async () => {
    tmpDir = setup()
    const nonexistent = path.join(tmpDir, 'does-not-exist.txt')

    const tool = createGrepTool()
    const result = await tool.execute({ pattern: 'hello', path: nonexistent })

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('出力形式が filepath:line:content である', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'format.txt')
    fs.writeFileSync(filePath, 'aaa\nbbb\nccc\n', 'utf-8')

    const tool = createGrepTool()
    const result = await tool.execute({ pattern: 'bbb', path: filePath })

    expect(result.ok).toBe(true)
    // Format should be filename:lineNumber:content
    const lines = result.output.split('\n').filter((l: string) => l.length > 0)
    expect(lines).toHaveLength(1)
    const firstLine = lines[0] ?? ''
    const parts = firstLine.split(':')
    // At minimum: filepath, line number, content
    expect(parts.length).toBeGreaterThanOrEqual(3)
    // The second part should be a line number
    expect(parts[1]).toMatch(/^\d+$/)
    // The line number for 'bbb' should be 2
    expect(parts[1]).toBe('2')
    // The rest should contain the matched content
    expect(parts.slice(2).join(':')).toContain('bbb')
  })

  it('空ディレクトリで空の出力を返す', async () => {
    tmpDir = setup()
    const emptyDir = path.join(tmpDir, 'empty')
    fs.mkdirSync(emptyDir)

    const tool = createGrepTool()
    const result = await tool.execute({ pattern: 'anything', path: emptyDir })

    expect(result.ok).toBe(true)
    expect(result.output).toBe('')
  })

  it('pattern パラメータが不足するとバリデーションエラーを返す', async () => {
    tmpDir = setup()
    const filePath = path.join(tmpDir, 'sample.txt')
    fs.writeFileSync(filePath, 'hello\n', 'utf-8')

    const tool = createGrepTool()
    const result = await tool.execute({ path: filePath })

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('pattern')
  })

  it('バイナリファイルをスキップする', async () => {
    tmpDir = setup()
    // Create a file with null bytes (binary)
    const binaryPath = path.join(tmpDir, 'binary.bin')
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x00, 0x57, 0x6f, 0x72, 0x6c])
    fs.writeFileSync(binaryPath, buf)

    // Create a normal text file alongside
    const textPath = path.join(tmpDir, 'text.txt')
    fs.writeFileSync(textPath, 'Hello World\n', 'utf-8')

    const tool = createGrepTool()
    const result = await tool.execute({ pattern: 'Hello', path: tmpDir })

    expect(result.ok).toBe(true)
    // Should find the match in the text file
    expect(result.output).toContain('text.txt')
    // Should NOT include the binary file in results
    expect(result.output).not.toContain('binary.bin')
  })
})
