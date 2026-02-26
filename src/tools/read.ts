import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ToolDefinition, ToolResult } from './types.js'
import { requireString } from './validate.js'
import { optionalNumber } from './validate.js'

/** read ビルトインツールを生成する */
export function createReadTool(): ToolDefinition {
  return {
    name: 'read',
    description: 'Read the contents of a file. Supports offset (1-based line number) and limit.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read (absolute or relative)' },
        offset: {
          type: 'number',
          description: 'Start reading from this line number (1-based)',
        },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['path'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      // --- validate path ---
      const pathResult = requireString(args, 'path')
      if ('error' in pathResult) return pathResult.error

      // --- validate offset ---
      const offsetResult = optionalNumber(args, 'offset', 1)
      if ('error' in offsetResult) return offsetResult.error

      // --- validate limit ---
      const limitResult = optionalNumber(args, 'limit', 1)
      if ('error' in limitResult) return limitResult.error

      const resolvedPath = path.resolve(pathResult.value)
      const offset = offsetResult.value
      const limit = limitResult.value

      try {
        const stat = await fs.promises.stat(resolvedPath)

        if (!stat.isFile()) {
          return {
            ok: false,
            output: '',
            error: `Path is not a file: ${resolvedPath}`,
          }
        }

        const content = await fs.promises.readFile(resolvedPath, 'utf-8')

        if (content.length === 0) {
          return { ok: true, output: '' }
        }

        let lines = content.split('\n')

        // Remove trailing empty string from split if file ends with newline
        if (lines.length > 0 && lines[lines.length - 1] === '') {
          lines = lines.slice(0, -1)
        }

        // Apply offset (1-based)
        if (offset !== undefined) {
          lines = lines.slice(offset - 1)
        }

        // Apply limit
        if (limit !== undefined) {
          lines = lines.slice(0, limit)
        }

        return { ok: true, output: lines.join('\n') }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return { ok: false, output: '', error: msg }
      }
    },
  }
}
