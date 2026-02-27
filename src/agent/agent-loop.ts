import type { Result } from '../result.js'
import { ok, err } from '../result.js'
import type { Message, Tool } from '../providers/types.js'
import type { AgentLoopHandler, AgentLoopOptions, AgentLoopState } from './types.js'

/**
 * AgentLoop — LLMProvider + ToolRegistry を接続する対話ループ
 *
 * step() で1回の対話ターンを処理し、
 * run() で継続的ループを実行する。
 */
export class AgentLoop {
  private readonly options: Required<
    Pick<AgentLoopOptions, 'provider' | 'tools' | 'handler' | 'maxToolRounds'>
  > &
    Pick<AgentLoopOptions, 'signal'>

  private state: AgentLoopState = 'idle'
  private readonly messages: Message[] = []

  constructor(opts: AgentLoopOptions) {
    this.options = {
      provider: opts.provider,
      tools: opts.tools,
      handler: opts.handler,
      maxToolRounds: opts.maxToolRounds ?? Infinity,
      signal: opts.signal,
    }

    if (opts.systemMessage !== undefined) {
      this.messages.push({ role: 'system', content: opts.systemMessage })
    }
  }

  /** 現在の状態 */
  getState(): AgentLoopState {
    return this.state
  }

  /** メッセージ履歴（読み取り専用） */
  getMessages(): readonly Message[] {
    return this.messages
  }

  /**
   * 1回の対話ターンを処理する。
   * ツール呼び出しがなくなるか maxToolRounds に達するまでループ。
   */
  async step(input: string): Promise<Result<string>> {
    // abort チェック
    if (this.options.signal?.aborted) {
      return err('Aborted')
    }

    this.messages.push({ role: 'user', content: input })

    const { provider, tools, handler, maxToolRounds } = this.options

    // ToolDefinition[] → Tool[] 変換
    const toolDefs = tools.list()
    const llmTools: readonly Tool[] = toolDefs.map((td) => ({
      name: td.name,
      description: td.description,
      parameters: td.parameters,
    }))

    let toolRound = 0

    while (toolRound < maxToolRounds) {
      // abort チェック
      if (this.options.signal?.aborted) {
        return err('Aborted')
      }

      await this.setState('thinking')

      const llmResult = await provider.complete(this.messages, llmTools)

      if (!llmResult.ok) {
        await handler.onError(llmResult.error)
        return err(llmResult.error)
      }

      const response = llmResult.data

      // usage 通知
      if (response.usage && handler.onUsage) {
        await handler.onUsage(response.usage)
      }

      // ツール呼び出しなし → テキスト応答で終了
      if (!response.toolCalls || response.toolCalls.length === 0) {
        this.messages.push({ role: 'assistant', content: response.content })
        await handler.onResponse(response.content)
        await this.setState('idle')
        return ok(response.content)
      }

      // ツール呼び出しあり
      this.messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      })

      // 中間テキストがあれば通知
      if (response.content) {
        await handler.onResponse(response.content)
      }

      // 各ツール呼び出しを順番に実行
      for (const toolCall of response.toolCalls) {
        // abort チェック
        if (this.options.signal?.aborted) {
          return err('Aborted')
        }

        const tool = tools.get(toolCall.name)

        if (!tool) {
          // 未登録ツール → エラーメッセージをフィードバック
          const errorOutput = `Tool not found: ${toolCall.name}`
          this.messages.push({
            role: 'user',
            content: errorOutput,
            toolCallId: toolCall.id,
            name: toolCall.name,
          })
          continue
        }

        await this.setState('tool_running')
        await handler.onToolStart(toolCall.name, toolCall.arguments)

        const result = await tool.execute(toolCall.arguments)

        this.messages.push({
          role: 'user',
          content: result.output,
          toolCallId: toolCall.id,
          name: toolCall.name,
        })

        await handler.onToolEnd(toolCall.name, result)
      }

      toolRound++
    }

    // maxToolRounds 到達
    const errorMsg = `Max tool rounds (${String(maxToolRounds)}) reached`
    await handler.onError(errorMsg)
    return err(errorMsg)
  }

  /**
   * 継続的ループ。inputSource から入力を取得して step() を呼ぶ。
   * AbortSignal または loopHook で終了。
   */
  async run(
    inputSource: AsyncIterable<string>,
    loopHook?: (loop: AgentLoop) => Promise<boolean>,
  ): Promise<Result<void>> {
    for await (const input of inputSource) {
      // abort チェック
      if (this.options.signal?.aborted) {
        return err('Aborted')
      }

      await this.step(input)

      // loopHook が true を返したら終了
      if (loopHook) {
        const shouldStop = await loopHook(this)
        if (shouldStop) {
          return ok(undefined)
        }
      }
    }

    return ok(undefined)
  }

  private async setState(newState: AgentLoopState): Promise<void> {
    this.state = newState
    await this.options.handler.onStateChange(newState)
  }
}

/** テスト用のノーオペレーションハンドラ */
export function createNoopHandler(): AgentLoopHandler {
  const noop = (): void => {}
  return {
    onResponse: noop,
    onToolStart: noop,
    onToolEnd: noop,
    onStateChange: noop,
    onError: noop,
    onUsage: noop,
  }
}
