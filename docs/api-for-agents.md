# Tsubame API — エージェント向けの使い方

メールを読む・送る・整理するための HTTP API。**このページだけで一通り動かせる**ように書いてある。
詳しい契約は [設計の「4. API 契約」](spec/architecture.md) にある。

## 1. 認証

発行された API キーを `Authorization` に載せる。全リクエスト共通。

```bash
curl -H "Authorization: Bearer tsb_..." https://<host>/api/v1/addresses
```

キーには**スコープ**（`read` / `send` / `admin`）と**対象アドレス**が設定されている。
キーの権限は所有ユーザーの権限との積集合で効くので、キーが持ち主を超えることはない。
持ち主が owner でも、**見えるのは持ち主に割り当てたアドレスだけ**（owner の特権は無い）。
`GET /v1/me` で、今のキーのスコープ・対象アドレス（`addressIds`）・書けるアドレス（`writableAddressIds`）・持ち主が分かる。
API キーで `addressIds` が `"all"` になることは無い（`"all"` は画面の管理者モードだけ）。

まず疎通を確認する。認証不要で叩ける。

```bash
curl https://<host>/api/health
# => {"ok":true,"app":"tsubame"}
```

## 2. 最初にやること — 自分が使えるアドレスを知る

`from` に使えるのは、キーの対象になっているアドレスだけ。決め打ちせず、ここから取る。

```bash
curl -H "Authorization: Bearer tsb_..." https://<host>/api/v1/addresses
```

```jsonc
{
  "data": [
    {
      "id": "adr_...",
      "address": "ai@m.example.com",
      "level": "write",       // read | write（割り当ての段階そのまま。owner でも割り当てが read なら read）
      "unreadCount": 3,
      "hidden": false         // 持ち主がそのメールボックスを「非表示」にしているか（下記）
    }
  ],
  "next_cursor": null
}
```

`level` が `read` のアドレスからは送信できない。

### 非表示のメールボックス

利用者はメールボックスごとに「非表示」にできる（画面か `PATCH /v1/addresses/{id}/hidden` `{"hidden": true}`。API キーでも通る）。
非表示にしたメールボックスのメールは、**`address` を付けずに** `GET /v1/messages` / `GET /v1/threads` を呼んだときの結果から外れる。
権限・通知・単体取得は変わらない（`GET /v1/messages/{id}` は普通に読める）。

- 全部を見たいときは `?includeHidden=true` を付ける。
- `?address=` でそのメールボックスを名指しすれば、非表示でもそのまま出る。
- 「一覧に出ないのに `unreadCount` がある」ときは、まず `hidden` を疑う。

この一覧の既定は**100 件**（最大 200）、カーソルページング対応（`limit` / `cursor`）。
件数が多くて先頭しか見えないときは `limit` で広げて辿る。

## 3. メールを読む

```bash
curl -H "Authorization: Bearer tsb_..." \
  "https://<host>/api/v1/messages?unread=true&limit=25"
```

**レスポンスの配列は `data`。`items` ではない。** 空に見えたらまずここを疑う。

```jsonc
{ "data": [ /* messageListItem */ ], "next_cursor": "..." }
```

一覧に本文は入らない（`snippet` だけ）。本文と添付は個別取得で。

```bash
curl -H "Authorization: Bearer tsb_..." https://<host>/api/v1/messages/msg_...
# textBody / htmlBody / attachments[] が付く
```

### 検索パラメータ

`GET /v1/messages` に付けられるもの:

| パラメータ | 内容 |
| --- | --- |
| `q` | 全文検索。簡易演算子も解釈する（下記） |
| `address` | アドレス文字列（`@` を含む）か `addressId` |
| `from` `to` `subject` `body` | いずれも部分一致 |
| `since` `until` | `YYYY-MM-DD`。`until` はその日の 23:59:59 UTC まで含む |
| `direction` | `inbound` / `outbound` |
| `status` | `received` / `sent` / `draft` / `queued` / `failed` / `trash` |
| `unread` `starred` `has_attachment` | `true` / `false` / `1` / `0` |
| `thread` | スレッド id |
| `includeHidden` | `true` で、非表示にしたメールボックスのメールも含める（`address` 無しのとき） |
| `order` | `received_at`（既定）/ `relevance` |
| `limit` | 既定 25 / 最大 100 |
| `cursor` | `next_cursor` をそのまま渡す |

`q` の演算子: `from:` `to:` `subject:` `body:` `since:` `until:` `is:unread` `is:starred` `has:attachment` `in:<アドレス>`。
例: `from:foo@bar subject:"見積" since:2026-01-01 has:attachment`。それ以外の語は全文検索（最大 500 文字・10 語）。

個別パラメータは `q` 内の同名条件より優先される。

### ページング

カーソル方式。`next_cursor` が `null` になるまで辿る。

