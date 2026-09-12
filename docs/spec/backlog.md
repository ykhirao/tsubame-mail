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

B-1〜B-22・B-27〜B-32 は 2026-09-12 に実装した（通知の D1 上限と設定画面、Webhook の止まった配信の再送、API キーの再発行、
管理画面の詳細ページ 6 つ、監査ログを読む API、接続後の Email Sending の有効化、ゴミ箱の添付、文書の更新）。中身はその時のコミットにある。
番号は続きから振る（次は B-33）。

### 残っているもの

| ID | 何が足りないか | 根拠 | 触る場所 | 共有 | 規模 | 優先度 |
| --- | --- | --- | --- | --- | --- | --- |
| B-23 | 一覧の位置の保持が部分的: 会話から戻ると 1 ページ目だけ取り直して ids を上書きするので「もっと読む」で進んだ位置は戻らない。通知から開いた会話は SW が `client.navigate` でページごと読み直すため `listState` が消える（FR-17 の e2e は「通知から開いたら受信箱に戻る」で許容） | `src/ui/routes/Inbox.tsx:77-99`、`src/ui/sw.ts:266`、`src/ui/lib/listState.ts`（モジュール変数）。M-01「一覧の位置を保つ」 | `Inbox.tsx`（復元時は保存した件数まで読む）、`sw.ts`（`postMessage` で開いているクライアントに遷移させる） | 不要 | M | 低 |
| B-24 | ホーム画面に追加の案内: Android / PC で `beforeinstallprompt` が来ていないと iOS の手順シートを出す。P-02 は文章だけで「絵で示す」が無い。P-03 は許可するとすぐ完了画面で「これで終わり」が無く、`unsupported` のとき何も出ない | `src/ui/components/InstallBanner.tsx:24`、`IosInstallSheet.tsx`、`src/ui/routes/welcome/notifications.tsx:110-116`。`mobile-screens.md` P-01〜P-03 | `InstallBanner.tsx`、`IosInstallSheet.tsx`（`public/icons/` に手順の絵を足す）、`welcome/notifications.tsx` | 不要 | M | 低 |

### 要件の解釈を決めてから着手するもの

| ID | 何が足りないか | 根拠 | 触る場所 | 共有 | 規模 | 優先度 |
| --- | --- | --- | --- | --- | --- | --- |
| B-25 | FR-9 は設定の例に「署名」を挙げるが、署名はアドレスの属性で owner の管理 API でしか変えられない。member は自分の署名を設定できない。作成画面は署名を本文に足す仕組みを持っている。共有メールボックスの署名を誰が変えてよいか（write 割り当てなら可、など）を決めてから | `src/ui/routes/Settings.tsx`（表示名・パスワード・通知・API キーのみ）、`src/shared/contracts/users.ts` `updateMeBody`（`signature` 無し）、`src/ui/routes/Compose.tsx:144-145` | `src/api/v1/addresses.ts`（`PATCH /v1/addresses/:id` で `signature` だけ受ける）、`src/shared/contracts/addresses.ts`、`Settings.tsx`、`e2e/specs/fr09-*.ts` | 不要 | M | 低 |
| B-26 | 子キーのカスケード失効が無い（親キーを失効しても、そのキーで発行した子キーは生きる）。発行の門（範囲・期限の clamp）で塞いでいるが、漏れたキーの失効で連鎖を止められない | 精査 #25。`src/db/schema.ts` `api_keys` に親子の列が無い | `src/db/schema.ts`（`parent_key_id`）、migration、`src/api/v1/me.ts`・`admin/api-keys.ts` | **スキーマ変更・migration** | M | 低 |

## 2. 実装タスクにしないもの

- **実機でしか確かめられないもの**は `security-audit.md` §5（`X-CF-SpamH-Score` の尺度、Email Routing の再送、998 文字ヘッダ、25MB のパース、ゾーン単位 catch-all、Cloudflare API のレート制限、`Zone Settings – Edit` の要否、`__Host-` Cookie とローカル開発）。
- **運用で守るもの**は `security-audit.md` §3 の太字（受信 HTML の DOMParser 経路に自動テストが無い、修正前に保存された行）と `docs/ops/operations.md` §6。
- **受け入れた制約**は `security-audit.md` §3。上に昇格させたのは #42 / #69（B-20）、#116（B-22）、#25（B-26）、#47（B-32）だけ。残りは仕組みで直す価値が無いか、設計として受け入れている。
  FR-13「変更するまで他の画面に進めない」がサーバでは API キー管理しか止めていない（`me.ts:41`）のも #25 の残件として受け入れている。
- 要件の非目標（`requirements.md` §4）に当たるものは載せない。
