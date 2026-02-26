import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ToolDefinition, ToolResult } from './types.js'
import { requireString } from './validate.js'

/**
 * write ツールを生成するファクトリ関数
 *
 * 指定されたパスにファイルを書き込む。
 * 親ディレクトリが存在しない場合は自動作成する。
 */
export function createWriteTool(): ToolDefinition {
  return {
    name: 'write',
    description: 'Write content to a file. Creates parent directories if they do not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative file path to write to',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      // path バリデーション（空文字列は不可）
      const pathResult = requireString(args, 'path')
      if ('error' in pathResult) {
        return pathResult.error
      }

      // content バリデーション（空文字列は許可するため requireString は使わない）
      const contentVal = args['content']
      if (typeof contentVal !== 'string') {
        return {
          ok: false,
          output: '',
          error: "Parameter 'content' is required and must be a string",
        }
      }

      try {
        const resolved = path.resolve(pathResult.value)
        const dir = path.dirname(resolved)

        // 親ディレクトリを再帰的に作成
        await fs.promises.mkdir(dir, { recursive: true })

        // ファイルに書き込み
        await fs.promises.writeFile(resolved, contentVal, 'utf-8')

        const byteCount = Buffer.byteLength(contentVal, 'utf-8')
        return {
          ok: true,
          output: `Wrote ${String(byteCount)} bytes to ${resolved}`,
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          ok: false,
          output: '',
          error: msg,
        }
      }
    },
  }
}
