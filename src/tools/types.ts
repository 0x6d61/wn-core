import type { Result } from '../result.js'
import { ok, err } from '../result.js'
import type { JsonSchema } from '../providers/types.js'

/** ツール実行結果 */
export interface ToolResult {
  readonly ok: boolean
  readonly output: string
  readonly error?: string
}

/**
 * ツール定義インターフェース
 *
 * 組み込みツール（read/write/shell/grep）と MCP ツールの両方が実装する。
 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  execute(args: Record<string, unknown>): Promise<ToolResult>
}

/**
 * ToolRegistry — 組み込みツールと MCP ツールを統合管理する
 *
 * - register(): ビルトインツールを登録
 * - registerMcp(): MCP 経由ツールを登録
 * - get(): 名前でツールを検索（ビルトイン優先）
 * - list(): 全ツールをマージして返す（ビルトインが MCP を上書き）
 */
export class ToolRegistry {
  private readonly builtins: Map<string, ToolDefinition> = new Map()
  private readonly mcpTools: Map<string, ToolDefinition> = new Map()

  /** ビルトインツールを登録する。重複時は Result エラーを返す。 */
  register(tool: ToolDefinition): Result<void> {
    if (this.builtins.has(tool.name)) {
      return err(`Builtin tool already registered: ${tool.name}`)
    }
    this.builtins.set(tool.name, tool)
    return ok(undefined)
  }

  /** MCP ツールを登録する。重複時は Result エラーを返す。 */
  registerMcp(tool: ToolDefinition): Result<void> {
    if (this.mcpTools.has(tool.name)) {
      return err(`MCP tool already registered: ${tool.name}`)
    }
    this.mcpTools.set(tool.name, tool)
    return ok(undefined)
  }

  /** 名前でツールを取得する。ビルトイン → MCP の優先順位。 */
  get(name: string): ToolDefinition | undefined {
    return this.builtins.get(name) ?? this.mcpTools.get(name)
  }

  /** 全ツールをマージして返す。名前衝突時はビルトインが優先。 */
  list(): ToolDefinition[] {
    const merged = new Map<string, ToolDefinition>(this.mcpTools)
    for (const [name, tool] of this.builtins) {
      merged.set(name, tool)
    }
    return [...merged.values()]
  }
}
