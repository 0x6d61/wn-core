# 計画: 組み込みツール実装（read / write / grep / shell）

> Issue #5 / Branch: feature/5-builtin-tools

## コンテキスト

Core 型定義 + ToolRegistry（Issue #3 / PR #4）が完了。次のステップとして architecture.md §5.3 で定義された **4つの組み込みツール** を実装する。ToolDefinition インターフェースに準拠し、ToolRegistry に登録可能な形で各ツールを提供する。

## 設計判断

1. **ファクトリ関数パターン** — 各ツールは `createXxxTool(): ToolDefinition` を返す関数（クラス不要）
2. **共通バリデーションモジュール** — `src/tools/validate.ts`（内部モジュール、非公開）で引数検証を共有
3. **shell ツール** — `execFile` + プラットフォームシェル（Unix: `/bin/sh -c`, Windows: `powershell.exe -Command`）。セキュリティ境界はRPC/オペレーター承認層（将来実装）
4. **`as` キャスト禁止** — 型ガード関数で代替（ESLint + CLAUDE.md 準拠）
5. **外部依存なし** — 全て `node:fs`, `node:path`, `node:child_process`, `node:util` で実装
6. **ファイルロック** — Worker Threads（SubAgentRunner）フェーズで実装。今回は単純な write
7. **shell デフォルトタイムアウト** — なし（timeout=0）。ペンテストツール（nmap 等）は長時間実行のため、LLM/operator が明示指定した場合のみ適用

## 変更対象ファイル

新規作成（10ファイル）:

| ファイル | 内容 |
|---------|------|
| `src/tools/validate.ts` | 引数バリデーションヘルパー（requireString, optionalString, optionalNumber） |
| `src/tools/read.ts` | `createReadTool()` — ファイル読み込み（offset/limit 対応） |
| `src/tools/write.ts` | `createWriteTool()` — ファイル書き込み（親ディレクトリ自動作成） |
| `src/tools/grep.ts` | `createGrepTool()` — 正規表現検索（ファイル/ディレクトリ再帰、glob フィルタ） |
| `src/tools/shell.ts` | `createShellTool()` + `getShellConfig()` — クロスプラットフォームコマンド実行 |
| `tests/tools/validate.test.ts` | バリデーションヘルパーのテスト |
| `tests/tools/read.test.ts` | read ツールのテスト（10件） |
| `tests/tools/write.test.ts` | write ツールのテスト（8件） |
| `tests/tools/grep.test.ts` | grep ツールのテスト（11件） |
| `tests/tools/shell.test.ts` | shell ツールのテスト（9件） |

変更（2ファイル）:
- `src/index.ts` — `createReadTool`, `createWriteTool`, `createGrepTool`, `createShellTool`, `getShellConfig`, `ShellConfig` を re-export
- `tests/index.test.ts` — re-export の検証追加

## セキュリティ考慮事項

- **パス正規化**: 全ツールで `path.resolve()` 使用（パストラバーサル対策）
- **コマンドインジェクション防止**: `execFile` 使用（`exec` 禁止）
- **リソース制限**: shell timeout (デフォルトなし、明示指定時のみ), maxBuffer (10MB), grep MAX_RESULTS (1000行)
- **入力バリデーション**: 全パラメータを実行前に検証、無効値は例外ではなく ToolResult で返却
- **`any` 型禁止**: エラーは `unknown` で受けて `instanceof Error` で絞り込み
