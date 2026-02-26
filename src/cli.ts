#!/usr/bin/env node

/**
 * wn-core CLI エントリポイント
 *
 * serve サブコマンドで JSON-RPC サーバーを起動し、
 * TUI クライアントからの接続を待ち受ける。
 */
import { parseArgs } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import type { Result } from './result.js'
import { err } from './result.js'
import type { LLMProvider } from './providers/types.js'
import type { ProviderConfig } from './loader/types.js'
import type { RpcRequestHandler } from './rpc/types.js'
import { createClaudeProvider } from './providers/claude.js'
import { createOpenAIProvider } from './providers/openai.js'
import { createOllamaProvider } from './providers/ollama.js'
import { createGeminiProvider } from './providers/gemini.js'
import { createReadTool } from './tools/read.js'
import { createWriteTool } from './tools/write.js'
import { createShellTool } from './tools/shell.js'
import { createGrepTool } from './tools/grep.js'
import { ToolRegistry } from './tools/types.js'
import { AgentLoop } from './agent/agent-loop.js'
import {
  createRpcRequestHandler,
  createRpcServer,
  createStdioTransport,
  createRpcAgentHandler,
} from './rpc/server.js'
import { loadConfig } from './loader/config-loader.js'
import { loadPersonas } from './loader/persona-loader.js'
import { loadSkills } from './loader/skill-loader.js'
import { loadAgents } from './loader/agent-loader.js'
import { createMcpManager } from './mcp/client.js'
import type { McpManager } from './mcp/types.js'

// ─── createProvider ───

/**
 * プロバイダー名からファクトリ関数を呼び出し LLMProvider を生成する
 */
export function createProvider(
  name: string,
  config: ProviderConfig,
  model: string,
): Result<LLMProvider> {
  switch (name) {
    case 'claude':
      return createClaudeProvider(config, model)
    case 'openai':
      return createOpenAIProvider(config, model)
    case 'ollama':
      return createOllamaProvider(config, model)
    case 'gemini':
      return createGeminiProvider(config, model)
    default:
      return err(`Unknown provider: ${name}`)
  }
}

// ─── createDefaultToolRegistry ───

/**
 * 4つのビルトインツール（read, write, shell, grep）を登録した ToolRegistry を返す
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(createReadTool())
  registry.register(createWriteTool())
  registry.register(createShellTool())
  registry.register(createGrepTool())
  return registry
}

// ─── createServeHandler ───

/**
 * AgentLoop と AbortController から RPC リクエストハンドラを生成する
 *
 * TUI → Core 方向のリクエスト（input, abort, configUpdate）を処理する。
 */
export function createServeHandler(
  agentLoop: AgentLoop,
  abortController: AbortController,
): RpcRequestHandler {
  return createRpcRequestHandler({
    async input(params: unknown): Promise<unknown> {
      const { text } = params as { text: string }
      const result = await agentLoop.step(text)
      return { accepted: result.ok }
    },
    abort(): Promise<unknown> {
      abortController.abort()
      return Promise.resolve({ aborted: true })
    },
    configUpdate(): Promise<unknown> {
      return Promise.resolve({ applied: true })
    },
  })
}

// ─── serve ───

/**
 * serve サブコマンドの本体
 *
 * 設定ロード → プロバイダー生成 → ペルソナ/スキル/エージェント読み込み →
 * ツールレジストリ構築 → MCP 接続 → AgentLoop + RPC サーバー起動
 */
