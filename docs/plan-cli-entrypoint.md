# 計画: wn-core CLI エントリーポイント実装

## コンテキスト

wn-core の全コンポーネント（LLMProvider, AgentLoop, Tools, MCP, RPC Server）は実装済みだが、起動スクリプト（CLI エントリーポイント）がない。TUI（wn-tui）が `child_process.spawn('wn-core', ['serve'])` で Core を起動し、stdin/stdout の JSON-RPC で通信する構成を実現するため、CLI を実装する。

**最終的な公開イメージ:**
- `wn-core`: npm パッケージ（ライブラリ + CLI）
- `wn-tui`: `wn-core` を依存に持ち、`weness` コマンドとして公開

## 設計

### CLI コマンド体系

最小構成で `serve` サブコマンドのみ実装する。

```
wn-core serve [options]     # RPC サーバーとして起動（TUI から spawn される）
```

**オプション:**
- `--provider <name>` — LLM プロバイダー指定（default: config.json の defaultProvider）
- `--model <name>` — モデル指定（default: config.json の defaultModel）
- `--persona <name>` — ペルソナ指定（default: config.json の defaultPersona）

### CLI 引数パーサー

**`node:util` の `parseArgs` を使用**（外部依存ゼロ）。サブコマンドは positional で取得。

### ブートストラップフロー（`docs/architecture.md` Section 7 の実装）

```
1. CLI パース (parseArgs)
2. loadConfig(globalDir, localDir, cliOverrides)
3. LLMProvider 生成 (createProvider ルーター)
4. loadPersonas / loadSkills / loadAgents
5. ToolRegistry 構築 (built-in + MCP)
6. RPC Server + AgentLoop 接続
7. rpcServer.start() — stdin/stdout でリッスン開始
8. シャットダウン処理 (MCP 切断, プロセス終了)
```

### プロバイダールーター

プロバイダー名 → ファクトリ関数のマッピング。

```typescript
function createProvider(name: string, config: ProviderConfig, model: string): Result<LLMProvider>
```

### ログ出力

RPC モードでは stdout は JSON-RPC 専用。ログは **stderr** に出力する。

## 対象ファイル

| ファイル | 操作 |
|---------|------|
| `src/cli.ts` | **新規** — CLI エントリーポイント |
| `tests/cli.test.ts` | **新規** — ブートストラップ関数のユニットテスト |
| `tsup.config.ts` | **変更** — entry に `src/cli.ts` を追加 |
| `package.json` | **変更** — `bin` フィールド追加 |

## `src/cli.ts` の公開関数

```typescript
/** プロバイダー名からファクトリを選択して生成 */
export function createProvider(name: string, config: ProviderConfig, model: string): Result<LLMProvider>

/** 組み込みツールを全て登録した ToolRegistry を生成 */
export function createDefaultToolRegistry(): ToolRegistry

/** RPC メソッドハンドラを構築（AgentLoop と接続） */
export function createServeHandler(agentLoop: AgentLoop, abortController: AbortController): RpcRequestHandler

/** メインのブートストラップ + RPC サーバー起動 */
export async function serve(args: { provider?: string; model?: string; persona?: string }): Promise<void>
```

## TDD 実装順序

1. `tests/cli.test.ts` — `createProvider` テスト（Red）
2. `src/cli.ts` — `createProvider` 実装（Green）
3. `tests/cli.test.ts` — `createDefaultToolRegistry` テスト追加（Red）
4. `src/cli.ts` — `createDefaultToolRegistry` 実装（Green）
5. `tests/cli.test.ts` — `createServeHandler` テスト追加（Red）
6. `src/cli.ts` — `createServeHandler` + `serve` + `main` 実装（Green）
7. `tsup.config.ts` — entry 追加
8. `package.json` — `bin` フィールド追加
9. 全検証（typecheck / lint / format / test / build / semgrep）

## テスト戦略

- `createProvider`: 各プロバイダー名で正しいファクトリが呼ばれるか、不明なプロバイダーでエラーになるか
- `createDefaultToolRegistry`: 4つの組み込みツール（read, write, shell, grep）が全て登録されるか
- `createServeHandler`: input/abort/configUpdate の各 RPC メソッドが正しく動作するか（AgentLoop はモック）

## 検証手順

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
# 動作確認
node dist/cli.js serve 2>&1
```
