# 設計 — tsubame

前提は `docs/spec/requirements.md`。ここでは「どう作るか」だけを書く。

## 1. 全体像

```
                Cloudflare Email Routing
                          |
                    (email handler)
                          |
        拒否/転送の判定 ──┴── 生MIME を R2 へ ── INBOUND_QUEUE
                                                      |
                                              (queue consumer)
                                                      |
                                        パース → D1 保存 → FTS 更新 → Webhook
                          
  ブラウザ / AI エージェント ── (fetch handler) ── Hono ── D1 / R2
                                                      |
                                              OUTBOUND_QUEUE → EMAIL binding
```

- ランタイムは **Workers 単体**。Next.js / OpenNext は使わない。
- HTTP は **Hono**。`/api/*` 以外は SPA 資産（`ASSETS` バインディング）にフォールバックする。
- UI は **Vite + React SPA**。SSR しない。
- ORM は **Drizzle**（D1）。マイグレーションは `wrangler d1 migrations` 一本。

### エントリポイント

`src/worker.ts` が `fetch` / `email` / `queue` / `scheduled` を持つ唯一の入口。
`fetch` は Hono アプリに委譲するだけで、分岐ロジックを書かない。

## 2. ディレクトリと所有権

並列作業の衝突を防ぐため、**ディレクトリごとに担当ワークストリームを固定する**。
自分の担当外のファイルは編集しない。必要なら担当者に依頼する。

```
src/
  worker.ts              [W1] エントリ。ハンドラは各 domain/ の関数を呼ぶだけ
  api/
    app.ts               [W1] Hono ルータ組み立て
    middleware/           [W1] 認証・エラー・ロギング
    auth.ts              [W4] ログイン/ログアウト/セッション
    v1/
      messages.ts        [W6 が GET, W3 が POST/PATCH]
      threads.ts         [W6]
      addresses.ts       [W5]
      attachments.ts     [W2]
      webhooks.ts        [W9]
      me.ts              [W4]
      admin/
        users.ts         [W4]
        api-keys.ts      [W4]
        domains.ts       [W5]
        addresses.ts     [W5]
        rules.ts         [W2]
  domain/                副作用を持たない、または最小限に閉じたロジック
    mail/
      parse.ts           [W2] 生MIME → 正規化済みメッセージ
      address.ts         [W1] アドレス文字列のパース/整形（共有ユーティリティ）
      thread.ts          [W2] スレッド解決
      compose.ts         [W3] 送信メッセージの組み立て
      quote.ts           [W3] 返信引用の生成
    routing/
      resolve.ts         [W2] 受信アドレス解決（拒否→実在→エイリアス→catch-all）
      rules.ts           [W2] ルール評価
    access/
      policy.ts          [W4] 誰がどのアドレスに何をできるか
    search/
      query.ts           [W6] 検索クエリのパースと SQL 生成
  services/              バインディング越しの副作用
    r2.ts                [W2]
    queue.ts             [W1] 型付き enqueue
    cloudflare-api.ts    [W5]
    sender.ts            [W3] EMAIL バインディング
    webhooks.ts          [W9]
  db/
    schema.ts            [W1] 単一ファイル。他ワークストリームは追記のみ相談の上
    client.ts            [W1]
  shared/
    contracts/           [W1 が骨格、各担当が自分の endpoint を追記]
      *.ts               zod スキーマ。サーバと UI で共有する唯一の真実
    errors.ts            [W1]
  ui/                    Vite + React
    main.tsx             [W7]
    lib/                 [W7] API クライアント（contracts から型を取る）
    routes/mail/         [W7]
    routes/admin/        [W8]
    components/          [W7 が基礎、W8 は自分の画面配下に置く]
migrations/              [各担当が連番で追加。番号衝突は統合時に解決]
tests/                   [各担当が自分の担当分を書く]
docs/                    [W10]
```

## 3. データモデル（D1）

`src/db/schema.ts` の一枚もの。ID は `nanoid` ベースの接頭辞付き文字列
（`usr_`, `dom_`, `adr_`, `msg_`, `thr_`, `att_`, `key_`, `whk_`, `job_`, `rul_`）。
時刻は Unix 秒の integer。

