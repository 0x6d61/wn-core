import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadConfig } from '../../src/loader/config-loader.js'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wn-config-test-'))
}

function writeConfig(dir: string, data: unknown): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(data), 'utf-8')
}

describe('loadConfig', () => {
  let globalDir: string
  let localDir: string

  beforeEach(() => {
    globalDir = makeTmpDir()
    localDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(globalDir, { recursive: true, force: true })
    fs.rmSync(localDir, { recursive: true, force: true })
  })

  // ── JSON 読み込み ──────────────────────────────────────────

  describe('JSON 読み込み', () => {
    it('グローバルの config.json を読み込める', async () => {
      writeConfig(globalDir, {
        defaultProvider: 'openai',
        defaultModel: 'gpt-4o',
      })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.defaultProvider).toBe('openai')
        expect(result.data.defaultModel).toBe('gpt-4o')
      }
    })

    it('ローカルの config.json がグローバルを上書きする', async () => {
      writeConfig(globalDir, {
        defaultProvider: 'openai',
        defaultModel: 'gpt-4o',
      })
      writeConfig(localDir, {
        defaultProvider: 'claude',
      })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.defaultProvider).toBe('claude')
        // グローバルの defaultModel は残る
        expect(result.data.defaultModel).toBe('gpt-4o')
      }
    })

    it('config.json が存在しない場合にデフォルト値を返す', async () => {
      // config.json を作らない
      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.defaultProvider).toBe('claude')
        expect(result.data.defaultModel).toBe('claude-sonnet-4-20250514')
        expect(result.data.defaultPersona).toBe('default')
        expect(result.data.providers).toStrictEqual({})
      }
    })

    it('不正な JSON に対してエラーを返す', async () => {
      fs.writeFileSync(path.join(globalDir, 'config.json'), '{invalid json}', 'utf-8')

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('PARSE_ERROR')
        expect(result.error.path).toContain('config.json')
      }
    })

    it('ディレクトリが存在しない場合にデフォルト値を返す', async () => {
      const nonExistentGlobal = path.join(globalDir, 'nonexistent')
      const nonExistentLocal = path.join(localDir, 'nonexistent')

      const result = await loadConfig(nonExistentGlobal, nonExistentLocal)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.defaultProvider).toBe('claude')
        expect(result.data.defaultModel).toBe('claude-sonnet-4-20250514')
        expect(result.data.defaultPersona).toBe('default')
        expect(result.data.providers).toStrictEqual({})
      }
    })
  })

  // ── ディープマージ ──────────────────────────────────────────

  describe('ディープマージ', () => {
    it('ネストされたオブジェクトを再帰的にマージする (providers object)', async () => {
      writeConfig(globalDir, {
        providers: {
          claude: { apiKey: '${CLAUDE_KEY}' },
          openai: { apiKey: '${OPENAI_KEY}' },
        },
      })
      writeConfig(localDir, {
        providers: {
          openai: { baseUrl: 'http://localhost:8080' },
        },
      })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        // claude プロバイダーはグローバルから維持される
        expect(result.data.providers['claude']).toBeDefined()
        // openai はマージされる（apiKey はグローバルから、baseUrl はローカルから）
        expect(result.data.providers['openai']?.apiKey).toBe('${OPENAI_KEY}')
        expect(result.data.providers['openai']?.baseUrl).toBe('http://localhost:8080')
      }
    })

    it('ローカルのプロパティがグローバルを上書きする (defaultProvider)', async () => {
      writeConfig(globalDir, { defaultProvider: 'openai' })
      writeConfig(localDir, { defaultProvider: 'claude' })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.defaultProvider).toBe('claude')
      }
    })

    it('配列は上書きされる（マージされない）(mcp.servers)', async () => {
      writeConfig(globalDir, {
        mcp: {
          servers: [{ name: 'global-server', command: 'cmd1', args: [] }],
        },
      })
      writeConfig(localDir, {
        mcp: {
          servers: [{ name: 'local-server', command: 'cmd2', args: ['--flag'] }],
        },
      })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.mcp?.servers).toHaveLength(1)
        expect(result.data.mcp?.servers[0]?.name).toBe('local-server')
      }
    })

    it('グローバルにないプロパティがローカルから追加される', async () => {
      writeConfig(globalDir, { defaultProvider: 'openai' })
      writeConfig(localDir, { defaultPersona: 'pentester' })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.defaultProvider).toBe('openai')
        expect(result.data.defaultPersona).toBe('pentester')
      }
    })
  })

  // ── CLI オーバーライド ──────────────────────────────────────

  describe('CLI オーバーライド', () => {
    it('defaultProvider を CLI から上書きできる', async () => {
      writeConfig(globalDir, { defaultProvider: 'openai' })

      const result = await loadConfig(globalDir, localDir, {
        defaultProvider: 'ollama',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.defaultProvider).toBe('ollama')
      }
    })

    it('defaultModel を CLI から上書きできる', async () => {
      writeConfig(globalDir, { defaultModel: 'gpt-4o' })

      const result = await loadConfig(globalDir, localDir, {
        defaultModel: 'claude-opus-4-20250514',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.defaultModel).toBe('claude-opus-4-20250514')
      }
    })

    it('defaultPersona を CLI から上書きできる', async () => {
      writeConfig(globalDir, { defaultPersona: 'default' })

      const result = await loadConfig(globalDir, localDir, {
        defaultPersona: 'pentester',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.defaultPersona).toBe('pentester')
      }
    })

    it('CLI オーバーライドが undefined の場合は何もしない', async () => {
      writeConfig(globalDir, {
        defaultProvider: 'openai',
        defaultModel: 'gpt-4o',
        defaultPersona: 'default',
      })

      const result = await loadConfig(globalDir, localDir, {
        defaultProvider: undefined,
        defaultModel: undefined,
        defaultPersona: undefined,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.defaultProvider).toBe('openai')
        expect(result.data.defaultModel).toBe('gpt-4o')
        expect(result.data.defaultPersona).toBe('default')
      }
    })
  })

  // ── 環境変数置換 ──────────────────────────────────────────

  describe('環境変数置換', () => {
    beforeEach(() => {
      process.env['WN_TEST_API_KEY'] = 'sk-test-12345'
      process.env['WN_TEST_BASE_URL'] = 'http://localhost:9090'
    })

    afterEach(() => {
      delete process.env['WN_TEST_API_KEY']
      delete process.env['WN_TEST_BASE_URL']
    })

    it('${VAR_NAME} を process.env の値に置換する', async () => {
      writeConfig(globalDir, {
        providers: {
          claude: { apiKey: '${WN_TEST_API_KEY}' },
        },
      })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.providers['claude']?.apiKey).toBe('sk-test-12345')
      }
    })

    it('未定義の環境変数は元の文字列のまま残す', async () => {
      writeConfig(globalDir, {
        providers: {
          claude: { apiKey: '${UNDEFINED_VAR_XXXXXX}' },
        },
      })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.providers['claude']?.apiKey).toBe('${UNDEFINED_VAR_XXXXXX}')
      }
    })

    it('ネストされたオブジェクト内の文字列も置換する', async () => {
      writeConfig(globalDir, {
        providers: {
          openai: {
            apiKey: '${WN_TEST_API_KEY}',
            baseUrl: '${WN_TEST_BASE_URL}',
          },
        },
      })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.providers['openai']?.apiKey).toBe('sk-test-12345')
        expect(result.data.providers['openai']?.baseUrl).toBe('http://localhost:9090')
      }
    })

    it('配列内の文字列も置換する (mcp.servers[].command)', async () => {
      writeConfig(globalDir, {
        mcp: {
          servers: [
            {
              name: 'test',
              command: '${WN_TEST_BASE_URL}/bin',
              args: ['--key', '${WN_TEST_API_KEY}'],
            },
          ],
        },
      })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.mcp?.servers[0]?.command).toBe('http://localhost:9090/bin')
        expect(result.data.mcp?.servers[0]?.args[0]).toBe('--key')
        expect(result.data.mcp?.servers[0]?.args[1]).toBe('sk-test-12345')
      }
    })

    it('文字列以外の値は変更しない', async () => {
      writeConfig(globalDir, {
        providers: {
          claude: { apiKey: '${WN_TEST_API_KEY}' },
        },
        mcp: {
          servers: [{ name: 'test', command: 'cmd', args: [] }],
        },
      })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        // 配列は配列のまま
        expect(Array.isArray(result.data.mcp?.servers)).toBe(true)
        // オブジェクトはオブジェクトのまま
        expect(typeof result.data.providers).toBe('object')
      }
    })
  })

  // ── デフォルト値 ──────────────────────────────────────────

  describe('デフォルト値', () => {
    it('defaultProvider が未指定の場合に "claude" をデフォルトとする', async () => {
      writeConfig(globalDir, {
        defaultModel: 'some-model',
      })

      const result = await loadConfig(globalDir, localDir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.defaultProvider).toBe('claude')
        expect(result.data.defaultModel).toBe('some-model')
        expect(result.data.defaultPersona).toBe('default')
        expect(result.data.providers).toStrictEqual({})
      }
    })
  })
})
