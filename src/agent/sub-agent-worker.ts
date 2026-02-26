/**
 * サブエージェント Worker
 *
 * Worker Thread として実行され、サブエージェントの LLM 対話ループを駆動する。
 * - createProviderByName: プロバイダー名から LLMProvider を生成
 * - runSubAgent: Worker 内でのエージェント実行エントリポイント
 */
import type { Result } from '../result.js'
import { err } from '../result.js'
import type { LLMProvider } from '../providers/types.js'
import type { ProviderConfig } from '../loader/types.js'
import type { SubAgentWorkerData, MessageSender, WorkerMessage } from './types.js'
import { createClaudeProvider } from '../providers/claude.js'
import { createOpenAIProvider } from '../providers/openai.js'
import { createOllamaProvider } from '../providers/ollama.js'
import { createGeminiProvider } from '../providers/gemini.js'
import { ToolRegistry } from '../tools/types.js'
import { createReadTool } from '../tools/read.js'
import { createWriteTool } from '../tools/write.js'
import { createGrepTool } from '../tools/grep.js'
import { createShellTool } from '../tools/shell.js'
import { AgentLoop, createNoopHandler } from './agent-loop.js'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'

/**
 * プロバイダー名から LLMProvider を生成する
 *
 * @param name - プロバイダー名 ('claude' | 'openai' | 'ollama' | 'gemini')
 * @param config - プロバイダー設定
 * @param model - 使用するモデル名
 * @returns Result<LLMProvider> - 成功時はプロバイダー、失敗時はエラーメッセージ
 */
export function createProviderByName(
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

/**
 * サブエージェントを実行する
 *
 * Worker Thread 内で呼び出され、LLM プロバイダーの生成、ツール登録、
 * AgentLoop の step() 実行を行い、結果を MessageSender 経由で返す。
 *
 * @param data - Worker に渡されたサブエージェント設定データ
 * @param sender - メッセージ送信インターフェース
 */
export async function runSubAgent(data: SubAgentWorkerData, sender: MessageSender): Promise<void> {
  try {
    // 1. プロバイダー生成
    const providerResult = createProviderByName(data.providerName, data.providerConfig, data.model)

    if (!providerResult.ok) {
      sender.postMessage({ type: 'error', error: providerResult.error })
      return
    }

    // 2. ToolRegistry を作成し、ビルトインツールを登録
    const tools = new ToolRegistry()
    tools.register(createReadTool())
    tools.register(createWriteTool())
    tools.register(createGrepTool())
    tools.register(createShellTool())

    // 3. AgentLoop を作成
    const loop = new AgentLoop({
      provider: providerResult.data,
      tools,
      handler: createNoopHandler(),
      systemMessage: data.systemMessage,
    })

    // 4. step() を実行
    const stepResult = await loop.step(data.task)

    if (stepResult.ok) {
      sender.postMessage({ type: 'result', data: stepResult.data })
    } else {
      sender.postMessage({ type: 'error', error: stepResult.error })
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    sender.postMessage({ type: 'error', error: message })
  }
}

// Worker エントリポイント: Worker Thread として実行された場合のみ自動実行
if (!isMainThread && parentPort !== null) {
  const port = parentPort
  const data = workerData as SubAgentWorkerData
  const sender: MessageSender = {
    postMessage(msg: WorkerMessage): void {
      port.postMessage(msg)
    },
  }
  void runSubAgent(data, sender)
}
