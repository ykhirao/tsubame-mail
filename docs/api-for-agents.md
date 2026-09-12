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
      "level": "write",       // read | write（owner も write）
      "unreadCount": 3
    }
  ],
  "next_cursor": null
}
```

`level` が `read` のアドレスからは送信できない。

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

`to` / `cc` / `bcc` は**文字列でも配列でも受ける**。`"a@x.jp, b@x.jp"` でもよい。

### 返信

```bash
curl -X POST https://<host>/api/v1/messages/msg_.../reply \
  -H "Authorization: Bearer tsb_..." -H 'Content-Type: application/json' \
  -d '{"text": "返信の本文", "replyAll": false}'
```

宛先は省略するとサーバが決める（`replyAll: true` なら元の To / Cc も含む）。
引用はサーバが付ける。`read` と `send` の両方のスコープが要る。

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

**自分宛に送ると送信と受信で別レコードになる。** 同じメールでも outbound 1 件と、
宛先ごとの inbound が別 id で立つ。To と Cc に同じアドレスを入れた場合は重複排除されて 1 件。

**`bounces@cf-bounce.<domain>` からのメールは異常ではない。**
Cloudflare が Return-Path に使う正常な envelope sender。

## 8. 補足

- `GET /v1/openapi.json` は**未実装**（404 が返る）。機械可読な定義は無い。
- 時刻はすべて **Unix 秒**（`receivedAt` など）。
- `to` / `cc` は複数アドレスが 1 本の文字列に入る（カンマ結合）。読むときは分割すること。
- レート制限に当たると `rate_limited` が返る。間隔を空けて再試行する。
