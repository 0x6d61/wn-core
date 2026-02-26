import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { McpConfig, McpServerConfig } from '../../src/loader/types.js'
import { ToolRegistry } from '../../src/tools/types.js'
import type { ToolDefinition, ToolResult } from '../../src/tools/types.js'

// --- MCP SDK モック ---

interface MockClientInstance {
  connect: Mock
  listTools: Mock
  callTool: Mock
  close: Mock
}

/** MCP SDK の Tool 型を模倣 */
interface MockMcpTool {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, object>
    required?: string[]
  }
}

/** MCP SDK の CallToolResult 型を模倣 */
interface MockCallToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

/**
 * 事前設定用のモックインスタンス配列。
 * Client コンストラクタが呼ばれるたびに、先頭から1つずつ消費される（FIFO）。
 */
let mockClientInstances: MockClientInstance[] = []
let nextMockIndex = 0

/** 新しい mockClient インスタンスを作成し、配列に追加して返す */
function createMockClientInstance(): MockClientInstance {
  const instance: MockClientInstance = {
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    listTools: vi.fn<() => Promise<{ tools: MockMcpTool[] }>>().mockResolvedValue({ tools: [] }),
    callTool: vi
      .fn<() => Promise<MockCallToolResult>>()
      .mockResolvedValue({ content: [{ type: 'text', text: '' }] }),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
  mockClientInstances.push(instance)
  return instance
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: class MockClient {
      connect: Mock
      listTools: Mock
      callTool: Mock
      close: Mock
      constructor(_info: { name: string; version: string }) {
        void _info
        const inst = mockClientInstances[nextMockIndex]
        if (!inst) {
          throw new Error(`No mock instance at index ${String(nextMockIndex)}`)
        }
        nextMockIndex++
        this.connect = inst.connect
        this.listTools = inst.listTools
        this.callTool = inst.callTool
        this.close = inst.close
      }
    },
  }
})

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: class MockStdioClientTransport {
      command: string
      args: string[]
      constructor(opts: { command: string; args?: string[] }) {
        this.command = opts.command
        this.args = opts.args ?? []
      }
    },
  }
})

// SUT は mock 設定後にインポート
const { createMcpManager } = await import('../../src/mcp/client.js')

// --- ヘルパー ---

function makeServerConfig(name: string, command = 'npx', args: string[] = []): McpServerConfig {
  return { name, command, args }
}

function makeMcpConfig(servers: McpServerConfig[]): McpConfig {
  return { servers }
}

function makeMcpTool(
  name: string,
  description?: string,
  properties?: Record<string, object>,
  required?: string[],
): MockMcpTool {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: properties ?? {},
      required: required ?? [],
    },
  }
}

function createDummyTool(name: string, description = `${name} tool`): ToolDefinition {
  return {
    name,
    description,
    parameters: {},
    execute: (): Promise<ToolResult> => Promise.resolve({ ok: true, output: `${name} executed` }),
  }
}

// --- テスト ---