| テーブル | 目的 | 要点 |
| --- | --- | --- |
| `users` | 人と AI のアカウント | `role: owner \| member \| agent`, `password_hash`(agent は null 可), `status` |
| `sessions` | UI セッション | Cookie `tsb_session`。ハッシュ保存、期限あり |
| `api_keys` | API トークン | `key_hash`, `prefix`, `scopes[]`, `address_ids[] \| null`, `expires_at`, `revoked_at` |
| `domains` | 接続済みゾーン | `zone_id`, `zone_name`, `name`, `mode: apex \| subdomain`, `routing_status`, `sending_status` |
| `addresses` | 受信アドレス | `domain_id`, `local_part`, `address`(一意), `kind: mailbox \| alias`, `alias_target_id`, `is_catch_all` |
| `address_grants` | 権限 | `(user_id, address_id)` 主キー, `level: read \| write` |
| `threads` | 会話 | `address_id`, `subject`, `last_message_at`, `message_count`, `unread_count` |
| `messages` | メッセージ | 下記参照 |
| `attachments` | 添付 | `message_id`, `filename`, `content_type`, `size`, `content_id`, `is_inline`, `r2_key` |
| `routing_rules` | ルール | `scope: domain \| address`, `action`, `matcher`(JSON), `target`, `priority`, `enabled` |
| `outbound_jobs` | 送信ジョブ | `message_id`, `status`, `attempts`, `last_error`, `next_attempt_at` |
| `webhooks` | 通知先 | `url`, `secret`, `events[]`, `address_ids[]`, `enabled` |
| `webhook_deliveries` | 配信履歴 | `status`, `http_status`, `error`, `duration_ms`, `attempt`, `next_retry_at` |
| `audit_logs` | 監査 | owner の管理操作のみ記録。`actor_id`, `action`, `target`, `meta` |

### `messages`

```
id, thread_id, address_id, direction(inbound|outbound),
status(received|sent|draft|queued|failed|trash),
rfc_message_id, in_reply_to, references_header,
from_addr, from_name, to_addr, cc_addr, bcc_addr,   -- addr 系はカンマ結合の完全な文字列
subject, snippet, text_body, html_body,
raw_r2_key, size_bytes, has_attachments,
is_read, is_starred, spam_verdict,
received_at, created_at
```

インデックス: `(address_id, received_at desc)`, `(thread_id)`,
`(address_id, rfc_message_id)`, `(status)`。

### 全文検索

