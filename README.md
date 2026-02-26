# @0x6d61/wn-core

[日本語](README.ja.md)

Lightweight AI Agent Core Framework for Node.js.

Build any AI agent by combining LLM providers, personas, skills, MCP tools, and built-in tools.

## Features

- **4 LLM Providers** — Claude, OpenAI, Ollama, and Gemini behind a unified interface
- **Tool System** — Built-in tools (read / write / shell / grep) + MCP dynamic tool loading
- **3-Layer Model** — Persona (system prompt) / Skill (action definition) / Agent (sub-agent) hierarchy
- **JSON-RPC 2.0** — Core and UI communicate over stdin/stdout as separate processes
- **Worker Threads** — Parallel sub-agent execution without blocking the main loop
- **MCP Support** — Dynamically load tools from Model Context Protocol servers

## Install

```bash
npm install @0x6d61/wn-core
```

Global install (to use as CLI):

```bash
npm install -g @0x6d61/wn-core
```

## Quick Start

### CLI (JSON-RPC Server)

```bash
wn-core serve --provider claude --model claude-sonnet-4-20250514
```

Listens on stdin/stdout for JSON-RPC 2.0 messages from a TUI or any client.

```bash
# Test: pipe a JSON-RPC message
echo '{"jsonrpc":"2.0","id":1,"method":"input","params":{"text":"hello"}}' | wn-core serve
```

### As a Library

```typescript
import {
  createClaudeProvider,
  AgentLoop,
  ToolRegistry,
  createReadTool,
  createWriteTool,
  createShellTool,
  createGrepTool,
  createNoopHandler,
} from '@0x6d61/wn-core'

// 1. Create an LLM provider
const providerResult = createClaudeProvider(
  { apiKey: process.env['ANTHROPIC_API_KEY'] },
  'claude-sonnet-4-20250514',
)
if (!providerResult.ok) throw new Error(providerResult.error)

// 2. Register built-in tools
const tools = new ToolRegistry()
tools.register(createReadTool())
tools.register(createWriteTool())
tools.register(createShellTool())
tools.register(createGrepTool())

// 3. Build an AgentLoop
const loop = new AgentLoop({
  provider: providerResult.data,
  tools,
  handler: createNoopHandler(),
  systemMessage: 'You are a helpful assistant.',
})

// 4. Run a single conversation turn
const result = await loop.step('Read src/index.ts and summarize it')
if (result.ok) {
  console.log(result.data)
}
```

## Configuration

Configuration is loaded from two levels: `~/.wn/config.json` (global) and `.wn/config.json` (project-local). CLI flags take the highest priority.

```json
{
  "defaultProvider": "claude",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultPersona": "default",
  "providers": {
    "claude": { "apiKey": "${ANTHROPIC_API_KEY}" },
    "openai": { "apiKey": "${OPENAI_API_KEY}" },
    "ollama": { "baseUrl": "http://localhost:11434" },
    "gemini": { "apiKey": "${GEMINI_API_KEY}" }
  },
  "mcp": {
    "servers": [
      {
        "name": "example",
        "command": "npx",
        "args": ["-y", "example-mcp-server"]
      }
    ]
  }
}
```

API keys can reference environment variables using `${ENV_VAR}` syntax.

**OAuth Token (authToken):** Claude provider also supports OAuth authentication via `authToken`. Use `authToken` instead of `apiKey` when authenticating with a Claude OAuth token:

```json
{
  "providers": {
    "claude": { "authToken": "${ANTHROPIC_AUTH_TOKEN}" }
  }
}
```

**Priority (highest to lowest):** CLI flags > project-local `.wn/` > global `~/.wn/`

## Personas, Skills & Agents

wn-core uses a 3-layer resource model. Resources are loaded from `~/.wn/` (global) and `.wn/` (project-local). Local resources override global ones with the same name.

### Persona (System Prompt)

A persona is a plain Markdown file that defines the system prompt for the LLM.

**Directory:** `personas/`

```
~/.wn/personas/default.md
.wn/personas/security-expert.md
```

**Example** (`personas/default.md`):

```markdown
You are a helpful assistant.
Answer concisely and accurately.
```

No frontmatter required — the entire file content becomes the system prompt. Select a persona by name (filename without `.md`) via `defaultPersona` in config or `--persona` CLI flag.

### Skill (Action Definition)

A skill defines a reusable action with a description, allowed tools, and instructions.

**Directory:** `skills/<skill-name>/SKILL.md`

```
~/.wn/skills/code-review/SKILL.md
.wn/skills/recon/SKILL.md
```

**Example** (`skills/code-review/SKILL.md`):

```markdown
---
name: code-review
description: Review source code for bugs and security issues
tools: [read, grep, shell]
---

## Instructions

1. Read the target files using the read tool.
2. Check for common vulnerabilities (injection, XSS, etc.).
3. Report findings with severity and remediation advice.
```

**Frontmatter fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | No | directory name | Skill identifier |
| `description` | **Yes** | — | Short description of the skill |
| `tools` | No | `[]` | List of tools the skill can use |

The body (after `---`) contains the detailed instructions.

### Agent (Sub-Agent)

An agent definition configures a sub-agent with its own persona, skills, provider, and model.

**Directory:** `agents/`

```
~/.wn/agents/scanner.md
.wn/agents/code-reviewer.md
```

**Example** (`agents/scanner.md`):

```markdown
---
persona: security-expert
skills: [recon, port-scan]
provider: claude
model: claude-sonnet-4-20250514
---

A sub-agent specialized in network reconnaissance.
Runs port scans and service detection, then reports findings.
```

**Frontmatter fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | No | filename | Agent identifier |
| `persona` | No | `""` | Persona name to use as system prompt |
| `skills` | No | `[]` | List of skills to enable |
| `provider` | No | `""` | LLM provider override |
| `model` | No | `""` | Model override |

The body becomes the agent's description.

## Architecture

```
wn-tui (separate process) <-- JSON-RPC 2.0 --> wn-core
                                                  |
                                                  +-- AgentLoop
                                                  +-- LLMProvider (Claude/OpenAI/Ollama/Gemini)
                                                  +-- Loader (persona/skill/agent)
                                                  +-- Tools (read/write/shell/grep + MCP)
                                                  +-- SubAgentRunner (Worker Threads)
                                                  +-- RPC Server (JSON-RPC 2.0)
```

See [docs/architecture.md](docs/architecture.md) for details.

## RPC Protocol

Core and clients communicate via JSON-RPC 2.0 over stdin/stdout (NDJSON format).

### Core -> Client (Notification)

| Method | Params |
|---|---|
| `response` | `{ content: string }` |
| `toolExec` | `{ event: 'start'\|'end', name, args\|result }` |
| `stateChange` | `{ state: 'idle'\|'thinking'\|'tool_running' }` |
| `log` | `{ level: 'info'\|'warn'\|'error', message }` |

### Client -> Core (Request)

| Method | Params | Result |
|---|---|---|
| `input` | `{ text: string }` | `{ accepted: boolean }` |
| `abort` | `{}` | `{ aborted: boolean }` |
| `configUpdate` | `{ persona?, provider?, model? }` | `{ applied: boolean }` |

## Development

```bash
npm install
npm test            # Run tests (344 tests)
npm run typecheck   # TypeScript type check
npm run lint        # ESLint
npm run build       # Build (tsup)
```

## Requirements

- Node.js >= 20

## License

MIT
