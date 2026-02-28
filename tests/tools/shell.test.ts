import { describe, it, expect } from 'vitest'
import { createShellTool, getShellConfig } from '../../src/tools/shell.js'
import type { ToolDefinition } from '../../src/tools/types.js'

describe('createShellTool', { timeout: 15_000 }, () => {
  it('コマンドを実行して stdout を返す', async () => {
    const tool = createShellTool()
    // Windows (powershell): echo hello -> "hello\r\n"
    const result = await tool.execute({ command: 'echo hello' })

    expect(result.ok).toBe(true)
    expect(result.output).toContain('hello')
  })

  it('失敗したコマンドでエラーを返す', async () => {
    const tool = createShellTool()
    // exit 1 works in both powershell and /bin/sh
    const result = await tool.execute({ command: 'exit 1' })

    expect(result.ok).toBe(false)
  })

  it('タイムアウト指定時にエラーを返す', async () => {
    const tool = createShellTool()
    // Use a long-running command with a short timeout
    const command = process.platform === 'win32' ? 'ping -n 100 127.0.0.1' : 'sleep 10'
    const result = await tool.execute({ command, timeout: 500 })

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('timed out')
  })

  it('デフォルトはタイムアウトなし（timeout: 0）', () => {
    const tool = createShellTool()

    // timeout is optional in the parameter schema
    const props = tool.parameters['properties'] as Record<string, Record<string, unknown>>
    const required = tool.parameters['required'] as string[]

    expect(props['timeout']).toBeDefined()
    expect(required).not.toContain('timeout')

    // Quick command should succeed without specifying timeout
    // (covered by the first test case)
  })

  it('command パラメータが不足するとバリデーションエラーを返す', async () => {
    const tool = createShellTool()
    const result = await tool.execute({})

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('command')
  })

  it('空のコマンド文字列でバリデーションエラーを返す', async () => {
    const tool = createShellTool()
    const result = await tool.execute({ command: '' })

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('command')
  })

  it('getShellConfig が win32 で powershell を返す', () => {
    const config = getShellConfig('win32')

    expect(config.shell).toBe('powershell.exe')
    expect(config.buildArgs('test')).toContain('-NoProfile')
    expect(config.buildArgs('test')).toContain('-Command')
    expect(config.buildArgs('test')).toContain('test')
  })

  it('getShellConfig が linux で /bin/sh を返す', () => {
    const config = getShellConfig('linux')

    expect(config.shell).toBe('/bin/sh')
    expect(config.buildArgs('test')).toContain('-c')
    expect(config.buildArgs('test')).toContain('test')
  })

  it('ToolDefinition インターフェースに準拠している', () => {
    const tool: ToolDefinition = createShellTool()

    expect(tool.name).toBe('shell')
    expect(tool.description).toBeDefined()
    expect(tool.description.length).toBeGreaterThan(0)
    expect(tool.parameters).toBeDefined()
    expect(tool.parameters).toHaveProperty('required')
    expect(typeof tool.execute).toBe('function')
  })
})
