/** MCP サーバー設定 */
export interface McpServerConfig {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
}

/** MCP 設定 */
export interface McpConfig {
  readonly servers: readonly McpServerConfig[]
}

/** LLM プロバイダー設定 */
export interface ProviderConfig {
  readonly apiKey?: string
  readonly baseUrl?: string
}

/** wn-core グローバル設定 */
export interface WnConfig {
  readonly defaultProvider: string
  readonly defaultModel: string
  readonly defaultPersona: string
  readonly providers: Readonly<Record<string, ProviderConfig>>
  readonly mcp?: McpConfig
}

/** ペルソナ定義 */
export interface Persona {
  readonly name: string
  readonly content: string
}

/** スキル定義 */
export interface Skill {
  readonly name: string
  readonly description: string
  readonly tools: readonly string[]
  readonly body: string
}

/** エージェント定義 */
export interface AgentDef {
  readonly name: string
  readonly persona: string
  readonly skills: readonly string[]
  readonly provider: string
  readonly model: string
  readonly description: string
}

/** frontmatter パース結果 */
export interface FrontmatterResult {
  readonly attributes: Readonly<Record<string, string | readonly string[]>>
  readonly body: string
}

/** Loader エラーコード */
export type LoaderErrorCode = 'FILE_NOT_FOUND' | 'PARSE_ERROR' | 'VALIDATION_ERROR' | 'IO_ERROR'

/** Loader エラー */
export interface LoaderError {
  readonly code: LoaderErrorCode
  readonly message: string
  readonly path?: string
}
