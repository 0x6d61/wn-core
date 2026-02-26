# wn-core アーキテクチャ設計

## 1. 全体方針

**wn-core** は、環境を選ばない軽量 AI エージェントコアフレームワーク。LLM プロバイダー・ペルソナ・Skill・MCP・ツールを組み合わせて、任意のエージェントを構築できる。

設計思想:

- **1 パッケージ・内部モジュール分割** — 依存管理のシンプルさを保ちつつ、関心の分離を実現
- **pi-mono 的アプローチ** — Skill は `SKILL.md` に手順を書き、LLM が読んで実行する。コードではなくドキュメントが行動を定義する
- **RPC 分離** — Core と TUI は別プロセスで動作し、JSON-RPC over stdin/stdout で通信。TUI が落ちても Core は継続する
- **プロバイダー非依存** — Claude, OpenAI, Ollama, Gemini の 4 プロバイダーを抽象層で統一

---

## 2. アーキテクチャ概要

```
wn-tui (別プロセス) ←─ JSON-RPC over stdin/stdout ─→ wn-core
                                                       │
                                                       ├── AgentLoop          # メインループ
                                                       ├── LLMProvider        # Claude / OpenAI / Ollama / Gemini
                                                       ├── Loader             # persona / skill / agent 階層管理
                                                       ├── Tools              # read / write / shell / grep + MCP
                                                       ├── MCPClient          # @modelcontextprotocol/sdk
                                                       ├── SubAgentRunner     # Worker Threads による並列実行
                                                       └── RPC Server         # JSON-RPC 2.0
```

---

## 3. ディレクトリ構成（ソース）

```
wn-core/
  ├── src/
  │   ├── index.ts                  # エントリーポイント
  │   ├── agent/                    # AgentLoop + SubAgentRunner
  │   │   ├── agent-loop.ts
  │   │   ├── sub-agent-runner.ts
  │   │   └── types.ts
  │   ├── providers/                # LLM 抽象層
  │   │   ├── types.ts
  │   │   ├── claude.ts
  │   │   ├── openai.ts
  │   │   ├── ollama.ts
  │   │   └── gemini.ts
  │   ├── loader/                   # リソース読み込み（階層管理）
  │   │   ├── persona-loader.ts
  │   │   ├── skill-loader.ts
  │   │   ├── agent-loader.ts
  │   │   └── config-loader.ts
  │   ├── tools/                    # 組み込みツール
  │   │   ├── types.ts
  │   │   ├── read.ts
  │   │   ├── write.ts
  │   │   ├── shell.ts
  │   │   └── grep.ts
  │   ├── mcp/                      # MCP クライアント
  │   │   └── client.ts
  │   └── rpc/                      # RPC Server
  │       └── server.ts
  ├── tests/                        # src/ とミラー構造
  ├── docs/
  ├── package.json
  └── tsconfig.json
```

---

## 4. 設定ディレクトリ構成

wn-core は **フラット型** の設定ディレクトリ `~/.wn/` を使用する。プロジェクトローカルの `.wn/` で上書きでき、CLI フラグが最優先。

```
~/.wn/                              # グローバル
  ├── config.json
  ├── personas/
  │   └── default.md
  ├── skills/
  │   └── my-skill/SKILL.md
  └── agents/
      └── reviewer.md

.wn/                                # プロジェクトローカル（上書き）
  ├── config.json
  ├── personas/
  ├── skills/
  └── agents/

CLI flags                           # 最優先
  --persona, --skill, --agent, --provider
```

**階層適用の優先順位（高 → 低）:**

1. **CLI フラグ** — `--persona code`, `--provider openai` など
2. **プロジェクトローカル** — `.wn/`（カレントディレクトリ）
3. **グローバル** — `~/.wn/`

同名リソースは上位が優先（上書き）。

---

## 5. 各コンポーネント詳細設計

### 5.1 LLMProvider 型定義

```typescript
interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface LLMResponse {
  content: string
  toolCalls?: ToolCall[]
  usage?: { inputTokens: number; outputTokens: number }
}

interface LLMProvider {
  complete(messages: Message[], tools?: Tool[]): Promise<LLMResponse>
  stream?(messages: Message[], tools?: Tool[]): AsyncIterable<string>
}
```

**4 プロバイダー実装:**