```bash
curl -H "Authorization: Bearer tsb_..." \
  "https://<host>/api/v1/messages?limit=100&cursor=<前回の next_cursor>"
```

## 4. メールを送る

**`POST /v1/messages`。`/v1/outbound` は存在しない**（誤ると 404）。

```bash
curl -X POST https://<host>/api/v1/messages \
  -H "Authorization: Bearer tsb_..." -H 'Content-Type: application/json' \
  -d '{
    "from": "ai@m.example.com",
    "to": ["a@example.com"],
    "cc": ["b@example.com"],
    "subject": "件名",
    "text": "本文"
  }'
# => 202 {"id":"msg_...","status":"queued"}
```

**送信は非同期。`202 queued` は受理であって送信完了ではない。**
結果は `GET /v1/messages/{id}` の `status` が `sent` / `failed` に変わるのを見る。
`sent` は Cloudflare が受け付けたという意味で、相手に届いたことまでは保証しない。

`to` / `cc` / `bcc` は**文字列でも配列でも受ける**。`"a@x.jp, b@x.jp"` でもよい。

`from` に使えないもの（403）: キーの対象外のアドレス、`level` が `read` のアドレス、エイリアス、アーカイブ済み。
**ドメインの送信が無効にされていると 409**（`conflict`）。管理者がドメインで送信を有効にするまで送れない。

### 返信

```bash
curl -X POST https://<host>/api/v1/messages/msg_.../reply \
  -H "Authorization: Bearer tsb_..." -H 'Content-Type: application/json' \
  -d '{"text": "返信の本文", "replyAll": false}'
```

宛先は省略するとサーバが決める（`replyAll: true` なら元の To / Cc も含む）。`to` / `cc` を渡せば
それを使う（自分のアドレスは除かれる）。引用はサーバが付け、本文の上限に収まるよう末尾から切る。
`read` と `send` の両方のスコープが要る。元メッセージが読めなければ 404。

**返信は `subject` / `bcc` を受け付けない**（件名と宛先の隠蔽は元メールに従い、サーバが決める）。
指定しても無視される。

### inReplyTo

`POST /v1/messages` に `inReplyTo` を渡すと、そのメッセージに返信として紐づき、
スレッドを継ぐ（`References` / `In-Reply-To` ヘッダを付けて送る）。

### 添付

`base64` で埋め込む。

```jsonc
{
  "from": "ai@m.example.com",
  "to": "a@example.com",
  "subject": "資料",
  "text": "添付します",
  "attachments": [
    { "filename": "a.pdf", "contentType": "application/pdf", "base64": "JVBERi0x..." }
  ]
}
```

### 上限

| 項目 | 上限 |
| --- | --- |
| 宛先（To + Cc + Bcc の合計） | 100 件 |
| 本文（text / html それぞれ） | 1MB |
| 本文 + 件名の合計 | 1.5MB |
| 添付 1 件 | 20MB |
| 添付の合計 | 25MB / 50 件 |
| 件名 | 600 バイト（日本語で約 200 文字）。超えると 400 |
| リクエストボディ全体 | 40MB（添付の base64 込み） |
| 送信回数 | キー 1 本につき 60 秒に 100 回（送信と返信の合計）。超えると `rate_limited` |

件名・宛先に**改行は入れられない**（MIME ヘッダに入るため弾かれる）。

### 署名

署名は API キーでは変えられない（403）。人が作成画面で書くメールに差し込まれるので、画面のログインからだけ変える。今の署名は `GET /v1/addresses` の `signature` で読める。

## 5. 既読・スター・ゴミ箱

```bash
curl -X PATCH https://<host>/api/v1/messages/msg_... \
  -H "Authorization: Bearer tsb_..." -H 'Content-Type: application/json' \
  -d '{"isRead": true}'
```

`isRead` / `isStarred` / `status` のうち最低 1 つを指定する。
`status` に指定できるのは **`received` と `trash` だけ**（ゴミ箱へ移す / 戻す）。
`sent` や `queued` は送信パイプラインの内部状態なので書き込めない。

**一覧は既定でゴミ箱を除く。** ゴミ箱だけを見たいときは `?status=trash` を明示する
（`status` を指定するとその状態だけに絞られる）。単体取得・スレッドは既定でゴミ箱を除き、
含めるなら `?includeTrash=true` を付ける。

## 6. スレッド

```bash
curl -H "Authorization: Bearer tsb_..." https://<host>/api/v1/threads
curl -H "Authorization: Bearer tsb_..." https://<host>/api/v1/threads/thr_...
```

会話単位で見たいときはこちら。`messageCount` / `unreadCount` が付く。

スレッド詳細のレスポンスは直近のメッセージだけを含む（`hasOlder` / `olderCursor` 付き）。
**古いメッセージまで遡る**には `olderCursor` を `?before=` に渡して繰り返す。
ゴミ箱に入れたメッセージも含めたいときは `?includeTrash=true`。

