# バックログ — 残っている作業

要件（`requirements.md`）・画面設計（`mobile-screens.md` / `pc-screens.md`）・精査（`security-audit.md`）・運用文書と、
`src/` `tests/` `e2e/` の実装を突き合わせて、**コードを読んで確かめた**未実装・不整合・未カバーだけを載せる。
読んで疑っただけのものは [気付き](notes.md) に `未確認` で置く。

- 2026-09-12 に作成。
- ID は `B-n`。優先度は 高（放置すると壊れる・利用者が操作できない）/ 中（要件・画面設計との差、利用者の要望）/ 低（改善）。
- 規模は S（半日）/ M（1〜2 日）/ L（それ以上）。
- 「共有」は `.agents/skills/workstream/SKILL.md` の編集禁止ファイル（`schema.ts` `app.ts` `worker.ts` `types.ts` `errors.ts`
  `contracts/common.ts` `address.ts` `queue.ts` `wrangler.jsonc` `package.json` migrations）や、複数の担当が触るファイルに手を入れるか。
- 実環境の値は書かない。

## 1. 実装

今は無い。B-1〜B-32 は 2026-09-12 に片付けた（中身はその時のコミットにある）。B-25 の署名は「そのメールボックスに write 権限を持つ利用者なら変えられ、変更は監査ログに `address.signature` で残す」と決めた。
新しく見つけたら B-33 から振る。

## 2. 実装タスクにしないもの

- **実機でしか確かめられないもの**は `security-audit.md` §5（`X-CF-SpamH-Score` の尺度、Email Routing の再送、998 文字ヘッダ、25MB のパース、ゾーン単位 catch-all、Cloudflare API のレート制限、`Zone Settings – Edit` の要否、`__Host-` Cookie とローカル開発）。
- **運用で守るもの**は `security-audit.md` §3 の太字（受信 HTML の DOMParser 経路に自動テストが無い、修正前に保存された行）と `docs/ops/operations.md` §6。
- **受け入れた制約**は `security-audit.md` §3。バックログに昇格させたのは #42 / #69（B-20）、#116（B-22）、#25（B-26）、#47（B-32）だけ。残りは仕組みで直す価値が無いか、設計として受け入れている。
  FR-13「変更するまで他の画面に進めない」がサーバでは API キー管理しか止めていない（`me.ts:41`）のも #25 の残件として受け入れている。
- 要件の非目標（`requirements.md` §4）に当たるものは載せない。