D1（SQLite）の **FTS5 を `tokenize='trigram'` で使う**。trigram なら形態素解析なしで
日本語の部分一致が成立する。

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, body, addrs,
  content='messages', content_rowid='rowid',
  tokenize='trigram'
);
```

`messages` への INSERT / UPDATE / DELETE トリガで同期する。
**W6 の最初のタスクは、D1 の実機で trigram tokenizer が使えるかを検証すること。**
使えない場合のフォールバックは `LIKE '%…%'` + 前方一致インデックスの併用に切り替える
（この判断は W6 が実測して ADR に記録する）。

## 4. API 契約

すべて `/api/v1/*`。**UI も同じ v1 API を使う**（管理用の別 API を作らない）。
認証は `Authorization: Bearer tsb_...`（API キー）か Cookie セッションのどちらでも通る。

エラーは必ずこの形:

```json
{ "error": { "code": "forbidden", "message": "…", "details": {} } }
```

`code` は `unauthorized` / `forbidden` / `not_found` / `invalid_request` /
`conflict` / `rate_limited` / `internal`。

ページングはカーソル方式。レスポンスは `{ "data": [...], "next_cursor": "…" | null }`。

| メソッド | パス | スコープ | 担当 |
| --- | --- | --- | --- |
| GET/PATCH | `/v1/me`、`/v1/me/api-keys` | スコープ検査無し（Cookie セッションか本人の API キーであること自体が条件。自分の情報のみ） | W4 |
| POST | `/v1/auth/login` `/v1/auth/logout` | — | W4 |
| GET | `/v1/addresses` | read | W5 |
| GET | `/v1/messages` | read | W6 |
| GET | `/v1/messages/{id}` | read | W6 |
| GET | `/v1/messages/{id}/raw` | read | W2 |
| PATCH | `/v1/messages/{id}` | read（`status` の変更は send と write 割り当て。受け付ける status は `received` / `trash` のみ） | W6 |
| POST | `/v1/messages` | send | W3 |
| POST | `/v1/messages/{id}/reply` | read かつ send（読めない相手には返信もできないよう、両方を要求する） | W3 |
| GET | `/v1/threads` `/v1/threads/{id}` | read | W6 |
| GET | `/v1/attachments/{id}` | read | W2 |
| GET/POST/PATCH/DELETE | `/v1/webhooks` | admin | W9 |
| CRUD | `/v1/admin/users` `/v1/admin/api-keys` | admin | W4 |
| CRUD | `/v1/admin/domains` `/v1/admin/addresses` | admin | W5 |
| CRUD | `/v1/admin/rules` | admin | W2 |
| GET | `/v1/openapi.json` | — | W9（未実装。呼ぶと 404） |

### `GET /v1/messages` の検索パラメータ（AI 向けの主要導線）

`q`（全文）, `address`, `from`, `to`, `subject`, `body`, `since`, `until`,
`direction`, `status`, `unread`, `starred`, `has_attachment`, `thread`,
`order`(`received_at`/`relevance`), `limit`(既定 25 / 最大 100), `cursor`。

`q` は簡易演算子を解釈する: `from:foo@bar subject:"見積" since:2026-01-01 添付`。
パースは `src/domain/search/query.ts` に閉じる。

### API を実際に叩くときの注意

実機で踏んだ間違いを残す。**推測で書かず、まずここを読む。**

**一覧のレスポンスは `data`。`items` ではない。**
空に見えたら、まず自分のパーサが `data` を読んでいるか疑う。

```jsonc
{ "data": [ /* ... */ ], "next_cursor": null }
```

**送信は `POST /v1/messages`。`/v1/outbound` は存在しない。**
`src/api/app.ts` で outbound のルータを `/api/v1/messages` に載せているため、
送信も返信も一覧と同じパスに集まる。誤ると `404 not_found` が返る。

**`to` / `cc` / `bcc` は文字列でも配列でも受ける**（`src/shared/contracts/send.ts`）。
保存時はカンマ結合の 1 本の文字列になる。読む側は必ず `parseAddressList` を通す。

```bash
curl -X POST https://<host>/api/v1/messages \
  -H "Authorization: Bearer tsb_..." -H 'Content-Type: application/json' \
  -d '{"from":"ai@example.com","to":["a@example.com"],"cc":["b@example.com"],
       "subject":"件名","text":"本文"}'
