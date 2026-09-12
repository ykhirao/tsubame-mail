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
      addresses.ts       [W5] 一覧と署名・非表示の変更
      attachments.ts     [W2]
      webhooks.ts        [W9]
      me.ts              [W4] 自分の情報・自分のキー（キーの連鎖失効 revokeKeyTree もここ）・管理者モード・外部アドレスの登録と確認
      notifications.ts   [W11] 通知設定・ルール・通知欄・会話の通知
      devices.ts         [W11] 購読端末
      push.ts            [W11] VAPID 公開鍵・バッジ
      admin/
        users.ts         [W4] 作成時のプライマリ割り当てもここ
        external-email.ts  [W4] owner が他の利用者の外部アドレスを登録する
        api-keys.ts      [W4]
        audit-logs.ts    [W4]
        domains.ts       [W5]
        addresses.ts     [W5]
        rules.ts         [W2]
  domain/                副作用を持たない、または最小限に閉じたロジック
    mail/
      address.ts         [W1] アドレス文字列のパース/整形（共有ユーティリティ）
      parse.ts           [W2] 生MIME → 正規化済みメッセージ
      inbound.ts         [W2] 受信キューのコンシューマ（保存・FTS・Webhook と通知をキューに積む）
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
    consumer.ts          [W1] キューのバッチを種類ごとに振り分け（inbound / outbound.send / webhook.retry / notify）
    webpush.ts           [W11] VAPID・RFC 8291 暗号化・送信
    notify.ts            [W11] 通知キューのコンシューマ・cron（digest の送信、通知ログ 30 日と未使用端末 90 日の掃除）
    notify/              [W11] deliver(配信)/load(読み込み)/prefs(設定・未読数)/render(描画)/token-cache
    maintenance.ts       [W11] cron の監査ログの掃除（400 日）
    cloudflare-api.ts    [W5]
    sender.ts            [W3] EMAIL バインディング。ドメインの送信の無効化の判定もここ
    verification-mail.ts [W4] 外部アドレスの確認コードの発行・送信・照合（差出人は本人のプライマリ → owner のプライマリ → 送信できる最古のメールボックス）
    webhooks.ts          [W9] 配信行の作成とキュー投入・POST・再試行
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
    routes/*.tsx         [W7] メールの画面（受信箱・会話・作成・検索・設定）
    routes/admin/        [W8] index / gate / detail / 各 *Page / 各 *DetailPage / api / ColorPicker
    routes/settings/notifications/  [W7]
    routes/welcome/notifications.tsx [W7]
    routes/NotificationsFeed.tsx     [W7] 通知欄
    components/          [W7 が基礎、W8 は自分の画面配下に置く]。mobile/ はスマホ配置だけの部品
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
| `users` | 人と AI のアカウント | `role: owner \| member \| agent`, `status`, `password_hash`(agent は null 可), `must_change_password`, `last_login_at`, `external_email`(一意。Gmail などの外部アドレス), `external_verified_at`, `primary_address_id`(一意。本人のメールボックス。member / agent は必ず持つ)。旧 `email` 列は外部アドレスの写し（無い利用者は `<id>@users.invalid`）で、ログインには使わない |
| `email_verifications` | 外部アドレスの確認コード | `user_id` 主キー（利用者 1 人に 1 行）, `email`, `code_hash`（6 桁のコードの SHA-256）, `attempts`, `expires_at`（30 分）, `created_at`（最後に送った時刻。再送は 60 秒あける） |
| `sessions` | UI セッション | Cookie `__Host-tsb_session`（精査 #84）。`token_hash` ハッシュ保存、`expires_at`、`user_agent`、`ip`、`admin_mode_until`（owner の管理者モードの期限。FR-19） |
| `api_keys` | API トークン | `user_id`, `name`, `prefix`, `key_hash`, `scopes[]`, `address_ids[] \| null`, `expires_at`, `revoked_at`, `last_used_at`, `parent_key_id`（API キーで発行したときの親。親の失効で子孫も失効） |
| `domains` | 接続済みゾーン | `zone_id`(一意), `name`, `zone_name`, `mode: apex \| subdomain`, `routing_status`, `sending_status`, `catch_all_enabled`, `last_error` |
| `addresses` | 受信アドレス | `domain_id`, `local_part`, `address`(一意), `display_name`, `kind: mailbox \| alias`, `alias_target_id`, `is_catch_all`, `signature`, `color`, `archived_at` |
| `address_grants` | 権限 | `(user_id, address_id)` 主キー, `level: read \| write`, `hidden`（本人がまとめた一覧・検索の既定から外す。権限と通知は変えない）。owner もこの表で割り当てたアドレスしか見ない（FR-11 / FR-19） |
| `threads` | 会話 | `address_id`, `subject`, `last_message_at`, `message_count`, `unread_count` |
| `messages` | メッセージ | 下記参照 |
| `attachments` | 添付 | `message_id`, `filename`, `content_type`, `size_bytes`, `content_id`, `is_inline`, `r2_key` |
| `routing_rules` | ルール | `scope: domain \| address`, `domain_id` / `address_id`, `name`, `action`, `matcher`(JSON), `target`, `priority`, `enabled` |
| `outbound_jobs` | 送信ジョブ | `message_id`, `status`, `attempts`, `last_error`, `next_attempt_at`, `sent_recipients`, `sent_at` |
| `webhooks` | 通知先 | `name`, `url`, `secret`(ハッシュ保存), `events[]`, `address_ids[]`, `enabled` |
| `webhook_deliveries` | 配信履歴 | `webhook_id`, `event`, `message_id`, `status`, `http_status`, `error`, `duration_ms`, `attempt`, `next_retry_at` |
| `audit_logs` | 監査 | 管理操作と端末・利用者自身のキー・署名・bootstrap を記録（action の一覧は `docs/ops/audit-log.md`）。`actor_id`, `action`, `target_type`, `target_id`, `meta`, `ip`。400 日で消す |
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
| GET/PATCH | `/v1/me` | スコープ検査無し。自分の情報のみ。GET は `externalEmail` / `externalVerified` / `primaryAddressId` / `adminMode` / `adminModeUntil` / `addressIds`（管理者モードなら `"all"`）/ `writableAddressIds` / `ownAddressIds`（自分の割り当て。管理者モードでも変わらない）/ `addresses` を返す | W4 |
| POST | `/v1/me/admin-mode` | `{ enabled }`。**owner のセッション限定**（member は 403、API キーは owner の admin キーでも 403）。`sessions.admin_mode_until` を今から 1 時間後（`ADMIN_MODE_SECONDS`）に置き、`false` で消す。監査ログ `admin_mode.enter` / `admin_mode.exit` | W4 |
| POST | `/v1/me/external-email` `/v1/me/external-email/verify` `/v1/me/external-email/resend` | **セッション限定**（API キーは 403）。登録（`{ email }`。未確認に戻して確認コードを送る。他の利用者の外部アドレス・このアプリのアドレスと重なると 409）/ 確認（`{ code }`。6 桁。誤り 5 回か 30 分で行を消して 400）/ 再送（前回から 60 秒以内は `rate_limited`）。送れるドメインが無いときは `{ sent: false, reason }`。監査ログ `user.external_email.set` / `user.external_email.verify` | W4 |
| GET/POST/DELETE | `/v1/me/api-keys` | 本人のキー。発行は本人の権限の範囲内のみ | W4 |
| POST | `/v1/auth/login` `/v1/auth/logout` `/v1/auth/bootstrap` | — 。login の `email` はプライマリアドレスか確認済みの外部アドレス（`auth.ts` `findLoginUser`。プライマリがまだ無い利用者＝ドメインを繋ぐ前の最初の owner だけ、未確認の外部アドレスでも入れる）。bootstrap の `email` は外部アドレスとして保存する | W4 |
| GET | `/v1/auth/session` `/v1/auth/setup-state` | セッション確認 / セットアップ要否 | W4 |
| GET | `/v1/addresses` | read。自分に割り当てたアドレス（管理者モードの owner は全部）。各行に `hidden`（割り当ての無いアドレスは false）と `level`（管理者モードで読めるだけのアドレスは `read`） | W5 |
| PATCH | `/v1/addresses/{id}/signature` | **セッション限定**（API キーは 403）。そのメールボックスに write。監査ログ `address.signature` | W5 |
| PATCH | `/v1/addresses/{id}/hidden` | `{ hidden }`。自分の `address_grants` の行だけ（割り当てが無ければ 404。管理者モードで読めるだけのアドレスも 404）。API キーでも通る。監査ログ無し | W5 |
| GET | `/v1/messages` | read。アドレスで絞っていないとき、自分が非表示にしたメールボックスを除く（`includeHidden=true` で含める。`address=` で名指ししたときは非表示でも出す） | W6 |
| GET | `/v1/messages/{id}` | read | W6 |
| GET | `/v1/messages/{id}/raw` | read | W2 |
| PATCH | `/v1/messages/{id}` | read（`status` の変更は send と write 割り当て。受け付ける status は `received` / `trash` のみ）。管理者モードで読めるだけの他人のメールは `isRead` / `isStarred` も 403（`canModify`） | W6 |
| POST | `/v1/messages` | send。送信を無効にしたドメインからは 409 | W3 |
| POST | `/v1/messages/{id}/reply` | read かつ send（読めない相手には返信もできないよう、両方を要求する）。無効ドメインは 409 | W3 |
| GET | `/v1/threads` `/v1/threads/{id}` | read。一覧は `/v1/messages` と同じく非表示を除き、`includeHidden=true` で含める | W6 |
| GET | `/v1/attachments/{id}` | read | W2 |
| GET / POST / PATCH / DELETE | `/v1/webhooks`（+ `/{id}`、`/{id}/deliveries`、手動再送 POST `/deliveries/{id}/retry`） | admin。変更系と再送は**範囲を絞ったキーでは 403** | W9 |
| GET / POST | `/v1/admin/users`（一覧 / 作成） | 一覧は admin。変更系は**セッション限定**。作成は `primaryAddress` が必須（`{ addressId }` で既存のメールボックスを選ぶか、`{ domainId, localPart, displayName? }` でその場に作る。アーカイブ済み・エイリアスは 400、他人のプライマリは 409）で、write で割り当てる。`email`（外部アドレス）は owner だけ必須、member / agent は省略可（ログインはプライマリで行う）。応答と一覧は `externalEmail` / `externalVerified` / `primaryAddressId` / `primaryAddress` を持つ | W4 |
| GET / PATCH / DELETE | `/v1/admin/users/{id}`（+ PUT `/{id}/grants`） | 変更系は**セッション限定**。PATCH の `primaryAddressId` は、その人に write で割り当てた（アーカイブされていない）メールボックスだけ（それ以外は 400、他人のプライマリは 409）。grants の PUT は、プライマリを一覧から外しても write のまま残し、`read` に下げる指定は 400 | W4 |
| PUT | `/v1/admin/users/{id}/external-email` | owner の**セッション限定**。他の利用者の外部アドレスを登録して確認コードを送る（本人の `/v1/me/external-email` と同じ検査）。監査ログ `user.external_email.set` | W4 |
| GET / POST / DELETE | `/v1/admin/api-keys`（+ `?userId=` 絞り込み / `/{id}`） | admin。発行はキーの範囲に clamp、失効は**範囲を絞ったキーでは 403** | W4 |
| GET | `/v1/admin/domains`（一覧） `/v1/admin/domains/available` `/v1/admin/domains/{id}` | admin | W5 |
| POST | `/v1/admin/domains` `/v1/admin/domains/preview` `/v1/admin/domains/{id}/verify` `/v1/admin/domains/{id}/catch-all` `/v1/admin/domains/{id}/sending` | admin。preview 以外は**範囲を絞ったキーでは 403** | W5 |
| DELETE | `/v1/admin/domains/{id}` | admin。範囲を絞ったキーでは 403 | W5 |
| GET / POST | `/v1/admin/addresses` `/v1/admin/addresses/{id}` `/v1/admin/addresses/{id}/viewers` | admin。作成は範囲を絞ったキーでは 403。作成の `assignToMe: true` で作った owner に write で割り当てる（割り当てないアドレスは誰にも見えない）。プライマリの無い owner が最初に作ったメールボックスは自動でその owner のプライマリになる（write で割り当て）。`viewers` は `address_grants` の利用者だけ（owner も割り当てが要る）で、`email`（外部アドレス。無ければ null）・`level: read \| write`・`isPrimary` | W5 |
| PATCH / DELETE | `/v1/admin/addresses/{id}` | admin。範囲を絞ったキーでは 403。誰かのプライマリはアーカイブ・エイリアス化・削除できない（409。先にプライマリを変える） | W5 |
| GET | `/v1/admin/audit-logs`（`targetType` `targetId` `actorId` `action` `limit` `cursor`） | owner のセッションか addressIds を絞っていない admin スコープ | W4 |
| GET / POST / PATCH / DELETE | `/v1/admin/rules`（+ `/{id}`） | admin。変更系は範囲を絞ったキーでは 403 | W2 |
| GET | `/v1/openapi.json` `/v1/openapi` | — （認証無し。JSON と、それを描く HTML） | W9 |

「範囲を絞ったキーでは 403」は `middleware/auth.ts` の `requireUnrestricted`（`via === "api_key"` かつ `keyRestricted`＝キーが `address_ids` を持つ、を弾く。精査 #129。
owner も割り当てでしか見ないので、`addressIds !== "all"` では絞ったキーを見分けられない）。
「セッション限定」は `requireSession`（#121）。自分のキーの発行・失効（`/v1/me/api-keys`）はセッションか admin スコープのキーに限り、
仮パスワードのままの利用者は 403（`me.ts` `requireKeyManagement`、#64）。

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
`order`(`received_at`/`relevance`), `limit`(既定 25 / 最大 100), `cursor`,
`includeHidden`（自分が非表示にしたメールボックスも含める。`address` で名指ししたときは不要）。

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
  addressIds: string[] | "all"   // 読めるアドレス。"all" は管理者モードの owner だけ
  writableAddressIds: string[] | "all"  // addressIds の部分集合（送信・status の変更）。管理者モードでも割り当てだけ
  adminMode?: boolean       // 管理者モードで全アドレスを読めるとき true
  ownAddressIds?: string[]  // 管理者モードのとき、自分の割り当て（既読などの変更はここだけ）
  keyRestricted?: boolean   // API キーが address_ids を持つとき true。管理の変更を止める判定に使う
  apiKeyId?: string
  sessionId?: string        // セッションで入ったときだけ。ログアウトで購読を消す
}
```

- **owner も member / agent と同じく `address_grants` から解決する**（`resolveUserAddressAccess`。FR-11）。
  割り当てていないアドレスは owner にも見えない。
- owner のセッションで `sessions.admin_mode_until` が今より後なら**管理者モード**: `addressIds` だけ `"all"` になり、
  `writableAddressIds` は割り当てのまま、`ownAddressIds` に割り当てを持つ（FR-19）。期限は毎リクエスト `resolvePrincipal` で見るので、
  切れた瞬間に戻る。API キーの principal には付かない。
- 読む・書く・変えるの 3 段（`policy.ts`）: `canRead` は `addressIds`、`canWrite` は `writableAddressIds`、
  `canModify`（既読・スター・ゴミ箱のような状態の変更）は管理者モードなら `ownAddressIds`、それ以外は `canRead` と同じ。
- API キー → 上記に加えて `api_keys.address_ids` で**さらに狭める**（積集合）。
  キーはユーザーの権限を超えられない。
- 非表示（`address_grants.hidden`）は認可ではなく見え方。一覧・検索でアドレスを名指ししていないときだけ、
  ハンドラが `hiddenAddressIds` を引いて `NOT IN` を足す（`search/sql.ts` `jsonIdsNotIn`）。
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
7. アドレススコープのルールを適用。`X-CF-SpamH-Score` を `spam_verdict` に写す（3 以上で `suspicious`）。
8. Webhook の配信行を `pending` で作り、`OUTBOUND_QUEUE` に `webhook.retry`（attempt 1）を積む。
   受け手への POST（最大 10 秒）はここでは待たない（`services/webhooks.ts` `dispatchMessageEvent`）。
9. 通知の判定用に `{ kind: "notify", event: "received", messageId, ruleRead }` を積む（第 11 節）。

## 7. 送信パイプライン（W3）

1. `POST /v1/messages` を検証（`from` が principal の権限内か。詐称は 403。エイリアス・アーカイブ済みも 403）。
   ドメインの `sending_status` が `disabled` なら 409（`sender.ts` `isSendingDisabled`、#144）。
   送信回数は `SEND_RATE_LIMIT`（キー id、セッションなら利用者 id で 100 回 / 60 秒）で絞る。
2. `messages` に `status=queued` で挿入し、`outbound_jobs` を作る（1 つの batch）。添付の保存かキュー投入に失敗したら両方を `failed` に落とす。
3. `OUTBOUND_QUEUE` に `outbound.send` を積む。コンシューマが `compose.ts` で MIME を組み立て、
   `EMAIL` バインディングで宛先ごとに 1 通ずつ送る。送れた宛先は `sent_recipients` に記録し、再試行では残りにだけ送る（#21 / #59）。
4. 成功で `status=sent`。Message-ID（`rfc_message_id`）は**送信前に自前採番**して DB に残す
   （返信がスレッドに刺さるため。Cloudflare が採番するのを待たない）。
   失敗は `attempts++` して指数バックオフで再投入。上限超過で `status=failed`。送信の直前にドメインの送信が無効になっていれば送らず `failed`。
5. `sent` / `failed` で Webhook（`message.sent` / `message.failed`）と、失敗なら通知（`send_failed`）をキューに積む。

## 8. ドメイン接続（W5）

1. `GET /v1/admin/domains/available` で Cloudflare の zone を列挙。
2. 接続時に **既存 MX を検査**して結果を返す。apex に他社 MX があれば
   `mode: subdomain` を強く推し、apex を選ぶには明示フラグを要求する。
3. Email Routing DNS を有効化。宛先 Worker はデプロイ名（`tsubame`）。
4. Email Sending 用の SPF / DKIM / DMARC を整える。接続後も `POST /v1/admin/domains/{id}/sending` で有効・無効を切り替えられる。
   無効化は D1 の `sending_status` を `disabled` にするだけで、DNS と Cloudflare 側は触らない（送信 API は 409）。
5. 切断時は作った DNS レコードとルーティングルールを片付ける（`cleanup=false` で残せる。監査ログ `domain.disconnect`）。

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
新しいキューは作らない。`OUTBOUND_QUEUE` には `outbound.send` / `webhook.retry` / `notify` の 3 種が流れ、
`consumer.ts` が振り分ける）。

```
受信: inbound.ts ── OUTBOUND_QUEUE { kind: "notify", event: "received", messageId, ruleRead }
送信失敗: outbound.ts ── { kind: "notify", event: "send_failed", messageId }
テスト: devices.ts ── { kind: "notify", event: "test", deviceId, userId }
```

`ruleRead` はアドレスルールが受信時に既読にしたかどうか。`messages.is_read` は後で利用者が読んでも立つので、
判定 5（`rule_read`）には受信時の値を運ぶ。

`processNotify`（`services/notify.ts`）:
- `received` / `send_failed` はまず対象利用者へ 1 メッセージずつ分ける
  （**Free の 1 実行あたり外部リクエスト上限 50 に収める**。`eligibleUserIds` は
  そのメールボックスへの `grant` を持つ active 利用者（agent を除く）。owner も割り当てが要り、
  キャッチオールの受け皿も同じ。管理者モードは通知に影響しない）。
  送信失敗は `sent_by_user_id` があればその人だけ、無ければ `write` 全員（`writeUserIds`。ここも owner の特別扱いは無い）。
- 利用者ごとに `decide` / `decideSendFailure`（`domain/notify/decide.ts`）で
  `sent / held / digest / dropped / excluded` を決め、`notification_log` に理由つきで記録。
  詳細な判定表は `pwa-notifications.md` の「4. 通知の判定」。
- `sent` は `filterDevices` で端末単位に間引いてから `deliverToDevices` で送る。
  429 / 5xx / タイムアウトの端末は `notification_log.retry_device_ids` に残してキューの再試行（30 秒・5 分・30 分、最大 3 回）で
  その端末にだけ送り直す。成功した端末に二度送らない（#131）。404 / 410 は端末を消し、その他の 4xx が 3 回続いた端末は無効にする。
- `held` は送らず `notification_log` にだけ記録してそこで止める（積まない）。
- `digest` は `notification_digests` に積み、`notification_log` にも記録する。
- `excluded` は対象外。何も書かずに終わる。

**VAPID と暗号化（RFC 8291）は自前実装**（`services/webpush.ts`）。
`web-push` パッケージは MPL-2.0 のため使わない。VAPID JWT は Apple の制約（1 時間に 1 回）を
守るため origin ごとに D1 の `settings` へ有効期限つきで置いて使い回す（`notify/token-cache.ts`）。
鍵は `VAPID_PRIVATE_KEY`（Secret、JWK の JSON）と `VAPID_SUBJECT`（Secret、`mailto:`）。

`handleScheduled`（cron `*/5 * * * *`、`wrangler.jsonc`）: 期限の来た digest を 1 通にまとめて送り、
`notification_log`（30 日）と未使用端末（90 日）を掃除する。同じ cron で `maintenance.ts` `pruneAuditLogs` が
監査ログ（400 日）を 1 回 1000 行ずつ消す。片方が失敗してももう片方は止めない（`worker.ts`）。

## 12. Webhook（W9）

- 配信行 `webhook_deliveries` は `attempt=0` の `pending` で作り、初回の POST も `webhook.retry`（attempt 1）としてキューに積む。
  受信・送信のコンシューマは受け手の応答（最大 10 秒）を待たない。
- `runDelivery` は POST の前に `UPDATE … SET attempt WHERE status='pending' AND attempt < :attempt` で試行番号を取り、取れた 1 つだけが送る。
  同じ試行番号で手動再送とキューが重なっても受け手に届くのは 1 回（#86 / #118）。
- 失敗は 30 秒 / 300 秒 / 1800 秒の遅延で最大 5 回。`redirect: "manual"` でリダイレクトは追わず、送る直前にも URL を検査する（#12）。
- 30 分以上 `pending` のまま止まった配信は `POST /v1/webhooks/deliveries/{id}/retry` で手動で再送できる（#42 / #69）。
