/**
 * OpenAI LLM プロバイダー
 *
 * OpenAI Chat Completions API を使用してテキスト生成とツール呼び出しを行う。
 */
import OpenAI from 'openai'
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

/**
 * OpenAI のメッセージ形式に変換する
 *
 * AgentLoop からの3パターンを OpenAI API 形式にマッピングする:
 * 1. ツール結果メッセージ（user + toolCallId） → role: 'tool'
 * 2. アシスタントのツール呼び出しメッセージ（assistant + toolCalls） → role: 'assistant' + tool_calls
 * 3. 通常メッセージ → そのまま渡す
 */
function toOpenAIMessages(
  messages: readonly Message[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
    // パターン1: ツール結果メッセージ（user + toolCallId → tool ロールに変換）
    if (m.toolCallId) {
      const toolMsg: OpenAI.Chat.Completions.ChatCompletionToolMessageParam = {
        role: 'tool',
        content: m.content,
        tool_call_id: m.toolCallId,
      }
      return toolMsg
    }

    // パターン2: アシスタントのツール呼び出しメッセージ
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      }
      return assistantMsg
    }

    // パターン3: 通常メッセージ（system / user / assistant）
    if (m.role === 'system') {
      const sysMsg: OpenAI.Chat.Completions.ChatCompletionSystemMessageParam = {
        role: 'system',
        content: m.content,
      }
      return sysMsg
    }

    if (m.role === 'assistant') {
      const asstMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: m.content,
      }
      return asstMsg
    }

    // user ロール（toolCallId なし）
    const userMsg: OpenAI.Chat.Completions.ChatCompletionUserMessageParam = {
      role: 'user',
      content: m.content,
    }
    return userMsg
  })
}

/**
 * wn-core の Tool 定義を OpenAI のツール形式に変換する
 */
function toOpenAITools(tools: readonly Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

/**
 * JSON 文字列を安全にパースする
 *
 * パース失敗時は空オブジェクト {} にフォールバックする。
 */
function safeJsonParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * OpenAI の tool_calls を ToolCall[] に変換する
 *
 * ChatCompletionMessageToolCall はユニオン型（function | custom）なので、
 * type === 'function' のもののみを変換する。
 */
function toToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined | null,
): ToolCall[] {
  if (!toolCalls) return []
  return toolCalls
    .filter(
      (tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
        tc.type === 'function',
    )
    .map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeJsonParse(tc.function.arguments),
    }))
}

/**
 * OpenAI の usage を TokenUsage に変換する
 */
function toTokenUsage(
  usage: OpenAI.Completions.CompletionUsage | undefined | null,
): TokenUsage | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
  }
}

/**
 * ストリーミング中のツール呼び出しを蓄積する型
 */
interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
}

/**
 * OpenAI プロバイダーのファクトリ関数
 *
 * @param config - プロバイダー設定（apiKey 必須、baseUrl オプション）
 * @param model - 使用するモデル名（例: 'gpt-4o'）
 * @returns Result<LLMProvider> - 成功時はプロバイダーインスタンス、失敗時はエラー
 */
export function createOpenAIProvider(config: ProviderConfig, model: string): Result<LLMProvider> {
  if (!config.apiKey) {
    return err('OpenAI provider requires an API key')
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  })

  const provider: LLMProvider = {
    async complete(
      messages: readonly Message[],
      tools?: readonly Tool[],
    ): Promise<Result<LLMResponse>> {
      try {
        const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
          model,
          messages: toOpenAIMessages(messages),
          ...(tools && tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
        }

        const response = await client.chat.completions.create(params)
        const choice = response.choices[0]
        if (!choice) {
          return err('No choices in OpenAI response')
        }

        const content = choice.message.content ?? ''
        const toolCalls = toToolCalls(choice.message.tool_calls)
        const usage = toTokenUsage(response.usage)

        return ok({
          content,
          toolCalls,
          ...(usage ? { usage } : {}),
        })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return err(message)
      }
    },

    async *stream(
      messages: readonly Message[],
      tools?: readonly Tool[],
    ): AsyncIterable<StreamChunk> {
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model,
        messages: toOpenAIMessages(messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(tools && tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
      }

      const response = await client.chat.completions.create(params)

      // ストリーミング中のツール呼び出しを蓄積する
      const toolCallAccumulators = new Map<number, ToolCallAccumulator>()
      let doneEmitted = false

      for await (const chunk of response) {
        const choice = chunk.choices[0]

        if (choice) {
          const delta = choice.delta

          // テキスト delta
          if (delta.content) {
            yield { type: 'delta' as const, content: delta.content }
          }

          // ツール呼び出し delta
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              let acc = toolCallAccumulators.get(idx)

              if (!acc) {
                // 新しいツール呼び出しの開始
                acc = {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  arguments: '',
                }
                toolCallAccumulators.set(idx, acc)
              }

              // 引数の断片を蓄積
              if (tc.function?.arguments) {
                acc.arguments += tc.function.arguments
              }
            }
          }

          // finish_reason が 'stop' または 'tool_calls' のとき、蓄積したツール呼び出しを yield
          if (choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls') {
            for (const [, acc] of toolCallAccumulators) {
              yield {
                type: 'tool_call' as const,
                toolCall: {
                  id: acc.id,
                  name: acc.name,
                  arguments: safeJsonParse(acc.arguments),
                },
              }
            }
            toolCallAccumulators.clear()
          }
        }

        // usage チャンク（finish_reason と同じチャンクに含まれることもある）
        if (chunk.usage) {
          const usage = toTokenUsage(chunk.usage)
          doneEmitted = true
          yield { type: 'done' as const, ...(usage ? { usage } : {}) }
        }
      }

      // ストリーム完了後に done チャンクが来ていなければ最後に yield する
      if (!doneEmitted) {
        yield { type: 'done' as const }
      }
    },
  }

  return ok(provider)
}
