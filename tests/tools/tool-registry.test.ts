import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistry } from '../../src/tools/types.js'
import type { ToolDefinition, ToolResult } from '../../src/tools/types.js'

/** テスト用のダミーツールを生成する */
function createDummyTool(name: string, description = `${name} tool`): ToolDefinition {
  return {
    name,
    description,
    parameters: {},
    execute: (): Promise<ToolResult> =>
      Promise.resolve({
        ok: true,
        output: `${name} executed`,
      }),
  }
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  describe('register()', () => {
    it('ビルトインツールを登録できる', () => {
      const tool = createDummyTool('read')
      const result = registry.register(tool)
      expect(result.ok).toBe(true)
    })

    it('同名のビルトインツールを重複登録するとエラーを返す', () => {
      const tool = createDummyTool('read')
      registry.register(tool)
      const result = registry.register(tool)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('read')
      }
    })
  })

  describe('registerMcp()', () => {
    it('MCP ツールを登録できる', () => {
      const tool = createDummyTool('mcp-scan')
      const result = registry.registerMcp(tool)
      expect(result.ok).toBe(true)
    })

    it('同名の MCP ツールを重複登録するとエラーを返す', () => {
      const tool = createDummyTool('mcp-scan')
      registry.registerMcp(tool)
      const result = registry.registerMcp(tool)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('mcp-scan')
      }
    })
  })

  describe('get()', () => {
    it('ビルトインツールを名前で取得できる', () => {
      const tool = createDummyTool('read')
      registry.register(tool)
      const found = registry.get('read')
      expect(found).toBeDefined()
      expect(found?.name).toBe('read')
    })

    it('MCP ツールを名前で取得できる', () => {
      const tool = createDummyTool('mcp-scan')
      registry.registerMcp(tool)
      const found = registry.get('mcp-scan')
      expect(found).toBeDefined()
      expect(found?.name).toBe('mcp-scan')
    })

    it('同名のビルトインと MCP がある場合、ビルトインが優先される', () => {
      const builtin = createDummyTool('overlap', 'builtin version')
      const mcp = createDummyTool('overlap', 'mcp version')
      registry.register(builtin)
      registry.registerMcp(mcp)
      const found = registry.get('overlap')
      expect(found).toBeDefined()
      expect(found?.description).toBe('builtin version')
    })

    it('未登録のツール名に対して undefined を返す', () => {
      const found = registry.get('nonexistent')
      expect(found).toBeUndefined()
    })

    it('空のレジストリで undefined を返す', () => {
      const found = registry.get('anything')
      expect(found).toBeUndefined()
    })
  })

  describe('list()', () => {
    it('空のレジストリで空配列を返す', () => {
      const tools = registry.list()
      expect(tools).toStrictEqual([])
    })

    it('ビルトインツールのみ登録した場合、それらを返す', () => {
      registry.register(createDummyTool('read'))
      registry.register(createDummyTool('write'))
      const tools = registry.list()
      expect(tools).toHaveLength(2)
      const names = tools.map((t) => t.name)
      expect(names).toContain('read')
      expect(names).toContain('write')
    })

    it('MCP ツールのみ登録した場合、それらを返す', () => {
      registry.registerMcp(createDummyTool('mcp-a'))
      registry.registerMcp(createDummyTool('mcp-b'))
      const tools = registry.list()
      expect(tools).toHaveLength(2)
      const names = tools.map((t) => t.name)
      expect(names).toContain('mcp-a')
      expect(names).toContain('mcp-b')
    })

    it('ビルトインと MCP をマージして返す', () => {
      registry.register(createDummyTool('read'))
      registry.registerMcp(createDummyTool('mcp-scan'))
      const tools = registry.list()
      expect(tools).toHaveLength(2)
      const names = tools.map((t) => t.name)
      expect(names).toContain('read')
      expect(names).toContain('mcp-scan')
    })

    it('名前が衝突した場合、ビルトインが MCP を上書きする', () => {
      const builtin = createDummyTool('overlap', 'builtin version')
      const mcp = createDummyTool('overlap', 'mcp version')
      registry.register(builtin)
      registry.registerMcp(mcp)
      const tools = registry.list()
      expect(tools).toHaveLength(1)
      expect(tools[0]?.description).toBe('builtin version')
    })

    it('複数の衝突がある場合も正しくマージされる', () => {
      // ビルトイン 2 つ + MCP 3 つ（うち 2 つが衝突）
      registry.register(createDummyTool('read', 'builtin-read'))
      registry.register(createDummyTool('write', 'builtin-write'))
      registry.registerMcp(createDummyTool('read', 'mcp-read'))
      registry.registerMcp(createDummyTool('write', 'mcp-write'))
      registry.registerMcp(createDummyTool('mcp-only', 'mcp-only'))
      const tools = registry.list()
      expect(tools).toHaveLength(3)
      const map = new Map(tools.map((t) => [t.name, t.description]))
      expect(map.get('read')).toBe('builtin-read')
      expect(map.get('write')).toBe('builtin-write')
      expect(map.get('mcp-only')).toBe('mcp-only')
    })
  })
})
