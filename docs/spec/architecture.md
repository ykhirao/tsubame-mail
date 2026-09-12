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
    v1/
      auth.ts            [W4] ログイン/ログアウト/セッション/オーナー作成（bootstrap）
      messages.ts        [W6（GET / PATCH）]
      outbound.ts        [W3]
      threads.ts         [W6]
      addresses.ts       [W5]
      attachments.ts     [W2]
      webhooks.ts        [W9]
      me.ts              [W4]
      notifications.ts   [W11] 通知設定・ルール・通知欄・会話の通知
      devices.ts         [W11] 購読端末
      push.ts            [W11] VAPID 公開鍵・バッジ
      admin/
        users.ts         [W4]
        api-keys.ts      [W4]
        domains.ts       [W5]
        addresses.ts     [W5]
        rules.ts         [W2]
      admin/
        audit-logs.ts     [W4]
  domain/                副作用を持たない、または最小限に閉じたロジック
    mail/
      address.ts         [W1] アドレス文字列のパース/整形（共有ユーティリティ）
      parse.ts           [W2] 生MIME → 正規化済みメッセージ
      inbound.ts         [W2] 受信キューのコンシューマ（保存・FTS・Webhook・NOTIFY を積む）
      thread.ts          [W2] スレッド解決
      outbound.ts        [W3] 送信キューのコンシューマ（組み立て・送信・バックオフ）
      compose.ts         [W3] 送信用 MIME の組み立て
      quote.ts           [W3] 返信引用の生成
    notify/
      decide.ts          [W11] 通知判定（副作用なし）
      schedule.ts        [W11] おやすみ時間の計算
    routing/
      incoming.ts        [W2] email ハンドラ（拒否/転送・R2 保存・INBOUND_QUEUE へ）
      resolve.ts         [W2] 受信アドレス解決（拒否→実在→エイリアス→catch-all）
      rules.ts           [W2] ルール評価
    access/
      policy.ts          [W4] 誰がどのアドレスに何をできるか
    domains/
      provision.ts       [W5] ドメイン接続と DNS 後始末
      dns-check.ts        [W5] 既存 MX / Email Sending の DNS 検査
      cleanup.ts          [W5] 切断時の後始末
    search/
      query.ts           [W6] 検索クエリのパース
      sql.ts             [W6] 検索 SQL の組み立て（trigram + LIKE）
  services/              バインディング越しの副作用
    r2.ts                [W2]
    queue.ts             [W1] 型付き enqueue
    consumer.ts          [W1] キューのバッチを種類ごとに振り分け
    webpush.ts           [W11] VAPID・RFC 8291 暗号化・送信
    notify.ts            [W11] 通知キューのコンシューマ・cron
    notify/              [W11] deliver(配信)/load(読み込み)/prefs(設定・未読数)/render(描画)/token-cache
    maintenance.ts       [W11] cron のまとめ配信・掃除（監査ログ・通知ログ・未使用端末）
    cloudflare-api.ts    [W5]
    sender.ts            [W3] EMAIL バインディング
    webhooks.ts          [W9]
  lib/                   id 採番・ページング・パスワード・トークン・検証などの共有ユーティリティ
    id.ts, paging.ts, password.ts, tokens.ts, validate.ts
  db/
    schema.ts            [W1] 単一ファイル。他ワークストリームは追記のみ相談の上
    client.ts            [W1]
  shared/
    contracts/           [W1 が骨格、各担当が自分の endpoint を追記]
      *.ts               zod スキーマ。サーバと UI で共有する唯一の真実
      notifications.ts   [W11]
    errors.ts            [W1]
    colors.ts            [W1] アドレス色の採番（FR-14）
  ui/                    Vite + React
    main.tsx             [W7]
    sw.ts                [W7] Service Worker（キャッシュ・push 表示）
    lib/                 [W7] API クライアント（contracts から型を取る）
    routes/*.tsx         [W7] メールの画面（受信箱・会話・作成・検索・設定）。サブディレクトリは切っていない
    routes/admin/        [W8] index / gate / detail / 各 *Page / 各 *DetailPage / api / ColorPicker
    routes/settings/notifications/  [W7]
    routes/welcome/notifications.tsx [W7]
    routes/NotificationsFeed.tsx     [W7] 通知欄
    components/          [W7 が基礎、W8 は自分の画面配下に置く]
public/
    manifest.webmanifest, icons/     [W7]
migrations/              [各担当が連番で追加。番号衝突は統合時に解決]
tests/                   [各担当が自分の担当分を書く]
docs/                    [W10]
```

## 3. データモデル（D1）

`src/db/schema.ts` の一枚もの。ID は `nanoid` ベースの接頭辞付き文字列
（`usr_`, `ses_`, `dom_`, `adr_`, `msg_`, `thr_`, `att_`, `key_`, `whk_`, `job_`, `rul_`, `dlv_`, `aud_`, `dev_`, `nrl_`, `ntf_`, `dig_`）。
時刻は Unix 秒の integer。

| テーブル | 目的 | 要点 |
| --- | --- | --- |
| `users` | 人と AI のアカウント | `role: owner \| member \| agent`, `status`, `password_hash`(agent は null 可), `must_change_password`, `last_login_at` |
| `sessions` | UI セッション | Cookie `__Host-tsb_session`（精査 #84）。`token_hash` ハッシュ保存、`expires_at`、`user_agent`、`ip` |
| `api_keys` | API トークン | `user_id`, `name`, `prefix`, `key_hash`, `scopes[]`, `address_ids[] \| null`, `expires_at`, `revoked_at`, `last_used_at` |
| `domains` | 接続済みゾーン | `zone_id`(一意), `name`, `zone_name`, `mode: apex \| subdomain`, `routing_status`, `sending_status`, `catch_all_enabled`, `last_error` |
| `addresses` | 受信アドレス | `domain_id`, `local_part`, `address`(一意), `display_name`, `kind: mailbox \| alias`, `alias_target_id`, `is_catch_all`, `signature`, `color`, `archived_at` |
| `address_grants` | 権限 | `(user_id, address_id)` 主キー, `level: read \| write` |
| `threads` | 会話 | `address_id`, `subject`, `last_message_at`, `message_count`, `unread_count` |
| `messages` | メッセージ | 下記参照 |
| `attachments` | 添付 | `message_id`, `filename`, `content_type`, `size_bytes`, `content_id`, `is_inline`, `r2_key` |
| `routing_rules` | ルール | `scope: domain \| address`, `domain_id` / `address_id`, `name`, `action`, `matcher`(JSON), `target`, `priority`, `enabled` |
| `outbound_jobs` | 送信ジョブ | `message_id`, `status`, `attempts`, `last_error`, `next_attempt_at`, `sent_recipients`, `sent_at` |
| `webhooks` | 通知先 | `name`, `url`, `secret`(ハッシュ保存), `events[]`, `address_ids[]`, `enabled` |
| `webhook_deliveries` | 配信履歴 | `webhook_id`, `event`, `message_id`, `status`, `http_status`, `error`, `duration_ms`, `attempt`, `next_retry_at` |
| `audit_logs` | 監査 | 管理操作と端末・利用者自身のキー・bootstrap を記録。`actor_id`, `action`, `target_type`, `target_id`, `meta`, `ip` |
| `settings` | キー・バリュー（VAPID キャッシュ等） | `key`, `value`(JSON), `updated_at` |
| `push_devices` | 購読端末 | `user_id`, `session_id`, `endpoint`(一意), `p256dh`, `auth`, `name`, `platform: ios \| android \| desktop`, `enabled`, `address_ids[] \| null`, `last_seen_at`, `last_success_at`, `failure_count` |
| `notification_prefs` | 利用者の通知設定（1 行） | `enabled`, `paused_until`, `display`, `badge`, `group_by_thread`, `burst_window_sec`, `suppress_when_active`, `spam_suspicious`, `quiet`(JSON), `notify_send_failure`, `notify_catch_all`, `feed_seen_at` |
| `notification_mailbox_prefs` | メールボックスごとの通知レベル | `(user_id, address_id)` 主キー, `level: all \| new_thread \| direct \| off` |
| `notification_rules` | 通知ルール | `name`, `matcher`(JSON), `action: always \| normal \| silent \| never`, `priority`, `enabled` |
| `thread_notification_prefs` | 会話ごと | `(user_id, thread_id)` 主キー, `mode: follow \| mute` |
| `notification_digests` | 後でまとめる分 | `user_id`, `due_at`, `message_ids[]` |
| `notification_log` | 判定の履歴（通知欄） | `kind: received \| send_failed`, `decision: sent \| held \| digest \| dropped`, `reason`, `hold_group`, `device_count`, `retry_device_ids`。30 日で消す |

### `messages`

```
id, thread_id, address_id, direction(inbound|outbound),
status(received|sent|draft|queued|failed|trash),
rfc_message_id, in_reply_to, references_header,
from_addr, from_name, to_addr, cc_addr, bcc_addr,   -- addr 系はカンマ結合の完全な文字列
subject, snippet, text_body, html_body,
raw_r2_key, size_bytes, has_attachments,
is_read, is_starred, spam_verdict,
sent_by_user_id, envelope_to,
received_at, created_at
```

インデックス: `(address_id, received_at desc)`, `(thread_id)`,
`(address_id, rfc_message_id)`, `(status)`。

`sent_by_user_id` は送信失敗を本人にだけ知らせるための記録（null の失敗はそのメールボックスの `write` 全員に知らせる）。
`envelope_to` はキャッチオールに届いたメールの本来の宛先（To ヘッダは BCC 等で食い違うため代わりにならない）。

### 全文検索

D1（SQLite）の **FTS5 を `tokenize='trigram'` で使う**。trigram なら形態素解析なしで
日本語の部分一致が成立する。

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, text_body, from_addr, to_addr, cc_addr,
  content='messages', content_rowid='rowid',
  tokenize='trigram'
);
```

`messages` への INSERT / UPDATE / DELETE トリガで同期する。
trigram は 3 文字未満の語を索引しないので、1〜2 文字の語は `LIKE` に落として検索する
（フォールバックの判断は [検索方式の決定](adr-search.md)）。

## 4. API 契約

すべて `/api/v1/*`。**UI も同じ v1 API を使う**（管理用の別 API を作らない）。
認証は `Authorization: Bearer tsb_...`（API キー）か Cookie セッションのどちらでも通る。

エラーは必ずこの形:

```json
{ "error": { "code": "forbidden", "message": "…", "details": {} } }
```

`code` は `unauthorized` / `forbidden` / `not_found` / `invalid_request` /
`conflict` / `rate_limited` / `internal`。
`details` は検証エラー（`invalid_request`）のときだけ持ち、`not_found` / `internal` では空。

ページングはカーソル方式。レスポンスは `{ "data": [...], "next_cursor": "…" | null }`。

| メソッド | パス | スコープ | 担当 |
| --- | --- | --- | --- |
| GET/PATCH | `/v1/me` | スコープ検査無し。自分の情報のみ | W4 |
| GET/POST/DELETE | `/v1/me/api-keys` | 本人のキー。発行は本人の権限の範囲内のみ | W4 |
| POST | `/v1/auth/login` `/v1/auth/logout` `/v1/auth/bootstrap` | — | W4 |
| GET | `/v1/auth/session` `/v1/auth/setup-state` | セッション確認 / セットアップ要否 | W4 |
| GET | `/v1/addresses` | read | W5 |
| GET | `/v1/messages` | read | W6 |
| GET | `/v1/messages/{id}` | read | W6 |
| GET | `/v1/messages/{id}/raw` | read | W2 |
| PATCH | `/v1/messages/{id}` | read（`status` の変更は send と write 割り当て。受け付ける status は `received` / `trash` のみ） | W6 |
| POST | `/v1/messages` | send | W3 |
| POST | `/v1/messages/{id}/reply` | read かつ send（読めない相手には返信もできないよう、両方を要求する） | W3 |
| GET | `/v1/threads` `/v1/threads/{id}` | read | W6 |
| GET | `/v1/attachments/{id}` | read | W2 |
| GET | `/v1/webhooks`（+ `/:id/deliveries`、手動再送 `/deliveries/:id/retry`） | admin | W9 |
| GET / POST | `/v1/admin/users`（一覧 / 作成） | 一覧は任意。変更系は**セッション限定** | W4 |
| GET / PATCH / DELETE | `/v1/admin/users/{id}`（+ PUT `/{id}/grants`） | 変更系は**セッション限定** | W4 |
| GET / POST / DELETE | `/v1/admin/api-keys`（+ `?userId=` 絞り込み / `/{id}`） | admin | W4 |
| GET | `/v1/admin/domains`（一覧） `/v1/admin/domains/available` `/v1/admin/domains/{id}` | admin | W5 |
| POST | `/v1/admin/domains` `/v1/admin/domains/preview` `/v1/admin/domains/{id}/verify` `/v1/admin/domains/{id}/catch-all` `/v1/admin/domains/{id}/sending` | admin | W5 |
| DELETE | `/v1/admin/domains/{id}` | admin | W5 |
| GET / POST | `/v1/admin/addresses` `/v1/admin/addresses/{id}` `/v1/admin/addresses/{id}/viewers` | admin | W5 |
| PATCH / DELETE | `/v1/admin/addresses/{id}` | admin | W5 |
| GET | `/v1/admin/audit-logs`（`targetType` `targetId` `actorId` `action` `limit` `cursor`） | owner のセッションか addressIds を絞っていない admin スコープ | W4 |
| GET / POST / PATCH / DELETE | `/v1/admin/rules`（+ `/{id}`） | admin | W2 |
| GET | `/v1/openapi.json` | — | W9（未実装。呼ぶと 404） |

#### 通知・端末（W11）— すべて**セッション限定**（API キーで叩くと 403）・agent 対象外・自分の分のみ

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET / PATCH | `/v1/me/notifications` | 設定一式（全体・メールボックスごと・ルール）。部分更新とプリセット適用は PATCH |
| PUT | `/v1/me/notifications/mailboxes/{addressId}` | メールボックスの通知レベル |
| GET / POST | `/v1/me/notifications/rules` | ルール一覧 / 追加 |
| PATCH / DELETE | `/v1/me/notifications/rules/{id}` | 更新 / 削除 |
| POST | `/v1/me/notifications/rules/reorder` | 並べ替え |
| POST | `/v1/me/notifications/dry-run` | 最近のメールに今の設定を当てて判定し返す |
| GET | `/v1/me/notifications/feed` | 通知欄（カーソルページング。一時停止の束 `hold_group` と、`include_dropped` で対象外も理由つき） |
| POST | `/v1/me/notifications/feed/seen` | 通知欄を開いた（未確認数の 0 化） |
| GET / PUT / DELETE | `/v1/threads/{id}/notification` | 会話のフォロー / ミュート解除（`threadNotificationRouter` を `/v1/threads` に載せている） |
| GET / POST | `/v1/me/devices` | 自分の端末一覧 / 購読の登録（同じ `endpoint` は上書き） |
| PATCH / DELETE | `/v1/me/devices/{id}` | 名前・有効・受け取るメールボックス / 削除 |
| POST | `/v1/me/devices/{id}/test` `/v1/me/devices/{id}/seen` | テスト通知 / 使用中の合図 |
| GET | `/v1/push/key` | VAPID 公開鍵（未設定・解釈不可なら `null`） |
| GET | `/v1/push/badge` | 未読件数バッジ（`me/notifications` の `badge` 設定で見る数） |

端末登録の `endpoint` はブラウザのプッシュサービス（FCM / Mozilla / Apple / Windows）に限定する
（`src/shared/contracts/notifications.ts` の `isPushServiceEndpoint`）。任意の URL を受けると踏み台になるため。

### `GET /v1/messages` の検索パラメータ（AI 向けの主要導線）

`q`（全文）, `address`, `from`, `to`, `subject`, `body`, `since`, `until`,
`direction`, `status`, `unread`, `starred`, `has_attachment`, `thread`,
`order`(`received_at`/`relevance`), `limit`(既定 25 / 最大 100), `cursor`。

`q` は簡易演算子を解釈する: `from:foo@bar subject:"見積" since:2026-01-01 has:attachment`。
演算子は `from:` `to:` `subject:` `body:` `since:` `until:` `is:unread|starred` `has:attachment` `in:<アドレス>`。
それ以外の語は全文検索の語になる（最大 500 文字・10 語）。パースは `src/domain/search/query.ts` に閉じる。

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
  writableAddressIds: string[] | "all"  // addressIds の部分集合（書き込み可）
  apiKeyId?: string
  sessionId?: string        // セッションで入ったときだけ。ログアウトで購読を消す
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
4. 成功で `status=sent`。Message-ID（`rfc_message_id`）は**送信前に自前採番**して DB に残す
   （返信がスレッドに刺さるため。Cloudflare が採番するのを待たない）。
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

- Worker 名は `tsubame`。`wrangler.jsonc` の `name`、`vars.EMAIL_WORKER_NAME`、
  Email Routing ルールの宛先の 3 箇所が一致していること（service binding は無い）。
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

## 11. プッシュ通知（W11）

通知は受信・送信失敗の処理とは別のキューメッセージにし、push サービスの遅延で
再試行を起こさない（`queue.ts` の `NotifyMessage` を `OUTBOUND_QUEUE` に載せる。
新しいキューは作らない）。

```
受信: inbound.ts ── OUTBOUND_QUEUE { kind: "notify", event: "received", messageId }
送信失敗: outbound.ts ── { kind: "notify", event: "send_failed", messageId }
テスト: devices.ts ── { kind: "notify", event: "test", deviceId }
```

`processNotify`（`services/notify.ts`）:
- `received` / `send_failed` はまず対象利用者へ 1 メッセージずつ分ける
  （**Free の 1 実行あたり外部リクエスト上限 50 に収める**。`eligibleUserIds` は
  owner（全員）＋ そのメールボックスへの `grant` を持つ active 利用者）。
  送信失敗は `sent_by_user_id` があればその人だけ、無ければ `write` 全員。
- 利用者ごとに `decide` / `decideSendFailure`（`domain/notify/decide.ts`）で
  `sent / held / digest / dropped / excluded` を決め、`notification_log` に理由つきで記録。
  詳細な判定表は `pwa-notifications.md` の「4. 通知の判定」。
- `sent` は `filterDevices` で端末単位に間引いてから `deliverToDevices` で送る。
- `held` は送らず `notification_log` にだけ記録してそこで止める（積まない）。
- `digest` は `notification_digests` に積み、`notification_log` にも記録する。
- `excluded` は対象外。何も書かずに終わる。

**VAPID と暗号化（RFC 8291）は自前実装**（`services/webpush.ts`）。
`web-push` パッケージは MPL-2.0 のため使わない。VAPID JWT は Apple の制約（1 時間に 1 回）を
守るため origin ごとに D1 の `settings` へ有効期限つきで置いて使い回す（`notify/token-cache.ts`）。
鍵は `VAPID_PRIVATE_KEY`（Secret、JWK の JSON）と `VAPID_SUBJECT`（Secret、`mailto:`）。

`handleScheduled`（cron `*/5 * * * *`、`wrangler.jsonc`）: 期限の来た digest を 1 通にまとめて送り、
`notification_log`（30 日）と未使用端末（90 日）を掃除する。
