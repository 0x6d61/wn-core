## プロジェクト概要

weness、小さなAI-AgentCore weave（編む）+ harness（馬具・制御）→ wenessから着想を得た。

詳細は `docs/architecture.md`

---

## Claude Code 作業スタイル

- **メインスレッド = ユーザーとの設計・議論**。実装の詳細はサブエージェント（Task tool）に委譲する。
- 設計方針が決まったら、サブエージェントを並列で起動して実装を進める。
- メインスレッドでは設計レビュー、方針決定、ユーザーからのフィードバック対応に集中する。
- サブエージェントの結果をメインスレッドで要約してユーザーに報告する。

---

## ブランチ戦略（GitHub Flow）

- ブランチモデル: `main` + `feature/*` のみ
- 必ず Issue を作成してからブランチを切る
- ブランチ命名規則: `feature/<issue番号>-<短い説明>` (例: `feature/5-nmap-wrapper`)
- PR は必ず Issue を参照し、マージ時に自動クローズする
  - PR 本文に `Closes #<issue番号>` を含めること
- マージ後もブランチは削除しない（監査証跡のため）

---

## 開発プロセス（TDD）

**すべての実装は以下の順序で行う：**

1. **テストを書く** → 失敗することを確認（Red）
2. **実装を書く** → テストが通ることを確認（Green）
3. **リファクタリング** → テストが引き続き通ることを確認（Refactor）

---

## TypeScript 開発ルール

### 技術スタック

| 項目 | 選定 | 備考 |
|------|------|------|
| 言語 | TypeScript 5.x (strict mode) | `tsconfig.json` の `strict: true` 必須 |
| ランタイム | Node.js >= 20 LTS | ES2022 ターゲット |
| パッケージマネージャー | npm | `package-lock.json` をコミットする |
| テスト | Vitest | Jest 互換 API、TypeScript ネイティブ |



### TypeScript コーディング規約

#### 型安全

- **`strict: true` 必須** — `any` の使用は原則禁止。やむを得ない場合は `// eslint-disable-next-line @typescript-eslint/no-explicit-any` + 理由コメント
- **`as` キャスト禁止** — 型ガード（`is`）やZod などのバリデーションで型を絞り込む
- **戻り値の型を明示** — public な関数・メソッドには必ず戻り値の型アノテーションを書く
- **`unknown` > `any`** — 外部入力（JSON パース結果、CLI引数など）は `unknown` で受けてバリデーション

#### モジュール・インポート

- **ESM（ES Modules）を使用** — `package.json` に `"type": "module"` を設定
- **拡張子付きインポート** — `import { foo } from './bar.js'`（`.js` 拡張子を付ける。TypeScriptでもビルド後のパスを指す）
- **パスエイリアス不使用** — 相対パスのみ使う。パスが深くなりすぎたら構造を見直す
- **barrel ファイル（index.ts）の乱用禁止** — 必要なモジュールだけを直接インポート

#### 命名規則

| 対象 | スタイル | 例 |
|------|----------|-----|
| ファイル名 | kebab-case | `nmap-parser.ts` |
| 変数・関数 | camelCase | `parseNmapXml()` |
| 型・インターフェース | PascalCase | `HttpEndpoint`, `ParseResult` |
| 定数 | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| Enum | PascalCase（メンバーも） | `enum Status { Open, Closed }` |

#### エラーハンドリング

- **Result パターンを推奨** — 例外スローの代わりに `{ ok: true, data } | { ok: false, error }` を返す
- **例外は境界でのみ catch** — CLI のエントリポイントや API ハンドラで catch し、内部ロジックは Result を伝播
- **カスタムエラークラス** — 必要に応じて `extends Error` で作成。`cause` プロパティを活用

#### SQLite 操作

- **SQL はプリペアドステートメントのみ** — 文字列結合によるクエリ組み立て禁止（SQLインジェクション防止）
- **トランザクションを活用** — 複数の write 操作は `db.transaction()` でラップ
- **マイグレーション管理** — スキーマ変更は `src/db/migrations/` にバージョン付きファイルで管理
- **ID 生成** — `crypto.randomUUID()` を使用（Node.js 組み込み）

### テスト規約（Vitest）

- **テストファイル配置** — `tests/` ディレクトリに `src/` と同じ構造でミラー配置
- **ファイル命名** — `*.test.ts`（例: `nmap-parser.test.ts`）
- **テスト構造** — `describe` > `it` で記述。テスト名は日本語 OK
- **各テストは独立** — テスト間で状態を共有しない。DBテストは毎回 `:memory:` で作成
- **カバレッジ** — `vitest --coverage` で確認。パーサーとエンジンは 80% 以上を目標
- **テスト実行コマンド**:
  - 全テスト: `npm test`
  - ウォッチモード: `npm run test:watch`
  - カバレッジ: `npm run test:coverage`

### npm scripts（標準化）

```json
{
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src/ tests/",
    "lint:fix": "eslint src/ tests/ --fix",
    "format": "prettier --write 'src/**/*.ts' 'tests/**/*.ts'",
    "format:check": "prettier --check 'src/**/*.ts' 'tests/**/*.ts'",
    "typecheck": "tsc --noEmit"
  }
}
```

### 依存関係ルール

- **本番依存（dependencies）は最小限** — better-sqlite3 とCLI フレームワーク程度に抑える
- **新しい依存追加時は必ずユーザーに確認** — なぜ必要か、代替手段はないかを提示
- **`@types/*` は devDependencies** に入れる
- **バージョン固定** — `package-lock.json` をコミットし、CI でも `npm ci` を使う

### セキュリティルール

- **外部入力は必ずバリデーション** — CLI引数、ファイル内容、パース結果すべて
- **パス操作には `path.resolve()` + チェック** — パストラバーサル防止
- **秘密情報をコードに含めない** — `.env` は `.gitignore` に入れる
- **子プロセス実行時はシェル経由禁止** — `execFile` を使い、引数は配列で渡す
- **依存パッケージの脆弱性チェック** — `npm audit` を定期実行

---

## Document

ドキュメントは `/docs` に記載
