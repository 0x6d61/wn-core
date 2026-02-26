# @0x6d61/wn-core

軽量 AI エージェントコアフレームワーク（Node.js）

LLM Provider / Persona / Skill / MCP / Tool を組み合わせて、任意の AI エージェントを構築できます。

## Features

- **4 LLM Providers** — Claude, OpenAI, Ollama, Gemini を統一インターフェースで利用
- **Tool System** — read / write / shell / grep + MCP 経由のツールを統合管理
- **3-Layer Model** — persona（人格） / skill（手順） / agent（サブエージェント）の階層管理
- **JSON-RPC 2.0** — stdin/stdout で TUI やクライアントと通信。Core と UI は別プロセス
- **Worker Threads** — サブエージェントの並列実行（CPU ヘビーなタスクもメインをブロックしない）
- **MCP Support** — Model Context Protocol でツールを動的にロード

## インストール

```bash
npm install @0x6d61/wn-core
```

グローバルインストール（CLI として使う場合）：

```bash
npm install -g @0x6d61/wn-core
```

## Quick Start

### CLI（JSON-RPC サーバーとして起動）

```bash
wn-core serve --provider claude --model claude-sonnet-4-20250514
```

TUI やクライアントから stdin/stdout で JSON-RPC 2.0 メッセージを送受信します。

```bash
# テスト: パイプで JSON-RPC メッセージを送信
echo '{"jsonrpc":"2.0","id":1,"method":"input","params":{"text":"hello"}}' | wn-core serve
```

### ライブラリとして使う

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

// 1. LLM Provider を作成
const providerResult = createClaudeProvider(
  { apiKey: process.env['ANTHROPIC_API_KEY'] },
  'claude-sonnet-4-20250514',
)
if (!providerResult.ok) throw new Error(providerResult.error)

// 2. ToolRegistry にビルトインツールを登録
const tools = new ToolRegistry()
tools.register(createReadTool())
tools.register(createWriteTool())
tools.register(createShellTool())
tools.register(createGrepTool())

// 3. AgentLoop を構築
const loop = new AgentLoop({
  provider: providerResult.data,
  tools,
  handler: createNoopHandler(),
  systemMessage: 'あなたは親切なアシスタントです。',
})

// 4. 1回の対話ターン
const result = await loop.step('src/index.ts を読んで要約して')
if (result.ok) {
  console.log(result.data)
}
```

## 設定

設定ファイルは `~/.wn/config.json`（グローバル）と `.wn/config.json`（プロジェクトローカル）の 2 階層。CLI フラグが最優先。

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

API キーは `${ENV_VAR}` 形式で環境変数を参照できます。

**OAuth トークン (authToken):** Claude プロバイダーは OAuth 認証にも対応しています。Claude OAuth トークンで認証する場合は `apiKey` の代わりに `authToken` を使用してください:

```json
{
  "providers": {
    "claude": { "authToken": "${ANTHROPIC_AUTH_TOKEN}" }
  }
}
```

**優先順位（高 → 低）:** CLI フラグ > プロジェクトローカル `.wn/` > グローバル `~/.wn/`

## Persona / Skill / Agent

wn-core は 3 層のリソースモデルを採用しています。リソースは `~/.wn/`（グローバル）と `.wn/`（プロジェクトローカル）から読み込まれ、同名のローカルリソースがグローバルを上書きします。

### Persona（システムプロンプト）

Persona は LLM のシステムプロンプトを定義するプレーンな Markdown ファイルです。

**ディレクトリ:** `personas/`

```
~/.wn/personas/default.md
.wn/personas/security-expert.md
```

**例** (`personas/default.md`):

```markdown
あなたは親切なアシスタントです。
簡潔かつ正確に回答してください。
```

フロントマター不要 — ファイル全体がシステムプロンプトになります。`config.json` の `defaultPersona` または `--persona` CLI フラグでファイル名（`.md` を除いた名前）を指定します。

### Skill（アクション定義）

Skill は再利用可能なアクションを定義します。説明文・使用可能ツール・手順を含みます。

**ディレクトリ:** `skills/<スキル名>/SKILL.md`

```
~/.wn/skills/code-review/SKILL.md
.wn/skills/recon/SKILL.md
```

**例** (`skills/code-review/SKILL.md`):

```markdown
---
name: code-review
description: ソースコードのバグとセキュリティ問題をレビュー
tools: [read, grep, shell]
---

## 手順

1. read ツールで対象ファイルを読む
2. 一般的な脆弱性（インジェクション、XSS 等）をチェック
3. 深刻度と修正アドバイスを含む報告書を作成
```

**フロントマターフィールド:**

| フィールド | 必須 | デフォルト | 説明 |
|-----------|------|-----------|------|
| `name` | いいえ | ディレクトリ名 | スキル識別子 |
| `description` | **はい** | — | スキルの短い説明 |
| `tools` | いいえ | `[]` | 使用可能なツールのリスト |

`---` 以降の本文が詳細な手順になります。

### Agent（サブエージェント）

Agent はサブエージェントを定義します。独自の persona、skill、provider、model を設定できます。

**ディレクトリ:** `agents/`

```
~/.wn/agents/scanner.md
.wn/agents/code-reviewer.md
```

**例** (`agents/scanner.md`):

```markdown
---
persona: security-expert
skills: [recon, port-scan]
provider: claude
model: claude-sonnet-4-20250514
---

ネットワーク偵察に特化したサブエージェント。
ポートスキャンとサービス検出を実行し、結果を報告します。
```

**フロントマターフィールド:**

| フィールド | 必須 | デフォルト | 説明 |
|-----------|------|-----------|------|
| `name` | いいえ | ファイル名 | エージェント識別子 |
| `persona` | いいえ | `""` | 使用する persona 名 |
| `skills` | いいえ | `[]` | 有効にする skill のリスト |
| `provider` | いいえ | `""` | LLM プロバイダーの上書き |
| `model` | いいえ | `""` | モデルの上書き |

`---` 以降の本文がエージェントの説明になります。

## アーキテクチャ

```
wn-tui (別プロセス) <-- JSON-RPC 2.0 --> wn-core
                                           |
                                           +-- AgentLoop
                                           +-- LLMProvider (Claude/OpenAI/Ollama/Gemini)
                                           +-- Loader (persona/skill/agent)
                                           +-- Tools (read/write/shell/grep + MCP)
                                           +-- SubAgentRunner (Worker Threads)
                                           +-- RPC Server (JSON-RPC 2.0)
```

詳細は [docs/architecture.md](docs/architecture.md) を参照。

## RPC プロトコル

Core とクライアントは JSON-RPC 2.0 over stdin/stdout（NDJSON）で通信します。

### Core -> Client (Notification)

| メソッド | パラメータ |
|---|---|
| `response` | `{ content: string }` |
| `toolExec` | `{ event: 'start'\|'end', name, args\|result }` |
| `stateChange` | `{ state: 'idle'\|'thinking'\|'tool_running' }` |
| `log` | `{ level: 'info'\|'warn'\|'error', message }` |

### Client -> Core (Request)

| メソッド | パラメータ | 結果 |
|---|---|---|
| `input` | `{ text: string }` | `{ accepted: boolean }` |
| `abort` | `{}` | `{ aborted: boolean }` |
| `configUpdate` | `{ persona?, provider?, model? }` | `{ applied: boolean }` |

## 開発

```bash
npm install
npm test            # テスト実行 (344 tests)
npm run typecheck   # TypeScript 型チェック
npm run lint        # ESLint
npm run build       # ビルド (tsup)
```

## 動作要件

- Node.js >= 20

## ライセンス

MIT
