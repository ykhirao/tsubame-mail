# AGENTS.md

`tsubame` — Cloudflare Workers 上で動く自前のメール基盤。

**まず `docs/spec/requirements.md` と `docs/spec/architecture.md` を読むこと。** 何を作るか（要件）と
どう作るか（設計・ディレクトリ所有権・API 契約）はそこに書いてある。この 2 つが唯一の真実。

## ライセンス

MIT で公開している。

- **他リポジトリのコードを読んで写さない。** 必要なら仕様だけを参照する。
- 依存に足すのは MIT / Apache-2.0 / BSD のライブラリのみ。

## コマンド

```bash
npm run dev              # Vite（UI）。/api は 127.0.0.1:8787 にプロキシ
npm run dev:worker       # wrangler dev（API・email・queue）
npm run typecheck        # tsc --noEmit。CI で必須
npm run test             # 単体 + e2e（@cloudflare/vitest-pool-workers）
npm run test:e2e         # e2e だけ
npm run spec:coverage    # 要件と e2e の対応。未カバーがあれば失敗
npm run e2e:new FR-5     # 要件から e2e の雛形を起こす
npm run verify           # 型検査 + テスト + 対応表 + ビルド
npm run doc              # 仕様書を組み立てて http://localhost:4173 で配る
npm run doc:build        # docs/build/ に出力（そのまま配れる）
npm run db:generate      # スキーマ変更後に必ず実行
npm run db:migrate:local
npm run build            # Vite で dist/client を作る
npm run deploy           # build + wrangler deploy
```

## 規約

- **コメントは負債。書かないのが既定で、why だけを例外として残す。**
  区切り線・章立て、識別子を言い換えただけの JSDoc、ファイル冒頭の設計解説は書かない
  （`.agents/skills/comments/SKILL.md`。`npm run check:comments` と commit フックで見張る）。
- 並列作業の進め方は `.agents/skills/workstream/SKILL.md`、
  レビュー観点は `.agents/skills/code-review/SKILL.md`、
  e2e の書き方と育て方は `.agents/skills/e2e/SKILL.md` にある。

- インデントはタブ。`@/*` は `src/*`。
- **担当ディレクトリの外を編集しない**（`docs/spec/architecture.md` の「2. ディレクトリと所有権」）。
  他所に手を入れる必要が出たら、変更内容を報告して統合担当に任せる。
- API のエラーは必ず `ApiError`（`src/shared/errors.ts`）を投げる。
  レスポンス整形はミドルウェアがやる。ハンドラで `c.json({error:...})` を直接書かない。
- リクエスト検証は zod。スキーマは `src/shared/contracts/` に置き、UI と共有する。
- 認可は `Principal.addressIds` で行う。**`userId` で絞るクエリを書かない**
  （共有アドレスと API キーのスコープが壊れる）。
- `to` / `cc` は複数アドレスのリスト。`src/domain/mail/address.ts` の
  `parseAddressList` を使う。単一アドレス前提のコードを書かない。
- 日本語 UI。翻訳レイヤーは作らない。文字列は直接日本語で書く。
- 新しい設定項目を安易に増やさない。要件に「設定は最小限」とある。

## 環境について

依存はどれも 2026 年秋時点の最新で、学習データより新しい可能性が高い
（TypeScript 7 / Vite 8 / Vitest 5 / React Router 8 / Hono 4 / Zod 4 / wrangler 4）。
API を思い出しで書かず、`node_modules/<pkg>` の型定義か公式ドキュメントを確認すること。

## 落とし穴（必ず守る）

1. `message.setReject()` / `message.forward()` は **email ハンドラでしか呼べない**。
   キューのコンシューマからは呼べない。
2. Worker 名 `tsubame` は `wrangler.jsonc` の `name`、`vars.EMAIL_WORKER_NAME`、
   Cloudflare Email Routing のルール宛先の 3 箇所で一致していなければ受信が止まる。
3. Cloudflare の catch-all は**ゾーン単位**。apex の MX を奪うと、そのドメインの
   全メールがこのアプリに流れ込む。既定で有効化しない。
4. 受信ハンドラでメールをパースしない。R2 に置いてキューに逃がす。
5. `wrangler.jsonc` にアカウント固有の ID を書かない。
