import Anthropic from '@anthropic-ai/sdk'
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
 * Anthropic Messages API のレスポンス型（必要なフィールドのみ）
 *
 * SDK の Message 型をそのまま使わず、必要なフィールドだけを抽出して
 * 型安全にアクセスする。
 */
interface AnthropicMessage {
  readonly content: ReadonlyArray<AnthropicContentBlock>
  readonly usage: {
    readonly input_tokens: number
    readonly output_tokens: number
  }
}

interface AnthropicTextBlock {
  readonly type: 'text'
  readonly text: string
}

interface AnthropicToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: unknown
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | { readonly type: string }

/**
 * ストリームイベント型
 */
interface StreamContentBlockStartEvent {
  readonly type: 'content_block_start'
  readonly index: number
  readonly content_block: {
    readonly type: string
    readonly id?: string
    readonly name?: string
  }
}

interface StreamContentBlockDeltaEvent {
  readonly type: 'content_block_delta'
  readonly index: number
  readonly delta: {
    readonly type: string
    readonly text?: string
    readonly partial_json?: string
  }
}

interface StreamContentBlockStopEvent {
  readonly type: 'content_block_stop'
  readonly index: number
}

interface StreamMessageStopEvent {
  readonly type: 'message_stop'
}

type StreamEvent =
  | StreamContentBlockStartEvent
  | StreamContentBlockDeltaEvent
  | StreamContentBlockStopEvent
  | StreamMessageStopEvent
  | { readonly type: string }

/**
 * MessageStream モック互換のインターフェース
 */
interface MessageStreamLike extends AsyncIterable<StreamEvent> {
  finalMessage(): Promise<AnthropicMessage>
}

/** content 配列からテキスト部分を結合する */
function extractText(content: ReadonlyArray<AnthropicContentBlock>): string {
  return content
    .filter((block): block is AnthropicTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** content 配列から ToolCall[] を抽出する */
function extractToolCalls(content: ReadonlyArray<AnthropicContentBlock>): ToolCall[] {
  return content
    .filter((block): block is AnthropicToolUseBlock => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments:
        block.input != null && typeof block.input === 'object'
          ? (block.input as Record<string, unknown>)
          : {},
    }))
}

/** Usage を TokenUsage に変換する */
function mapUsage(usage: {
  readonly input_tokens: number
  readonly output_tokens: number
}): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  }
}

/** messages から system メッセージを分離する */
function separateSystemMessages(messages: readonly Message[]): {
  system: string | undefined
  nonSystemMessages: Array<{ role: 'user' | 'assistant'; content: string }>
} {
  const systemMessages = messages.filter((m) => m.role === 'system')
  const nonSystemMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const system =
    systemMessages.length > 0 ? systemMessages.map((m) => m.content).join('\n') : undefined

  return { system, nonSystemMessages }
}

/** Tool[] を Claude API 固有形式に変換する */
function convertTools(
  tools: readonly Tool[],
): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
}

/**
 * Claude (Anthropic) LLM プロバイダーを作成する
 *
 * @param config - プロバイダー設定（apiKey 必須）
 * @param model - 使用するモデル名（例: 'claude-sonnet-4-20250514'）
 * @returns Result<LLMProvider> - 成功時は LLMProvider、失敗時はエラーメッセージ
 */
export function createClaudeProvider(config: ProviderConfig, model: string): Result<LLMProvider> {
  if (!config.apiKey) {
    return err('Claude provider requires an API key')
  }

  const clientOptions: Record<string, unknown> = {
    apiKey: config.apiKey,
  }
  if (config.baseUrl) {
    clientOptions['baseURL'] = config.baseUrl
  }

  const client = new Anthropic(clientOptions as ConstructorParameters<typeof Anthropic>[0])

  const provider: LLMProvider = {
    async complete(
      messages: readonly Message[],
      tools?: readonly Tool[],
    ): Promise<Result<LLMResponse>> {
      try {
        const { system, nonSystemMessages } = separateSystemMessages(messages)

        const params: Record<string, unknown> = {
          model,
          max_tokens: 4096,
          messages: nonSystemMessages,
        }

        if (system !== undefined) {
          params['system'] = system
        }

        if (tools && tools.length > 0) {
          params['tools'] = convertTools(tools)
        }

        const response = (await client.messages.create(
          params as unknown as Parameters<typeof client.messages.create>[0],
        )) as unknown as AnthropicMessage

        const content = extractText(response.content)
        const toolCalls = extractToolCalls(response.content)
        const usage = mapUsage(response.usage)

        return ok({
          content,
          toolCalls,
          usage,
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
      const { system, nonSystemMessages } = separateSystemMessages(messages)

      const params: Record<string, unknown> = {
        model,
        max_tokens: 4096,
        messages: nonSystemMessages,
      }

      if (system !== undefined) {
        params['system'] = system
      }

      if (tools && tools.length > 0) {
        params['tools'] = convertTools(tools)
      }

      const stream = client.messages.stream(
        params as unknown as Parameters<typeof client.messages.stream>[0],
      ) as unknown as MessageStreamLike

      // ストリームイベントごとの状態管理
      // tool_use ブロックの追跡: index → { id, name, inputJson }
      const toolBlocks = new Map<number, { id: string; name: string; inputJson: string }>()

      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start': {
            const startEvent = event as StreamContentBlockStartEvent
            if (startEvent.content_block.type === 'tool_use') {
              toolBlocks.set(startEvent.index, {
                id: startEvent.content_block.id ?? '',
                name: startEvent.content_block.name ?? '',
                inputJson: '',
              })
            }
            break
          }

          case 'content_block_delta': {
            const deltaEvent = event as StreamContentBlockDeltaEvent
            if (deltaEvent.delta.type === 'text_delta' && deltaEvent.delta.text !== undefined) {
              yield { type: 'delta', content: deltaEvent.delta.text }
            } else if (
              deltaEvent.delta.type === 'input_json_delta' &&
              deltaEvent.delta.partial_json !== undefined
            ) {
              const block = toolBlocks.get(deltaEvent.index)
              if (block) {
                block.inputJson += deltaEvent.delta.partial_json
              }
            }
            break
          }

          case 'content_block_stop': {
            const stopEvent = event as StreamContentBlockStopEvent
            const block = toolBlocks.get(stopEvent.index)
            if (block) {
              let parsedArgs: Record<string, unknown> = {}
              try {
                parsedArgs = JSON.parse(block.inputJson) as Record<string, unknown>
              } catch {
                // JSON パース失敗時は空オブジェクトにフォールバック
              }
              yield {
                type: 'tool_call',
                toolCall: {
                  id: block.id,
                  name: block.name,
                  arguments: parsedArgs,
                },
              }
              toolBlocks.delete(stopEvent.index)
            }
            break
          }

          case 'message_stop': {
            // finalMessage() から usage を取得
            const finalMsg = await stream.finalMessage()
            const usage = mapUsage(finalMsg.usage)
            yield { type: 'done', usage }
            break
          }

          default:
            // 他のイベントタイプ（message_start, message_delta 等）は無視
            break
        }
      }
    },
  }

  return ok(provider)
}
