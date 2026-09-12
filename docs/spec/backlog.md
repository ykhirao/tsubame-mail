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

B-1〜B-32 は 2026-09-12 に片付けた（中身はその時のコミットにある）。B-25 の署名は「そのメールボックスに write 権限を持つ利用者なら変えられ、変更は監査ログに `address.signature` で残す」と決めた。
番号は続きから振る（次は B-35）。

### 残っているもの

| ID | 何が足りないか | 根拠 | 触る場所 | 共有 | 規模 | 優先度 |
| --- | --- | --- | --- | --- | --- | --- |
| B-33 | 未読の数え方が 2 系統あって必ずドリフトする: バッジは `messages.is_read = false` を毎回数える実測値、一覧の行の濃淡は `threads.unread_count` というカウンタ列。この列は**受信の挿入時にしか加算されないのに、既読化の PATCH は direction を問わず減算する**という非対称があり、送信控えを既読にするたびに実態から下振れする（`max(0, …)` で 0 に張り付く）。加えて送信控えは行の `is_read` が既定の `false` のまま作られるためバッジだけを増やす。結果、送信しかしていないメールボックスでバッジが増え続け、一覧はどの行も既読の見た目になる。どちらを正とするか（送信控えを既読で作る／バッジも direction で絞る）を決めて片方に寄せ、加算と減算を対称にする | 実機で確認: 同じ 8 件に対し `/v1/addresses` が未読 4、`/v1/threads` が全スレッド 0、`/v1/messages` の `is_read = false` が 4 件（いずれも outbound。trash は 0 件なので status による差ではない）。`src/api/v1/addresses.ts:54-57`（direction で絞らない相関サブクエリ）、`src/api/v1/outbound.ts:161-179`（`isRead` を設定しない）・`:190`（新規スレッドは `unreadCount: 0`）・`:194-197`（返信では `unread_count` を加算しない）、`src/db/schema.ts:190`（既定 `false`）、`src/api/v1/messages.ts:208-214`（減算は direction を問わない）、`src/domain/mail/inbound.ts:361,389`（受信だけが `isRead` と `unreadCount` の対を持つ）、`src/ui/routes/AppLayout.tsx:114`、`src/ui/routes/Inbox.tsx:360` | `src/api/v1/outbound.ts`（送信控えを既読で作る）か `src/api/v1/addresses.ts`（数える条件）。`messages.ts` の減算と対称にする | 不要 | S | 中 |
| B-34 | 一覧で送信と受信を見分けられない: `Inbox.tsx` は `direction` を一度も参照しておらず、行に出るのは差出人・件名・時刻と、スレッドの所属メールボックスを示す色チップ（`t.address`）だけ。自分宛に送ると同じ件名の行が受信と送信控えで 2 本並び、どちらがどちらか一覧では判別できない。「送信済み」を開いても行の見た目は受信箱と同じ。検索画面も同様。方向を示す手掛かり（アイコン・宛先の前置き・行の装飾のいずれか）を足す | 実機で確認: 別ドメインのメールボックス宛に送った 2 通が、受信箱では受信側のチップ、送信済みでは送信控えとして同じ件名・同じ差出人表示で並び、区別がつかなかった。`src/ui/routes/Inbox.tsx`（`direction` の参照が 0 箇所。チップは `:404-411` `:483-493` `:538-548` で `t.address`）、`src/domain/search/sql.ts:287` 付近（一覧が受け取る列に direction が含まれるか要確認）、`src/ui/routes/Search.tsx:135-165` | `src/ui/routes/Inbox.tsx`、`src/ui/routes/Search.tsx`。一覧が direction を持っていなければ `src/api/v1/threads.ts` と `src/domain/search/sql.ts` にも足す | 不要 | S | 中 |

## 2. 実装タスクにしないもの

- **実機でしか確かめられないもの**は `security-audit.md` §5（`X-CF-SpamH-Score` の尺度、Email Routing の再送、998 文字ヘッダ、25MB のパース、ゾーン単位 catch-all、Cloudflare API のレート制限、`Zone Settings – Edit` の要否、`__Host-` Cookie とローカル開発）。
- **運用で守るもの**は `security-audit.md` §3 の太字（受信 HTML の DOMParser 経路に自動テストが無い、修正前に保存された行）と `docs/ops/operations.md` §6。
- **受け入れた制約**は `security-audit.md` §3。バックログに昇格させたのは #42 / #69（B-20）、#116（B-22）、#25（B-26）、#47（B-32）だけ。残りは仕組みで直す価値が無いか、設計として受け入れている。
  FR-13「変更するまで他の画面に進めない」がサーバでは API キー管理しか止めていない（`me.ts:41`）のも #25 の残件として受け入れている。
- 要件の非目標（`requirements.md` §4）に当たるものは載せない。
