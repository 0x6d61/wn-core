/**
 * Gemini LLM プロバイダー
 *
 * Google Generative AI SDK を使用して Gemini モデルと通信する。
 * system メッセージは systemInstruction パラメータとして分離し、
 * ツール呼び出しには crypto.randomUUID() で ID を生成する。
 */
import { GoogleGenerativeAI } from '@google/generative-ai'
import type {
  GenerateContentRequest,
  Content as GeminiSdkContent,
  FunctionDeclarationsTool,
} from '@google/generative-ai'
import { randomUUID } from 'node:crypto'
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

/** Gemini レスポンスの Part 型（レスポンス解析用） */
interface GeminiResponsePart {
  readonly text?: string
  readonly functionCall?: {
    readonly name: string
    readonly args: Record<string, unknown>
  }
}

/**
 * メッセージ配列から system メッセージを分離し、
 * Gemini 形式の contents と systemInstruction に変換する。
 */
function separateSystemMessages(messages: readonly Message[]): {
  contents: GeminiSdkContent[]
  systemInstruction: GeminiSdkContent | undefined
} {
  const systemMessages = messages.filter((m) => m.role === 'system')
  const nonSystemMessages = messages.filter((m) => m.role !== 'system')

  const systemInstruction: GeminiSdkContent | undefined =
    systemMessages.length > 0
      ? {
          role: 'system',
          parts: systemMessages.map((m) => ({ text: m.content })),
        }
      : undefined

  const contents: GeminiSdkContent[] = nonSystemMessages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : m.role,
    parts: [{ text: m.content }],
  }))

  return { contents, systemInstruction }
}

/**
 * wn-core の Tool[] を Gemini 固有のツール形式に変換する。
 *
 * Gemini SDK の FunctionDeclaration.parameters は FunctionDeclarationSchema 型を要求するが、
 * wn-core の Tool.parameters は Record<string, unknown>（JSON Schema）で定義されている。
 * SDK 内部では JSON としてシリアライズされるため、構造的には互換性がある。
 */
function convertTools(tools: readonly Tool[]): FunctionDeclarationsTool[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // wn-core の JsonSchema (Record<string, unknown>) を SDK の FunctionDeclarationSchema に変換
        // SDK 内部では JSON シリアライズされるため構造互換性あり
        parameters: t.parameters as FunctionDeclarationsTool['functionDeclarations'] extends Array<
          infer D
        >
          ? D extends { parameters?: infer P }
            ? P
            : never
          : never,
      })),
    },
  ]
}

/**
 * Gemini レスポンスの parts から content 文字列と ToolCall[] を抽出する。
 */
function extractPartsData(parts: readonly GeminiResponsePart[]): {
  content: string
  toolCalls: ToolCall[]
} {
  let content = ''
  const toolCalls: ToolCall[] = []

  for (const part of parts) {
    if (part.text) {
      content += part.text
    }
    if (part.functionCall) {
      toolCalls.push({
        id: randomUUID(),
        name: part.functionCall.name,
        arguments: part.functionCall.args,
      })
    }
  }

  return { content, toolCalls }
}

/**
 * Gemini の usageMetadata を TokenUsage に変換する。
 */
function convertUsage(usageMetadata?: {
  promptTokenCount?: number
  candidatesTokenCount?: number
}): TokenUsage | undefined {
  if (!usageMetadata) return undefined
  return {
    inputTokens: usageMetadata.promptTokenCount ?? 0,
    outputTokens: usageMetadata.candidatesTokenCount ?? 0,
  }
}

/**
 * リクエストパラメータを構築する。
 */
function buildRequest(
  contents: GeminiSdkContent[],
  systemInstruction: GeminiSdkContent | undefined,
  tools: readonly Tool[] | undefined,
): GenerateContentRequest {
  const request: GenerateContentRequest = { contents }

  if (systemInstruction) {
    request.systemInstruction = systemInstruction
  }

  if (tools && tools.length > 0) {
    request.tools = convertTools(tools)
  }

  return request
}

/**
 * Gemini プロバイダーを生成するファクトリ関数。
 *
 * @param config - プロバイダー設定（apiKey 必須）
 * @param model - 使用するモデル名（例: 'gemini-pro'）
 * @returns Result<LLMProvider> - 成功時は LLMProvider、失敗時はエラーメッセージ
 */
export function createGeminiProvider(config: ProviderConfig, model: string): Result<LLMProvider> {
  if (!config.apiKey) {
    return err('Gemini provider requires an API key')
  }

  const genAI = new GoogleGenerativeAI(config.apiKey)
  const generativeModel = genAI.getGenerativeModel({ model })

  const provider: LLMProvider = {
    async complete(
      messages: readonly Message[],
      tools?: readonly Tool[],
    ): Promise<Result<LLMResponse>> {
      try {
        const { contents, systemInstruction } = separateSystemMessages(messages)
        const requestParams = buildRequest(contents, systemInstruction, tools)

        const result = await generativeModel.generateContent(requestParams)
        const response = result.response

        // candidates は SDK の型定義では non-nullable だが、実際の API レスポンスでは
        // undefined になる場合があるため、明示的に undefined 許容型に広げて安全にアクセスする
        const candidates: typeof response.candidates | undefined = response.candidates
        const firstCandidate = candidates === undefined ? undefined : candidates[0]
        const parts: GeminiResponsePart[] =
          firstCandidate === undefined ? [] : (firstCandidate.content.parts as GeminiResponsePart[])

        const { content, toolCalls } = extractPartsData(parts)
        const usage = convertUsage(response.usageMetadata)

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
      const { contents, systemInstruction } = separateSystemMessages(messages)
      const requestParams = buildRequest(contents, systemInstruction, tools)

      const streamResult = await generativeModel.generateContentStream(requestParams)

      for await (const chunk of streamResult.stream) {
        // candidates は SDK の型定義では non-nullable だが、実際の API レスポンスでは
        // undefined になる場合があるため、明示的に undefined 許容型に広げて安全にアクセスする
        const candidates: typeof chunk.candidates | undefined = chunk.candidates
        const firstCandidate = candidates === undefined ? undefined : candidates[0]
        const parts: GeminiResponsePart[] =
          firstCandidate === undefined ? [] : (firstCandidate.content.parts as GeminiResponsePart[])

        for (const part of parts) {
          if (part.text) {
            yield { type: 'delta' as const, content: part.text }
          }
          if (part.functionCall) {
            yield {
              type: 'tool_call' as const,
              toolCall: {
                id: randomUUID(),
                name: part.functionCall.name,
                arguments: part.functionCall.args,
              },
            }
          }
        }
      }

      // ストリーム完了後に usage を取得
      const finalResponse = await streamResult.response
      const usage = convertUsage(finalResponse.usageMetadata)
      yield { type: 'done' as const, usage }
    },
  }

  return ok(provider)
}
