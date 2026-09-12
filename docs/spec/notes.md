# 気付き — 未確認の疑いを置く場所

[セキュリティ観点](security.html) でコードを読んでいて「怪しいが、まだ走らせて確かめていない」
ものを書く。人が気付いたものも、エージェントが精査中に気付いたものも、ここに置く。

[精査の残件](security-audit.html) には**確認したものしか書かない**。
ここはその手前の置き場で、確かめたら精査へ昇格させるか、却下して理由を残す。

## 書き方

1 項目は 3 行まで。「疑い」「場所」「どう確かめるか」だけ書く。長くなるなら精査に書く。

| 状態 | 意味 |
| --- | --- |
| `未確認` | 読んで疑っただけ。走らせていない |
| `精査 #n` | 確かめて成立した。本文は精査に移し、ここは 1 行だけ残す |
| `却下` | 確かめて成立しなかった、または意図どおり。理由を残す（次の人が同じ道を歩かない） |

消さない。却下も残す。

## セキュリティ

### 認証（S-1）

- `解決` **bootstrap にレート制限が無い。** 精査 #52 で `auth.ts` bootstrap に IP 単位の `LOGIN_RATE_LIMIT` を掛けた。
- `精査 #25` **仮パスワードの強制が UI だけ。** 成立。`POST /me/api-keys` は #64 で塞いだ（`requireKeyManagement`）。残りの API は今も通る（FR-13 は画面の話としている）。
- `却下` **ログイン後の `?next=` を検証していない。** react-router 8.3.1 の `validateNavigationTarget` が
  `//evil.example` / `/\evil.example` / `https://evil.example` を拒否する（実物の router で確認）。ライブラリ依存なので自前検査の追加は推奨。

### 認可（S-2）

- `却下` **返信経路だけ権限外を 403 で返す。** 読めない id は 404 に揃っている。403 は「読めるが書けない」ときだけで、存在は既に分かっている。
- `未確認` **範囲を絞った admin キーで他人のキーを失効できる。** `src/api/v1/admin/api-keys.ts` の `DELETE /:id` に `requireUnrestricted` が無い（POST は clamp、webhook・ルール・ドメイン・アドレスの変更系は #129 で 403）。
  addressIds を絞ったキーで別ユーザーの全開放キーを `DELETE` して 200 になるか、`tests/security-129-restricted-admin.test.ts` に足して確かめる。

### 受信（S-3）

- `精査 #19` **受信の `Date` ヘッダをそのまま `received_at` に使う。** 成立。`inbound.ts` `resolveReceivedAt` で外れ値を投入時刻に落とした。1 年以内の過去日は通る（精査の残件）。
- `解決` **`spam_verdict` を書く側が無い。** 精査 #128 で `inbound.ts` が `X-CF-SpamH-Score` を `spamVerdictFromScore` で `spam_verdict` に写すようになった。
- `解決` **キュー投入の失敗が観測されない。** 精査 #24。`incoming.ts` が `INBOUND_QUEUE.send` を `await` して例外にし、Email Routing に再送させる形にした。実機での再送は未確認（精査の「未確認」）。

### 送信（S-5）

- `解決` **返信の引用に受信 HTML をそのまま埋め込む。** 精査 #16。`quote.ts` `buildReplyQuote` が `stripHtml → escapeHtml → <pre>` に落とすようにした。
- `却下` **受信ヘッダ由来の値が送信ヘッダに戻る。** postal-mime は encoded-word 経由で CRLF を残すが、`compose.ts` の検査で注入は成立しない（実証済み）。
  返信が失敗する副作用は精査 #33。
- `精査 #21` **二重送信の防止が「読んでから更新」。** `outbound.ts` を 1 文の `UPDATE … RETURNING` の claim と `sent_recipients` の記録に直した。残る経路は精査の残件（送信）。

### 表示と配信（S-4）

- `解決` **生 MIME が `inline` で配信される。** 精査 #49。`attachments.ts` `rawRouter` が `Content-Disposition: attachment; filename="<id>.eml"` で返す。

### シークレット・監査（S-8）

- `解決` **`AUTH_SECRET` がコードで使われていない。** 精査 #41。`worker-env.d.ts`・`.dev.vars.example`・`docs/ops/deployment.md` から消した。
- `対応済` **監査ログの対象外が多い。** webhooks（作成・更新・削除・手動再送）、rules（作成・更新・削除）、
  domains（接続・切断・catch-all 変更）、addresses（作成・更新・削除・アーカイブ）、devices（登録・削除）に
  recordAudit を揃えて入れた。DNS を触る切断（domain.disconnect）も記録する。アーカイブは address.update の
  meta の `archived` に含む。各 action が記録されることを e2e で確かめる。

### 可用性（S-9）

- `未確認` **Webhook の POST が受信コンシューマの中で直列に走る。** `services/webhooks.ts` `dispatchMessageEvent` は有効な Webhook 全部へ `Promise.all` で `fetch`（各 10 秒タイムアウト）し、`inbound.ts` がそれを `await` する。
  Webhook が多い・遅いと受信 1 通の処理が長引き、Free の外部リクエスト上限（50）にも当たる。Webhook 5 本を 10 秒遅延で用意して `drainQueues` の所要時間と `item.retry` の有無を見る。

- `解決` **精査 #5 の「回り続ける」は `max_retries: 3` で止まる。** 精査 #20。`wrangler.jsonc` に受信・送信の DLQ を足し、パース例外は `inbound.ts` `parseErrorPlaceholder` で行を残すようにした。DLQ に落ちた分の見方は運用文書に無い（バックログ）。

## セキュリティ以外

- `対応済` **`wrangler.jsonc.example` の Worker 名が `ridley` のまま。** `name` と `EMAIL_WORKER_NAME` が本体と違った。
  `tsubame` に揃え、本体から抜けていた DLQ 設定も反映した。環境変数も `RIDLEY_*` → `D1_DATABASE_ID` / `TSUBAME_*` に改名。
