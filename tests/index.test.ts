import { describe, it, expect } from 'vitest'
import { VERSION, ok, err, ToolRegistry } from '../src/index.js'
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
  })
})