```bash
curl -H "Authorization: Bearer tsb_..." \
  "https://<host>/api/v1/threads/thr_...?before=<olderCursor>"
```

### 添付と生 MIME の取得

添付は `GET /v1/attachments/{id}`、受信したままの元メール（生 MIME）は
`GET /v1/messages/{id}/raw` で取る。
どちらも `Content-Disposition: attachment` 付きで返るので、ブラウザや CLI では保存に落ちる。
ゴミ箱のメッセージのものは `?includeTrash=true` を付けないと 404 になる。

```bash
curl -H "Authorization: Bearer tsb_..." -OJ https://<host>/api/v1/attachments/att_...
curl -H "Authorization: Bearer tsb_..." -OJ https://<host>/api/v1/messages/msg_.../raw
```

## 7. エラー

形は必ず同じ。

```jsonc
{ "error": { "code": "forbidden", "message": "…", "details": {} } }
```

`code` は `unauthorized` / `forbidden` / `not_found` / `invalid_request` /
`conflict` / `rate_limited` / `internal`。

### 踏みやすいもの

**権限外の id は `403` ではなく `404` を返す。** 存在を推測されないための意図的な挙動なので、
**404 を「消えた」と解釈しない。** キーの対象アドレスを確認する。

**API キーでは叩けないもの（`403`）。** 画面のログイン（Cookie セッション）だけが通る。
- 署名の変更 `PATCH /v1/addresses/{id}/signature`（人が書くメールに差し込まれるため）
- 外部アドレス（ログイン先）の登録・確認 `POST /v1/me/external-email*`、`PUT /v1/admin/users/{id}/external-email`
- 管理者モード `POST /v1/me/admin-mode`（owner の画面だけ。キーで全アドレスを読む手段は無い）
- 通知・端末の設定 `/v1/me/notifications/*` `/v1/me/devices/*` `/v1/push/*` `/v1/threads/{id}/notification`
- ユーザー管理の変更 `POST/PATCH/DELETE /v1/admin/users*`（パスワードやロールはキーの期限や範囲で縛れないため）

**見えない id は、割り当てが無いだけかもしれない。** owner が作ったアドレスでも、誰かに割り当てないと誰にも見えない
（`POST /v1/admin/addresses` は `assignToMe: true` で作った owner に割り当てる）。エージェントに見せるには、
管理画面でその利用者に `read` / `write` を割り当ててもらう。

**対象アドレスを絞った admin キーでは、管理の変更ができない（`403`）。** ドメイン・アドレス・ルール・Webhook の
作成・変更・削除、Webhook の手動再送、他のキーの失効、`GET /v1/admin/audit-logs` は、`addressIds` が無制限のキーか
セッションでしか通らない。一覧と単体取得は絞ったキーでも読める。

**キーの発行・失効（`/v1/me/api-keys`）には `admin` スコープが要る。** 発行できるキーは、今のキーのスコープ・
対象アドレス・期限を超えられない（超える指定は 403）。発行したキーはこのキーの子になり、このキーが失効・差し替え
されると子も失効する。

**自分宛に送ると送信と受信で別レコードになる。** 同じメールでも outbound 1 件と、
宛先ごとの inbound が別 id で立つ。To と Cc に同じアドレスを入れた場合は重複排除されて 1 件。

**`bounces@cf-bounce.<domain>` からのメールは異常ではない。**
Cloudflare が Return-Path に使う正常な envelope sender。

## 8. 補足

- `GET /v1/openapi.json` で OpenAPI 3.1 の定義が読める（認証不要。`/v1/openapi` はそれを描いた HTML）。
- 時刻はすべて **Unix 秒**（`receivedAt` など）。
- `to` / `cc` は複数アドレスが 1 本の文字列に入る（カンマ結合）。読むときは分割すること。
- レート制限に当たると `rate_limited` が返る。間隔を空けて再試行する。
- ボディを送る要求（POST / PATCH / PUT）は `Content-Type: application/json` が無いと 400。
- 管理（`admin` スコープ + owner のキー）で読めるもの: `/v1/admin/users` `/v1/admin/api-keys` `/v1/admin/domains`
  `/v1/admin/addresses`（+ `/{id}/viewers`。割り当てた人と `level` / `isPrimary`。`email` は外部アドレスで無ければ null）`/v1/admin/rules` `/v1/webhooks`（+ `/{id}/deliveries`）。
  一覧はどれも `{ data, next_cursor }`。Webhook の `secret` は作成の応答にしか出ない。
  利用者には `primaryAddressId` / `primaryAddress`（本人のメールボックス。member / agent は必ず持つ）と `externalEmail` / `externalVerified` が付く。