# => 202 {"id":"msg_...","status":"queued"}
```

**送信は非同期。**`202 queued` は受理であって送信完了ではない。
実際の結果は `GET /v1/messages/{id}` の `status` が `sent` / `failed` に変わるのを見る。

**自分宛に送ると送信と受信で別レコードになる。**同じメールでも
outbound 1 件と、宛先ごとの inbound が別 id で立つ。To と Cc に同じアドレスを
入れた場合は重複排除されて 1 件になる。

**権限外の id は `403` ではなく `404`。**存在を推測されないための意図的な挙動
（`src/api/v1/messages.ts`）。404 を「消えた」と解釈しない。

### 受信の確認

`bounces@cf-bounce.<domain>` は **Cloudflare が Return-Path に使う正常な envelope sender**。
バウンス（配送失敗）ではない。`wrangler tail` の
`Email from:bounces@cf-bounce...` を送信失敗と読み違えない。

配送経路の切り分けは、上流から順に見る。

| 見るもの | 確認できること |
| --- | --- |
| `dig +short MX <domain>` | `route[1-3].mx.cloudflare.net` を向いているか |
| `wrangler tail` の `Email from:...` | Cloudflare が受けて email ハンドラが起動したか |
| `wrangler tail` の `Queue tsubame-inbound` | パースのキューまで流れたか |
| `GET /v1/messages?direction=inbound` | D1 に保存され API から見えるか |

`mail.example.com` のような**サブドメインは独立したゾーンではない**。
`wrangler email routing settings <subdomain>` は zone not found を返すのが正常で、
ルールは親ゾーンに乗る。catch-all を触るときは第 5 節の apex 保護を必ず読む。

## 5. 認可の考え方

すべてのデータアクセスは「**このリクエストが触れてよい address_id の集合**」を
最初に確定させてから行う（`src/domain/access/policy.ts`）。

```ts
type Principal = {
  userId: string
  role: "owner" | "member" | "agent"
  via: "session" | "api_key"
  scopes: Scope[]          // api_key のとき
  addressIds: string[] | "all"   // 解決済みの許可アドレス
}
```

- owner + session → `"all"`。
- member/agent → `address_grants` から解決。
- API キー → 上記に加えて `api_keys.address_ids` で**さらに狭める**（積集合）。
  キーはユーザーの権限を超えられない。
- クエリは必ず `WHERE address_id IN (…)` を伴う。`userId` で絞る実装は禁止。

## 6. 受信パイプライン（W2）

`email` ハンドラ内で完結させること:
1. `resolveIncoming(message)` — 拒否ルール → 実在アドレス → エイリアス → catch-all。
2. `reject` なら `message.setReject()`、`forward` なら `message.forward()` して終了。
   転送はループ防止ヘッダを見る/付ける。
3. `deliver` なら生 MIME を R2 (`raw/{yyyy}/{mm}/{id}.eml`) に置き、`INBOUND_QUEUE` に
   `{ addressId, rawKey, envelope }` を積んで即座に返す。**パースしない。**

キューのコンシューマ:
4. R2 から取り出して `parse.ts` で正規化（postal-mime）。
5. `thread.ts` で `In-Reply-To` / `References` を既存 `rfc_message_id` と突き合わせてスレッド決定。
6. `messages` + `attachments` を挿入。添付は R2 (`att/{messageId}/{attachmentId}`) へ。
7. アドレススコープのルールを適用。
8. Webhook を発火。

## 7. 送信パイプライン（W3）

1. `POST /v1/messages` を検証（`from` が principal の権限内か。詐称は 403）。
2. `messages` に `status=queued` で挿入し、`outbound_jobs` を作る。
3. `OUTBOUND_QUEUE` に積む。コンシューマが `compose.ts` で MIME を組み立て、
   `EMAIL` バインディングで送る。
4. 成功で `status=sent` + Cloudflare が返した Message-ID を `rfc_message_id` に記録。
   失敗は `attempts++` して指数バックオフで再投入。上限超過で `status=failed`。

## 8. ドメイン接続（W5）

1. `GET /v1/admin/domains/available` で Cloudflare の zone を列挙。
2. 接続時に **既存 MX を検査**して結果を返す。apex に他社 MX があれば
   `mode: subdomain` を強く推し、apex を選ぶには明示フラグを要求する。
3. Email Routing DNS を有効化。宛先 Worker はデプロイ名（`tsubame`）。
4. Email Sending 用の SPF / DKIM / DMARC を整える。
5. 切断時は作った DNS レコードとルーティングルールを片付ける。

**catch-all はゾーン単位で全メールを飲む**。既定で有効化しない。有効化は
ドメイン単位のオプトインとし、UI に警告を出す。

## 9. 運用制約（必ず守る）

- Worker 名は `tsubame`。`wrangler.jsonc` の `name`、service binding の `service`、
  Email Routing ルールの宛先の 3 箇所が一致していること。
- `wrangler.jsonc` にアカウント固有の ID を書かない（`database_id` 等は
  `wrangler.jsonc` をローカルで上書きするか、CI のシークレットから注入する）。
- 旧 `mailflare` Worker と D1 には触らない。新規リソースを別名で作る。
  切り替えは `docs/ops/deployment.md`（W10）の手順に従う。

## 10. 決定事項（ADR 相当）

- **ADR-1**: Next.js/OpenNext をやめて Hono + React SPA にする。理由: 実質の入口が
  Worker であり、SSR の要件が無く、ビルドとデプロイの複雑さに見合わない。
- **ADR-2**: API キーはユーザー単位ではなくキー単位でアドレスとスコープを絞る。
  理由: AI 用アカウントと人間の受信箱を構造的に分離するため。
- **ADR-3**: 検索は FTS5 trigram。理由: 形態素解析器を Workers に載せずに日本語部分一致を得るため。
- **ADR-4**: UI 用 API を分けず v1 API を UI からも使う。理由: 二重実装を避け、
  API を常に第一級に保つため。
- **ADR-5**: IMAP/POP3 は提供しない。理由: Workers に常駐プロセスが無い。
  代替は API・Webhook・Email Routing の転送。
