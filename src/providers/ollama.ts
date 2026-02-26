/**
 * Ollama LLM プロバイダー
 *
 * Ollama の /api/chat エンドポイントに対して、native fetch のみで通信する。
 * SDK 不使用。OpenAI 互換のメッセージ・ツール形式を採用。
 */
import { ok, err } from '../result.js'
import type { Result } from '../result.js'
import type {
  LLMProvider,
  LLMResponse,
  Message,
  Tool,
  ToolCall,
  StreamChunk,
  TokenUsage,
} from './types.js'
import type { ProviderConfig } from '../loader/types.js'

// ─── 内部型定義（Ollama API レスポンス） ───────────────────

/** Ollama /api/chat レスポンス内の tool_call */
interface OllamaToolCall {
  readonly function: {
    readonly name: string
    readonly arguments: Record<string, unknown>
  }
}

/** Ollama /api/chat レスポンスのメッセージ部分 */
interface OllamaChatMessage {
  readonly role: string
  readonly content?: string
  readonly tool_calls?: readonly OllamaToolCall[]
}

/** Ollama /api/chat 非ストリーミングレスポンス */
interface OllamaChatResponse {
  readonly message: OllamaChatMessage
  readonly prompt_eval_count?: number
  readonly eval_count?: number
}

/** Ollama /api/chat ストリーミングチャンク */
interface OllamaStreamChunk {
  readonly message?: OllamaChatMessage
  readonly done: boolean
  readonly prompt_eval_count?: number
  readonly eval_count?: number
}

// ─── ツール形式変換（OpenAI 互換） ───────────────────────

interface OpenAIToolFormat {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

function convertToolsToOpenAIFormat(tools: readonly Tool[]): readonly OpenAIToolFormat[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

// ─── OllamaToolCall → ToolCall 変換 ─────────────────────

function convertToolCalls(ollamaToolCalls: readonly OllamaToolCall[]): readonly ToolCall[] {
  return ollamaToolCalls.map((tc) => ({
    id: crypto.randomUUID(),
    name: tc.function.name,
    arguments: tc.function.arguments,
  }))
}

// ─── TokenUsage 変換 ────────────────────────────────────

function convertUsage(promptEvalCount?: number, evalCount?: number): TokenUsage | undefined {
  if (promptEvalCount === undefined && evalCount === undefined) {
    return undefined
  }
  return {
    inputTokens: promptEvalCount ?? 0,
    outputTokens: evalCount ?? 0,
  }
}

// ─── NDJSON パーサー ────────────────────────────────────

async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) yield JSON.parse(trimmed) as unknown
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer.trim()) as unknown
  } finally {
    reader.releaseLock()
  }
}

// ─── メッセージ変換（AgentLoop → Ollama API） ──────────────

/**
 * Ollama API に送信するメッセージの型
 *
 * Ollama は OpenAI 互換のため、ツール結果は role: 'tool'、
 * assistant のツール呼び出しは tool_calls フィールドで送信する。
 */
interface OllamaRequestMessage {
  readonly role: string
  readonly content: string
  readonly tool_calls?: ReadonlyArray<{
    readonly function: {
      readonly name: string
      readonly arguments: string
    }
  }>
}

/**
 * AgentLoop の Message 配列を Ollama API 形式に変換する
 *
 * 3 パターンを処理する:
 * 1. ツール結果メッセージ (role:'user' + toolCallId) → { role: 'tool', content }
 * 2. assistant + toolCalls → { role: 'assistant', content, tool_calls }
 * 3. 通常メッセージ → { role, content }
 */
function toOllamaMessages(messages: readonly Message[]): readonly OllamaRequestMessage[] {
  return messages.map((m): OllamaRequestMessage => {
    // Case 1: ツール結果メッセージ → role: 'tool'
    if (m.toolCallId !== undefined) {
      return { role: 'tool', content: m.content }
    }

    // Case 2: assistant がツール呼び出しを含む場合
    if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
      return {
        role: m.role,
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      }
    }

    // Case 3: 通常メッセージ
    return { role: m.role, content: m.content }
  })
}

// ─── ファクトリ関数 ──────────────────────────────────────

/**
 * Ollama プロバイダーを生成する
 *
 * API キーは不要。config.baseUrl のデフォルトは http://localhost:11434。
 */
export function createOllamaProvider(config: ProviderConfig, model: string): Result<LLMProvider> {
  const baseUrl = config.baseUrl ?? 'http://localhost:11434'

  const provider: LLMProvider = {
    async complete(
      messages: readonly Message[],
      tools?: readonly Tool[],
    ): Promise<Result<LLMResponse>> {
      const requestBody: Record<string, unknown> = {
        model,
        messages: toOllamaMessages(messages),
        stream: false,
      }

      if (tools && tools.length > 0) {
        requestBody['tools'] = convertToolsToOpenAIFormat(tools)
      }

      try {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          const text = await response.text()
          return err(`Ollama API error (${String(response.status)}): ${text}`)
        }

        const data = (await response.json()) as OllamaChatResponse
        const content = data.message.content ?? ''
        const toolCalls =
          data.message.tool_calls && data.message.tool_calls.length > 0
            ? convertToolCalls(data.message.tool_calls)
            : undefined
        const usage = convertUsage(data.prompt_eval_count, data.eval_count)

        const llmResponse: LLMResponse = {
          content,
          ...(toolCalls ? { toolCalls } : {}),
          ...(usage ? { usage } : {}),
        }

        return ok(llmResponse)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return err(`Ollama fetch error: ${message}`)
      }
    },

    async *stream(
      messages: readonly Message[],
      tools?: readonly Tool[],
    ): AsyncIterable<StreamChunk> {
      const requestBody: Record<string, unknown> = {
        model,
        messages: toOllamaMessages(messages),
        stream: true,
      }

      if (tools && tools.length > 0) {
        requestBody['tools'] = convertToolsToOpenAIFormat(tools)
      }

      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Ollama API error (${String(response.status)}): ${text}`)
      }

      if (!response.body) {
        throw new Error('Ollama stream: response body is null')
      }

      for await (const raw of parseNdjson(response.body)) {
        const chunk = raw as OllamaStreamChunk

        // ツール呼び出しチャンク
        if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
          for (const tc of chunk.message.tool_calls) {
            yield {
              type: 'tool_call' as const,
              toolCall: {
                id: crypto.randomUUID(),
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }
          }
        }
        // テキストデルタチャンク
        else if (chunk.message?.content && !chunk.done) {
          yield { type: 'delta' as const, content: chunk.message.content }
        }

        // 完了チャンク
        if (chunk.done) {
          const usage = convertUsage(chunk.prompt_eval_count, chunk.eval_count)
          yield { type: 'done' as const, ...(usage ? { usage } : {}) }
        }
      }
    },
  }

  return ok(provider)
}