| プロバイダー | ファイル | SDK / 接続方式 |
|---|---|---|
| Claude | `providers/claude.ts` | `@anthropic-ai/sdk` |
| OpenAI | `providers/openai.ts` | `openai` |
| Ollama | `providers/ollama.ts` | REST API（localhost） |
| Gemini | `providers/gemini.ts` | `@google/generative-ai` |

### 5.2 3 層モデル（persona / skill / agent）

#### persona（システムプロンプト）

`.md` ファイルで記述し、LLM の system message として注入する。

```
~/.wn/personas/default.md
```

```markdown
あなたはセキュリティに詳しいAIアシスタントです。
丁寧な日本語で回答してください。
```

#### skill（アクション定義）

`SKILL.md`（frontmatter + 手順）で記述する。LLM に手順を提示し、LLM がツールを使って実行する。

```
skills/
  └── my-skill/
      ├── SKILL.md        # フロントマター + 手順（必須）
      └── scripts/        # ヘルパースクリプト（任意）
```

```markdown
---
name: my-skill
description: このSkillが何をするか。いつ使うか。
tools: [shell, read]
---

# My Skill

## 手順
1. ステップ1
2. ステップ2

## コマンド例
```bash
some-command {param}
```
```

#### agent（サブエージェント定義）

`.md` ファイルの frontmatter で persona / skills / provider / model を指定する。サブエージェントとして起動される。

```markdown
---
name: reviewer
persona: code-reviewer
skills: [read, grep]
provider: claude
model: claude-sonnet-4-20250514
---

コードレビューを行うサブエージェントです。
指摘事項をリスト形式で返します。
```

### 5.3 Tool 層

#### ToolDefinition インターフェース

```typescript
interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>   // JSON Schema
  execute(args: Record<string, unknown>): Promise<ToolResult>
}

interface ToolResult {
  ok: boolean
  output: string
  error?: string
}
```

#### 組み込みツール

| ツール | ファイル | 概要 |
|---|---|---|
| `read` | `tools/read.ts` | ファイル読み込み |
| `write` | `tools/write.ts` | ファイル書き込み |
| `shell` | `tools/shell.ts` | クロスプラットフォーム コマンド実行 |
| `grep` | `tools/grep.ts` | ファイル内容検索 |

**shell ツールのクロスプラットフォーム設計:**

- **シェル経由の文字列実行は禁止** — `execFile` で引数を配列渡し（コマンドインジェクション防止）
- **OS 検出によるデフォルトシェル切り替え:**
  - Linux / macOS → `/bin/sh -c`（POSIX 互換）
  - Windows → `cmd.exe /c` または `powershell.exe -Command`
- **LLM へのコンテキスト提供** — 実行環境の `process.platform` を system message に含め、LLM が OS に適したコマンドを生成できるようにする
- **パス区切り文字の正規化** — 内部では `path.resolve()` / `path.join()` を使い、OS 差異を吸収

#### MCP 経由ツール

`@modelcontextprotocol/sdk` を使い、MCP サーバーからツール定義を動的ロードする。

#### ToolRegistry

組み込みツールと MCP 経由ツールを統合管理する。名前が衝突した場合は組み込みツールが優先。

```typescript
class ToolRegistry {
  private builtins: Map<string, ToolDefinition>
  private mcpTools: Map<string, ToolDefinition>

  register(tool: ToolDefinition): void
  registerMcp(tool: ToolDefinition): void
  get(name: string): ToolDefinition | undefined    // builtins 優先
  list(): ToolDefinition[]
}
```

### 5.4 階層読み込み（Loader）

各 Loader は以下のマージ戦略に従う:

```
CLI フラグ  >  プロジェクトローカル (.wn/)  >  グローバル (~/.wn/)
```

- **config.json** — deep merge（CLI > プロジェクト > グローバル）
- **persona / skill / agent** — 同名は上位が優先（上書き）。異なる名前は統合

```typescript
// 読み込みの流れ
const globalPersonas = await loadPersonas('~/.wn/personas/')
const localPersonas = await loadPersonas('.wn/personas/')
const cliPersona = opts.persona ? await loadPersona(opts.persona) : null

// マージ: 同名は上位が勝つ
const merged = new Map([...globalPersonas, ...localPersonas])
if (cliPersona) merged.set(cliPersona.name, cliPersona)
```

### 5.5 SubAgentRunner

