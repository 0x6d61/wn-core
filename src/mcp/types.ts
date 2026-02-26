import type { Result } from '../result.js'
import type { ToolDefinition } from '../tools/types.js'

/** MCP 接続1本分のハンドル */
export interface McpConnection {
  readonly serverName: string
  readonly tools: readonly ToolDefinition[]
  close(): Promise<void>
}

/** MCP マネージャー — 複数サーバーの接続を一括管理 */
export interface McpManager {
  /** 全サーバーに接続し、ツール定義を取得 */
  connectAll(): Promise<Result<readonly McpConnection[]>>
  /** 全接続をクローズ */
  closeAll(): Promise<void>
}
