import { describe, it, expect } from 'vitest'
import {
  VERSION,
  ok,
  err,
  ToolRegistry,
  createReadTool,
  createWriteTool,
  createGrepTool,
  createShellTool,
  getShellConfig,
  parseFrontmatter,
  loadConfig,
  loadPersonas,
  loadSkills,
  loadAgents,
  AgentLoop,
  createNoopHandler,
} from '../src/index.js'
import type { ShellConfig } from '../src/index.js'
import type {
  Result,
  JsonSchema,
  Message,
  Tool,
  ToolCall,
  TokenUsage,
  LLMResponse,
  LLMProvider,
  ToolResult,
  ToolDefinition,
  SubAgentStatus,
  SubAgentHandle,
  AgentConfig,
  SubAgentRunner,
  AgentLoopState,
  AgentLoopHandler,
  AgentLoopOptions,
  WnConfig,
  ProviderConfig,
  McpConfig,
  McpServerConfig,
  Persona,
  Skill,
  AgentDef,
  FrontmatterResult,
  LoaderError,
  LoaderErrorCode,
} from '../src/index.js'

describe('wn-core', () => {
  it('バージョンが定義されている', () => {
    expect(VERSION).toBe('0.1.0')
  })

  it('ok/err ヘルパーがエクスポートされている', () => {
    expect(typeof ok).toBe('function')
    expect(typeof err).toBe('function')
  })

  it('ToolRegistry クラスがエクスポートされている', () => {
    expect(typeof ToolRegistry).toBe('function')
    const registry = new ToolRegistry()
    expect(registry).toBeInstanceOf(ToolRegistry)
  })

  it('型エクスポートがコンパイル時に利用可能（型チェック用）', () => {
    // これらの型が import できること自体がテスト
    // 実行時には値を生成して検証する
    const message: Message = { role: 'user', content: 'hello' }
    expect(message.role).toBe('user')

    const result: Result<number> = ok(42)
    expect(result.ok).toBe(true)

    const schema: JsonSchema = { type: 'object' }
    expect(schema).toBeDefined()

    const tool: Tool = { name: 'test', description: 'test tool', parameters: {} }
    expect(tool.name).toBe('test')

    const toolCall: ToolCall = { id: '1', name: 'test', arguments: {} }
    expect(toolCall.id).toBe('1')

    const usage: TokenUsage = { inputTokens: 10, outputTokens: 20 }
    expect(usage.inputTokens).toBe(10)

    const response: LLMResponse = { content: 'hello' }
    expect(response.content).toBe('hello')

    const toolResult: ToolResult = { ok: true, output: 'done' }
    expect(toolResult.ok).toBe(true)

    const status: SubAgentStatus = 'running'
    expect(status).toBe('running')

    const handle: SubAgentHandle = { id: '1', status: 'running' }
    expect(handle.id).toBe('1')

    const config: AgentConfig = {
      persona: 'default',
      skills: [],
      provider: 'claude',
      model: 'sonnet',
      task: 'test',
    }
    expect(config.persona).toBe('default')

    // LLMProvider, ToolDefinition, SubAgentRunner はインターフェースのため
    // ここではインポートできること自体が型チェックの検証
    expect(undefined as LLMProvider | undefined).toBeUndefined()
    expect(undefined as ToolDefinition | undefined).toBeUndefined()
    expect(undefined as SubAgentRunner | undefined).toBeUndefined()

    // AgentLoop 関連型
    const loopState: AgentLoopState = 'idle'
    expect(loopState).toBe('idle')

    expect(undefined as AgentLoopHandler | undefined).toBeUndefined()
    expect(undefined as AgentLoopOptions | undefined).toBeUndefined()
  })

  it('組み込みツールファクトリがエクスポートされている', () => {
    expect(typeof createReadTool).toBe('function')
    expect(typeof createWriteTool).toBe('function')
    expect(typeof createGrepTool).toBe('function')
    expect(typeof createShellTool).toBe('function')
    expect(typeof getShellConfig).toBe('function')

    // ファクトリが ToolDefinition を返すことを確認
    const readTool = createReadTool()
    expect(readTool.name).toBe('read')
    const writeTool = createWriteTool()
    expect(writeTool.name).toBe('write')
    const grepTool = createGrepTool()
    expect(grepTool.name).toBe('grep')
    const shellTool = createShellTool()
    expect(shellTool.name).toBe('shell')

    // ShellConfig 型が利用可能
    const config: ShellConfig = getShellConfig('linux')
    expect(config.shell).toBe('/bin/sh')
  })

  it('AgentLoop と createNoopHandler がエクスポートされている', () => {
    expect(typeof AgentLoop).toBe('function')
    expect(typeof createNoopHandler).toBe('function')

    const handler = createNoopHandler()
    expect(typeof handler.onResponse).toBe('function')
  })

  it('Loader 関数がエクスポートされている', () => {
    expect(typeof parseFrontmatter).toBe('function')
    expect(typeof loadConfig).toBe('function')
    expect(typeof loadPersonas).toBe('function')
    expect(typeof loadSkills).toBe('function')
    expect(typeof loadAgents).toBe('function')
  })

  it('Loader 型がコンパイル時に利用可能（型チェック用）', () => {
    const wnConfig: WnConfig = {
      defaultProvider: 'claude',
      defaultModel: 'claude-sonnet-4-20250514',
      defaultPersona: 'default',
      providers: {},
    }
    expect(wnConfig.defaultProvider).toBe('claude')

    const providerConfig: ProviderConfig = { apiKey: 'test' }
    expect(providerConfig.apiKey).toBe('test')

    const mcpServer: McpServerConfig = { name: 's', command: 'c', args: [] }
    expect(mcpServer.name).toBe('s')

    const mcpConfig: McpConfig = { servers: [mcpServer] }
    expect(mcpConfig.servers).toHaveLength(1)

    const persona: Persona = { name: 'default', content: 'hello' }
    expect(persona.name).toBe('default')

    const skill: Skill = { name: 'scan', description: 'scan skill', tools: ['shell'], body: '' }
    expect(skill.name).toBe('scan')

    const agentDef: AgentDef = {
      name: 'recon',
      persona: 'default',
      skills: ['scan'],
      provider: 'claude',
      model: 'sonnet',
      description: 'recon agent',
    }
    expect(agentDef.name).toBe('recon')

    const frontmatter: FrontmatterResult = { attributes: {}, body: '' }
    expect(frontmatter.body).toBe('')

    const loaderError: LoaderError = { code: 'PARSE_ERROR', message: 'bad' }
    expect(loaderError.code).toBe('PARSE_ERROR')

    const code: LoaderErrorCode = 'IO_ERROR'
    expect(code).toBe('IO_ERROR')
  })
})