async function serve(args: { provider?: string; model?: string; persona?: string }): Promise<void> {
  const globalDir = path.join(os.homedir(), '.wn')
  const localDir = path.join(process.cwd(), '.wn')

  // 1. 設定ロード
  const configResult = await loadConfig(globalDir, localDir, {
    ...(args.provider !== undefined ? { defaultProvider: args.provider } : {}),
    ...(args.model !== undefined ? { defaultModel: args.model } : {}),
    ...(args.persona !== undefined ? { defaultPersona: args.persona } : {}),
  })
  if (!configResult.ok) {
    console.error(`Failed to load config: ${configResult.error.message}`)
    process.exit(1)
  }
  const config = configResult.data

  // 2. プロバイダー生成
  const providerConfig = config.providers[config.defaultProvider] ?? {}
  const providerResult = createProvider(config.defaultProvider, providerConfig, config.defaultModel)
  if (!providerResult.ok) {
    console.error(`Failed to create provider: ${providerResult.error}`)
    process.exit(1)
  }
  const provider = providerResult.data

  // 3. ペルソナ / スキル / エージェント 並列読み込み
  const [personasResult, skillsResult, agentsResult] = await Promise.all([
    loadPersonas(globalDir, localDir),
    loadSkills(globalDir, localDir),
    loadAgents(globalDir, localDir),
  ])

  if (!personasResult.ok) {
    console.error(`Failed to load personas: ${personasResult.error.message}`)
    process.exit(1)
  }
  if (!skillsResult.ok) {
    console.error(`Failed to load skills: ${skillsResult.error.message}`)
    process.exit(1)
  }
  if (!agentsResult.ok) {
    console.error(`Failed to load agents: ${agentsResult.error.message}`)
    process.exit(1)
  }

  const personas = personasResult.data

  // 4. ToolRegistry 構築
  const toolRegistry = createDefaultToolRegistry()

  // 5. MCP 接続（設定がある場合のみ）
  let mcpManager: McpManager | undefined
  if (config.mcp) {
    mcpManager = createMcpManager(config.mcp)
    const connectResult = await mcpManager.connectAll()
    if (connectResult.ok) {
      for (const conn of connectResult.data) {
        for (const tool of conn.tools) {
          toolRegistry.registerMcp(tool)
        }
      }
    } else {
      console.error(`MCP connection warning: ${connectResult.error}`)
    }
  }

  // 6. AbortController
  const abortController = new AbortController()

  // 7. ペルソナからシステムメッセージを取得
  const persona = personas.get(config.defaultPersona)
  const systemMessage = persona?.content

  // 8. RPC トランスポート + サーバー（循環参照回避）
  const transport = createStdioTransport(process.stdin, process.stdout)

  // agentLoop を後から代入するため配列で間接参照
  const agentLoopRef: [AgentLoop | undefined] = [undefined]

  // RPC ハンドラは agentLoopRef 経由で AgentLoop を参照する（循環参照回避）
  const rpcHandler = createRpcRequestHandler({
    async input(params: unknown): Promise<unknown> {
      const { text } = params as { text: string }
      const loop = agentLoopRef[0]
      if (!loop) {
        return { accepted: false }
      }
      const result = await loop.step(text)
      return { accepted: result.ok }
    },
    abort(): Promise<unknown> {
      abortController.abort()
      return Promise.resolve({ aborted: true })
    },
    configUpdate(): Promise<unknown> {
      return Promise.resolve({ applied: true })
    },
  })

  const rpcServer = createRpcServer({ transport, handler: rpcHandler })

  // AgentLoop のイベントを RPC 通知としてクライアントに送信する
  const agentHandler = createRpcAgentHandler(rpcServer)

  agentLoopRef[0] = new AgentLoop({
    provider,
    tools: toolRegistry,
    handler: agentHandler,
    systemMessage,
    signal: abortController.signal,
  })

  // 9. シグナルハンドラ（graceful shutdown）
  const shutdown = (): void => {
    console.error('Shutting down...')
    abortController.abort()
    rpcServer.stop()
    if (mcpManager) {
      void mcpManager.closeAll()
    }
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // 10. 起動ログ（stderr に出力 — stdout は JSON-RPC 用）
  console.error(
    `wn-core serve started (provider=${config.defaultProvider}, model=${config.defaultModel})`,
  )

  // 11. RPC サーバー開始（入力ストリームが終了するまでブロック）
  await rpcServer.start()
}

// ─── main ───

/**
 * CLI エントリポイント
 *
 * parseArgs でサブコマンドとオプションを解析し、対応する関数を呼び出す。
 */
export async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      persona: { type: 'string' },
    },
    allowPositionals: true,
  })

  const subcommand = positionals[0]

  if (subcommand === 'serve') {
    await serve({
      provider: values.provider,
      model: values.model,
      persona: values.persona,
    })
  } else {
    console.error('Usage: wn-core <command>')
    console.error('')
    console.error('Commands:')
    console.error('  serve   Start the JSON-RPC agent server')
    console.error('')
    console.error('Options:')
    console.error('  --provider <name>   LLM provider (claude, openai, ollama, gemini)')
    console.error('  --model <name>      Model name')
    console.error('  --persona <name>    Persona name')
    process.exit(1)
  }
}

// エントリポイントとして直接実行された場合のみ main() を呼ぶ
// テストからの import 時は実行しない
import { fileURLToPath } from 'node:url'

const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (isEntryPoint) {
  void main()
}
