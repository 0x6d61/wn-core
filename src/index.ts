export const VERSION = '0.1.0' as const

// Result
export type { Result } from './result.js'
export { ok, err } from './result.js'

// LLM Provider types
export type {
  JsonSchema,
  Message,
  Tool,
  ToolCall,
  TokenUsage,
  LLMResponse,
  LLMProvider,
  StreamChunk,
} from './providers/types.js'

// LLM Provider factories
export { createClaudeProvider } from './providers/claude.js'
export { createOpenAIProvider } from './providers/openai.js'
export { createOllamaProvider } from './providers/ollama.js'
export { createGeminiProvider } from './providers/gemini.js'

// Tool types + ToolRegistry
export type { ToolResult, ToolDefinition } from './tools/types.js'
export { ToolRegistry } from './tools/types.js'

// Built-in tools
export { createReadTool } from './tools/read.js'
export { createWriteTool } from './tools/write.js'
export { createGrepTool } from './tools/grep.js'
export { createShellTool, getShellConfig } from './tools/shell.js'
export type { ShellConfig } from './tools/shell.js'

// Agent types
export type { SubAgentStatus, SubAgentHandle, AgentConfig, SubAgentRunner } from './agent/types.js'
export type { AgentLoopState, AgentLoopHandler, AgentLoopOptions } from './agent/types.js'

// AgentLoop
export { AgentLoop, createNoopHandler } from './agent/agent-loop.js'

// Loader types
export type {
  WnConfig,
  ProviderConfig,
  McpConfig,
  McpServerConfig,
  Persona,
  Skill,
  AgentDef,
  FrontmatterResult,
  LoaderError,
  LoaderErrorCode,
} from './loader/types.js'

// MCP
export type { McpConnection, McpManager } from './mcp/types.js'
export { createMcpManager } from './mcp/client.js'

// Loader functions
export { parseFrontmatter } from './loader/frontmatter.js'
export { loadConfig } from './loader/config-loader.js'
export { loadPersonas } from './loader/persona-loader.js'
export { loadSkills } from './loader/skill-loader.js'
export { loadAgents } from './loader/agent-loader.js'
