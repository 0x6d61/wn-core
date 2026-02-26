import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolDefinition, ToolResult } from './types.js'
import { requireString, optionalNumber } from './validate.js'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 10 * 1024 * 1024 // 10 MB

export interface ShellConfig {
  readonly shell: string
  readonly buildArgs: (command: string) => string[]
}

export function getShellConfig(platform: string): ShellConfig {
  if (platform === 'win32') {
    return {
      shell: 'powershell.exe',
      buildArgs: (cmd: string): string[] => ['-NoProfile', '-Command', cmd],
    }
  }
  return {
    shell: '/bin/sh',
    buildArgs: (cmd: string): string[] => ['-c', cmd],
  }
}

/** execFile が投げるエラーの型ガード（`as` キャスト回避） */
function isExecError(e: unknown): e is Error & { stdout: string; stderr: string; killed: boolean } {
  return e instanceof Error && 'stdout' in e && 'stderr' in e
}

/** shell ビルトインツールを生成する */
export function createShellTool(): ToolDefinition {
  return {
    name: 'shell',
    description: 'Execute a shell command. Uses /bin/sh on Unix and powershell.exe on Windows.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds. Default: no timeout (0)',
        },
      },
      required: ['command'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      // --- validate command ---
      const commandResult = requireString(args, 'command')
      if ('error' in commandResult) return commandResult.error

      // --- validate timeout ---
      const timeoutResult = optionalNumber(args, 'timeout', 1)
      if ('error' in timeoutResult) return timeoutResult.error

      const timeout = timeoutResult.value ?? 0 // 0 = no timeout
      const config = getShellConfig(process.platform)

      try {
        const { stdout, stderr } = await execFileAsync(
          config.shell,
          config.buildArgs(commandResult.value),
          { timeout, maxBuffer: MAX_BUFFER },
        )

        const output = stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout
        return { ok: true, output }
      } catch (e: unknown) {
        if (isExecError(e)) {
          if (e.killed) {
            return {
              ok: false,
              output: e.stdout,
              error: `Command timed out after ${String(timeout)}ms`,
            }
          }
          return {
            ok: false,
            output: e.stdout,
            error: e.stderr || e.message,
          }
        }
        const message = e instanceof Error ? e.message : String(e)
        return { ok: false, output: '', error: message }
      }
    },
  }
}