```typescript
interface SubAgentRunner {
  spawn(config: AgentConfig): Promise<SubAgentHandle>
  list(): SubAgentHandle[]
  stop(id: string): Promise<void>
}

interface SubAgentHandle {
  id: string
  status: 'running' | 'completed' | 'failed'
  result?: unknown
}

interface AgentConfig {
  persona: string
  skills: string[]
  provider: string
  model: string
  task: string
}
```

**実装: `WorkerSubAgentRunner`（Worker Threads）**

ペネトレーションテストでは、大量のスキャン結果パース（Nmap XML, Nuclei JSON 等）や複数ターゲットの同時偵察など CPU ヘビーな並列処理が発生する。メインループの応答性を維持するため、Worker Threads による真の並列実行を採用する。

```typescript
class WorkerSubAgentRunner implements SubAgentRunner {
  private workers: Map<string, Worker> = new Map()
  private handles: Map<string, SubAgentHandle> = new Map()

  async spawn(config: AgentConfig): Promise<SubAgentHandle> {
    const id = crypto.randomUUID()
    const handle: SubAgentHandle = { id, status: 'running' }
    this.handles.set(id, handle)

    const worker = new Worker('./src/agent/sub-agent-worker.ts', {
      workerData: { id, config }
    })

    worker.on('message', (msg) => {
      // 進捗報告、ツール実行結果などをメインスレッドに通知
    })

    worker.on('exit', (code) => {
      handle.status = code === 0 ? 'completed' : 'failed'
      this.workers.delete(id)
    })

    worker.on('error', (err) => {
      handle.status = 'failed'
      handle.result = err.message
      this.workers.delete(id)
    })

    this.workers.set(id, worker)
    return handle
  }

  async stop(id: string): Promise<void> {
    const worker = this.workers.get(id)
    if (worker) await worker.terminate()
  }
}
```

**Worker Threads を採用する理由:**

| 要件 | async/await | Worker Threads |
|---|---|---|
| スキャン結果の並列パース（CPU バウンド） | メインが止まる | **止まらない** |
| 複数ターゲット同時偵察 | I/O のみ並行 | **CPU も並列** |
| オペレーターへのリアルタイム報告 | 重い処理中は応答遅延 | **常時応答可能** |
| サブエージェントの障害隔離 | 1 つの例外で全体影響 | **独立メモリで隔離** |

**メインスレッドとの通信:**

- `worker.postMessage()` / `parentPort.postMessage()` でメッセージパッシング
- 進捗・結果はイベントとしてメインに通知 → RPC 経由で TUI に転送

**ツール実行戦略: 全ツールを Worker 内で実行**

ペネトレーションテストでは、複数のサブエージェントが `nmap`, `nuclei`, `gobuster` 等の長時間コマンドを **同時並列で実行** する必要がある。ツール実行をメインに集約すると直列化してしまうため、全ツールを Worker 内で実行する。

| ツール | 実行場所 | 並行性の確保 |
|---|---|---|
| `read` | Worker 内 | 読み取り専用。そのまま並列実行 |
| `grep` | Worker 内 | 読み取り専用。そのまま並列実行 |
| `write` | Worker 内 | ファイルロック（`lockfile`）で排他制御 |
| `shell` | Worker 内 | `execFile` で直接実行。並列で動作 |
| MCP ツール | Worker 内 | 各 Worker が独自の MCP 接続を保持 |

**排他制御と監査はツール実行と分離する:**

```
Worker Thread A (サブエージェント: target1)
  ├── shell: nmap -sV target1     ← Worker 内で直接実行
  ├── read: nmap-result.xml       ← Worker 内で直接実行
  ├── write: report.md            ← ファイルロックで排他制御
  └── 監査ログ → postMessage → Main Thread → RPC → TUI

Worker Thread B (サブエージェント: target2)
  ├── shell: nuclei -t cves/ target2   ← 同時に実行できる
  ├── read: nuclei-result.json
  └── 監査ログ → postMessage → Main Thread → RPC → TUI

Main Thread
  ├── 監査ログの集約・記録
  ├── オペレーターへのリアルタイム通知（RPC → TUI）
  └── サブエージェントのライフサイクル管理（spawn / stop）
```

**メインスレッドの責務:**

- サブエージェントのライフサイクル管理（起動・停止・監視）
- 監査ログの集約（誰が・いつ・何を実行したか）
- RPC 経由での TUI への通知
- オペレーターからの中断指示の伝達

