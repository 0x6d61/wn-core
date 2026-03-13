import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Result } from '../result.js'
import { ok, err } from '../result.js'
import type { McpConfig, McpServerConfig } from '../loader/types.js'
import type { ToolDefinition, ToolResult } from '../tools/types.js'
import type { McpConnection, McpManager, ConnectAllResult } from './types.js'

/**
 * MCP サーバー1台に接続し、ツール定義を取得する。
 *
 * @returns 成功時は McpConnection、失敗時は Error
 */
async function connectServer(serverConfig: McpServerConfig): Promise<Result<McpConnection>> {
  const client = new Client({ name: 'wn-core', version: '0.1.0' })

  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: [...serverConfig.args],
    ...(serverConfig.env !== undefined ? { env: { ...serverConfig.env } } : {}),
  })

  try {
    await client.connect(transport)
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return err(`Failed to connect to MCP server "${serverConfig.name}": ${message}`)
  }

  let tools: ToolDefinition[]
  try {
    const listResult = await client.listTools()
    tools = listResult.tools.map((mcpTool) => wrapMcpTool(client, serverConfig.name, mcpTool))
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    await client.close().catch(() => {})
    return err(`Failed to list tools from MCP server "${serverConfig.name}": ${message}`)
  }

  const connection: McpConnection = {
    serverName: serverConfig.name,
    tools,
    close: async (): Promise<void> => {
      await client.close()
    },
  }

  return ok(connection)
}

/** content 配列からテキストを抽出する型ガード */
function isTextContent(item: unknown): item is { type: 'text'; text: string } {
  if (typeof item !== 'object' || item === null) return false
  if (!('type' in item) || !('text' in item)) return false
  return item.type === 'text' && typeof item.text === 'string'
}

/** CallToolResult の content 配列から最初のテキストを抽出する */
function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return ''
  }
  const textItem = content.find(isTextContent)
  return textItem?.text ?? ''
}

/** MCP SDK の Tool 型（部分型） */
interface McpToolDef {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
}

/**
 * MCP SDK の Tool → wn-core の ToolDefinition に変換する。
 *
 * - ツール名に `{serverName}__{toolName}` プレフィクスを付与
 * - execute() は client.callTool() を元の名前で呼び出す
 */
function wrapMcpTool(client: Client, serverName: string, mcpTool: McpToolDef): ToolDefinition {
  const originalName = mcpTool.name
  const prefixedName = `${serverName}__${originalName}`

  return {
    name: prefixedName,
    description: mcpTool.description ?? '',
    parameters: mcpTool.inputSchema,
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
      try {
        const result = await client.callTool({
          name: originalName,
          arguments: args,
        })

        const output = extractTextFromContent(result.content)

        if (result.isError === true) {
          return { ok: false, output, error: output }
        }

        return { ok: true, output }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e)
        return { ok: false, output: '', error: message }
      }
    },
  }
}

/**
 * McpManager を生成するファクトリ関数。
 *
 * config.servers の各 MCP サーバーに対して stdio 接続を行い、
 * ツール定義を取得する。
 */
export function createMcpManager(config: McpConfig): McpManager {
  let connections: McpConnection[] = []

  return {
    async connectAll(): Promise<Result<ConnectAllResult>> {
      const servers = config.servers

      if (servers.length === 0) {
        return ok({ connections: [], warnings: [] })
      }

      const results = await Promise.allSettled(
        servers.map((serverConfig) => connectServer(serverConfig)),
      )

      const succeeded: McpConnection[] = []
      const errors: string[] = []

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.ok) {
            succeeded.push(result.value.data)
          } else {
            errors.push(result.value.error)
          }
        } else {
          errors.push(
            result.reason instanceof Error ? result.reason.message : String(result.reason),
          )
        }
      }

      // 全サーバー失敗 → err
      if (succeeded.length === 0 && errors.length > 0) {
        return err(`All MCP servers failed to connect: ${errors.join('; ')}`)
      }

      connections = succeeded
      return ok({ connections: succeeded, warnings: errors })
    },

    async closeAll(): Promise<void> {
      const closing = connections.map((conn) => conn.close().catch(() => {}))
      await Promise.all(closing)
      connections = []
    },
  }
}
