# 計画: Loader 層実装（config / persona / skill / agent）

## コンテキスト

組み込みツール（Issue #5 / PR #6）が完了。ロードマップ B として、architecture.md §5.2, §5.4, §6 で定義された **Loader 層** を実装する。設定ファイル（config.json）と 3 層リソース（persona / skill / agent）を階層的に読み込み、マージする機能を提供する。

## 設計判断

1. **関数パターン** — 各ローダーは `loadXxx()` 関数で Result を返す（クラス不要）
2. **frontmatter パーサー** — 外部依存なし。簡易 YAML（flat key-value + inline array）のみサポート
3. **deep merge** — config.json はオブジェクト再帰マージ、配列は上書き（マージしない）
4. **環境変数置換** — `${VAR_NAME}` → `process.env[VAR_NAME]`、未定義は元文字列を保持
5. **LoaderError 構造体** — code + message + path でエラーを構造化
6. **ENOENT 許容** — ディレクトリ/ファイル不在は正常（空の結果を返す）、パースエラーのみ err

## 変更対象ファイル

新規作成（11ファイル）:

| ファイル | 内容 |
|---------|------|
| `src/loader/types.ts` | WnConfig, Persona, Skill, AgentDef, LoaderError, FrontmatterResult |
| `src/loader/frontmatter.ts` | `parseFrontmatter()` — 簡易 YAML frontmatter パーサー |
| `src/loader/config-loader.ts` | `loadConfig()` — JSON 読み込み + deep merge + env var 置換 |
| `src/loader/persona-loader.ts` | `loadPersonas()` — .md ファイルから persona 読み込み |
| `src/loader/skill-loader.ts` | `loadSkills()` — SKILL.md の frontmatter + body 読み込み |
| `src/loader/agent-loader.ts` | `loadAgents()` — agent .md の frontmatter + body 読み込み |
| `tests/loader/frontmatter.test.ts` | frontmatter パーサーのテスト（13件） |
| `tests/loader/config-loader.test.ts` | config ローダーのテスト（19件） |
| `tests/loader/persona-loader.test.ts` | persona ローダーのテスト（8件） |
| `tests/loader/skill-loader.test.ts` | skill ローダーのテスト（8件） |
| `tests/loader/agent-loader.test.ts` | agent ローダーのテスト（7件） |

変更（2ファイル）:
- `src/index.ts` — Loader 型・関数を re-export
- `tests/index.test.ts` — re-export の検証追加

## 型定義（`src/loader/types.ts`）

```typescript
interface WnConfig {
  defaultProvider: string    // デフォルト: "claude"
  defaultModel: string       // デフォルト: "claude-sonnet-4-20250514"
  defaultPersona: string     // デフォルト: "default"
  providers: Record<string, ProviderConfig>
  mcp?: McpConfig
}

interface ProviderConfig { apiKey?: string; baseUrl?: string }
interface McpConfig { servers: McpServerConfig[] }
interface McpServerConfig { name: string; command: string; args: string[] }

interface Persona { name: string; content: string }
interface Skill { name: string; description: string; tools: string[]; body: string }
interface AgentDef { name: string; persona: string; skills: string[]; provider: string; model: string; description: string }

interface FrontmatterResult { attributes: Record<string, string | string[]>; body: string }
interface LoaderError { code: LoaderErrorCode; message: string; path?: string }
type LoaderErrorCode = 'FILE_NOT_FOUND' | 'PARSE_ERROR' | 'VALIDATION_ERROR' | 'IO_ERROR'
```

## 実装ステップ（TDD）

### Step 1: types.ts（テスト不要、純粋な型定義）

### Step 2: frontmatter パーサー（13テスト）

- frontmatter 付き文字列からキー・値とボディを抽出する
- インライン配列を string[] としてパースする
- frontmatter がない場合、全体をボディとして返す
- 空の frontmatter を正しく扱う
- ボディが空の場合、空文字列を返す
- コメント行・空行を無視する
- 値の前後空白をトリムする
- キーにハイフンを含む場合を正しくパースする
- 空の配列 [] を空配列として返す
- 配列内要素の前後空白をトリムする
- Windows 改行コード（CRLF）を正しく扱う
- 開始デリミタがあるが終了デリミタがない場合にエラーを返す

### Step 3: config ローダー（19テスト）

- JSON 読み込み: global読み込み / local上書き / 不在時デフォルト / 不正JSON / ディレクトリ不在
- deep merge: 再帰マージ / local上書き / 配列上書き / 新プロパティ追加
- CLI オーバーライド: 3フィールド上書き / undefined スキップ
- 環境変数: 置換 / 未定義保持 / ネスト内 / 配列内 / 非文字列スキップ / 複数変数
- デフォルト値: provider / model / providers

### Step 4: persona ローダー（8テスト）

- グローバルから .md 読み込み / ファイル名→persona名 / 全文→content
- ローカルが同名を上書き / 異名はマージ
- ディレクトリ不在→空Map / .md以外無視 / 空ディレクトリ→空Map

### Step 5: skill ローダー（8テスト）

- SKILL.md から name/description/tools 抽出 / body 取得
- ローカル上書き / 異名マージ / ディレクトリ不在→空Map
- name 未指定→ディレクトリ名フォールバック / description 未指定→エラー / SKILL.md 不在→スキップ

### Step 6: agent ローダー（7テスト）

- frontmatter から全フィールド抽出 / body→description
- ローカル上書き / 異名マージ / ディレクトリ不在→空Map
- name 未指定→ファイル名フォールバック / .md以外無視

### Step 7: index.ts 更新 + 全検証

## セキュリティ考慮事項

- パス操作: `path.resolve()` + `path.join()` で正規化
- `as` キャスト禁止: `isNodeError()` 型ガードで ENOENT 判定
- 環境変数: config.json に直接書かれた API キーは非推奨、`${VAR}` パターンを推奨
- JSON パース: `JSON.parse()` の結果を `isPlainObject()` で型チェック

## テスト結果

- 全13ファイル、132テストがパス
- 既存75件 + 新規57件