**メインスレッドがやらないこと:**

- ツールの実行そのもの（Worker に任せる）
- LLM API 呼び出し（Worker 内の AgentLoop が行う）

### 5.6 AgentLoop

メインループの設計。入力待ち → LLM 呼び出し → ツール実行 → 応答のサイクルを回す。

```typescript
class AgentLoop {
  private provider: LLMProvider
  private tools: ToolRegistry
  private messages: Message[]
  private loopHook?: (agent: AgentLoop) => Promise<boolean>

  async run(): Promise<void> {
    while (true) {
      // 1. ユーザー入力を処理
      const input = await this.waitForInput()
      this.messages.push({ role: 'user', content: input })

      // 2. LLM 呼び出し
      const response = await this.provider.complete(
        this.messages,
        this.tools.list()
      )

      // 3. ツール呼び出しがあれば実行
      if (response.toolCalls) {
        for (const call of response.toolCalls) {
          const tool = this.tools.get(call.name)
          if (tool) {
            const result = await tool.execute(call.arguments)
            // ツール結果をメッセージに追加して再度 LLM へ
          }
        }
        continue
      }

      // 4. 応答を返す
      this.messages.push({ role: 'assistant', content: response.content })
      await this.emitResponse(response.content)

      // 5. loopHook（拡張ポイント）
      if (this.loopHook) {
        const done = await this.loopHook(this)
        if (done) break
      }
    }
  }
}
```

`loopHook` により、外部からドメイン固有の処理を注入可能。コアはループの中身を知らない。

### 5.7 RPC 通信

Core と TUI は別プロセスで動作し、**JSON-RPC 2.0 over stdin/stdout** で通信する。

```
wn-tui (フロントエンド)  ←──── JSON-RPC 2.0 ────→  wn-core (バックエンド)
```

**Core → TUI（イベント通知）:**

| メソッド | 内容 |
|---|---|
| `log` | ログ出力 |
| `stateChange` | 状態変更（idle, thinking, toolRunning） |
| `toolExec` | ツール実行通知（名前、引数、結果） |
| `response` | LLM の応答テキスト |

**TUI → Core（コマンド）:**

| メソッド | 内容 |
|---|---|
| `input` | ユーザー入力 |
| `abort` | 処理中断 |
| `configUpdate` | 設定変更（persona 切り替えなど） |

**設計方針:**

- TUI が落ちても Core は動き続ける
- TUI を後からアタッチ可能（再接続）
- Core は stdin/stdout をリッスンするだけなので、TUI 以外のクライアントも接続可能

---

## 6. config.json スキーマ

```json
{
  "defaultProvider": "claude",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultPersona": "default",
  "providers": {
    "claude": {
      "apiKey": "${ANTHROPIC_API_KEY}"
    },
    "openai": {
      "apiKey": "${OPENAI_API_KEY}"
    },
    "ollama": {
      "baseUrl": "http://localhost:11434"
    },
    "gemini": {
      "apiKey": "${GEMINI_API_KEY}"
    }
  },
  "mcp": {
    "servers": [
      {
        "name": "example-server",
        "command": "npx",
        "args": ["-y", "example-mcp-server"]
      }
    ]
  }
}
```

- API キーは環境変数参照（`${VAR_NAME}`）を推奨。直書きも可能だが非推奨
- `providers` の各キーは `LLMProvider` 実装と対応する

---

## 7. 起動フロー

```
1. CLI パース
   └── --persona, --skill, --agent, --provider, --model を取得

2. config.json 読み込み（階層マージ）
   └── ~/.wn/config.json → .wn/config.json → CLI フラグ

3. LLMProvider 生成
   └── config.defaultProvider（または --provider）に対応する実装をインスタンス化

4. リソース読み込み
   ├── PersonaLoader: persona を読み込み → system message を構築
   ├── SkillLoader: skill を読み込み → ツール定義として登録
   └── AgentLoader: agent 定義を読み込み → SubAgentRunner に渡す準備

5. ToolRegistry 構築
   ├── 組み込みツール（read, write, shell, grep）を登録
   └── MCP サーバー起動 → ツール定義を動的ロード → 登録

6. AgentLoop 起動
   └── メインループ開始（入力待ち → LLM → ツール → 応答）

7. RPC Server 開始
   └── stdin/stdout をリッスン、TUI からの接続を受け付け
```