describe('MCP Client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClientInstances = []
    nextMockIndex = 0
  })

  // ====================================================================
  // 1. createMcpManager
  // ====================================================================
  describe('createMcpManager', () => {
    it('servers: [] で空の McpManager を返す', () => {
      const manager = createMcpManager(makeMcpConfig([]))
      expect(manager).toBeDefined()
      expect(manager).toHaveProperty('connectAll')
      expect(manager).toHaveProperty('closeAll')
    })

    it('有効な config で McpManager を返す', () => {
      const config = makeMcpConfig([
        makeServerConfig('server-a', 'npx', ['-y', '@example/mcp-server']),
        makeServerConfig('server-b', 'node', ['server.js']),
      ])
      const manager = createMcpManager(config)
      expect(manager).toBeDefined()
      expect(manager).toHaveProperty('connectAll')
      expect(manager).toHaveProperty('closeAll')
    })
  })

  // ====================================================================
  // 2. connectAll — 接続
  // ====================================================================
  describe('connectAll — 接続', () => {
    it('1サーバー接続成功 → ok + McpConnection 1件', async () => {
      const inst = createMockClientInstance()
      inst.listTools.mockResolvedValue({ tools: [] })

      const manager = createMcpManager(
        makeMcpConfig([makeServerConfig('alpha', 'npx', ['-y', 'alpha-server'])]),
      )
      const result = await manager.connectAll()

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveLength(1)
        expect(result.data[0]?.serverName).toBe('alpha')
      }
    })

    it('複数サーバー接続成功 → ok + McpConnection 複数件', async () => {
      const inst1 = createMockClientInstance()
      inst1.listTools.mockResolvedValue({ tools: [] })
      const inst2 = createMockClientInstance()
      inst2.listTools.mockResolvedValue({ tools: [] })
      const inst3 = createMockClientInstance()
      inst3.listTools.mockResolvedValue({ tools: [] })

      const config = makeMcpConfig([
        makeServerConfig('server-a', 'npx', ['a']),
        makeServerConfig('server-b', 'npx', ['b']),
        makeServerConfig('server-c', 'npx', ['c']),
      ])
      const manager = createMcpManager(config)
      const result = await manager.connectAll()

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveLength(3)
        const names = result.data.map((c) => c.serverName)
        expect(names).toContain('server-a')
        expect(names).toContain('server-b')
        expect(names).toContain('server-c')
      }
    })

    it('1サーバーのみで接続失敗 → err', async () => {
      const inst = createMockClientInstance()
      inst.connect.mockRejectedValue(new Error('Connection refused'))

      const manager = createMcpManager(
        makeMcpConfig([makeServerConfig('broken', 'npx', ['broken-server'])]),
      )
      const result = await manager.connectAll()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBeDefined()
      }
    })

    it('部分失敗（2サーバー中1つ成功）→ ok + 成功分のみ', async () => {
      const successInst = createMockClientInstance()
      successInst.listTools.mockResolvedValue({ tools: [] })

      const failInst = createMockClientInstance()
      failInst.connect.mockRejectedValue(new Error('Connection refused'))

      const config = makeMcpConfig([
        makeServerConfig('good-server', 'npx', ['good']),
        makeServerConfig('bad-server', 'npx', ['bad']),
      ])
      const manager = createMcpManager(config)
      const result = await manager.connectAll()

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveLength(1)
        expect(result.data[0]?.serverName).toBe('good-server')
      }
    })

    it('全サーバー失敗 → err', async () => {
      const fail1 = createMockClientInstance()
      fail1.connect.mockRejectedValue(new Error('Timeout'))

      const fail2 = createMockClientInstance()
      fail2.connect.mockRejectedValue(new Error('Connection refused'))

      const config = makeMcpConfig([
        makeServerConfig('server-x', 'npx', ['x']),
        makeServerConfig('server-y', 'npx', ['y']),
      ])
      const manager = createMcpManager(config)
      const result = await manager.connectAll()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBeDefined()
      }
    })

    it('servers: [] で connectAll → ok + 空配列', async () => {
      const manager = createMcpManager(makeMcpConfig([]))
      const result = await manager.connectAll()

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveLength(0)
      }
    })
  })

  // ====================================================================
  // 3. ツール定義変換
  // ====================================================================
  describe('ツール定義変換', () => {
    it('MCP ツール → ToolDefinition に正しく変換される', async () => {
      const inst = createMockClientInstance()
      inst.listTools.mockResolvedValue({
        tools: [makeMcpTool('scan', 'Run a scan', { target: { type: 'string' } }, ['target'])],
      })

      const manager = createMcpManager(
        makeMcpConfig([makeServerConfig('sec-tools', 'npx', ['sec'])]),
      )
      const result = await manager.connectAll()

      expect(result.ok).toBe(true)
      if (result.ok) {
        const conn = result.data[0]
        if (!conn) throw new Error('expected connection')
        expect(conn.tools).toHaveLength(1)

        const tool = conn.tools[0]
        if (!tool) throw new Error('expected tool')
        expect(tool).toHaveProperty('name')
        expect(tool).toHaveProperty('description')
        expect(tool).toHaveProperty('parameters')
        expect(tool).toHaveProperty('execute')
      }
    })

    it('ツール名にサーバー名プレフィクスが付く (serverName__toolName)', async () => {
      const inst = createMockClientInstance()
      inst.listTools.mockResolvedValue({
        tools: [makeMcpTool('run_scan', 'Run scan')],
      })

      const manager = createMcpManager(
        makeMcpConfig([makeServerConfig('nmap', 'npx', ['nmap-server'])]),
      )
      const result = await manager.connectAll()

      expect(result.ok).toBe(true)
      if (result.ok) {
        const tool = result.data[0]?.tools[0]
        if (!tool) throw new Error('expected tool')
        expect(tool.name).toBe('nmap__run_scan')
      }
    })

    it('description が引き継がれる（未定義の場合は空文字）', async () => {
      const inst = createMockClientInstance()
      inst.listTools.mockResolvedValue({
        tools: [makeMcpTool('with_desc', 'This tool does something'), makeMcpTool('no_desc')],
      })

      const manager = createMcpManager(makeMcpConfig([makeServerConfig('srv', 'npx', ['srv'])]))
      const result = await manager.connectAll()

      expect(result.ok).toBe(true)
      if (result.ok) {
        const conn = result.data[0]
        if (!conn) throw new Error('expected connection')
        expect(conn.tools).toHaveLength(2)

        const toolWithDesc = conn.tools.find((t) => t.name === 'srv__with_desc')
        const toolNoDesc = conn.tools.find((t) => t.name === 'srv__no_desc')

        expect(toolWithDesc?.description).toBe('This tool does something')
        expect(toolNoDesc?.description).toBe('')
      }
    })

    it('inputSchema が parameters にマッピングされる', async () => {
      const inst = createMockClientInstance()
      const inputSchema = {
        type: 'object' as const,
        properties: {
          host: { type: 'string', description: 'Target host' },
          port: { type: 'number', description: 'Target port' },
        },
        required: ['host'],
      }
      inst.listTools.mockResolvedValue({
        tools: [{ name: 'connect', description: 'Connect to host', inputSchema }],
      })

      const manager = createMcpManager(makeMcpConfig([makeServerConfig('net', 'npx', ['net'])]))
      const result = await manager.connectAll()

      expect(result.ok).toBe(true)
      if (result.ok) {
        const tool = result.data[0]?.tools[0]
        if (!tool) throw new Error('expected tool')
        expect(tool.parameters).toStrictEqual(inputSchema)
      }
    })

    it('ツールなしサーバー → 空配列の tools', async () => {
      const inst = createMockClientInstance()
      inst.listTools.mockResolvedValue({ tools: [] })

      const manager = createMcpManager(
        makeMcpConfig([makeServerConfig('empty-srv', 'npx', ['empty'])]),
      )
      const result = await manager.connectAll()

      expect(result.ok).toBe(true)
      if (result.ok) {
        const conn = result.data[0]
        if (!conn) throw new Error('expected connection')
        expect(conn.tools).toStrictEqual([])
      }
    })
  })

  // ====================================================================
  // 4. ツール実行 execute
  // ====================================================================
  describe('ツール実行 execute', () => {
    it('execute() が client.callTool() をプレフィクスなしの元の名前で呼ぶ', async () => {
      const inst = createMockClientInstance()
      inst.listTools.mockResolvedValue({
        tools: [makeMcpTool('do_thing', 'Do a thing', { input: { type: 'string' } })],
      })
      inst.callTool.mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
      })

      const manager = createMcpManager(makeMcpConfig([makeServerConfig('my-srv', 'npx', ['srv'])]))
      const connectResult = await manager.connectAll()
      if (!connectResult.ok) throw new Error('connectAll failed')

      const tool = connectResult.data[0]?.tools[0]
      if (!tool) throw new Error('expected tool')

      expect(tool.name).toBe('my-srv__do_thing')
      await tool.execute({ input: 'hello' })

      expect(inst.callTool).toHaveBeenCalledWith({
        name: 'do_thing',
        arguments: { input: 'hello' },
      })
    })

    it('成功結果 → { ok: true, output: "result text" }', async () => {
      const inst = createMockClientInstance()
      inst.listTools.mockResolvedValue({
        tools: [makeMcpTool('echo', 'Echo tool')],
      })
      inst.callTool.mockResolvedValue({
        content: [{ type: 'text', text: 'echoed back' }],
      })

      const manager = createMcpManager(makeMcpConfig([makeServerConfig('util', 'npx', ['util'])]))
      const connectResult = await manager.connectAll()
      if (!connectResult.ok) throw new Error('connectAll failed')

      const tool = connectResult.data[0]?.tools[0]
      if (!tool) throw new Error('expected tool')

      const execResult = await tool.execute({})

      expect(execResult).toStrictEqual({ ok: true, output: 'echoed back' })
    })

    it('エラー結果 (isError: true) → { ok: false, output, error }', async () => {
      const inst = createMockClientInstance()
      inst.listTools.mockResolvedValue({
        tools: [makeMcpTool('fail_tool', 'A tool that fails')],
      })
      inst.callTool.mockResolvedValue({
        content: [{ type: 'text', text: 'something went wrong' }],
        isError: true,
      })

      const manager = createMcpManager(makeMcpConfig([makeServerConfig('err-srv', 'npx', ['err'])]))
      const connectResult = await manager.connectAll()
      if (!connectResult.ok) throw new Error('connectAll failed')

      const tool = connectResult.data[0]?.tools[0]
      if (!tool) throw new Error('expected tool')

      const execResult = await tool.execute({})

      expect(execResult).toStrictEqual({
        ok: false,
        output: 'something went wrong',
        error: 'something went wrong',
      })
    })

    it('client.callTool() が例外 → { ok: false, output: "", error }', async () => {
      const inst = createMockClientInstance()
      inst.listTools.mockResolvedValue({
        tools: [makeMcpTool('crash_tool', 'A tool that crashes')],
      })
      inst.callTool.mockRejectedValue(new Error('Transport error'))

      const manager = createMcpManager(
        makeMcpConfig([makeServerConfig('crash-srv', 'npx', ['crash'])]),
      )
      const connectResult = await manager.connectAll()
      if (!connectResult.ok) throw new Error('connectAll failed')

      const tool = connectResult.data[0]?.tools[0]
      if (!tool) throw new Error('expected tool')

      const execResult = await tool.execute({})

      expect(execResult).toStrictEqual({
        ok: false,
        output: '',
        error: 'Transport error',
      })
    })
  })

  // ====================================================================
  // 5. closeAll
  // ====================================================================
  describe('closeAll', () => {
    it('全接続が正しくクローズされる', async () => {
      const inst1 = createMockClientInstance()
      inst1.listTools.mockResolvedValue({ tools: [] })
      const inst2 = createMockClientInstance()
      inst2.listTools.mockResolvedValue({ tools: [] })

      const config = makeMcpConfig([
        makeServerConfig('srv-1', 'npx', ['1']),
        makeServerConfig('srv-2', 'npx', ['2']),
      ])
      const manager = createMcpManager(config)
      const result = await manager.connectAll()
      expect(result.ok).toBe(true)

      await manager.closeAll()

      expect(inst1.close).toHaveBeenCalledOnce()
      expect(inst2.close).toHaveBeenCalledOnce()
    })

    it('接続前に closeAll() を呼んでもエラーにならない', async () => {
      const manager = createMcpManager(makeMcpConfig([makeServerConfig('srv', 'npx', ['srv'])]))
      await expect(manager.closeAll()).resolves.toBeUndefined()
    })
  })

  // ====================================================================
  // 6. ToolRegistry 統合
  // ====================================================================
  describe('ToolRegistry 統合', () => {
    it('MCP ツールを registry.registerMcp() で登録できる', async () => {
      const inst = createMockClientInstance()
      inst.listTools.mockResolvedValue({
        tools: [makeMcpTool('scan_ports', 'Scan ports on a target')],
      })

      const manager = createMcpManager(makeMcpConfig([makeServerConfig('nmap', 'npx', ['nmap'])]))
      const result = await manager.connectAll()
      if (!result.ok) throw new Error('connectAll failed')

      const registry = new ToolRegistry()
      for (const conn of result.data) {
        for (const tool of conn.tools) {
          const regResult = registry.registerMcp(tool)
          expect(regResult.ok).toBe(true)
        }
      }

      const registered = registry.get('nmap__scan_ports')
      expect(registered).toBeDefined()
      expect(registered?.name).toBe('nmap__scan_ports')
      expect(registered?.description).toBe('Scan ports on a target')
    })

    it('ビルトインと MCP のツール名が同じ場合、registry.get() はビルトイン優先', async () => {
      const inst = createMockClientInstance()
      inst.listTools.mockResolvedValue({
        tools: [makeMcpTool('read', 'MCP read tool')],
      })

      const manager = createMcpManager(makeMcpConfig([makeServerConfig('srv', 'npx', ['srv'])]))
      const result = await manager.connectAll()
      if (!result.ok) throw new Error('connectAll failed')

      const registry = new ToolRegistry()

      // ビルトインとして同名を先に登録
      const builtinTool = createDummyTool('srv__read', 'builtin version')
      registry.register(builtinTool)

      // MCP ツールとして同名を登録
      for (const conn of result.data) {
        for (const tool of conn.tools) {
          registry.registerMcp(tool)
        }
      }

      // ビルトインが優先される
      const found = registry.get('srv__read')
      expect(found).toBeDefined()
      expect(found?.description).toBe('builtin version')
    })
  })
})
