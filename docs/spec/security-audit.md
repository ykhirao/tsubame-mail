# セキュリティ全精査の結果 — 2026-09-11

観点は [セキュリティ観点](security.html)。対象は `src/` 全体（約 16,000 行）、
設定ファイル、CI、マイグレーション。

**印の意味**: 実際にコードを走らせて成立を確認したものに「実証済み」と書いた。
それ以外はコードを読んで確認したもので、推測は載せていない。

この文書は上から順に、第 1 回精査（#1〜#15）→ その対応 → **再検査** → **第 2 回精査（#16〜#54）**
→ その対応 → **再検査（第 2 回。#55〜#72 を先に振った）** → その対応 → **再検査（#73〜#81 を先に振った）**
→ **第 3 回精査（#82〜#112）** → 第 2 回の詳細 → 第 1 回の詳細、の順で並んでいる。
他の文書からは「精査 #n」で参照する。

**この文書を進める手順**（対応 → 再検査 → 次の精査、の輪を 1 段進める）は
`.agents/skills/security-audit/SKILL.md` にある。「この文書を進めて」と言われたらそれに従う。

## まとめ（第 1 回）

| # | 深刻度 | 内容 | 場所 |
| --- | --- | --- | --- |
| 1 | **重大** | `inReplyTo` から CRLF ヘッダインジェクション（実証済み） | `domain/mail/compose.ts:53` |
| 2 | **重大** | `stripHeader` が正規のBccだけ消し、注入されたBccを残す（実証済み） | `services/sender.ts:31` |
| 3 | **高** | `read` スコープが受信系で一切検査されていない（実証済み） | `api/v1/{messages,threads,attachments}.ts` |
| 4 | **高** | `read` だけのキーでメッセージを変更・削除できる（実証済み） | `api/v1/messages.ts:146` |
| 5 | **高** | 受信経路にサイズ・件数の上限が無い（毒メッセージ） | `domain/mail/inbound.ts:86` |
| 6 | **高** | セキュリティヘッダが 1 つも無い（CSP / nosniff / frame-ancestors） | `worker.ts:14` |
| 7 | **中** | 送信添付のファイル名が R2 キーに素通り（名前空間の越境） | `api/v1/outbound.ts:60` |
| 8 | **中** | 添付配信が送信者の `Content-Type` をそのまま返す | `api/v1/attachments.ts:36` |
| 9 | **中** | `+タグ` で拒否ルールを回避できる | `domain/routing/resolve.ts:41` |
| 10 | **中** | 偽装 `In-Reply-To` で他人のスレッドに紛れ込める | `domain/mail/thread.ts:25` |
| 11 | **中** | リモート画像が既定で読み込まれる（開封トラッキング） | `ui/components/MessageHtml.tsx` |
| 12 | **中** | Webhook が SSRF に使える（owner 限定） | `services/webhooks.ts:159` |
| 13 | **中** | 権限判定の重複実装が 2 か所で弱い（現状は上位で防御） | `api/v1/webhooks.ts:17`, `admin/rules.ts:12` |
| 14 | 低 | 受信の `to_addr` にヘッダ値を保存（エンベロープを使っていない） | `domain/mail/inbound.ts:119` |
| 15 | 低 | 一覧系にページング・上限が無いものがある | `admin/api-keys.ts:23` ほか |


## 対応状況 — 2026-09-11

15 件すべてに手を入れた。攻撃の再現はテストに落としてあり、`npm run verify` が通る
（39 ファイル・371 件）。**残る制約**の欄は、今回の修正でも塞ぎきれていないもの。

| # | 対応 | 残る制約 |
| --- | --- | --- |
| 1 | `compose.ts` が改行入りの値をヘッダに書かず throw する。入口の zod で `inReplyTo` は `<id>` 形式、添付の filename は制御文字と `/` `\` 禁止、contentType は `type/subtype` のみ。`normalizeAddress` も制御文字を含むアドレスを捨てる | — |
| 2 | Bcc ヘッダをそもそも組み立てず、エンベロープ宛先だけで配る。`stripHeader` はヘッダ部の同名ヘッダを全件消す | — |
| 3 | messages / threads / attachments / raw の GET に `requireScope("read")`。送信と同じパスに載っているので、ルータ単位ではなくハンドラ単位で掛けた | — |
| 4 | `PATCH` の `status` 変更（ゴミ箱など）は send スコープと書き込み権限を要求する。既読・スターは read で通す（read 割り当ての共有メンバーもスレッドを開くと既読になるため） | — |
| 5 | email ハンドラで 25MB 超を拒否。コンシューマは上限超過をパースせず 1 行だけ残して ack する。本文は UTF-8 のバイト数で切り詰め、添付は 50 件・1 件 20MB まで（落とした分は本文末尾に明記） | — |
| 6 | API は `app.ts` の `secureHeaders`（`default-src 'none'` など）。SPA は `public/_headers`。`run_worker_first: ["/api/*"]` で、ナビゲーションの `/api/*` も必ず Worker を通す | CSP の `sandbox` は付けていない（添付のダウンロードを止めるブラウザがあるため） |
| 7 | 送信添付の R2 キーは `att/{messageId}/{attachmentId}`。利用者の入力はキーに入らない | — |
| 8 | 添付の `Content-Type` は安全な型（画像・pdf・text/plain・text/csv）以外を `application/octet-stream` にする。nosniff は #6 で全 API に付く | — |
| 9 | 拒否ルールをリテラルと基本アドレス（`+タグ` を落とした形）の両方で評価する。ドメインは IDNA、ローカル部は NFC に揃えてから解決する | キリル文字の `а` のような同形異字は、正規化では同じにならない |
| 10 | 接ぎ木の起点を「自分が送った outbound」か「From が同じ inbound」に限る。あわせて、送信メールの Message-ID が山括弧付きで保存されているせいで、新規送信への返信がスレッドに刺さっていなかった不具合も直した | From はヘッダ値なので、From を偽装し、Message-ID も知っている相手は防げない |
| 11 | srcdoc の先頭に meta CSP を差し込み、リモート画像を既定で止める。外部画像を含むメールにだけ「画像を表示」ボタンを出す | ブラウザでの目視確認はしていない |
| 12 | `https:` のみ。内部向けのホスト名と非公開 IP は、登録時にも配信直前にも弾く。リダイレクトは追わない | DNS リバインディングは Workers から防げない |
| 13 | 自前の判定を消し、`requireOwner`（owner ロール かつ admin スコープ）に統一。テストは `createApp()` 経由で本番と同じ門を通る | — |
| 14 | ルールの `to` 照合をエンベロープの宛先で行う | 表示用の `to_addr` はヘッダ値のまま（一般的なメールクライアントと同じ。変えるにはスキーマ変更が要る） |
| 15 | users / api-keys / webhooks の一覧に `limit`（既定 25・最大 100）と `cursor`。webhooks の一覧は `{ data, next_cursor }` の形に変わった | — |

## 再検査 — 2026-09-11

上の「対応」欄を信用せず、15 件それぞれの修正がコードに存在し、元の攻撃が今も成立しないかを
確かめた。可能なものは一時テストと `node` で `node_modules/mimetext` を直接叩いて再現を試みた。
`npm run verify` は通る（39 ファイル・371 件。文書の記述と一致）。

**結果: 14 件は修正確認。#10 は再検査失敗。** #4 / #9 / #13 / #15 は修正そのものは効いているが、
同じ欠陥が隣に残っている（第 2 回精査の #28〜#32 に書いた）。

| # | 判定 | 根拠 |
| --- | --- | --- |
| 1 | 修正確認（実証済み） | `compose.ts` `assertNoLineBreak` / `formatMessageIdList` が改行で throw。`mimetext` の `setHeader` は今も素通しだが、`composeMime` に CRLF 入りの `inReplyTo` / `referencesHeader` を渡すと throw する。受信 From の表示名を encoded-word で CRLF 入りにして DB に保存させ、`POST /messages/:id/reply` しても送信 raw に `Bcc:` は出ない |
| 2 | 修正確認（実証済み） | `composeMime` は Bcc ヘッダを書かない。`stripHeader` はヘッダ部の同名ヘッダを継続行ごと全件消す（LF のみ・先頭行・小文字・継続行 2 段・末尾改行なし・空値で確認） |
| 3 | 修正確認（実証済み） | messages / threads / attachments / raw / reply の 7 経路に `requireScope("read")`。`send` だけのキーで `GET /attachments/:id` は 403。e2e FR-5 が 6 経路を検査 |
| 4 | 修正確認（実証済み） | read だけのキーで `status: trash` は 403、`isRead` / `isStarred` は 200。既読を read で通す判断は `ThreadDetail.tsx` が開封時に既読 PATCH を送るので整合している |
| 5 | 修正確認（実証済み） | 1.2MB の HTML → `html_body` 512KB + 通知文、5000 文字の件名 → 2048 バイト。25MB+1 の生 MIME を 2 回処理しても 1 行だけ残る。`clampUtf8` は多バイト文字の途中で切らない |
| 6 | 修正確認（実証済み） | 添付応答に `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` と `nosniff`。`dist/client/_headers` は `public/_headers` と同一。本番の応答ヘッダは未確認 |
| 7 | 修正確認（既存テスト） | `putAttachment(env, messageId, attId, …)` → `att/{messageId}/{attachmentId}`。zod が `/` `\` を禁止 |
| 8 | 修正確認（実証済み） | `text/html` と名乗る添付 → `application/octet-stream`、`attachment`、CSP・nosniff 付き |
| 9 | 修正確認（実証済み） | `victim+x@`、大文字、`+x+y`、末尾ドット付きドメイン、全角ローカル部はすべて reject。残りは #28 / #29 |
| 10 | **再検査失敗（実証済み）** | 塞がったのは「第三者が既知の **inbound** Message-ID を使う」経路だけ。元の指摘本文が挙げた「このメールボックスから返信を受け取った相手が、その返信の Message-ID を使う」攻撃は、`thread.ts` `findExistingThreadId` が **outbound を無条件にアンカーにする**ので今も成立する。`POST /messages` で送った outbound の Message-ID を、無関係な `attacker@evil.jp` が `In-Reply-To` に入れて送ると同じスレッドに入った。From 偽装は不要。「残る制約」欄の「From を偽装し Message-ID も知っている相手」は過小で、Message-ID を知るだけでよい（Bcc 受信者、転送先、メーリングリスト経由で知りうる）。直すなら outbound アンカーも「From がそのメッセージの宛先に含まれる」ことを要求する |
| 11 | 修正確認（コードとテスト） | srcdoc 先頭の meta CSP、`sandbox="allow-same-origin"`、`referrerPolicy="no-referrer"`、「画像を表示」ボタン。第 2 回で Chrome 実機でも確認したが、`<link rel="preconnect">` が抜ける（#17） |
| 12 | 修正確認（実証済み） | 8 進・10 進・16 進の IPv4、`[::ffff:7f00:1]`、`[::]`、全角数字、`user:pw@10.0.0.1`、`example.com@10.0.0.1`、100.64/10、`localhost.`、`[2002:7f00:1::]`、`[fc00::]`、`[fe80::]`、`0.0.0.0`、マルチキャストを拒否。登録・更新・配信直前・手動再送の 4 経路とも同じ判定。`redirect: "manual"`、10 秒タイムアウト |
| 13 | 修正確認（実証済み） | webhooks / rules / users / api-keys は `middleware/auth.ts` の `requireOwner` → `policy.ts`（owner かつ admin）。owner の read+send キーで `/admin/domains` `/admin/addresses` も 403。ただし後者 2 つは自前実装のまま（#31） |
| 14 | 修正確認（実証済み） | `applyAddressRules` に `to: msg.envelope.to`。`To: other@ext.jp` のメールに envelope 宛先の drop ルールが効いた |
| 15 | 修正確認（実証済み） | 同一秒に作った 5 件を `limit=2` で 3 ページ読んで重複も欠落も無し。壊れた cursor と `limit=0` は 400。残りは #32 |

## 第 2 回全精査 — 2026-09-11

観点の S-1〜S-11 を 4 つに分け、それぞれの「見る場所」をチェック項目ごとに読んだ。
第 1 回で指摘済みのものは再掲しない。番号は第 1 回から通しで #16 から振る。

実証に使ったのは、プロジェクトの `parse.ts` / `compose.ts` / `quote.ts` / `address.ts` / `sql.ts` /
`cleanup.ts` / `contracts/webhooks.ts` を `tsx` から直接呼んだもの、`node_modules` の postal-mime 3.0.0 /
mimetext 3.0.28 / hono 4.13.7 / react-router 8.3.1 / zod 4.5.4 / drizzle-orm 0.45.2、
ローカルの sqlite 3.51.0（FTS5 あり）、Chrome（`_headers` と同じ CSP と `MessageHtml.tsx` と同じ
srcdoc / sandbox を再現したローカルサーバ）。vitest は `npm run verify` の 1 回だけ。

### まとめ（第 2 回）

| # | 深刻度 | 内容 | 場所 |
| --- | --- | --- | --- |
| 16 | **中** | 返信の引用に受信 HTML をサニタイズ無しで埋め込む（実証済み） | `domain/mail/quote.ts` `buildReplyQuote` |
| 17 | **中** | `<link rel="preconnect">` で開封トラッキングができる（実証済み・Chrome） | `ui/components/MessageHtml.tsx` `buildSrcDoc` |
| 18 | **中** | apex 接続のドメインを切断すると、ゾーン内の他サブドメインのメール用 DNS まで消す（実証済み） | `domain/domains/cleanup.ts` `isOwnDnsRecord` |
| 19 | **中** | 受信 `Date` ヘッダをそのまま `received_at` に使い、1970 年以前でページングが 400、未来日で先頭に固定（実証済み） | `domain/mail/inbound.ts:193`、`search/sql.ts` `decodeCursor` |
| 20 | **中** | パース例外（入れ子 257 段・パート合計ヘッダ 2MB 超）で受信メールが痕跡なく消える。DLQ が無い（実証済み） | `domain/mail/parse.ts`、`services/consumer.ts`、`wrangler.jsonc` |
| 21 | **中** | 送信の部分失敗で成功した宛先にも再送する。`sending` のまま固まる経路もある | `domain/mail/outbound.ts` `processOutboundSend` |
| 22 | **中** | 送信 API に量の上限が無い（ボディ・宛先数・本文長・添付） | `shared/contracts/send.ts`、`api/v1/outbound.ts` |
| 23 | **中** | 「全員に返信」の宛先に受信 `To` 由来が入るのに UI が見せない。自分の `+タグ` とエイリアスを除外しない | `api/v1/outbound.ts` `replyAllRecipients`、`ui/routes/Compose.tsx` |
| 24 | **中** | R2 に置いた後のキュー投入が `waitUntil` で、失敗するとメールが消える | `domain/routing/incoming.ts:61` |
| 25 | **中** | `/me/api-keys` にスコープの門が無く、漏れたキー 1 本で無期限の子キーを作れ、同じ人の他のキーを全部失効できる | `api/v1/me.ts:108-187` |
| 26 | **中** | ログインの応答時間でメールアドレスの存在が分かる（実証済み・ローカル計測） | `api/v1/auth.ts:73-78` |
| 27 | **中** | FTS の同期トリガが外部コンテンツテーブルの削除手順を使っておらず、更新・削除で索引が残る（実証済み・sqlite。今は発火する経路が無い） | `migrations/0001_search_fts.sql:31-39` |
| 28 | 低 | アドレススコープのルールが `+タグ` を見ない（#9 / #14 の残り。実証済み） | `domain/mail/inbound.ts:274` |
| 29 | 低 | 引用ローカル部 `"victim"@` と `victim.@` が拒否ルールに当たらず catch-all へ（#9 の残り。実証済み） | `domain/mail/address.ts` `normalizeAddress` |
| 30 | 低 | PATCH で inbound の `status` を `sent` / `queued` / `failed` にできる（#4 の残り。実証済み） | `api/v1/messages.ts:165`、`contracts/messages.ts` `messagePatch` |
| 31 | 低 | `admin/domains` `admin/addresses` の `ownerOnly` が自前実装のまま。テストも単体マウント（#13 の残り） | `api/v1/admin/domains.ts:28`、`admin/addresses.ts:24`、`tests/domains-api.test.ts:36` |
| 32 | 低 | 配信履歴のカーソルが未検証で同秒の行を落とす。`limit` の無い一覧が 5 つ残る（#15 の残り。実証済み） | `api/v1/webhooks.ts:160`、`me.ts:108`、`addresses.ts:82`、`admin/{rules,domains,addresses}.ts` |
| 33 | 低 | 受信 `Message-ID` に CRLF が入ると、そのメールへの返信が必ず失敗する（注入はされない。実証済み） | `domain/mail/parse.ts:97` |
| 34 | 低 | 返信の `References` / `Subject` が 998 文字を超える 1 行になる（実証済み） | `domain/mail/compose.ts:87-91` |
| 35 | 低 | スレッド詳細が全件返しで、同じ From から接ぎ木し続ければ無限に伸ばせる | `search/sql.ts` `queryThreadMessages` |
| 36 | 低 | エイリアスの連鎖を PATCH で作れる | `api/v1/admin/addresses.ts:199` |
| 37 | 低 | アーカイブ済み・エイリアスのアドレスから送信でき、宛にも届く | `routing/resolve.ts:118`、`api/v1/outbound.ts` `assertCanSend` |
| 38 | 低 | ドメインルールの `target` が検証されない | `api/v1/admin/rules.ts`、`contracts/rules.ts:24` |
| 39 | 低 | 受信 From / To の表示名に CRLF、アドレスにタブが入ると返信の宛先が黙って落ちる（実証済み） | `domain/mail/parse.ts` `flattenAddresses`、`address.ts` `formatAddress` |
| 40 | 低 | 転送ループヘッダにエンベロープ `to` を載せている | `routing/incoming.ts:38` |
| 41 | 低 | `AUTH_SECRET` が型・手順にあるがコードで未使用。`INTERNAL_SECRET` の手順が抜けている | `worker-env.d.ts:27`、`docs/ops/deployment.md` §3、`README.md` |
| 42 | 低 | Webhook の手動再送が状態を見ず、成功済みを再送し、再送チェーンを増やす | `api/v1/webhooks.ts:184` |
| 43 | 低 | Webhook 通知に `bcc` が載る。受け手向けの署名検証手順が文書に無い | `services/webhooks.ts:47` |
| 44 | 低 | Webhook の `addressIds` に存在検査と個数上限が無い | `api/v1/webhooks.ts:93`、`contracts/webhooks.ts:116` |
| 45 | 低 | CI の Action がタグ固定で SHA ではない | `.github/workflows/ci.yml`、`deploy.yml` |
| 46 | 低 | `deploy.sh` が `DATABASE_ID` を検証せず `sed` に入れる | `scripts/deploy.sh:40` |
| 47 | 低 | Worker 名のずれを検出する自動手段が無い | `wrangler.jsonc`、`tests/domains-helpers.ts:14` |
| 48 | 低 | テスト・ローカル用の既知 `INTERNAL_SECRET` を本番が拒否しない | `vitest.config.ts:19`、`scripts/seed-local.mjs:14` |
| 49 | 低 | 生 MIME が `inline` で配信される | `api/v1/attachments.ts:80` |
| 50 | 低 | CSRF 防御が Cookie の `SameSite=Lax` だけ。`Content-Type` を検査していない | `lib/validate.ts` `readJson`、hono `HonoRequest.json` |
| 51 | 低 | API 表と実装のずれ。未使用の `threadId` スキーマ項目。zod に `strict` が無い | `docs/spec/architecture.md` §4、`contracts/send.ts:37` |
| 52 | 低 | ログインのレート制限の鍵が `ip:email` の組だけ。bootstrap に制限が無い | `api/v1/auth.ts:66,146` |
| 53 | 低 | 仮パスワード生成に剰余バイアス | `lib/password.ts:93` |
| 54 | 低 | 最後のオーナー保護に同時実行の隙間 | `api/v1/admin/users.ts:132`、`policy.ts` `countActiveOwners` |

### 直す順番（第 2 回）

1. **#10 の再検査失敗**と **#16**（引用 HTML）— 匿名の送信者の HTML が、信頼している会話の続きとして表示され、返信すると自ドメインの署名付きで第三者へ届く。2 つで 1 つの攻撃になる。
2. **#18**（apex 切断）— 実証済みで、他のドメインのメールを止める。取り返しがつかない。
3. **#19 / #20 / #24**（受信の可用性）と DLQ — 匿名の送信者が 1 通で起こせる。
4. **#21 / #22 / #23**（送信）— 二重送信は通常運用でも起きる。
5. **#25 / #26**（認証・キー）— キー 1 本の被害範囲に「持続」と「他キーの失効」が入っている。
6. **#17 / #27** と残り。

### 対応の分担（第 2 回）

#10 の再検査失敗と #16〜#54 の 40 件を、**編集するファイルが重ならない** 5 群に分けた。
1 群を 1 エージェントに渡し、別々の worktree で並行に直す。群をまたぐ依存は「前提」欄に書いた。
`docs/spec/security-audit.md` 自体は各群では編集せず、取り込み時に統合担当が「対応状況」を書く。

| 群 | 名前 | 指摘 | 編集してよいファイル | 前提・注意 |
| --- | --- | --- | --- | --- |
| A | 受信パイプライン | #10, #19, #20, #24, #28, #29, #33, #35, #39, #40 | `domain/mail/{thread,inbound,parse,address}.ts`、`domain/routing/incoming.ts`、`domain/search/sql.ts`、`services/consumer.ts`、`wrangler.jsonc`（DLQ のみ）、`tests/{thread,inbound,parse,address,search-*}.test.ts` | #19 の `received_at` を変えると B の `updateThreadStats` 呼び出しには影響しない（A 側の関数）。`address.ts` は共有なので `normalizeAddress` の戻り値の意味を変えない（引用符・末尾ドットを剥がすだけ） |
| B | 送信 | #16, #21, #22, #23, #34, #37, #51 のうち `threadId` 削除 | `domain/mail/{quote,compose,outbound}.ts`、`services/sender.ts`、`shared/contracts/send.ts`、`api/v1/outbound.ts`、`ui/routes/Compose.tsx`、`domain/routing/resolve.ts`（#37 の `archivedAt` のみ）、`tests/{compose,send,outbound-*}.test.ts` | #21 で `outbound_jobs` に送信済み宛先の列が要るなら、スキーマ変更は「要依頼」として報告し、まずは列を増やさない実装（`meta` JSON など既存列）を優先する。#23 の `isSelf` に使うエイリアス集合は `resolve.ts` の既存関数を読む |
| C | 認証・自分のキー・メッセージ API | #25, #26, #30, #48, #50, #52, #53, #54, #51 のうち `createUserBody` と `architecture.md` §4 の表、#32 のうち `me/api-keys` と `addresses` の `limit` | `api/v1/{auth,me,messages,addresses}.ts`、`api/v1/admin/{users,api-keys}.ts`、`shared/contracts/{messages,users}.ts`、`lib/{password,validate,paging}.ts`、`docs/spec/architecture.md` §4 の表、`tests/{auth-*,policy-*,scope-*}.test.ts` | #50 の `readJson` は全ハンドラが通るので、他群のテストが JSON を `Content-Type` 無しで送っていれば壊れる。`tests/helpers.ts` の送信ヘルパを直して全テストを通す |
| D | ドメイン・アドレス・ルール管理と CI | #18, #31, #36, #38, #45, #46, #47, #32 のうち `admin/{rules,domains,addresses}` の `limit` | `domain/domains/cleanup.ts`、`api/v1/admin/{domains,addresses,rules}.ts`、`shared/contracts/rules.ts`、`.github/workflows/*.yml`、`scripts/deploy.sh`、`tests/{domains-*,routing-*}.test.ts` と Worker 名の一致テスト | #18 は「迷ったら消さず報告」。apex 切断で `name === mailName` と `cf-bounce._domainkey.${mailName}` の完全一致だけを消す。下位に別接続があれば 409。#31 は `requireOwner` に置き換え、ルータ単体でも 403 になるテストを足す |
| E | Webhook・表示・文書 | #17, #27, #41, #42, #43, #44, #49, #32 のうち deliveries のカーソル | `ui/components/MessageHtml.tsx`、`migrations/0004_*.sql`（新規）、`api/v1/{webhooks,attachments}.ts`、`services/webhooks.ts`、`shared/contracts/webhooks.ts`、`worker-env.d.ts`、`.dev.vars.example`、`README.md`、`docs/ops/deployment.md`、`tests/webhook-*.test.ts`、`tests/security-headers.test.ts` | #27 は既存マイグレーションを書き換えず新規ファイルでトリガを作り直し `'rebuild'` する。#17 は `onLoad` 後では遅いので srcdoc を組む前に `DOMParser` で落とす。#43 の署名検証手順は `deployment.md` に節を足す |

各群に共通:

- 攻撃の再現をテストに落とす（第 1 回と同じ）。「直った」の根拠は元の攻撃が失敗するテスト。
- 終わる前に `npm run verify` を通す。他群のテストを壊さない。
- 直せなかった・判断できなかった指摘は、番号と理由を報告に残す。黙って飛ばさない。
- 報告は 30 行以内: 指摘番号ごとに「直した / 直さなかった（理由）」、触ったファイル、要依頼（スキーマ・依存・担当外）。

### 対応状況（第 2 回）— 2026-09-11

上の 5 群を並行に直し、群ごとに差分を審査して取り込んだ。差し戻しは 2 件（B: `sending` 固着の回収が
再配達のタイミングで効かない、D: 管理画面が一覧を 1 ページしか読まない）。統合時に #50 の Content-Type 検査を
`app.ts` の全体ミドルウェアに引き上げ、srcdoc の doctype と受信 DLQ の作成手順を足した。
`npm run verify` は通る（43 ファイル・457 件）。

| # | 対応 | 残る制約 |
| --- | --- | --- |
| 10 | outbound をアンカーにするのは「新しい送信者がその outbound の To/Cc/Bcc に含まれる」ときだけ | Bcc 受信者は宛先に含まれるので接ぎ木できる（正規の受信者なので許容） |
| 16 | 引用 HTML は `stripHtml` → `escapeHtml` → `<pre>`。テキスト経路と同じ | 受信 HTML の見た目は引用に残らない |
| 17 | srcdoc を組む前に `DOMParser` で `link` と `meta[http-equiv=refresh]` を除去。doctype は付け直す | `DOMParser` の無い環境（テスト）は正規表現の代用。実機での再確認はしていない |
| 18 | apex 切断は `name === mailName` と `cf-bounce._domainkey.` の完全一致だけ削除。下位に別接続があれば 409。クエリ不正は 400 | — |
| 19 | `Date` が `[投入時刻 − 1 年, + 10 分]` の外なら投入時刻に落とす。`updateThreadStats` は `max()`。`decodeCursor` は負数も読む | 1 年以内の過去日は通る（自分のメールが沈むだけ。スレッドは沈まない） |
| 20 | パース例外を捕まえて placeholder 行を残して ack。`dead_letter_queue: tsubame-inbound-dlq` | DLQ キューは `wrangler queue create` が要る（deployment.md に追記） |
| 21 | `UPDATE … WHERE status='queued' OR (sending AND 期限切れ) RETURNING` で claim。送信後の DB 更新と Webhook を try の外へ。期限内の `sending` に再配達が来たら期限後に自分を積み直す | **宛先ごとの送信済み記録は未実装**（列追加が要る）。N 件目で失敗すると成功済み宛先にも再送する（最大 4 回） |
| 22 | zod に subject 998・本文 1MB・添付 20MB/合計 25MB/50 件・宛先 100。`bodyLimit` 40MB。スレッド作成とメッセージ挿入を同じ `batch` に | `compose.ts` は件名を 600 バイトで黙って切る（zod の 998 文字と一致していない） |
| 23 | reply API に `to` / `cc` の明示指定を足し、UI が最終宛先を表示・編集する。`isSelf` は基本アドレスとエイリアス集合を含む | — |
| 24 | `await env.INBOUND_QUEUE.send(payload)` | — |
| 25 | `/me/api-keys` の POST / DELETE はセッションか admin スコープのみ。`expiresAt` を親キー以下に clamp。監査 `meta` に `apiKeyId` | 子キーのカスケード失効は未実装（親子関係の列が無い。門で発行自体を塞いだ） |
| 26 | ユーザー不在・`passwordHash` null でも固定ダミーハッシュに対して `verifyPassword` を走らせる | Workers 上での遠隔計測はしていない |
| 27 | `migrations/0004_fts_delete_triggers.sql` でトリガを `'delete'` 形式に作り直し `'rebuild'` | `migrations/meta/_journal.json` は元から食い違っており触っていない |
| 28 | address ルールの `to` を基本アドレスでも評価 | — |
| 29 | `normalizeAddress` が引用符と末尾ドットを剥がす | — |
| 30 | PATCH の `status` は `received` / `trash` のみ | — |
| 31 | `requireOwner` に統一。ルータ単体でも 403 のテスト | — |
| 32 | deliveries は `lib/paging.ts` の複合カーソル。`me/api-keys`・`addresses`・`admin/*` に `limit`。管理画面は `getAllPages` で全件読む | `/addresses`（既定 100）と `/me/api-keys`（既定 25）は UI が 1 ページしか読まない |
| 33 | `parse.ts` で Message-ID 系トークンを `[^\s<>\x00-\x1f\x7f]+` に絞る | — |
| 34 | `References` は直近 50 件、さらに送信直前に 998 文字に収める。件名は 600 バイトで切る | 中継 MTA の挙動は未確認 |
| 35 | `queryThreadMessages` に 200 件の上限 | 201 件目以降は表示されない（切り詰めの通知は無い） |
| 36 | PATCH でエイリアス化するとき、自分をエイリアス先にしている行があれば 409 | — |
| 37 | アーカイブ済み・エイリアスからの送信を 403。受信解決でアーカイブ済みは実在しない扱い | アーカイブ済み宛は catch-all があればそこへ落ちる |
| 38 | `deliver` は同ドメインの実在アドレス id、`forward` はメールアドレス形式 | — |
| 39 | 受信アドレスを `normalizeAddress` に通し、表示名の CRLF を空白に | 引用ローカル部に空白を含むアドレスは捨てる |
| 40 | 転送ループヘッダの値は `"1"` | — |
| 41 | `AUTH_SECRET` を型・文書から削除。§3 を `INTERNAL_SECRET` に | — |
| 42 | `failed` 以外の再送は 409 | — |
| 43 | Webhook 通知から `bcc` を削除。deployment.md §10 に署名検証手順 | — |
| 44 | `addressIds` は最大 100・重複排除・実在と可視性を検査。`events` も重複排除 | — |
| 45 | `actions/checkout` / `setup-node` を v4.4.0 の SHA に固定（`git ls-remote` で照合） | — |
| 46 | `DATABASE_ID` に `^[0-9a-f-]{36}$` を要求 | — |
| 47 | `tests/worker-name.test.ts` が `wrangler.jsonc` の `name` と `vars.EMAIL_WORKER_NAME` の一致を検査 | — |
| 48 | bootstrap がテスト・ローカル用の既知の 2 値を拒否。vitest の値は別に、seed は `.dev.vars` から読む | vitest の固定値もリポジトリにあり拒否リストには無い |
| 49 | 生 MIME は `attachment` | — |
| 50 | `app.ts` で `/api/*` のボディ付き POST / PUT / PATCH に `application/json` を要求。`readJson` も同じ検査 | — |
| 51 | `threadId` を削除。`createUserBody` の agent + password を 400。§4 の表を実装に合わせた | `GET /v1/openapi.json` は未実装のまま（表から外した） |
| 52 | ログインの鍵に `ip` 単独・`email` 単独を追加。bootstrap に `ip` 単位の制限 | `email` 単独の鍵は、他人のアドレスを 1 分に 20 回叩けばその人のログインを止められる |
| 53 | 棄却法で剰余バイアスを除去 | — |
| 54 | 「他に有効な owner が居る」を UPDATE / DELETE の WHERE 句に埋めて 1 文に | — |

### 再検査（第 2 回）— 2026-09-11

上の「対応状況（第 2 回）」を信用せず、40 件（#10 の再検査失敗と #16〜#54）を対応と同じ 5 群に分け、群ごとに別の読み手が
隔離した worktree で、修正がコードに存在し元の攻撃が今も成立しないかを確かめた。実証に使ったのは、一時テスト
（vitest・harness 経由。終わったら削除）、`tsx` から本物の関数を直接呼んだもの、sqlite 3.51.0（FTS5）、`wrangler dev` への
実 HTTP、Chrome 152 headless（`_headers` と同じ CSP の親ページに `buildSrcDoc` を束ねて載せ、接続を記録する TCP リスナで観測）、
`git ls-remote`。`npm run verify` は通る（43 ファイル・457 件。文書の記述と一致）。

**結果: 34 件は修正確認。#17 / #22 / #23 / #28 / #32 / #39 の 6 件は再検査失敗。** さらに、修正が新しく持ち込んだ退行が
2 件ある（#55: #50 の修正でボディ無しの POST が本番で 400、#56: #20 の修正で R2 の一時失敗がメール本文を永久に捨てる）。
修正は効いているが隣に欠陥が残っているもの、新たに見つかったものは第 3 回の番号として #55〜#72 を先に振った。

| # | 判定 | 根拠 |
| --- | --- | --- |
| 10 | 修正確認（実証済み） | `findExistingThreadId`: 送信済み outbound（To・Cc・Bcc あり）に対し、無関係な `attacker@evil.jp` と `partner+x@` は接ぎ木しない。宛先本人（大文字違い・Cc・Bcc）は接ぎ木し、References だけ経由でも同じ判定。inbound アンカーも別人・`+タグ` は null。「残る制約」は過小（下記） |
| 16 | 修正確認（実証済み） | `buildReplyQuote` に元の攻撃 HTML、エンティティの二重化、`</pre><script>`、`alt="a>b" onerror=`、閉じない `<script src=`、`<scr<script>ipt>`、`<style>` `<link>` `<meta refresh>`、コメント・CDATA を通して `<pre>` 内の生タグ 0。reply API → キュー → 送信 MIME にも `<script>` `<img` 無し、`<blockquote>` 1 個 |
| 17 | **再検査失敗（実証済み・Chrome）** | 単純な `<link>` 32 種（大文字、svg・template・noscript 内、dns-prefetch / prerender / modulepreload / preload、meta Refresh の各表記）は除去され接続 0。だが名前空間混乱の mXSS、`<iframe srcdoc>` 属性、`<iframe src>` の 3 変形で攻撃者ホストへ接続が来た（下記） |
| 18 | 修正確認（実証済み） | fake CF で `cleanupDomain`: apex 切断で `MX/TXT mail.example.com`、`cf-bounce._domainkey.mail.example.com`、`MX other.example.com` は残り、apex の完全一致だけ消える。大文字・末尾ドット付きの名前も正しく判定。配下に大文字や `xn--` の別接続があれば 409、`cleanup=abc` は 400、`cleanup=false` は CF 呼び出し 0。subdomain 同士の入れ子は #60 |
| 19 | 修正確認（実証済み） | `Date:` 1900 / 2100 / 不正文字列 / `+275760-09-13` / 366 日前 / +11 分 / epoch 0 はすべて投入時刻。364 日前・+9 分は通る。10 通を `limit=2` で 5 ページ読んで 400 無し。負の `received_at` のカーソルも復元できる。既存スレッドの `lastMessageAt` は後退しない |
| 20 | 修正確認（実証済み） | 入れ子 257 段と累積ヘッダ 2MB 超で placeholder 行が残り例外なし。`dead_letter_queue` の設定と `queue create` の手順あり。ただし try が R2 の読み込みまで包んでいる（#56） |
| 21 | 修正確認（実証済み） | queued を 5 並列で `processOutboundSend` → 送信 1・積み直し 4。2 件目の宛先が常に失敗すると 1 件目に 4 通で `failed`（記載どおり）。期限切れ `sending` の回収は attempts を数えない（#59） |
| 22 | **再検査失敗（実証済み）** | `to: ["r0@…, r1@…, …(200 件)"]`（配列 1 要素にカンマ区切り）が zod を通り 202 → `EMAIL.send` 200 回。reply の `to` / `cc` でも 300 回。`bodyLimit` は reply にも効き、base64 と本文の上限は 40MB と整合している |
| 23 | **再検査失敗（実証済み）** | 全員に返信で、受信 `To: box+news@…` と `Cc: box+promo@…` が宛先に残り、返信が自分の受信箱に戻る。大文字・エイリアス・`alias+x@` は除外される。UI の最終宛先の表示・編集は実装済み |
| 24 | 修正確認（コードとテスト） | `await env.INBOUND_QUEUE.send`。既存テストが send 失敗で reject を確認。Email Routing が一時失敗を送信側の再送に変えるかは公式文書に記述が無く未確認 |
| 25 | 修正確認（実証済み） | read キーの POST・send キーの DELETE は 403、GET は 200。`clampExpiresAt` は省略・親より後 → 親の期限、親が無期限 → null。仮パスワードの Cookie と admin スコープの限定キーは抜ける（#64 / #58） |
| 26 | 修正確認（実証済み） | ダミーハッシュの反復回数は `DEFAULT_ITERATIONS`（100,000）と同じ。miniflare 上で誤パスワード 8 回ずつの中央値は、居る 9.0 ms・居ない 9.0 ms・agent 10.0 ms・無効 14.0 ms。文言も同じ |
| 27 | 修正確認（実証済み） | sqlite で 0000〜0004 を順に流し、UPDATE 後に旧語 0 件・新語ヒット、DELETE 後に FTS の rowid 0 件、rowid を再利用した行が旧語でヒットせず `integrity-check` も通る。`readD1Migrations` と wrangler は番号順で `_journal.json` を読まない（ただし #70） |
| 28 | **再検査失敗（実証済み）** | `+tag` と大文字は drop される。だがエンベロープ `"a"@example.com` と `a.@example.com` は、`resolveIncoming` が a のメールボックスに配送するのに、address ルールの `{to:"a@example.com"}` に当たらず `received` のまま |
| 29 | 修正確認（実証済み） | reject `{to:"a@example.com"}` に対し `"a"@`、`a.@`、`"a."@EXAMPLE.COM.`、`"a+x"@`、`<"a"@…>`、`a..@`、`.a@` はすべて reject。`"a b"@` は不正アドレスとして reject |
| 30 | 修正確認（実証済み） | `sent` / `queued` / `failed` / `draft` / `"RECEIVED"` / `""` は 400。未知キー（`direction`、`addressId`）は落とされる。outbound の trash → received は #68 |
| 31 | 修正確認（実証済み） | `admin/domains` `admin/addresses` `admin/rules` をルータ単体で載せ、member のセッションと owner の read+send キーは 403、owner の admin キーとセッションは 200、principal 無しは 401 |
| 32 | **再検査失敗（実証済み）** | deliveries（同一秒 3 行を limit=2 で 2+1、壊れた cursor は 400）、admin の 3 つ（同一秒 30 件を limit=10 で 3 ページ）、`me/api-keys` のカーソルは直った。だが `/addresses` は見えるアドレスが 99 件以上で 500 になる（下記） |
| 33 | 修正確認（実証済み） | encoded-word で CRLF を入れた Message-ID / In-Reply-To は null。References は空白で割ってからトークンを検査するので改行は残らない（割れた断片がゴミトークンとして残る。#72） |
| 34 | 修正確認（実証済み） | References 200 個 → 50 個・998 文字以内。1500 文字の Message-ID は In-Reply-To ごと落ちる（スレッド化だけ失う）。宛先 100 件の To は mimetext が 1 行 1 宛先に折る。長い表示名は #66 |
| 35 | 修正確認（実証済み） | 201 件のスレッドで 200 件。ただし古い順なので落ちるのは最新の 1 件（「残る制約」を書き直す） |
| 36 | 修正確認（実証済み） | A→B の状態で、B を alias→A（循環）にすると 400、B→C は 409、自分自身は 400、B の DELETE は 409。ドメイン DELETE 経由は #61 |
| 37 | 修正確認（実証済み） | 送信 API・reply ともアーカイブ済みとエイリアスからは 403。`ai+tag@` も 403、大文字は正規化されて 202。キュー投入後のアーカイブは #67 |
| 38 | 修正確認（実証済み） | `deliver` に他ドメインの id・存在しない id は 400。PATCH で `domainId` だけ・`action` だけ差し替えても 400。`forward` に改行入りは 400。エイリアス行・アーカイブ済み行は通る（#62） |
| 39 | **再検査失敗（実証済み）** | CRLF の表示名とタブ入りアドレスは直った。だが表示名に `"` が 1 つ入ると、返信時に**宛先が 0 件**になる（下記）。元の指摘より悪い |
| 40 | 修正確認（コードとテスト） | `headers.set(FORWARD_HEADER, "1")`。既存テストが値にエンベロープの `to` を含まないことを確認 |
| 41 | 修正確認（コードとテスト） | `AUTH_SECRET` は src・README・`.dev.vars.example`・`worker-env.d.ts`・`wrangler.jsonc(.example)`・docs/ops から消えた（残りは精査の記録のみ）。README のローカル手順と §3 は整合。§8 の curl 例は #71 |
| 42 | 修正確認（実証済み） | `pending` / `success` の retry は 409・fetch 0 回。`failed`（attempt 5）の再送は成功・失敗ともキュー投入 0 回、`failed`（attempt 1）はチェーン 1 本。同時 2 回の retry は #69 |
| 43 | 修正確認（実証済み） | `message.received` / `sent` / `failed` のペイロードに bcc 無し。deployment.md §10 の `verify()` を写し、`buildSignatureHeader` の実出力で true、本文改変・別鍵・t−301 秒で false。ヘッダ名・`t=…,v1=…`・`<t>.<body>` は実装と一致 |
| 44 | 修正確認（実証済み） | 存在しない id・可視性外・101 件・`[123]` は 400、重複は除去、PATCH でも 400 かつ値は不変、member は 403。`[]` は 201（一度も発火しない webhook。実害なし） |
| 45 | 修正確認（実証済み） | `git ls-remote` で `actions/checkout` `11d5960a…` と `actions/setup-node` `49933ea5…` が `refs/tags/v4.4.0` と一致。両 workflow の `uses:` 4 行すべて SHA 固定 |
| 46 | 修正確認（実証済み） | 同じ `[[ =~ ^[0-9a-f-]{36}$ ]]` を bash で実行: 正常な UUID は通り、大文字の UUID・改行入り・`/` `&` `"` は拒否。`-` 36 個は通るが sed に無害 |
| 47 | 修正確認（コードとテスト） | `tests/worker-name.test.ts` が本物の `wrangler.jsonc` を読み、`name === vars.EMAIL_WORKER_NAME` を検査する（3 件通過）。`env.*` 別の設定は見ない |
| 48 | 修正確認（実証済み） | 既知の 2 値で bootstrap → 403。末尾空白付きは通るが、`wrangler secret put` は末尾空白を落とすので CLI からは入れられない |
| 49 | 修正確認（実証済み） | raw の実応答が `Content-Disposition: attachment; filename="msg_….eml"`、`message/rfc822`、CSP `default-src 'none'`、`nosniff`、`X-Frame-Options: DENY`。権限外は 404 |
| 50 | 修正確認（実証済み） | `Application/JSON` と `application/json ; charset=utf-8` は通り、`json-patch+json`・`text/plain;application/json`・multipart・urlencoded・Content-Type 無しは 400。`/api/internal` も同じ。ただしボディ無しの POST まで止める（#55） |
| 51 | 修正確認（実証済み） | `threadId` に他人のスレッドを入れても 202 で新規スレッド（`contracts/send.ts` に項目が無い）。`createUserBody` の agent + password は 400。§4 の表は read / send / reply / raw / attachments / threads が実装と一致。`/me/api-keys` の POST / DELETE の門（セッションか admin）が表に無い |
| 52 | 修正確認（実証済み） | 大文字の email を別 IP から 20 回 → 以後 429。同じ IP・別 email の 21 通目 → 429。bootstrap も同じ IP の 21 回目で 429 |
| 53 | 修正確認（実証済み） | 20 文字 × 5000 本で 56 文字すべて出現、出現数の最大／最小 = 1.115（一様の範囲） |
| 54 | 修正確認（実証済み） | owner 2 人が {降格・無効化・削除・agent 化} を互いに同時実行する 16 組すべてで [200, 409]、有効な owner は常に 1 人 |

#### 再検査失敗の再現（第 2 回）

- **#17** `MessageHtml.tsx` `buildSrcDoc`。出力を `sandbox="allow-same-origin"` の iframe の srcdoc に入れ、Chrome 152 で次の 3 つとも攻撃者ホストへの接続を観測した（対照の未除去 preconnect は接続 1、`<img src>` は 0）。
  1. 名前空間混乱: `<form><math><mtext></form><form><mglyph><style></math><link rel=preconnect href=http://attacker/>`。
     DOMParser の段では `<style>` が HTML 要素で `<link …>` はその中のテキストなので `querySelectorAll("link")` に掛からず、
     `outerHTML` に文字列のまま残る。iframe が再パースすると `<style>` が MathML 側の要素になり、`<link>` が実要素として現れる。
     parse → serialize → reparse が冪等でない。
  2. `<iframe srcdoc="&lt;link rel=preconnect href=http://attacker/&gt;">`。属性値なので DOMParser からは見えず、入れ子の srcdoc 文書で preconnect が動く。
  3. `<iframe src="http://attacker/">` だけ。meta CSP `default-src 'none'`（`frame-src 'none'` を明示しても同じ）で読み込みは止まるが、
     Chrome が枠の origin へ投機的に接続する（http は SYN のみ、https は TLS ClientHello まで）。`sandbox` や `loading=lazy` を付けても同じ。

  **直し方**: `iframe` / `frame` / `object` / `embed` を要素ごと落とし、除去後の出力を再度パースして除去を繰り返し、変化が無くなるまで回す
  （1 は 2 周目で live な link が 0・接続 0 になることを確認済み）。名前空間混乱の要素（`math` / `svg` 内の `mglyph` / `style` など）を落とす
  サニタイザ（DOMPurify は Apache-2.0 を選べる）に載せ替える案もある。
- **#22** `shared/contracts/send.ts` `recipientCount`。配列なら `list.length` しか数えず、要素の中のカンマ区切りを数えない。
  `send` キーで `{"from":"ai@…","to":["a0@x.jp, a1@x.jp, …"],"text":"x"}` を送ると、`singleLine` に長さの上限も無いので 40MB まで宛先を詰められる。
  **直し方**: `parseAddressList(addressListToCsv(list)).length` で正規化後の件数を数える。`singleLine` に長さの上限を付ける。
- **#23** `api/v1/outbound.ts` `isSelf`。`ownBase = baseAddressOf(own)` はメールボックスのアドレスに `+` が無いと null になり、
  `baseAddressOf(n) === own` を比べる行が無い。受信メールの `To: box+news@reply.tsubame.test` に全員に返信すると（UI の既定の宛先でも）、
  返信が自分の受信箱に戻る。**直し方**: `if (baseAddressOf(n) === own) return true;` を足す。UI の `looseAddressOf` も `+` を落とす。
- **#28** `domain/mail/inbound.ts:187` `toCandidates = [envelope.to, baseAddressOf(envelope.to)]`。生の値と `+` を落とした形しか無く、
  正規化した形（引用符と末尾ドットを剥がしたもの）が無い。catch-all が worker に向いていれば、envelope `"a"@example.com` で address スコープの
  drop をすり抜けて a の受信箱に入る。**直し方**: 候補に `normalizeAddress(envelope.to)` を足す。
- **#32** `api/v1/addresses.ts:62-73`。ページ内のアドレス id を未読集計の `inArray` に全部渡すので、バインド変数が id の数 + 2 個になる。
  オーナーでアドレスを 99 個以上作り `GET /api/v1/addresses`（既定 `limit=100`）→ 500（`D1_ERROR: too many SQL variables`）。
  `limit=98` → 200、`limit=99` → 500。UI のサイドバー（`AppLayout.tsx` `AddressesApi.list()`）は 1 件も表示できなくなる。
  **直し方**: 未読集計を `address_id` の JOIN / サブクエリにするか、id を 90 個ずつに割る。`limit` の上限も 98 以下にする。同じ根は #57。
- **#39** `domain/mail/address.ts`。`formatAddress` は表示名の `"` を `\"` にエスケープして保存するが、`parseAddressList` は `"` を見るたびに
  `inQuote` を反転し、`\` を解さない。`To: "x\"y" <bob@x.com>, carol@x.com`（encoded-word `=?utf-8?q?x=22y?=` でも同じ）の受信メールは
  `"x\"y" <bob@x.com>, carol@x.com` として保存され、`parseAddressList` が `[]` を返す。全員に返信でも、`toAddr` / `ccAddr` を読む経路は宛先が消える。
  **直し方**: `formatAddress` で表示名から `"` と `\` を落とす（簡単）か、`parseAddressList` にエスケープの解釈を足す。

#### 「残る制約」の書き直し（第 2 回）

| # | 正しい記述 |
| --- | --- |
| 10 | Message-ID と宛先アドレスの両方を知る第三者は、From を偽装すれば接ぎ木できる（Bcc 受信者・転送先はヘッダから両方を知る）。From の DMARC / SPF 判定は読んでいない。Reply-To は読まないので返信は偽装元へ行かず、被害は「信頼している会話の続きとして表示される」こと |
| 17 | parse → serialize → reparse が冪等でなく、名前空間混乱で `<link>` が復活する。`<iframe>` の `src` への投機接続と `srcdoc` 内の `<link>` は除去の対象外（再検査失敗） |
| 19 | 既存スレッドは沈まない。1 年以内の過去日で新規スレッドを作ると `lastMessageAt` がその日付になって沈む（送信者自身のメールだけ） |
| 21 | 例外で失敗した経路は最大 4 回。期限切れの `sending` の拾い直しは attempts を数えないので、Worker が落ち続けるかぎり全宛先に再送する（#59） |
| 22 | API は件名を 998 コード単位まで受けるが、送信では 600 バイト（日本語なら 200 文字）で黙って切る。本文の 1MB もコード単位なので多バイト文字なら 3MB 入る（`bodyLimit` 40MB が先に効くので安全側） |
| 25 | 子キーのカスケード失効は未実装。仮パスワードの Cookie でも作れる（#64）。admin スコープの限定キーは `/admin/api-keys` 経由で全アドレス・全スコープ・無期限のキーを作れる（#58） |
| 32 | `/addresses` は 99 件以上で 500（再検査失敗）。`/me/api-keys` は UI が 25 件を取ってから失効済みを画面側で除くので、失効キーを含めて 26 本目以降にある古い有効キーは、プロフィール画面に出ず失効もできない（#65） |
| 35 | 古い順に 200 件なので、最新のメールがスレッド詳細に出ない。#10 の From 偽装と組み合わせると、正規のスレッドに 200 件積んで以後の正規メールをスレッド詳細から隠せる（受信箱の一覧には出る） |
| 37 | 加えて、キュー投入の後に差出人をアーカイブしても送信される（#67） |
| 42 | `pending` のまま再送のキューメッセージを失った配信は、手動で再送できない（永久に 409）。同じ `failed` 配信を同時に 2 回 retry すると両方通る（#69） |
| 47 | `env.*` 別の `name` / `vars` は見ない。env は `vars` を継承しないので、env を足した時点のずれは検出できない |
| 52 | 成功したログインもバケットを消費する。`ip` 単独の鍵は、NAT 配下の全員で 1 分 20 回を分け合う |

#### 再検査で見つかったもの（第 3 回の番号として先に振る）

「実証済み」は再検査で実際に走らせたもの。#55 / #56 は第 2 回の修正が持ち込んだ退行。

| # | 深刻度 | 内容 | 場所 |
| --- | --- | --- | --- |
| 55 | **中** | #50 の修正で、ボディ無しの POST が実 HTTP で 400 になる。管理画面の「DNS を確認」と Webhook の「再送」ボタンが本番で動かない（実証済み・`wrangler dev`） | `api/app.ts:53`、`ui/routes/admin/api.ts:22` |
| 56 | **中** | #20 の修正で、R2 本文の一時的な読み込み失敗が placeholder 行として ack され、再配達も重複扱いで捨てられて本文が永久に取り込まれない（実証済み） | `domain/mail/inbound.ts:234` |
| 57 | **中** | D1 のバインド変数 100 個の上限。grant 34 件以上で `PUT /admin/users/:id/grants` が 500、grant 100 件の member は `/addresses` `/messages` `/threads` が 500、101 件で `/me` も 500（実証済み） | `api/v1/admin/users.ts` grants、`addressFilter` の `inArray` |
| 58 | **中** | 特定アドレス・期限付きの admin スコープのキーで `POST /admin/api-keys`（`userId` = 自分）を呼ぶと、全アドレス・全スコープ・無期限のキーを作れる。principal を基準にした clamp が無く、監査 `meta` に `apiKeyId` も無い（実証済み） | `api/v1/admin/api-keys.ts` |
| 59 | **中** | 期限切れの `sending` を拾い直すとき attempts を増やさず上限も見ない。attempts=99 の期限切れ `sending` を 6 回処理して 12 通送った（実証済み） | `domain/mail/outbound.ts` `processOutboundSend` |
| 60 | **中** | subdomain 同士の入れ子: `mail.example.com` と `deep.mail.example.com` を接続して前者を切断すると、`deep` の MX / TXT が消える。#18 の 409 判定が apex モード限定（実証済み） | `domain/domains/cleanup.ts`、`api/v1/admin/domains.ts` |
| 61 | 低 | 別ドメインのアドレスへのエイリアスを作れ、エイリアス先のドメインを DELETE すると `aliasTargetId` が宙に浮く。受信は存在しない id へ `deliver` して FK 違反で例外（`alias_target_id` に FK 無し。実証済み） | `api/v1/admin/addresses.ts` POST、`admin/domains.ts` DELETE |
| 62 | 低 | ルールの `deliver` 先にエイリアス行・アーカイブ済み行を指定できる。ルール経路はエイリアスを辿らず、エイリアス先がアーカイブ済みでも配送する（実証済み） | `api/v1/admin/rules.ts`、`domain/routing/resolve.ts` |
| 63 | 低 | 存在しない `domainId` / `addressId` でルールを作ると FK 違反の 500（実証済み） | `api/v1/admin/rules.ts` |
| 64 | 低 | 仮パスワードの Cookie（`mustChangePassword`）で `POST /me/api-keys` が 201・無期限。#25 の本文 4 点目が残っている（実証済み） | `api/v1/me.ts` |
| 65 | 低 | 一覧の取りこぼし: `MyApiKeys.tsx` は 25 件を取ってから失効済みを画面側で除く。`ApiKeysPage.tsx:276` は `admin/addresses` を 1 ページしか読まない。`admin/rules` はカーソルが無く 100 件（最大 200）で打ち切る（実証済み） | `ui/routes/MyApiKeys.tsx`、`ui/routes/admin/ApiKeysPage.tsx`、`api/v1/admin/rules.ts` |
| 66 | 低 | 返信の宛先まわり: 明示した `to` が全部自分だと 202 の後に 4 回試行して `failed`（実証済み）。全員に返信で宛先を編集すると Cc 欄が隠れたまま送られる（コード）。受信の表示名 1000 バイトで返信の To 行が 1376 文字になる（実証済み） | `api/v1/outbound.ts`、`ui/routes/Compose.tsx`、`domain/mail/compose.ts` |
| 67 | 低 | キュー投入の後に差出人をアーカイブしても送信される（実証済み） | `domain/mail/outbound.ts` `processOutboundSend` |
| 68 | 低 | outbound を PATCH で trash → received にでき、送信済みが「received」になって `status=sent` の検索から消える（実証済み） | `api/v1/messages.ts` |
| 69 | 低 | Webhook の手動再送に claim が無く、同時 2 回で受け手に 2 回届く。無効化した webhook の `failed` 配信を再送すると 200 で `failed` のまま（実証済み） | `api/v1/webhooks.ts` `POST /deliveries/:id/retry` |
| 70 | 低 | `migrations/meta/_journal.json` が 0002 までしか無く、次の `npm run db:generate` が `0003_*.sql` を作って既存と番号が衝突する（実証済み・スクラッチにコピーして実行） | `migrations/meta/_journal.json` |
| 71 | 低 | deployment.md §8 の bootstrap の curl 例に `secret` が無く 400 になる。§3・§8 と重複する「最初のオーナーを作る」節が末尾に残る | `docs/ops/deployment.md` |
| 72 | 低 | References の CRLF で割れた断片（`X-Inj:` など）がトークンとして保存され、返信の References に出る。注入はされない（コード） | `domain/mail/parse.ts` |

#55 の補足: workerd は実 HTTP のボディ無し POST でも `c.req.raw.body` を null にしないので、`app.ts` の検査が Content-Type 無しの要求を
全部 400 にする。管理画面の `request()` はボディが無いと Content-Type を付けないため、`DomainsPage.tsx:473` と `WebhooksPage.tsx:234` が壊れる。
一般画面の `ui/lib/api.ts` は常に Content-Type を付けるのでログアウトは動くが、API を直接叩く利用者の `POST /auth/logout` などは 400 になる。
vitest と `e2e/harness.ts` は `new Request` でボディが null になるので、テストは素通りする。

#### 次の段

失敗 6 件（#17 / #22 / #23 / #28 / #32 / #39）を対応の手順で直し、再検査を追記する。#55 / #56 は第 2 回の修正が持ち込んだ退行で、
#55 は本番の画面操作を壊しているので同じ段で直す。#57〜#72 は第 3 回の精査に含める。

未確認: Email Routing が `INBOUND_QUEUE.send` の失敗を送信側の再送に変えるか（#24）。998 文字超のヘッダ行を Cloudflare Email Sending が拒否するか（#34 / #66）。

### 対応の分担（第 2 回の再検査失敗）

再検査失敗の 6 件（#17 / #22 / #23 / #28 / #32 / #39）と退行 2 件（#55 / #56）を、**編集するファイルが重ならない** 4 群に分けた。
本文は「再検査失敗の再現（第 2 回）」と「再検査で見つかったもの」の表。#57〜#72 は第 3 回の精査に回すので、ここでは直さない
（同じ根の #57 に気づいても報告に書くだけ）。

| 群 | 名前 | 指摘 | 編集してよいファイル | 前提・注意 |
| --- | --- | --- | --- | --- |
| A | 受信 | #28, #56 | `domain/mail/inbound.ts`、`tests/inbound.test.ts`、新規テスト | #28 は `toCandidates` に `normalizeAddress(envelope.to)` とその基本アドレスを足す（`address.ts` は B が触るので読むだけ）。#56 は R2 の本文読み込み（`arrayBuffer()`）を try の外に出し、パース例外だけを placeholder にする。読み込み失敗は throw してキューに再配達させる。再配達で重複扱いにならないこと（dup 判定より前に行が残らないこと）をテストで示す |
| B | 送信・宛先 | #22, #23, #39 | `shared/contracts/send.ts`、`api/v1/outbound.ts`、`ui/routes/Compose.tsx`、`domain/mail/address.ts`、`tests/{address,parse,send,compose,outbound-*}.test.ts`、新規テスト | #39 は**保存済みの行**（`"x\"y" <bob@x.com>, carol@x.com`）も読めるよう、`parseAddressList` に `\` エスケープの解釈を足すことを優先する（`formatAddress` だけ直しても既存データの返信が 0 件のまま）。`normalizeAddress` の戻り値の意味は変えない。#22 の件数は `parseAddressList` 後の数で数え、`singleLine` に長さの上限を付ける（件名 998 など既存の上限と矛盾させない）。#23 は `baseAddressOf(n) === own` を足し、UI の `looseAddressOf` も `+タグ` を落とす |
| C | 表示 | #17 | `ui/components/MessageHtml.tsx`、`tests/security-headers.test.ts`、新規テスト。依存を足す場合に限り `package.json` / `package-lock.json` | `iframe` / `frame` / `object` / `embed` を要素ごと落とし、除去後の出力を再パースして変化が無くなるまで回す（上限回数を決め、超えたら本文を空にするなど安全側に倒す）。サニタイザを入れるなら MIT / Apache-2.0 / BSD を選べるものだけ。可能なら Chrome headless で 3 つの攻撃（名前空間混乱・`iframe srcdoc`・`iframe src`）が接続 0 になることを確かめる |
| D | API 共通 | #32, #55 | `api/app.ts`（Content-Type 検査のみ）、`api/v1/addresses.ts`、`ui/routes/admin/api.ts`、`ui/lib/api.ts`、`tests/csrf-content-type.test.ts`、`tests/helpers.ts` と `e2e/harness.ts`（#55 の再現に要る場合のみ）、新規テスト | #55 は「実 HTTP のボディ無し POST が通る」と「ボディ付きの `text/plain` フォーム POST は 400 のまま（#50 を戻さない）」の両立。空ボディのフォーム POST（`Content-Length: 0`）で Cookie 付きのボディ無し POST 経路（ログアウト・DNS 確認・Webhook 再送など）が叩けるかを列挙し、許すなら理由を報告に書く。vitest は `new Request` でボディが null になるので、workerd の挙動を再現するテストか `wrangler dev` への実 HTTP で確かめる。#32 は未読集計をバインド変数がアドレス数に比例しない形（サブクエリ / JOIN）にし、`limit` 99 以上・既定値で 500 にならないことを示す |

各群に共通:

- 指摘ごとに元の攻撃を再現するテストを先に書き、直した後に通ることで「直った」を示す。
- **変更した API・関数を呼んでいる UI・スクリプト・テストヘルパも同じ群で直す。** 他群のファイルに及ぶなら編集せず「要依頼」で報告する。
- 終わる前に `npm run verify` を通す。他群のテストを壊さない。
- 直せなかった・判断できなかった指摘は、番号と理由を報告に残す。黙って飛ばさない。
- 報告は 30 行以内: 指摘ごとに「直した（要点）/ 直さなかった（理由）」、触ったファイル、要依頼、verify の結果、worktree のパス・ブランチ・コミット SHA。

### 対応状況（第 2 回の再検査失敗）— 2026-09-12

上の 4 群を並行に直し、群ごとに別の読み手が差分を審査して取り込んだ。差し戻しは 3 件:

- B: #39 の修正で `parseAddressList` が `\` をエスケープとして読むようになったのに、`formatAddress` が `\` をエスケープしていなかった。表示名が `\` で終わると `"a,\" <bob@…>, carol@…` が `[]` になる退行（修正前は 2 件読めた）。
  #23 の `ownFamily` は、メールボックス自身に `+` があると別メールボックス `box@` 宛を自分扱いで落としていた。
- C: `<template shadowrootmode>`（宣言的 Shadow DOM）は `DOMParser` では shadow root にならず中身が見えないのに、srcdoc では live になる（Chrome で接続 1）。
  また Chrome の直列化は `<pre>` 直後の LF を落とすので、先頭に LF が 5 個以上あると収束せず本文が空になった。
- D: #55 を「Content-Type ヘッダが無ければ通す」で直したため、同一サイトの別サブドメインから no-cors fetch で送る Content-Type 無しの Blob ボディが通った。
  `readJson` を通らない 10 経路（送信・返信を含む）で、Cookie 付きの `POST /webhooks` と `/admin/rules` が 201 になった（修正前は 400）。

統合時に本体が足したのは、#28 の複合変装（`"a+x"@EXAMPLE.COM.`）と #56 のスレッド行が残らないことのテストだけ。
`npm run verify` は通る（46 ファイル・494 件）。

| # | 対応 | 残る制約 |
| --- | --- | --- |
| 17 | 除去対象に `iframe` / `frame` / `object` / `embed` / `math` / `svg` / `template` を足し、除去 → 直列化 → 再パースを変化が無くなるまで回す（5 周で収束しなければ本文を空に）。`pre` / `textarea` / `listing` の先頭 LF は直列化前に補って往復を冪等にする。審査役が Chrome 152 で 3 攻撃・宣言的 Shadow DOM・変形 30 種余りの接続 0 を確認 | **ブラウザで実際に走る `DOMParser` の経路に自動テストが無い**（workerd に `DOMParser` が無く、vitest は正規表現の代用経路だけを見る）。インライン SVG のロゴは表示されない。`<plaintext>` を含む本文は常に空 |
| 22 | 件数を `parseAddressList` 後の数で数える（配列の要素内のカンマも数える）。`singleLine` に 10,000 文字の上限 | — |
| 23 | `isSelf` は `n === own` か `baseAddressOf(n) === own`。UI は `ui/lib/looseAddress.ts` の `isSelfAddress` で同じ規則（引用ローカル部・末尾ドットも `normalizeAddress` で揃える） | UI はエイリアスを判定しない（サーバが除く） |
| 28 | address ルールの候補に `normalizeAddress(envelope.to)` を足す（`baseAddressOf` と合わせて引用・末尾ドット・大文字・`+タグ` を畳む） | `resolve.ts` の NFKC・punycode の畳み込みは候補に無い（#73） |
| 32 | 未読集計を `addresses.id` への相関サブクエリにし、バインド変数をアドレス数に比例させない。`limit` の上限は 200 のまま | grant 数に比例する `addressFilter` の `inArray` は #57 のまま |
| 39 | `parseAddressList` が `\` エスケープを解釈し、`formatAddress` は `\` と `"` を両方エスケープする。往復は冪等 | 修正前に保存された「`\` で終わる引用表示名」の行は読めない（救う手段が無い） |
| 55 | Content-Type があれば `application/json` 必須。無ければ `clone()` した body の最初のチャンクを読み、1 バイトでもあれば 400。ボディ無しの POST は通る | ボディ無しの 3 経路（logout・DNS 確認・Webhook 再送）は別サブドメインから no-cors で叩ける（#76）。`readJson` を通らない 10 経路は `app.ts` の検査だけに依存している（#75） |
| 56 | R2 の本文読み込みを try の外に出し、失敗は throw してキューに再配達させる。パース例外だけを placeholder にする | — |

#### 対応中に見つかったもの（第 3 回の番号として先に振る）

| # | 深刻度 | 内容 | 場所 |
| --- | --- | --- | --- |
| 73 | 低 | address ルールの候補に、`resolve.ts` が配送判定で使う NFKC と punycode の畳み込みが無い。catch-all 経由で全角ローカル部や Unicode ドメインのエンベロープが a に配送されても、a の address ルールに当たらない（コード） | `domain/mail/inbound.ts` `applyAddressRules`、`routing/resolve.ts` `canonicalAddress` / `ruleTargets` |
| 74 | 低 | `replyAll: true` で `to` を省略した返信は、受信メールの To / Cc 由来の宛先数に上限が無い（コード） | `api/v1/outbound.ts` reply |
| 75 | 低 | 10 経路が `readJson` を通らず `c.req.json()` / 自前の `readBody` で読むので、Content-Type の検査は `app.ts` のミドルウェアだけに依存する（ミドルウェアが Content-Type 無しを通していた #55 の最初の修正では、Blob ボディで 201。実証済み）。エラーの `details` の形も経路ごとに違う | `api/v1/webhooks.ts:107,152`、`outbound.ts:187,217`、`admin/rules.ts:68,96`、`admin/{addresses,domains}.ts` `readBody` |
| 76 | 低 | ボディ無しの POST（logout・DNS 確認・Webhook 再送）は同じ登録ドメインの別サブドメインから no-cors で Cookie 付きで叩ける。直し方の案は Fetch Metadata: Cookie 認証の変更系に `Sec-Fetch-Site: same-origin`（無ければ `Origin` がホストと一致）を要求し、API キーは対象外にする | `api/app.ts` |

### 再検査（第 2 回の再検査失敗）— 2026-09-12

上の「対応状況」を信用せず、8 件を 2 群（表示と API 共通: #17 / #32 / #55、受信と送信・宛先: #22 / #23 / #28 / #39 / #56）に分け、
対応にも審査にも関わっていない読み手が、`2e4f6bb` を隔離した worktree に取り出して確かめた。実証に使ったのは、一時テスト
（vitest・harness 経由の実 API と実受信経路。終わったら削除）、本物の `processInbound` / `parseRawMime` / `resolveIncoming` の直接呼び出し、
`wrangler dev` 4.127.1 への実 HTTP（curl）、Chrome 152.0.7977.83 headless（実ファイルを esbuild 0.25.4 で束ねた `buildSrcDoc` の出力を、
`_headers` と同じ CSP の親ページの iframe に srcdoc で載せ、攻撃者役の TCP リスナへの接続を数えた。対照の未除去 preconnect・`iframe src`・
Shadow DOM 内の preconnect は接続 1）。`npm run verify` は 2 群とも通る（46 ファイル・494 件。文書の記述と一致）。

**結果: 8 件すべて修正確認。再検査失敗は無い。** 修正の隣に残った欠陥と新たに見つかったものは、第 3 回の番号として #77〜#81 を振った。

| # | 判定 | 根拠 |
| --- | --- | --- |
| 17 | 修正確認（実証済み・Chrome） | 元の 3 攻撃（名前空間混乱・`iframe srcdoc`・`iframe src`）と、宣言的 Shadow DOM（open / closed × iframe / link、table 内、名前空間混乱との入れ子、closed 内の svg/foreignObject）で接続 0。変形 50 種余り（svg/desc・annotation-xml の名前空間混乱、noscript 内、frameset、object / embed / fencedframe / portal、foster parenting、select 内、xmp / title / textarea、コメントと CDATA の崩し、EOF-in-tag、NUL 入りタグ名、`</body>` 後の link、preload / modulepreload、@import / video / input image）もすべて 0。ニュースレター風の HTML、`pre` / `textarea` / `listing` の先頭 LF 1〜12 個・CRLF は本文が残り、LF は元の数 −1（HTML 仕様どおり。Chrome 固有ではない）で収束。インライン SVG が消えるのは記載どおり |
| 22 | 修正確認（実証済み） | send キーで `to:[200 件のカンマ詰め]` → 400。to 40 + cc 40 + bcc `[21 件詰め]` = 101 → 400、100 → 202 で `EMAIL.send` はちょうど 100 回。reply の `to:[60 件詰め]` + cc 41 → 400。`singleLine` は 10,000 文字で通り 10,001 で 400。閉じない `"` や `<` で 150 件を 1 要素に飲ませると数えた件数は 0 になるが、下流（`addressListToCsv` / `parseMailboxes` / `collectRecipients`）も同じ `parseAddressList` を通るので実送信も 0（0 件で 202 になるのは #80） |
| 23 | 修正確認（実証済み） | 実受信経路で `box@` 宛に `To: box+news@, 第三者` / `Cc: box+promo@` を配送し、全員に返信の実送信は `[送信者, 第三者]` だけ。既存行を想定した `Box+News@…`、`"box+promo"@`、`box.@`、エイリアス `news@` と `news+x@` もすべて除外。メールボックスが `box+a@` のとき `box@` / `box+b@` は残る。UI の `isSelfAddress` も同じ規則。UI の既定 Cc は #78 |
| 28 | 修正確認（実証済み） | catch-all のあるドメインで envelope `"a"@`、`a.@`、`"a+x"@EXAMPLE.COM.`、`A+Y@Example.Com` を `resolveIncoming` → a に deliver（catch-all に落ちない）。同じ envelope を harness から配送すると a の `{to:"a@example.com"}` の drop と mark(star) の両方に当たる |
| 32 | 修正確認（実証済み） | アドレス 150 件の owner で `GET /api/v1/addresses` 既定 → 200・100 件と `next_cursor`、2 ページ目 50 件。`limit=99/100/120/150/200` → 200、`201` → 400。未読数は未読・既読・trash を正しく数え分ける。`/me` も 150 件で 200。サイドバーが 1 ページしか読まないのは #81 |
| 39 | 修正確認（実証済み） | `To: "x\"y" <bob@x.com>, carol@x.com` と encoded-word 版を `parseRawMime` → 保存 → `parseAddressList` で 2 件・表示名 `x"y`。実受信から全員に返信で bob / carol / 送信者の 3 通。表示名 12 種（`a\`、`a\\`、`"`、`\"`、`Doe, John`、`a, \`、`a\"b\`、`x@y` ほか）で format → parse → format が同一。引用内カンマ・山括弧・空要素の既存挙動も変わらない |
| 55 | 修正確認（実証済み・wrangler dev） | 実 HTTP でボディ無し・Content-Type 無しの POST は logout 200、DNS 確認・Webhook 再送は 404（ハンドラ到達。`Content-Length: 0` でも同じ）。Content-Type 無しのボディ付き（`--data`、chunked、1 バイト）→ 400。text/plain・urlencoded・multipart はボディ付きも空ボディも 400。`text/json`・`application/x-json`・空値 → 400、`Application/JSON ; charset=utf-8` → 201。添付 2 件 1.2MB の送信は 202（chunked でも）。vitest でも Cookie + Content-Type 無しの Blob で `/messages`・`/webhooks`・`/admin/rules`・`/admin/domains/preview`・`/admin/addresses`・`PATCH /me` が 400、作成物 0 件。JSON の要求は clone を通らない |
| 56 | 修正確認（実証済み） | コンシューマ経由で `arrayBuffer()` を reject させると `retry()` 1 回、messages / threads とも 0 行。同じ payload の再配達で本文が取り込まれる。R2 の get が null なら throw（`max_retries` 3 の後に DLQ）。postal-mime の入れ子例外は従来どおり placeholder で ack。書き込み側の同じ形は #77 |

#### 再検査で見つかったもの（第 3 回の番号として先に振る）

| # | 深刻度 | 内容 | 場所 |
| --- | --- | --- | --- |
| 77 | **中** | messages 行を insert した後の一時失敗（添付の R2 put・attachments insert・`updateThreadStats`・`applyAddressRules`・`dispatchMessageEvent`）は throw して再配達されるが、再配達は `rawR2Key` の重複判定で捨てられ、続きが永久に実行されない。添付付きメールで `att/` キーの `BUCKET.put` を 1 回だけ失敗させると、`hasAttachments=true` のまま attachments 0 件で固まる（実証済み）。`applyAddressRules` なら drop ルールが二度と当たらず、`dispatchMessageEvent` なら Webhook が出ない（コード）。#56 と同じ形の書き込み側 | `domain/mail/inbound.ts` `processInbound` |
| 78 | 低 | 全員に返信の UI は、既定の Cc を `isSelfAddress` で濾していない。`Cc: box+promo@` は Cc 欄に見えたまま送られ、サーバの `dedupeRecipients` が除くので実送信には入らない。画面とサーバの結果が食い違う（UI はコード、サーバ側は実証済み） | `ui/routes/Compose.tsx` `setReplyCc` |
| 79 | 低 | `to` / `cc` / `bcc` の配列の要素数に上限が無い。`bodyLimit` の 40MB まで詰められ、`safeParse` に 50 万要素で 406ms かかる（最後は宛先 100 件の上限で 400。実証済み）。`z.array(...).max(100)` で済む | `shared/contracts/send.ts` `addressList` |
| 80 | 低 | 送信 API は、実際に使える宛先が 0 件でも 202 を返し、ジョブが「送信先が指定されていません」で `failed` になる（閉じない引用 `"open <a@x.jp>` など。実証済み）。#66 の reply 版と同じ形 | `shared/contracts/send.ts` `recipientCount`、`api/v1/outbound.ts` |
| 81 | 低 | サイドバーの `AddressesApi.list()` は `/addresses` を 1 回しか呼ばず `next_cursor` を追わないので、見えるアドレスが 101 件以上だと 101 件目以降が出ない（API 側は実証済み、UI はコード）。第 2 回の対応状況に書いた「1 ページしか読まない」制約に番号を振ったもの。#65 と同種 | `ui/lib/api.ts` `AddressesApi.list`、`ui/routes/AppLayout.tsx` |

#### 次の段

第 2 回の指摘（#10、#16〜#54）と、その再検査で失敗した分はすべて修正確認になった。次の「進めて」は第 3 回の全精査で、
先に番号を振った #57〜#81 を含める。中の #57〜#60 と #77 から直す。

デプロイ時に要る作業はこの段では増えていない（スキーマ変更・新しいキュー・シークレットは無い）。

## 第 3 回全精査 — 2026-09-12

観点 S-1〜S-11 を 4 群に分け、各群を別の読み手が担当した。第 1 回・第 2 回で指摘済みのものは再掲せず、
先に番号を振った #57〜#81 もそのまま引き継ぐ。新規の番号は #82 から通しで振った。

| 群 | 観点 | 新規指摘 |
| --- | --- | --- |
| 1 | S-1 認証 / S-2 認可 / S-8 シークレット・ログ・監査 | #82〜#88 |
| 2 | S-3 受信メール / S-4 表示と配信 | #89〜#92 |
| 3 | S-5 送信 / S-6 検索とクエリ生成 | #93〜#101 |
| 4 | S-7 外部連携 / S-9 可用性 / S-10 サプライチェーン / S-11 検証の仕組み | #102〜#112 |

実証に使ったのは、一時テスト（vitest・`createApp()` と e2e harness 経由の実 API・実受信経路。終わったら削除）、
`tsx` から本物の関数を直接呼んだもの（`parseAddressList` / `formatAddressList` / `normalizeAddress` /
`resolveIncoming` / `processInbound` / `composeMime`）、`node` からの `node_modules` 直叩き
（mimetext 3.0.28 の node / browser ビルド、hono 4.13.7 の Cookie パーサ）、fake Cloudflare API、
ローカル sqlite（FTS5）、`npm audit`、drizzle-kit。`npm run verify` は通る（46 ファイル・494 件。文書の記述と一致）。

**本体（審査役）の検証**: 各群の報告を信用せず、#82〜#92 と #93 / #96 / #102 / #105 / #106 は本体が自分で
コードを読み、または実際に走らせて成立を確かめた。以下の「実証済み」はその確認を経たもの。

### まとめ（第 3 回）

| # | 深刻度 | 内容 | 場所 |
| --- | --- | --- | --- |
| 82 | **高** | 引用ローカル部のカンマが保存時に裸になり、返信の宛先に攻撃者のアドレスが湧く（実証済み） | `domain/mail/address.ts` `normalizeAddress` / `formatAddress` |
| 83 | **中** | `expiresAt` が Date の範囲を超えると Invalid Date → 無期限キーになり、clamp も `NaN` 比較で素通り（#25 の門を回避。実証済み） | `api/v1/me.ts` `clampExpiresAt`、`contracts/api-keys.ts` |
| 84 | **中** | セッション Cookie に `__Host-` が無く、同名 Cookie の先頭勝ちでセッション固定。logout で消せない（サーバ側は実証済み） | `api/v1/auth.ts` `sessionCookieOptions`、`lib/tokens.ts` `SESSION_COOKIE` |
| 85 | **中** | catch-all はゾーン単位なのに `catchAllEnabled` はドメイン単位。別ドメインの無効化・切断が有効な catch-all を confirm 無しで落とす（実証済み） | `domain/domains/provision.ts` `setCatchAll`、`cleanup.ts` `cleanupDomain` |
| 86 | **中** | Webhook のキュー再試行が同じ `attempt` をやり直すので受け手への POST が最大 4 倍。`pending` 固着で手動再送も永久に 409。outbound に DLQ が無い（実証済み） | `services/webhooks.ts` `runDelivery`、`services/consumer.ts`、`wrangler.jsonc` |
| 87 | **中** | 送信する生 MIME が全 bare LF で CRLF が 1 つも無い。DKIM と Bcc 防御の前提が外れる（実証済み） | `domain/mail/compose.ts` `composeMime`（`mimetext` の node エントリ） |
| 88 | **中** | `?q=` の語数に上限が無く、read スコープ 1 本で検索 API が 500（実証済み） | `domain/search/sql.ts` `freeWordCondition` / `relevanceScore` |
| 89 | **中** | 送信本文の上限がコード単位なので、日本語 2MB 超で D1 の行上限に当たり 400 でなく 500（#22 の残りが想定より悪い。実証済み） | `shared/contracts/send.ts` `MAX_BODY_BYTES` |
| 90 | **中** | 添付の R2 put 失敗で `queued` の行だけが残り、キューに積まれず永久に送られも失敗もしない（#77 の送信側。実証済み） | `api/v1/outbound.ts` `enqueueOutbound` / `storeAttachments` |
| 91 | **中** | `messages` の insert 前に `createThread` するので、insert の一時失敗ごとに空スレッド（未読 1）が残り再配達で増える（実証済み） | `domain/mail/inbound.ts` `processInbound` |
| 92 | **中** | `drop` ルールが `status=trash` を立てるだけで、スレッド一覧・詳細が status を見ないため受信箱に未読 1 で残り本文も読める（実証済み） | `domain/mail/inbound.ts` `applyAddressRules`、`domain/search/sql.ts` `queryThreads` |
| 93 | **中** | `POST /admin/domains` の `localParts` 50 件で CF API を 1,057 回叩き、アカウントのレート枠をほぼ使い切る（実証済み） | `domain/domains/provision.ts` `provisionDomain` |
| 94 | 中 | `CF_ACCOUNT_ID` をどのコードも読まない（#41 と同じ形）。`GET /zones` をアカウントで絞らないので他アカウントのゾーンを接続しうる | `services/cloudflare-api.ts` `listZones`、`domain/domains/provision.ts` `resolveZone` |
| 95 | 中 | owner の管理操作のうち webhooks / rules / domains / addresses が一切監査されない。DNS を消す操作の記録が無い | `api/v1/webhooks.ts`、`admin/{rules,domains,addresses}.ts` |
| 96 | 低 | `package.json` の `allowScripts` が効いていない（`@lavamoat/allow-scripts` 不在）。門に見えて門でない（実証済み） | `package.json` `allowScripts` |
| 97 | 低 | Cloudflare API 呼び出しにタイムアウト・`AbortSignal` が無い（実証済み） | `services/cloudflare-api.ts` `#request` |
| 98 | 低 | owner の PATCH でのパスワード再設定が監査上 `meta: {}` になり no-op と区別できない。`mustChangePassword` も立たない（実証済み） | `api/v1/admin/users.ts` PATCH |
| 99 | 低 | パスワード変更でセッションは落ちるが API キーは失効しない（実証済み） | `api/v1/me.ts` PATCH |
| 100 | 低 | `addressIds` の個数に上限が無く、5000 件のキーを自分で作ると以後全リクエストが 500（#57 と同根だが grants も owner 権限も不要。実証済み） | `contracts/api-keys.ts`、`policy.ts` `addressFilter` |
| 101 | 低 | アーカイブ済みメールボックスは直接宛だと reject なのに、そこを指すエイリアス宛だと配送される（実証済み） | `domain/routing/resolve.ts` `resolveIncoming` |
| 102 | 低 | R2 から添付が消えていると空 0 バイトの添付を黙って送り `sent` にする（実証済み） | `domain/mail/outbound.ts` `processOutboundSend` |
| 103 | 低 | 非 ASCII 本文を `Content-Transfer-Encoding: 7bit` と宣言して送る（実証済み） | `domain/mail/compose.ts` `composeMime` |
| 104 | 低 | 本文は無加工で MIME に入るので boundary を当てられればパート注入ができる。boundary は `Math.random()` 由来（機構は実証済み・悪用は未実証） | `mimetext` `generateBoundaries` 経由の `composeMime` |
| 105 | 低 | `displayName` に改行を書き込める（PATCH が 200）。注入は mimetext の base64 化 1 枚で止まっている | `shared/contracts/addresses.ts` `displayName` |
| 106 | 低 | 送信のレート制限が無い。1 リクエスト 100 宛先の上限はあるがリクエスト数の上限が無い | `api/v1/outbound.ts`、`wrangler.jsonc` |
| 107 | 低 | シークレットのローテーション・失効手順が文書に無い。bootstrap 後に `INTERNAL_SECRET` を消す指示も無い | `docs/ops/deployment.md` §3・§8 |
| 108 | 低 | #45 / #46 / キューの DLQ 設定に回帰テストが無い。`@v4` に戻しても `dead_letter_queue` を消しても緑のまま | `.github/workflows/*.yml`、`scripts/deploy.sh`、`wrangler.jsonc` |
| 109 | 低 | fr07（ルーティングルール）の e2e に否定ケースが 1 つも無い。fr07 / fr08 は 403 期待が 0 件 | `e2e/specs/fr07-ルーティングルール.e2e.test.ts` |
| 110 | 低 | CI に `npm audit` の門が無い。実行時依存の High CVE が入っても緑 | `.github/workflows/ci.yml` |
| 111 | 低 | #70 の残り。`_journal.json` のタグ 3 件が実ファイル名と一致せず、`db:generate` は永久に 2 番ずれる（実証済み） | `migrations/meta/_journal.json` |
| 112 | 低 | `migrations/0004` の `'rebuild'` がバッチ無しの全件再構築。デプロイ前に `--remote` で流すので行数が増えると止まる | `migrations/0004_fts_delete_triggers.sql`、`scripts/deploy.sh` |

### 直す順番（第 3 回）

1. **#82**（引用ローカル部のカンマ）— 匿名の送信者がメール 1 通で、返信の宛先に自分のアドレスを増やせる。
   返信には元の会話の引用が必ず付き、自ドメインの DKIM 署名で届く。#39 の再検査が表示名しか見ていなかった隙。
2. **#83 / #84**（キーとセッションの持続）— #25 が塞いだ「漏れたキーで持続性を得る」経路が 1 パラメータで開く。
   #84 は #50 / #76 で既に認めた「別サブドメイン」の攻撃者から成立する。
3. **#85 / #93 / #94**（Cloudflare 操作の巻き添え）— #18 / #60 と同じ「取り返しがつかない」系。
   #85 は有効な catch-all を確認無しで落とし、画面は「有効」と表示し続ける。
4. **#87 / #89 / #90**（送信の土台）— #87 は規格違反で DKIM と #2 の Bcc 防御の前提に触る。
   #89 / #90 は通常運用の日本語メールと添付で起きる。
5. **#86 / #88 / #91 / #92**（可用性と、設定どおりに動かないもの）— #92 は「捨てる」設定が何も捨てていない。
6. **#57〜#81** と残り。#100 は #57 と同根なので `addressFilter` の直しに合わせる。

### 対応の分担（第 3 回）

#57〜#81（前回までに番号を振った 25 件）と #82〜#112（今回の 31 件）のうち、**上の「直す順番」の 1〜5 に当たる
#82〜#94 と、同根でまとめて直せる #100 / #101 / #105** を先に片付ける。残り（#57〜#81 の大半と #95〜#112）は次の段に回す。

**編集するファイルが重ならない** 5 群に分けた。1 群を 1 エージェントに渡し、別々の worktree で並行に直す。
`docs/spec/security-audit.md` 自体は各群では編集せず、取り込み時に統合担当が「対応状況」を書く。

| 群 | 名前 | 指摘 | 編集してよいファイル | 前提・注意 |
| --- | --- | --- | --- | --- |
| A | アドレスの往復 | #82, #101, #105 | `domain/mail/address.ts`、`domain/routing/resolve.ts`、`shared/contracts/addresses.ts`、`ui/routes/Compose.tsx`、`ui/lib/looseAddress.ts`、`tests/{address,parse,routing-*,resolve*}.test.ts`、新規テスト | #82 は**カンマだけが冪等性を壊す**（`;` は `parseAddressList` が区切らないので無害。本体が確認済み）。直しはカンマに限定し、`normalizeAddress` でローカル部にカンマを含むアドレスを捨てる案を優先（保存済みの行も安全側になる）。`normalizeAddress` の戻り値の意味は変えない。`Compose.tsx` の `splitAddressCsv` は素の `.split(",")` なので `parseAddressList` に置き換える。placeholder 経路（`parseErrorPlaceholder` / `oversizedPlaceholder`）の `from` / `to` も通す。#101 はエイリアス分岐で `aliasTargetId` の行の `archivedAt` を見る。#105 は `displayName` を `singleLine` 相当にし、`compose.ts` は触らず（B の担当）報告に回す |
| B | 送信の土台 | #87, #89, #90, #103 | `domain/mail/compose.ts`、`domain/mail/outbound.ts`、`shared/contracts/send.ts`、`api/v1/outbound.ts`、`tests/{compose,send,outbound-*}.test.ts`、新規テスト | #87 は `mimetext/browser` に替える（browser ビルドの `eol` は `"\r\n"` 固定。本体が両ビルドを確認済み）。`js-base64` 依存が増えるがライセンスは要確認（MIT なら可）。CRLF であることをテストで固定し、`stripHeader`（`services/sender.ts` は E の担当なので読むだけ）が CRLF でも効くことを確かめる。#103 は `addMessage` に `encoding: "base64"` を渡す（#104 も同時に塞がる）。#89 は `TextEncoder` のバイト数で検査し、`text + html + 件名` の合計も D1 の行上限の手前に置く。#90 は R2 put とキュー投入の失敗時に `failed` へ落とす |
| C | 認証・キー・監査 | #83, #98, #99, #100 | `api/v1/me.ts`、`api/v1/admin/{users,api-keys}.ts`、`shared/contracts/api-keys.ts`、`lib/paging.ts`、`domain/access/policy.ts`（`addressFilter` のみ）、`tests/{auth-*,policy-*,scope-*,paging*}.test.ts`、新規テスト | #83 は `expiresAt` に上限（`8_640_000_000` 程度）を付け、`clampExpiresAt` と両方の POST で `Number.isFinite(date.getTime())` を検査して Invalid Date は 400。`lib/paging.ts` の `decode` も同じ形（範囲外 cursor が 400 でなく空ページになる）なので一緒に直す。#100 は `addressIds` に `.max(100)`（#44 と揃える）と実在検査。`addressFilter` を JOIN / サブクエリにする根治は **#57 と同根なので、この群でやるなら #57 も一緒に直して報告に明記**する（触らない判断も可。その場合は理由を書く） |
| D | Cloudflare 操作 | #85, #93, #94 | `domain/domains/{provision,cleanup,dns-check}.ts`、`services/cloudflare-api.ts`、`api/v1/admin/domains.ts`、`shared/contracts/domains.ts`、`tests/domains-*.test.ts`、新規テスト | #85 は catch-all の操作前に同じ `zoneId` の他ドメインの `catchAllEnabled` を数え、残るなら無効化を 409。**無効化にも `confirm` を要求する**。#93 はルール一覧を 1 回だけ取って `Map` で引く。#94 は `listZones` の query に `"account.id"` を付け `resolveZone` でも照合する（使わないなら #41 と同じく型・docs から消すが、**消す判断は本体に報告してから**）。#97 の `AbortSignal.timeout` も同じファイルなのでここで直してよい |
| E | 受信の取りこぼし | #91, #92, #86 | `domain/mail/inbound.ts`、`domain/search/sql.ts`、`services/webhooks.ts`、`services/consumer.ts`、`wrangler.jsonc`（outbound の DLQ のみ）、`tests/{inbound,search-*,webhook-*}.test.ts`、新規テスト | #91 はスレッド作成とメッセージ挿入を 1 つの `batch` に（送信側は #22 で既にそうしている）。#92 は `queryThreads` / `queryThreadMessages` に既定で `status != 'trash'` を入れ、ゴミ箱画面用に明示指定で外せるようにする。**`Inbox.tsx` / `ThreadDetail.tsx` を変える必要が出たら編集せず報告**（UI は A の担当）。`drop` のとき `adjustThreadUnread(-1)` も掛ける。#86 は `runDelivery` の副作用に `deliveryId` + `attempt` の claim を持たせ、`tsubame-outbound` にも DLQ を足す（`deployment.md` は F 以降の担当なので手順は報告に書く） |

各群に共通:

- 攻撃の再現をテストに落とす。「直った」の根拠は元の攻撃が失敗するテスト。
- **変更した API・関数を呼んでいる UI・スクリプト・テストヘルパも同じ群で直す。** 他群のファイルに及ぶなら編集せず「要依頼」で報告する。
- 終わる前に `npm run verify` を通す。他群のテストを壊さない。
- 直せなかった・判断できなかった指摘は、番号と理由を報告に残す。黙って飛ばさない。
- 報告は 30 行以内: 指摘番号ごとに「直した / 直さなかった（理由）」、触ったファイル、要依頼、verify の結果、ブランチとコミット SHA。

### 対応状況（第 3 回）— 2026-09-12

分担表の 5 群を並行に直した。実装は `pi`（ollama-cloud / deepseek-v4-flash）に 1 群 1 セッションで任せ、
審査と統合は本体（Opus）が行った。差し戻しは 0 件。`npm run verify` は通る（51 ファイル・541 件。
精査前は 46 ファイル・494 件なので 47 件増）。

**審査で確かめたこと**（各群の報告を信用せず、本体が自分で走らせたもの）:

- **#82**: 攻撃入力 `"box,leak@evil.jp,zz"@example.com, box@example.com` を本物の
  `parseAddressList` / `formatAddressList` に通し、`leak@evil.jp` が湧かず往復が冪等になったことを確認。
  対照の `"Doe, John" <bob@x.com>`（2 件のまま）、`"a;b"@x.jp`、#29 の `"victim"@` / `victim.@`
  （どちらも `victim@` に正規化される）が壊れていないことも確認した。
- **#87**: 実際に `composeMime` を呼び、CRLF > 0・bare LF == 0 を assert。`mimetext/browser` が
  引く `js-base64` は BSD-3-Clause（規約の MIT / Apache-2.0 / BSD に適合）で、依存の追加は無い
  （既に推移的に入っている）。`stripHeader` は `\r?\n` で書かれており CRLF でも #2 の Bcc 防御が効く。
  D1 に保存するのは生本文で、base64 化は MIME 組み立て時だけなので #89 の行サイズ上限と干渉しない。
- **#89**: 精査で 500 になった 3MB の日本語本文が 400 で弾かれ、ASCII 1MB は通ることを確認。
- **#92**: 「全メッセージがゴミ箱のスレッドだけ隠す」`exists` 条件なので、1 通だけ消したスレッドは残る。
  `includeTrash` で参照できる。**サイドバーの「ゴミ箱」は元から `Inbox.tsx` が `view` を読んでおらず
  機能していない**ので、この変更が壊したものではない（#113 として記録）。
- **#94**: `listZones` に `account.id` を付けた結果、`CF_ACCOUNT_ID` 未設定だと `listZones` が
  `ApiError` で失敗する。`deployment.md` §3 が元から必須として投入を指示しているので、
  「使っていないシークレット」を使う側に倒した意図どおりの変更と判断した。
- **群 D が共有テストヘルパ `tests/domains-helpers.ts` を触った**が、既存 fixture に `account` を
  spread で足す後方互換の変更で、依存する 7 ファイルは通る。担当外の `addresses-api.test.ts` も緑。

**統合時に本体が直したもの**: `docs/ops/deployment.md` の Queues の節に
`wrangler queue create tsubame-outbound-dlq` を追記した（群 E が `wrangler.jsonc` に
`dead_letter_queue` を足したので、**作らないとデプロイが失敗する**）。

| # | 対応 | 残る制約 |
| --- | --- | --- |
| 82 | `normalizeAddress` がローカル部にカンマを含むアドレスを捨てる。`Compose.tsx` の `splitAddressCsv` は `parseAddressList` + `formatAddress` に置き換え | カンマのみを対象（`;` は `parseAddressList` の区切りではないので無害）。修正前に保存された裸カンマの行は読み直しで分かれたまま |
| 83 | `expiresAt` に `.max(8_640_000_000)`、`clampExpiresAt` に `Number.isFinite` の検査（zod と二重）。`lib/paging.ts` の `decode` も範囲外の cursor を 400 にする | — |
| 85 | catch-all の変更は有効化・無効化とも `confirm: true` が必須。切断時は `assertZoneCatchAllSafe` が同じゾーンの他接続を見る | — |
| 86 | `delivery.attempt` を claim に使い、再配達では受け手に再 POST せず次試行の投入だけやり直す。`tsubame-outbound` に DLQ | **`wrangler queue create tsubame-outbound-dlq` がデプロイ時に要る**（deployment.md に追記済み） |
| 87 | `mimetext/browser`（`eol` が `"\r\n"` 固定）に切り替え。CRLF をテストで固定 | Cloudflare Email Sending が bare LF をどう扱っていたかは未確認のまま（直したので実害は消えたが、従来の送信が中継でどう見えていたかは不明） |
| 89 | `text` / `html` を `TextEncoder` のバイト数で検査し、`text + html + 件名` の合計 1.5MB を D1 の 2MB 上限の手前に置く | 従来 202 だった 1MB〜1.5MB 超の多バイト本文は 400 になる（D1 の制約上、通していたほうが誤り） |
| 90 | 添付の R2 put とキュー投入を try で包み、失敗時に `messages` と `outbound_jobs` を `failed` に落とす | batch は確定済みなので行自体は残る（`failed` として見える） |
| 91 | スレッド作成とメッセージ挿入を同じ `batch` に入れた | — |
| 92 | `queryThreads` / `queryThreadMessages` / `getThread` に `includeTrash`（既定 false）。全件ゴミ箱のスレッドを一覧から除き、`drop` で未読も減らす | ゴミ箱を見る画面が無いので、`includeTrash` を使う呼び出し元はまだ無い（#113） |
| 93 | ルーティングルール一覧を 1 回だけ取って `Map` で引く | `verifyDomain` / `previewDomain` のページ上限（最大 41 往復）はそのまま |
| 94 | `listZones` の query に `account.id` を付け、`resolveZone` でも `zone.account?.id` を照合 | `CF_ACCOUNT_ID` 未設定の環境ではドメイン接続が動かなくなる（元から必須と文書化されている） |
| 97 | `#request` に `AbortSignal.timeout(10s)`、ページループ全体に 30 秒の予算 | — |
| 98 | 監査 `meta` に `passwordChanged`（値は入れない）。owner が password を設定すると `mustChangePassword: true` | owner が admin 経路で自分のパスワードを変えると自分にも強制変更が付く（`PATCH /me` で解除できる） |
| 99 | パスワード変更（`PATCH /me` と `admin/users.ts` の両方）で、その利用者の未失効 API キーを全部失効させる | **UI に告知が無い**。プロフィール画面はパスワード変更でキーが失効することを伝えない（#114） |
| 100 | `addressIds` に `.max(100)` と `assertAddressesExist` の実在検査 | `addressFilter` の `inArray` は手を付けていない（#57 のまま。grant 数に比例するバインドは残る） |
| 101 | エイリアス分岐でエイリアス先の `archivedAt` を見る。届く先が無ければ catch-all、それも無ければ bounce を返さず drop | — |
| 103 | `addMessage` に `encoding: "base64"` を渡し、本文を自前で base64 化して宣言と実体を揃える | — |
| 104 | #103 の base64 化で本文に `--<boundary>` を書けなくなり、同時に塞がった | boundary が `Math.random()` 由来であることは変わっていない（添付のパートは base64 なので注入経路は残らない） |
| 105 | `displayName` を `/^[^\r\n\0]*$/` にした（作成・更新とも） | `compose.ts` の `fromName` への `assertNoLineBreak` は入れていない（防御は zod 側に寄せた） |

#### 対応中に見つかったもの（次の段の番号として先に振る）

| # | 深刻度 | 内容 | 場所 |
| --- | --- | --- | --- |
| 113 | 低 | サイドバーに「ゴミ箱」があるのに `Inbox.tsx` が `view` パラメータを読まず、受信箱と同じ一覧を出す。スター付き・送信済みも同様（第 3 回の対応前から。#92 の `includeTrash` を使う呼び出し元がまだ無い） | `ui/routes/Inbox.tsx`、`ui/routes/AppLayout.tsx` `VIEWS` |
| 114 | 低 | #99 でパスワード変更時に API キーを失効させたが、UI がそれを告知しない。利用者はキーが黙って死んだように見える | `ui/routes/ChangePassword.tsx`、`ui/components/MyApiKeys.tsx` |

#### 次の段

第 3 回で先に直した 16 件（#82〜#94 と #100 / #101 / #103 / #104 / #105）は対応済み。次の「進めて」は
**この 16 件の再検査**（SKILL.md §3）で、対応にも審査にも関わっていない読み手に確かめさせる。
残りの #57〜#81 と #95〜#99 / #102 / #106〜#112、新しい #113 / #114 はその次の対応に回す。

デプロイ時に要る作業: **`wrangler queue create tsubame-outbound-dlq`**（#86）。
スキーマ変更と新しいシークレットは無い。

### 82.【高】引用ローカル部のカンマで返信の宛先が増える

`src/domain/mail/address.ts`。`normalizeAddress` は引用ローカル部の `"` を剥がすが（#29 の修正）中のカンマは残す。
`formatAddress` の `needsQuote` は**表示名だけ**を見るのでアドレス側のカンマは裸のまま `to_addr` に入る。
保存形式がカンマ区切りなので、`parseAddressList` が読み直すと別のアドレスに割れる。往復が冪等でない。
#39 と同じ形だが、#39 の再検査は表示名 12 種しか見ておらずローカル部を見ていなかった。

**実証**（本体が `tsx` から本物の関数を直接呼んで確認）。
`To: "box,leak@evil.jp,zz"@example.com, box@example.com` を `box@example.com` に配送すると:

```
保存される to_addr : box,leak@evil.jp,zz@example.com, box@example.com
読み直し           : ["leak@evil.jp", "zz@example.com", "box@example.com"]   ← leak@evil.jp が湧く
全員に返信の宛先   : ["attacker@evil.jp", "leak@evil.jp", "zz@example.com"]
```

対照として `"Doe, John" <bob@x.com>, carol@x.com` は 2 件のまま壊れない。`;` も無害（区切り文字ではない）。
`sender.ts` の `parseMailboxes` → `collectRecipients` も同じ `parseAddressList` を通るので、`leak@evil.jp` は
**実エンベロープ宛先**になる。`buildReplyQuote` が元の会話の引用を必ず付けるので、
「全員に返信」を 1 回押すと引用ごと自ドメインの DKIM 署名付きで攻撃者に届く。UI 側はさらに悪く、
`Compose.tsx` の `splitAddressCsv` が素の `.split(",")` なので `leak@evil.jp` が正規の宛先の 1 つとして表示される。
placeholder 経路（解析不能メール）は envelope の値を無加工で保存するので同じ穴がある。

**直し方**: `normalizeAddress` でローカル部にカンマを含むアドレスを捨てる（単純で、保存済みの行も安全側になる）。
`Compose.tsx` の `splitAddressCsv` を `parseAddressList` + `formatAddress` に置き換える。
placeholder の `from` / `to` も `normalizeAddress` / `formatAddressList` に通す。

### 83.【中】`expiresAt` のオーバーフローで無期限キーができる

`src/api/v1/me.ts` `clampExpiresAt` と POST `/me/api-keys`、`admin/api-keys.ts` POST（どちらも `new Date(sec * 1000)`）。
`contracts/api-keys.ts` の `expiresAt` は `z.number().int().positive()` で**上限が無い**。

**実証**（本体が確認）。JS の Date は ±8.64e15 ms までなので、`expiresAt: 8_640_000_000_001`（境界 +1 秒）は
`Invalid Date` になり `getTime()` が `NaN`。drizzle の timestamp モードは NaN を書き、
`middleware/auth.ts` の `if (key.expiresAt && key.expiresAt.getTime() <= now)` は NULL / NaN を「無期限」と読む。
つまり**期限を指定したのに無期限のキー**ができる。境界 `8_640_000_000_000` までは正しく保存される。

さらに clamp を回避できる。1 時間で切れる admin スコープの親キーから同じ値で子キーを作ると、
`clampExpiresAt` の `requested.getTime() > parentExpiresAt.getTime()` が `NaN > x` = **false** になり
Invalid Date がそのまま返る。親を期限切れにしても子は生き続ける。`expiresAt` を省略した素直な要求は
親の期限に clamp される（#25 の修正は効いている）ので、**#25 が塞いだ「漏れたキーで持続性を得る」経路が
この 1 パラメータで開く**。

**直し方**: `expiresAt` に上限を付ける（`.max(8_640_000_000)` ≒ 西暦 2243 年）。あわせて `clampExpiresAt` と
両方の POST で `Number.isFinite(date.getTime())` を検査し Invalid Date は 400 にする。
`lib/paging.ts` の `decode` も同じ形で、範囲外の cursor が 400 でなく空ページになる（一緒に直す）。

### 84.【中】セッション Cookie の重複でセッション固定ができる

`src/api/v1/auth.ts` `sessionCookieOptions`（`httpOnly` / `secure` / `SameSite=Lax` / `path=/`、**`Domain` 無し**）、
`src/lib/tokens.ts` の `SESSION_COOKIE = "tsb_session"`（**`__Host-` 接頭辞が無い**）。

**実証**（サーバ側は本体が確認）。hono 4.13.7 の Cookie パーサは同名 Cookie の**先頭勝ち**
（`tsb_session=AAA; tsb_session=BBB` → `AAA`、逆順なら `BBB`）。

このアプリの脅威モデルは #50 / #76 で「同じ登録ドメインの別サブドメイン」を攻撃者として既に認めている。
その立場からは `Set-Cookie: tsb_session=<攻撃者のセッション>; Domain=.example.com; Path=/api` を撃てる。
RFC 6265 §5.4 は Cookie ヘッダをパスの長い順に並べるので、`Path=/api` の Cookie が常に先頭に来て
`/api/**` の全リクエストで採用される。結果は (1) 被害者が攻撃者のアカウントで操作する（セッション固定）、
(2) logout の `Set-Cookie` は `Domain` 無しなのでホスト限定 Cookie しか消せず、**被害者が自力で復帰できない**。

ブラウザでの並び順は RFC と Chrome の実装に基づく記述で、**ブラウザでの実測はしていない**
（サーバが先頭を採る点だけが実証済み）。

**直し方**: Cookie 名を `__Host-tsb_session` にする（`Secure` + `Path=/` + `Domain` 無しが強制され、
サブドメインからは書けない）。あわせて `Cookie` ヘッダに `tsb_session` が 2 つ以上あれば 401 にする。

### 85.【中】catch-all の粒度がゾーンとドメインで食い違う

`src/domain/domains/provision.ts` `setCatchAll`、`cleanup.ts` `cleanupDomain`、`api/v1/admin/domains.ts`。
叩く `PUT /zones/:z/email/routing/rules/catch_all` は**ゾーンに 1 本**しかないのに、
`domains.catchAllEnabled` は**ドメイン行ごと**に持つ。

**実証**（fake Cloudflare API）。同じゾーン `example.com` に `mail.example.com`(A) と `send.example.com`(B) を接続し、
A で catch-all を有効化 → 有効になる。続けて B に `enabled: false` を送ると（`catchAllInput.confirm` は
**有効化時のみ必須**なので確認を求められない）ゾーンの catch-all が落ち、**A の DB は `catchAllEnabled: true` のまま**。
B を `DELETE ?cleanup=true` しても同じ（`cleanupDomain` が `target.catchAllEnabled` で無効化する）。

結果、A の受け皿宛メールが黙って届かなくなり、画面は「有効」と表示し続ける。
`DELETE` の `cleanup` は既定 true・確認も監査記録も無い（#95）ので気付く手段が無い。

**直し方**: catch-all の操作前に同じ `zoneId` の他ドメインの `catchAllEnabled` を数え、1 件でも残るなら
無効化を 409 にする（または `catchAllEnabled` をゾーン単位の状態として持つ）。**無効化にも `confirm` を要求する。**

### 86.【中】Webhook のキュー再試行が受け手への POST を増幅する

`src/services/webhooks.ts` `runDelivery`、`services/consumer.ts` `handleQueueBatch`、`wrangler.jsonc`。

`runDelivery` は「POST → DB 更新 → `OUTBOUND_QUEUE.send`」の順で、`send` が throw すると
`handleQueueBatch` の catch が `item.retry()` する。再配達は同じ `{deliveryId, attempt}` なので
`runDelivery` が頭から走り、**受け手に再度 POST する**。

**実証**。`fetch` をスパイして 503 を返し、`OUTBOUND_QUEUE.send` を常に失敗させて `max_retries: 3` と同じ
4 回（初回 + 3 再配達）流したところ、受け手への POST = **4 回**、DB の `attempt` = 2 のまま、`status` = `pending`。
`MAX_ATTEMPTS = 5` が縛るのは DB 上のチェーンだけで、キュー層の再配達は数えていない。
さらに `tsubame-outbound` には `dead_letter_queue` が**無い**（`tsubame-inbound` だけ #20 で足した）ので、
4 回目で毒メッセージは黙って消え、配信は `pending` 固着 → 手動再送は `failed` 以外を 409 にするため永久に再送できない。
#69 の「`pending` で 409」の原因を 1 つ特定したもの。

**直し方**: `runDelivery` の副作用に冪等キー（`deliveryId` + `attempt` で claim）を持たせ、
キュー投入を DB 更新より前か同一の claim 内に入れる。`tsubame-outbound` にも DLQ を足す。

### 87.【中】送信する生 MIME が全 bare LF で CRLF が 1 つも無い

`src/domain/mail/compose.ts` は `import { createMimeMessage } from "mimetext"` で読む。
mimetext 3.0.28 の `exports["."]` は **node ビルド**を指し、その `eol` は `node:os` の `EOL`（Workers では `"\n"`）。

**実証**（本体が両ビルドを確認）。node ビルドは `eol:e`（`import { EOL as e } from "node:os"`）、
browser ビルドは `eol:"\r\n"` 固定。node ビルドで実際に MIME を組むと **CRLF 0 / bare LF 9**。
ヘッダ区切り・パート境界・本文すべて `\n`。

RFC 5322 / 5321 は CRLF を要求する。`stripHeader` は `\r?\n` を見るので現状は破綻していないが、
(1) DKIM の署名対象の正規化は行末を見るので、中継側が LF を CRLF に直した時点で署名が壊れる、
(2) CRLF だけを行区切りとする MTA / パーサはメール全体を 1 つのヘッダ塊と読み、`stripHeader` 由来の
Bcc 防御（#2）と `assertNoLineBreak`（#1）の前提が両方外れる、(3) `os.EOL` が `\r\n` を返す環境
（Windows での `wrangler dev`）で出力が黙って変わる。

**直し方**: `mimetext/browser` に替える（`eol` が `"\r\n"` 固定）。`composeMime` の戻り値が CRLF であることを
テストで固定する。**Cloudflare Email Sending が bare LF を CRLF に直しているのか素通しなのかは未確認**で、
実害の大きさはそこで決まる。

### 88.【中】`?q=` の語数に上限が無く検索 API が 500 になる

`src/domain/search/sql.ts` `freeWordCondition` / `relevanceScore`、`shared/contracts/messages.ts`。
`q` は `z.string().optional()` で長さも語数も無い。`freeWordCondition` は 1 語ごとに条件を足し、
`relevanceScore` は 1 語ごとに `sql` を**入れ子**にする。

**実証**（owner = `addressIds: "all"` のバインド 0 本という最良条件で計測）。
- 1〜2 文字の語（LIKE 経路、1 語 5 バインド）: **20 語で 500**（19 語は 200）。`too many SQL variables`。
  日本語の 2 文字語 20 個は普通の検索文。
- `order=relevance`: **50 語で 500**。同じ `too many SQL variables`。
- FTS 経路: 約 95 語で `Expression tree is too large (maximum depth 100)`、1000 語で `statement too long`、
  10,000 語で `RangeError: Maximum call stack size exceeded`（`sql` タグの再帰で JS 側が死ぬ）。

いずれも `ApiError` ではないので `{"code":"internal"}` の 500 になる。grant 付きの member は
`inArray` のバインドが乗るのでしきい値がさらに下がる（#57 と同じ根だが、こちらは**入力 1 本で押し切れる**）。

**直し方**: `q` に長さの上限（例 500 文字）、`freeWords` に語数の上限（例 10 語）を付け超過は 400 にする。
`relevanceScore` は入れ子でなく `+` の平坦な和にする。

### 89〜92.【中】送信と受信の取りこぼし

- **#89** `shared/contracts/send.ts`。`MAX_BODY_BYTES = 1024 * 1024` は名前がバイトだが `z.string().max()` は
  **コード単位**。第 2 回の「残る制約 #22」は「多バイト文字なら 3MB 入る（`bodyLimit` 40MB が先に効くので安全側）」
  と書いたが安全側ではない。**実証**: `text: "あ".repeat(700*1024)`（2.1MB）は 202、`"あ".repeat(1024*1024)`（3MB）は
  **500**（`D1_ERROR: string or blob too big`、`enqueueOutbound` の `db.batch`）。D1 の 1 行 2MB 上限に zod の門より先に当たる。
  **直し方**: `TextEncoder` のバイト数で検査し、`text + html + 件名` の合計も行上限の手前に置く。
- **#90** `api/v1/outbound.ts`。`db.batch([...])` → `storeAttachments` → `OUTBOUND_QUEUE.send` の順なので、
  R2 put が落ちると batch は確定済みでキュー投入が実行されない。**実証**: `att/` の put を 1 回だけ失敗させると 500 の後に
  `status=queued` の行が残り、`drainQueues` を回しても `queued` のまま。**送られも失敗もしない**。#77 の送信側。
  **直し方**: R2 put とキュー投入を insert より前に済ませるか、失敗時に `failed` へ落とす。
- **#91** `domain/mail/inbound.ts` `processInbound`。`createThread`（`messageCount:1, unreadCount:1`）→ `messages` の insert の順。
  insert が落ちるとスレッド行だけが残り、再配達は `rawR2Key` の dup 判定に掛からないので**また新しいスレッドを作る**。
  **実証**: insert を 3 回失敗させて同じ payload を 4 回処理 → `threads` 4 行・`messages` 1 行。`queryThreads` は
  メッセージの存在を要求しないので、空スレッドが受信箱を占め未読バッジが増える。#77 の前半。
  **直し方**: スレッド作成とメッセージ挿入を 1 つの `batch` にする。
- **#92** `domain/mail/inbound.ts` `applyAddressRules` の `drop` は `status = "trash"` を立てるだけで、
  `queryThreads` / `queryThreadMessages` は **status を条件に入れていない**。`threads.unreadCount` も減らさない。
  **実証**: `drop` ルールで 3 通配送 → `messages` は 3 件とも trash だが `threads` は 3 行とも未読 1 で一覧に出て、
  開けば本文も読める。サイドバーの未読数だけは `ne(status,"trash")` で正しく数えるので**画面内で食い違う**。
  利用者が「捨てる」と設定したルールが何も捨てていない。
  **直し方**: `queryThreads` / `queryThreadMessages` に既定で `status != 'trash'` を入れ、`drop` で `adjustThreadUnread(-1)`。

### 93〜95.【中】Cloudflare 操作と監査

- **#93** `provisionDomain` は `localParts` 1 件ごとに `ensureAddressRoutingRule` を呼び、その中で
  `listEmailRoutingRules` が最大 20 ページを読み直す。**実証**（fake fetch）: ルール 20 ページのゾーンで
  `localParts` 50 件を接続すると CF API 呼び出し **1,057 回**。Cloudflare の API レートは 5 分 1,200 回／アカウントなので、
  owner の 1 リクエストで枠をほぼ使い切り、以後そのアカウントの CF 操作が 429 になる。#97 でタイムアウトも無い。
  **直し方**: ルール一覧を 1 回だけ取って `Map` で引く。
- **#94** `cfZone` スキーマは `account.id` を読むが、**`src/` 全体でこの値を使う箇所が 0 件**（本体が確認）。
  `CloudflareApi.accountId` ゲッタも呼び出し 0 件。`listZones` は `GET /zones` に `name` / `page` だけを付ける。
  `CF_ACCOUNT_ID` は `deployment.md` §3 が「3 つのシークレット」の 1 つとして投入を指示し、
  `.dev.vars.example` と `worker-env.d.ts` にも載っているのに**どこからも参照されない**（#41 と同じ形）。
  実害は、トークンが複数アカウントに効く場合に `resolveZone` が他アカウントのゾーンを候補に入れ、
  そのゾーンの MX / Email Routing を書き換えられること。
  **直し方**: `listZones` の query に `"account.id"` を付け `resolveZone` でも照合する。使わないなら #41 と同じく消す。
- **#95** `recordAudit` の呼び出しは auth（bootstrap）/ admin users / me api-keys / admin api-keys だけで、
  **webhooks・rules・domains（接続・切断・catch-all）・addresses は 0 件**（本体が確認）。
  domain の切断は**ゾーンの DNS レコードを消す**（#18 / #60）のに、いつ誰のキーで行われたかを事後に確定できない。
  `auditLogs` を読む経路も src に無く、保持期間も決まっていない。
  **直し方**: 上記 4 群に `recordAudit` を足す（`meta` に zoneId・レコード名・catch-all の可否）。
  `docs/ops/` に「監査ログの見方と保持期間」を 1 節書く。

### 96〜112.【低】残り

- **#96** `package.json` の `allowScripts`（`workerd` 2 件のみ許可）は効いていない。`@lavamoat/allow-scripts` が
  `package.json` にも `package-lock.json` にも無く、`.npmrc` も無く、`ignore-scripts` は `false`（本体が確認）。
  `allowScripts` は npm / pnpm / Bun のいずれの正式キーでもない。install script を持つのは `workerd` ×2 のほか
  `esbuild` ×3・`core-js-pure`・`fsevents` の計 7 つで、`npm ci` はこれら全部を実行する。**門に見えるが門でない。**
  **直し方**: 絞るなら `@lavamoat/allow-scripts` を入れる。絞らないなら誤解を招く `allowScripts` を消す。
- **#97** `cloudflare-api.ts` `#request` の `init` に `signal` が無い（`webhooks.ts` は `AbortSignal.timeout(10_000)` を
  付けている）。**実証**: `fetch` を永遠に解決しない Promise に差し替えると `listAllZones()` が待ち続ける。
- **#98** `admin/users.ts` PATCH の `meta: { …, password: undefined }` は JSON 化で消えるので、
  他人のパスワードの掌握が `user.update` / `meta: {}` として記録され、名前変更や no-op と区別できない（本体が確認）。
  `mustChangePassword` も立たないので owner が知っているパスワードのまま使い続けられる。
  **直し方**: `meta` に `passwordChanged: true`（値は入れない）。owner が password を設定したら `mustChangePassword: true`。
- **#99** `me.ts` PATCH は `sessions` を全削除するが **`api_keys` は失効しない**（本体が確認）。
  パスワード流出時の封じ込めがセッションだけ。**直し方**: 方針を決めて文書化する（落とすなら `revokedAt` を入れる）。
- **#100** `contracts/api-keys.ts` の `addressIds` に `.max()` が無い（本体が確認）。5000 件のキーを自分で作ると
  以後**全リクエストが 500**（`addressFilter` の `inArray` がバインド上限超え）。owner は `addressSetHas("all", id)` が
  常に true なので**存在しない id でも 201** で保存される。#57 と根は同じだが grants も owner 権限も不要。
- **#101** `resolve.ts` `resolveIncoming` の完全一致ループは `hit.archivedAt` で自分は飛ばすが、
  `hit.kind === "alias"` の分岐は `aliasTargetId` をそのまま返し**先の行の `archivedAt` を見ない**。
  **実証**: `box@` をアーカイブし `al@` を `box` へのエイリアスにすると、`box@` 宛は reject、`al@` / `al+t@` 宛は deliver。
  #37 の「アーカイブ済みは実在しない扱い」がエイリアス先に及んでいない。
- **#102** `processOutboundSend` の `obj ? … : new Uint8Array(0)`。**実証**: 202 の後に R2 の `att/` を消して
  キューを回すと、本体が空のパートを持つメールが送られ `status` は `sent`。**直し方**: null なら throw して再試行させる。
- **#103** `addMessage` が `Content-Transfer-Encoding` を既定の `7bit` にし本文を無加工で入れる。
  **実証**: `"日本語の本文です"` で `7bit` と宣言しつつ raw に 0x80 以上のバイトがある。日本語 UI なのでほぼ全送信が該当。
  8BITMIME 非対応の中継で化けるか拒否される。**直し方**: `encoding: "base64"` を渡す（#104 も同時に塞がる）。
- **#104** 本文が `7bit` で無加工なので、本文中の行が `--<boundary>` に一致するとパート境界になる。
  boundary は mimetext の `Math.random().toString(36).slice(2)`（CSPRNG ではない）。
  **機構は実証済み**（`Math.random` を固定して攻撃者のパートが独立して現れることを確認）だが、
  **実運用の boundary を当てる部分は未実証**。返信の引用本文は攻撃者が書いた受信本文そのものなので、
  当てられれば「自ドメインの署名付きで攻撃者のパートが第三者に届く」になる。#103 の base64 化で塞がる。
- **#105** `contracts/addresses.ts` の `displayName: z.string().trim().max(120)` は `singleLine` が掛かっていない。
  **実証**: `displayName: "Alice\r\nBcc: evil@evil.jp"` の PATCH が **200 で保存**される。
  注入は mimetext の `dumpMailboxSingle` が表示名を必ず encoded-word にするので成立しない（`Bcc:` 行は出ない）が、
  **防御が mimetext の実装 1 枚に依存している**。直接ヘッダに書く実装に替わった瞬間に #1 が復活する。
  **直し方**: `displayName` を `singleLine` 相当にし、`composeMime` で `fromName` にも `assertNoLineBreak` を掛ける。
- **#106** レートリミッタは `LOGIN_RATE_LIMIT` だけで、`POST /messages` と `/:id/reply` に制限が無い。
  1 リクエスト 100 宛先の上限はあるがリクエスト数の上限が無いので、漏れた `send` キー 1 本で送信量は実質無制限。
  S-9 の表にも「キーのスコープ = 被害の上限に送信量が入っていない」ことが明記されていない。
- **#107** `docs/ops/deployment.md` に「ローテ」「失効」「再生成」の語が 0 件。`CF_API_TOKEN` は Zone /
  Email Routing / Email Sending の編集権を持つので入れ替え手順が要る。Webhook の `secret` は再発行の API が無い
  （登録応答にしか出ない）ので、漏れたら作り直すしかないことを書く。bootstrap 後に `INTERNAL_SECRET` を消す指示も無い。
- **#108** `tests/` に `.yml` を読む処理が 0 件。`worker-name.test.ts` が `wrangler.jsonc` を読む形は良い前例だが、
  同じファイルの `queues.consumers[].dead_letter_queue` は誰も見ていない。#45 の SHA 固定、#46 の UUID 検査も同じ。
  **`@v4` に戻しても `dead_letter_queue` を消しても 494 件が緑のまま。**
- **#109** fr07 の 5 シナリオはすべて owner で、`memberPrincipal` も 403 期待も無い。fr06 は 403 が 1 件あるが
  fr07 / fr08 は 0 件。ルータ単体テストは門を検査しているが、**本番の `app.ts` を通した e2e の否定ケース**が無い。
- **#110** `ci.yml` に `npm audit` が無い。現時点の `--omit=dev` は 0 件、dev 込み 8 件（`sharp` / `esbuild` 経由、
  配布物外）で第 2 回の記録どおりだが、実行時依存に High が入っても CI は気付かない。
- **#111** `_journal.json` のタグ 3 件（`0000_init` / `0001_add_address_color` / `0002_add_must_change_password`）は
  実ファイル（`0000_init` / `0001_search_fts` / `0002_add_address_color` / `0003_add_must_change_password` /
  `0004_fts_delete_triggers`）と**idx 1・2 が一致しない**。手書きの 0001 / 0004 はチェーンに無い。
  **実証**: スクラッチに複製して `drizzle-kit generate` を走らせると `0003_*.sql` が生まれ `0003_*` が 2 本並ぶ。
  `readD1Migrations` は名前順なので局所的には動くが、ずれは以後ずっと残る。#70 の本文より悪い。
- **#112** `migrations/0004` の `INSERT INTO messages_fts VALUES ('rebuild')` はバッチ無しの全件再構築で、
  `--> statement-breakpoint` で分かれるため全体のトランザクションも無い。`deploy.sh` は `wrangler deploy` の**前**に
  `--remote` で流すので、行数が増えると「トリガは新形式・索引は古いまま・デプロイ未実施」で止まる。

### 第 3 回で問題なしと確認した範囲

**S-1 / S-2**（群 1）。`createApp()` の実ルータで 21 経路 × 無資格 → `/api/health` と `/auth/setup-state` 以外すべて 401。
パスの変形 10 種（末尾スラッシュ、大文字、`%6de`、`admin//users`）でも門を抜けられない。KDF は自己記述形式・100,000 回・
`needsRehash` の貼り替え、`timingSafeEqual` / `secretEquals` は長さで早期 return しない、仮パスワードは棄却法（#53）。
ログイン失敗は 4 ケースすべてで `DUMMY_PASSWORD_HASH` に対する `verifyPassword` が走る（#26 が残っている）。
レート制限は `ip:email` / `ip` / `email` の 3 鍵、bootstrap は `ip`（#52）。セッションは 32 バイト・DB はハッシュのみ・
期限切れを弾いて削除・logout は行を削除・role / status / password の変更で全セッション削除。API キーは
`revokedAt` / `expiresAt` を毎リクエスト検査し、持ち主が `status !== active` で即 401。
owner→member の降格で既存キーの `addressIds` が `"all"` → `[]` に縮む。member セッションが admin スコープのキーを
作れても `/admin/*` は 403（`requireOwner` が role を先に見る）。`set()` / `values()` はすべて明示フィールドで
`role` / `status` / `passwordHash` / `userId` はボディから流れない。最後のオーナー保護は WHERE 句に埋める形（#54）。

**S-3 / S-4**（群 2）。#17 の収束ループと `DANGEROUS_TAGS`（`math` / `svg` / `template` を含む）は doctype の
差し込みと整合し、`MessageHtml` の使用箇所は `ThreadDetail.tsx` の 1 か所だけ。#10 の `addressListContains` は
`parseAddressList` + 完全一致で、`capReferenceIds` は 80 バインドに収まる。#28 / #73 の `toCandidates` の
`undefined` 要素は誤一致しない。#56 の `arrayBuffer()` は try の外で、R2 が null なら throw。
添付の `servedContentType` に `image/svg+xml` / `text/html` は入らず、`filename*=UTF-8''` +
`encodeURIComponent` が `"` `;` `,` CRLF をすべて percent 化する。生 MIME の filename はサーバ採番。
R2 キーは `r2.ts` の 2 関数のみで組む。`dangerouslySetInnerHTML` / `innerHTML` は `src/ui` に 0 件で、
件名・差出人・添付名は JSX のテキスト。`api.ts` は `details` を描画せず `location.href` は自オリジン固定。

**S-5 / S-6**（群 3）。`assertCanSend` は 4 段（scope → 正規化 → DB → `archivedAt` / alias）で、返信も同じ門。
`EMAIL.send` を呼ぶのは `sendRawEmail` だけ。件名・表示名は mimetext が必ず base64 化（5 パターンで確認）、
宛先は `assertNoLineBreak`、Message-ID 系は `formatMessageIdList`、添付名は zod + エスケープ。
本文に `\nBcc:` を書いてもヘッダ部には出ない。`composeMime` は Bcc を組み立てず、`stripHeader` は bare LF でも
同名ヘッダを継続行ごと全件消す。件名は 600 バイトで切って base64 化後 821 文字、References は `clampReferences` で
998 以内。引用は `stripHtml` → `escapeHtml` → `<pre>`。宛先の重複排除はすべて `normalizeAddress` 後の鍵。
`sql.raw` は 0 件で、`sql` タグに渡す前に連結した文字列は無い。`order` は enum、`limit` は 1〜100、
`cursor` は base64 → 正規表現 → バインド。アドレス条件は `conds[0]` としてカーソル・検索語と独立に付き、
FTS / LIKE / 関連度順 / スレッド一覧 / スレッド内 / 単体の 6 経路すべてに `inArray`。
`escapeFtsTerm` に 19 パターン（`SEC*`、`NEAR(...)`、`{subject}:`、`" OR "`、`\`）を通して範囲は広がらない。

**S-7 / S-9 / S-10 / S-11**（群 4）。`webhookUrlProblem` は登録・更新・配信直前の 3 経路で同一、`redirect: "manual"`、
`AbortSignal.timeout(10_000)`、`MAX_ATTEMPTS = 5`、`RETRY_DELAYS = [30,300,1800]`。`secret` は 32 バイト CSPRNG で
POST 応答のみ・`toResponse` に無く・更新不可。#43 の Bcc 漏れは修正済みで、受け手向け検証手順は §10 にある。
#44 は `.max(100)` + 重複除去 + 実在と可視性の検査で、空配列は fail-closed。CF トークンは `#token` に閉じ
`Authorization` にしか入らず、`details` の `path` / `bodySnippet` は `requireOwner` の後ろだけ。`zoneId` は
`listAllZones` の結果と `isWithinZone` で照合。apex は `confirmApex` 必須、catch-all の**有効化**は `confirm` 必須。
`isOwnRoutingRule` は worker 名一致 + 全 matcher が `@<name>` 終わりで `deep.mail.example.com` を拾わない。
`processOutboundSend` はアプリ側で attempts / `OUTBOUND_MAX_ATTEMPTS` / `SENDING_STUCK_SECONDS` を持つ。
`handleQueueBatch` は `for` 内 `try` で 1 件の失敗が同バッチを巻き込まない。実行時依存 9 パッケージはすべて
MIT / Apache-2.0 / BSD / MIT-0 で、`package-lock.json` は 309 パッケージすべて registry 由来・integrity あり。
`deploy.yml` は `workflow_dispatch` のみ・`concurrency` あり・シークレットは最終ステップの `env:` だけ。
`pull_request_target` 不使用。`deploy.sh` は `set -euo pipefail` と UUID 検査と `trap` での消去。
`tests/webhook-api.test.ts` は `createApp()` を通し、加えてルータ単体でも 403 を検査。#31 は
`tests/domains-api.test.ts` が同形で検査し、`adminUserRoutes` / `adminApiKeyRoutes` は bare mount だが
両ルータが自前で `use("*", requireOwner)` を持つので門は落ちない（全 8 ルータの配置を確認）。
`csrf-content-type.test.ts` は `SELF` 経由で #50 / #55 の両方向を押さえている。

### 第 3 回の未確認

- **Cloudflare Email Sending が bare LF の生 MIME を CRLF に直すか素通しするか**（#87 の実害の大きさがここで決まる）。
  あわせて `7bit` + 8bit 本文を拒否するか直すか（#103）、998 文字超のヘッダ行を拒否するか（#34 / #66 から持ち越し）。
- 実運用の `Math.random()` 由来 boundary を送信済みメールの値から予測できるか（#104）。
- ブラウザで `Domain=` + `Path=/api` の Cookie が先頭に並ぶこと、`__Host-` への移行時の挙動（#84。サーバ側のみ実証）。
- 実 `CF_API_TOKEN` が複数アカウントに効く構成で `GET /zones` が他アカウントのゾーンを返すか（#94 の成立条件）。
- Cloudflare の `catch_all` が実機でゾーン単位の単一ルールであること（#85 の前提。fake CF と仕様記述に基づく）。
- Cloudflare API の実レート制限値と 429 時の挙動（#93 の影響度）。`tsubame-outbound` に DLQ が無い状態で
  `max_retries` 超過が実機で破棄されるか（#86）。
- `'rebuild'` が D1 の実行時間上限に当たる行数（#112）。
- ブラウザ実機での `buildSrcDoc`（本環境に `DOMParser` を持つランタイムが無く、#17 の DOM 経路の新しい mXSS は探せていない）。
- #88 のしきい値を member（grant 付き）で測っていない。owner の最良条件の値のみ。
- `Zone Settings – Edit` 権限に対応する呼び出しが `cfEndpoints` に無い件（第 2 回から未確認。過剰権限の可能性）。
- #91 の insert 失敗を本物の D1 で起こす条件（行サイズ上限。第 2 回からの持ち越し。今回は `prepare` の差し替えで示した）。

### 16.【中】返信の引用に受信 HTML をサニタイズ無しで埋め込む

`src/domain/mail/quote.ts` `buildReplyQuote`（`htmlSource = source.htmlBody`）→ `quoteHtml`。
呼び出しは `src/api/v1/outbound.ts` reply。

受信 HTML `<p>hi</p><img src="https://attacker.example/t.png"></blockquote><script>1</script>` に返信すると、
送信 HTML は次のようになる（実証済み）。

```
<blockquote>…<br /><p>hi</p><img src="https://attacker.example/t.png"></blockquote><script>1</script>
</blockquote>
```

トラッキング画像、`</blockquote>` による構造の脱出、`<script>` が、そのまま自ドメインの DKIM 署名付きで
返信先（全員に返信なら第三者）へ届く。`replyAll` は要らない。`stripHtml` のコメントに
「サニタイズ目的には使えない」とあるとおり、サニタイズしている箇所は無い。

**直し方**: 引用 HTML は `stripHtml` → `escapeHtml` → `<pre>` に落とす（`textBody` 経路と同じ）。
最低でも `<script>` `<img>` `<link>` `<style>` `on*=` `javascript:` を落とす。

### 17.【中】`<link rel="preconnect">` で開封トラッキングができる

`src/ui/components/MessageHtml.tsx` `buildSrcDoc`。

meta CSP `default-src 'none'`、親の `_headers` CSP、`sandbox="allow-same-origin"` のどれも
`<link rel="preconnect" href="https://attacker/">` を止めない。CSP は fetch を伴わない接続を対象にしない。
開いた瞬間に攻撃者ホストへ TCP/TLS 接続が張られ、IP・時刻・SNI が渡る。`hasRemoteImages` は
`src=` / `url(` しか見ないので「画像を表示」ボタンも出ない。

**実証**: Chrome で srcdoc に `<link rel="preconnect" href="http://[::1]:8799">` だけを入れると、
サーバ側でリクエストを伴わない接続を観測した。対照の `stylesheet` / `dns-prefetch` / `prefetch` は
接続もリクエストも無し（CSP で止まる）。

**直し方**: srcdoc に入れる前に `DOMParser`（不活性文書）に載せ、`link` 要素と
`meta[http-equiv="refresh"]` を除去してから `documentElement.outerHTML` を使う。`onLoad` 後の除去では遅い。

### 18.【中】apex 切断で他サブドメインのメール用 DNS まで消す

`src/domain/domains/cleanup.ts` `isOwnDnsRecord` の `underMailName = name === mailName || name.endsWith(`.${mailName}`)`。
呼び出しは `admin/domains.ts` `DELETE /:id`（`cleanup` 既定 true）。

`example.com` を `confirmApex: true` で接続した状態で切断すると、`mailName = example.com` なので
ゾーン内のすべてのサブドメインが `underMailName` になる。`provisionDomain` は名前の重複しか見ないので、
同じアプリで `example.com`（apex）と `mail.example.com`（subdomain）を同時に接続できる。

**実証**: バンドルした本物の `isOwnDnsRecord` で、apex 切断時に `MX mail.example.com`、
`TXT mail.example.com`（SPF）、`TXT cf-bounce._domainkey.mail.example.com`（DKIM）、
`MX other.example.com`（他のツールが Cloudflare Email Routing に向けたもの）がすべて削除判定になった。
subdomain 切断では apex に触らない（既存テストどおり）。既存テスト `tests/domains-cleanup.test.ts` は
subdomain の `target` しか使っていない。ルーティングルールは完全一致サフィックスなので DNS だけが過剰。

「迷ったら消さず報告する」方針に反する。あわせて `deleteDomainQuery.safeParse` の失敗が
`doCleanup = true` に倒れている（`domains.ts:204`）。

**直し方**: apex モードでは `name === mailName` と `cf-bounce._domainkey.${mailName}` の完全一致だけを
対象にする。切断対象より下位に `domains` テーブルの別接続があれば拒否する。クエリの検証失敗は 400。

### 19.【中】受信 `Date` ヘッダをそのまま `received_at` に使う

`src/domain/mail/inbound.ts:193`（`parsed.date ? parsed.date * 1000 : msg.receivedAt`）、
`:267` `updateThreadStats`、`src/domain/search/sql.ts` `encodeCursor` / `decodeCursor`。

- `Date: Mon, 1 Jan 1900` → `received_at` が負数。`encodeCursor(-62135596800, id)` を `decodeCursor` が
  `^(\d+):` で読めず null → `invalidRequest("カーソルが不正です")`。`received_at DESC` なので古い日付は
  末尾に沈み、そのメッセージがページ境界に来た瞬間に**次ページが 400** になる。攻撃者が 26 通送れば必ず境界に当たる（実証済み）。
- `Date: 2100-01-01` → そのまま `received_at` と `threads.last_message_at` に入り先頭に固定。
  既存スレッドへの返信でも `updateThreadStats` が無条件に `lastMessageAt = receivedAt` を書くので、
  古い日付の返信でスレッドを沈めることもできる。

`notes.md` の「未確認」が成立した。

**直し方**: `received_at` はキュー投入時刻に固定し、`Date` は表示用の別列にする。
または `[now - 数日, now + 数分]` の外なら投入時刻に落とす。`updateThreadStats` は `max()`。`decodeCursor` は負数も受ける。

### 20.【中】パース例外で受信メールが痕跡なく消える

`src/domain/mail/parse.ts` `parseRawMime`、`inbound.ts:188-191`、`services/consumer.ts:24-27`、
`wrangler.jsonc` `max_retries: 3`（`dead_letter_queue` 無し）。

postal-mime は入れ子 256 段超と、**メッセージ全体で累積した**ヘッダ 2MB 超で throw する。
`depth 257` と `100,000 パート・4.2MB` で throw を確認した（実証済み）。#5 の対応は
「サイズ超過は placeholder を残す」だが、パース例外には効かない。`processInbound` から抜けて
`item.retry()` → 3 回再試行（毎回 R2 から読み直す）→ 4 回目で黙って消える。生 MIME は R2 に残るが
D1 に行が無いので誰も気付けない。`notes.md` の「3 回で止まるが DLQ が無い」が成立した。

**直し方**: `parseRawMime` の例外を捕まえて `oversizedPlaceholder` と同型の行を残して ack する。
`dead_letter_queue` を足す。

### 21.【中】送信の部分失敗で二重送信する

`src/domain/mail/outbound.ts` `processOutboundSend`、`services/sender.ts` `sendRawEmail`。

`sendRawEmail` は受信者ごとに `EMAIL.send` するが、N 件目で throw すると `catch` が `queued` に戻して
再キューし、次回は**全受信者に再送**する。`try` は送信後の DB 更新と Webhook 配信も包んでいるので、
送信成功後に D1 が失敗しても同じ経路で再送する。`OUTBOUND_MAX_ATTEMPTS` で最大 4 回なので、
成功した受信者に最大 4 通届く。`sending` に更新した直後に Worker が落ちると `sending` のまま残り、
再試行も `failed` 化もされない（`job.status !== "queued"` で return）。
「読んでから更新」なのは `notes.md` のとおり。

**直し方**: 受信者ごとの送信済みを記録し再試行は未送分だけにする。送信後の DB 更新を `try` の外に出す。
`UPDATE … WHERE status='queued' RETURNING` で掴み、`sending` のまま一定時間のものを回収する。

### 22.【中】送信 API に量の上限が無い

`src/shared/contracts/send.ts`（`subject` / `text` / `html` / `base64` に max 無し、`to` / `cc` / `bcc` に
max 無し、`attachments` に max 無し）、`src/api/v1/outbound.ts:180` `c.req.json()`（`bodyLimit` 未使用）。

`send` スコープのキー 1 本で数百 MB の JSON を `atob` → `Uint8Array` に展開して R2 に置ける。
宛先は 1 件ごとに `EMAIL.send` されるので宛先数がそのまま送信数。本文が D1 の列上限を超えると
`messages` の insert が失敗するが、その前に `createOutboundThread` が済んでいるので
**メッセージの無い空スレッド行が残る**（D1 で実際に失敗するかは未確認）。
「キーのスコープ = 被害の上限」に送信量が入っていない。

**直し方**: `subject` 998、`text` / `html` 256KB〜1MB、添付 1 件 20MB・合計 25MB・50 件、宛先合計 100 程度を
zod に置き、`bodyLimit` を付ける。スレッド作成はメッセージ insert と同じバッチにする。

### 23.【中】「全員に返信」の宛先が利用者に見えない

`src/api/v1/outbound.ts` `replyAllRecipients`（From + To + Cc から自分を除外）、
`src/ui/routes/Compose.tsx:98-100, 233-242`（`replyTo = m.fromAddr`、`replyCc = m.ccAddr` だけを表示）。

サーバは受信 `To` ヘッダ由来の宛先を含めるが、UI は From と Cc しか見せない。攻撃者が `To:` に第三者を
並べておくと、利用者に見えない宛先へ #16 の引用 HTML ごと送られる。
`isSelf` は `normalizeAddress(addr) === own` の完全一致だけなので、自分の `+タグ` 付きアドレスと
自分のエイリアスは除外されず、返信が自分の受信箱に戻る（同じロジックで確認）。宛先数の上限も無い。

**直し方**: 返信画面で最終宛先を表示し編集できるようにする。`isSelf` に `baseAddressOf` と
そのメールボックスへのエイリアス集合を含める。

### 24.【中】R2 に置いた後のキュー投入が `waitUntil`

`src/domain/routing/incoming.ts:61`。`saveRaw` は `await` だが `INBOUND_QUEUE.send` は `waitUntil`。
一時失敗してもハンドラは正常終了し、送信側 MTA に 250 が返るので再送も来ない。R2 に生 MIME だけ残る。
`notes.md` の「未確認」がコードで成立（実行はしていない）。

**直し方**: `await env.INBOUND_QUEUE.send(payload)` にして失敗を例外にする。Email Routing が一時失敗を返し、
送信側が再送する。

### 25.【中】`/me/api-keys` にスコープの門が無い

`src/api/v1/me.ts:108-187`。門は `requireAuth` だけ。

- `read` だけのキーで `POST /me/api-keys` → `clampScopes` は同じ `["read"]` を通す。`expiresAt` は親キーの
  期限で clamp されない（`me.ts:135`）ので、**期限付きキーから無期限のキー**を作れる。元のキーを失効しても
  子キーは生き残る。
- `send` だけのキーで `DELETE /me/api-keys/:id` → 同じユーザーの**他のキーを全部失効**できる。
- 監査ログは `actorId` だけで `apiKeyId` を記録しないので、どのキーが子キーを作ったか追えない。
- 仮パスワードでログインした Cookie でも作れる（仮パスワードの強制は UI だけ。`notes.md` の「未確認」が成立）。

スコープもアドレスも広がらないが、漏れたキー 1 本で**持続性の獲得**と**他キーの失効**ができる。

**直し方**: キー管理を `via === "session"` か `admin` スコープに限る（FR-12 は UI で満たせる）。
少なくとも `expiresAt` を親以下に clamp し、監査 `meta` に `apiKeyId` を入れ、失効時に子キーも失効させる。

### 26.【中】ログインの応答時間でメールアドレスの存在が分かる

`src/api/v1/auth.ts:73-78`。`if (!user) throw loginFailed()` が `verifyPassword`（PBKDF2 100,000 回）の
**前**にある。`verifyPassword` は `stored` が null（agent）なら即 false。「居ない／agent」は KDF 無しで即応答、
「居る member/owner」は KDF 1 回分遅れる。文言は揃っている（`tests/auth-api.test.ts:87`）が時間は揃っていない。

**実証**: Node の WebCrypto で PBKDF2-SHA256 100,000 回 ≈ 11 ms、居ないユーザー相当 ≈ 0 ms。
Workers 上での遠隔計測はしていない。レート制限の鍵が `ip:email` なので、メールごとに 1 回ずつ試す
列挙は制限に掛からない。

**直し方**: `user` が居ない／`passwordHash` が null のときも固定のダミーハッシュに対して `verifyPassword` を走らせる。

### 27.【中】FTS の同期トリガが外部コンテンツの削除手順でない

`migrations/0001_search_fts.sql:31-39` `messages_fts_au` / `messages_fts_ad`。

`content='messages'` の FTS5 は行の値を持たず、`DELETE FROM messages_fts WHERE rowid=…` のとき
content テーブルから値を読んでトークンを消す。AFTER DELETE では行が既に無いので何も消えず、
AFTER UPDATE では **new の値**で消そうとして old のトークンが残る。正しくは
`INSERT INTO messages_fts(messages_fts, rowid, …) VALUES('delete', old.rowid, old.subject, …)`（FTS5 §4.4.3）。

**実証**（sqlite 3.51.0・同じ DDL）: subject を `secret invoice` → `changed` に UPDATE した後も
`MATCH '"secret"'` が同じ行を返す。DELETE 後も FTS に rowid が残り、次に INSERT した別アドレスの
メッセージが同じ rowid を再利用して、`world` を含まないのに `MATCH '"world"'` でヒットした。

アドレス絞り込みは `messages.address_id` 側に付くので他人の本文は読めないが、検索結果に偽陽性が混ざり、
「削除された（他アドレスの）メッセージにその語があった」ことは推定できる。**今は `messages` を DELETE する
経路も索引列を UPDATE する経路も無い**（5 か所の update は status / isRead / isStarred / rfcMessageId のみ）。
削除機能を足した瞬間に顕在化する。

**直し方**: 新しいマイグレーションでトリガを `'delete'` コマンド形式に作り直し、`'rebuild'` で索引を作り直す。

### 28〜32.【低】第 1 回の修正の隣に残ったもの

- **#28** `inbound.ts:274` `applyAddressRules` の `to: msg.envelope.to` はリテラルのみ。address スコープの
  `drop` ルール `{to: "a@example.com"}` に対し、envelope `a+tag@example.com` は `received` のまま（実証済み）。
  #9 と同じ回避が配信後のルール層に残っている。
- **#29** `"victim"@example.com` と `victim.@example.com` は `normalizeAddress` が引用符・末尾ドットを剥がさないので
  reject に当たらず、catch-all が有効なら受け皿に届く（実証済み）。本人の受信箱には入らない。
  正規化は 1 か所（`address.ts`）に集まっているが、観点にある「引用ローカル部」は未対応。
- **#30** `messagePatch` の `status` は `messageStatus` の全値を受けるので、write 権限があれば inbound を
  `sent` / `queued` / `failed` にできる（read+send キーで 200 を確認）。送信は `outbound_jobs` を見るので起きないが、
  一覧の意味が壊れる。受け付けるのは `inbox` / `archive` / `trash` に絞る。
- **#31** `admin/domains.ts:28-39` と `admin/addresses.ts:24-35` の `ownerOnly` は自前実装のまま。
  セッションは全スコープを持つので実効的には `requireOwner` と同値で悪用不可だが、
  `tests/domains-api.test.ts:36` はルータ単体で載せており、#13 で問題にした形が再現している。
  `app.use("*", requireOwner)` に置き換え、`webhook-api.test.ts` の「ルータ単体でも 403」に足す。
- **#32** `webhooks/:id/deliveries` は `paginationQuery` を通した直後に `c.req.query("cursor")` を生で読み直し、
  `new Date(Number(cursor))` を `createdAt` だけの `lt` に使う。同一秒の 3 行を `limit=2` で読むと 2 ページ目が
  0 件になり 1 行読めない（実証済み）。`cursor=abc` は 400 ではなく `Invalid Date`（D1 に NaN をバインドした
  ときの挙動は未確認）。`lib/paging.ts` に載せ替える。`limit` の無い一覧は `me/api-keys`、`addresses`、
  `admin/rules`、`admin/domains`、`admin/addresses` の 5 つ（principal に紐づく件数か owner 限定）。
  `admin/addresses.ts:21` の `scopes.includes("read")` も自前判定（効いてはいる）。

### 33〜40.【低】受信・送信の残り

- **#33** postal-mime は `Message-ID` / `In-Reply-To` / `References` を `decodeWords` に通すので、encoded-word で
  CRLF を混入できる（`"abc\r\nX-Mid-Inj: 1@x"` を確認）。`rfc_message_id` にそのまま保存され、返信時に
  `formatMessageIdList` の `assertNoLineBreak` が throw → 4 回試行後 `failed`。**注入は成立しない**が、
  利用者には 202 の後で失敗になる。`parse.ts` で `[^\s<>\x00-\x1f\x7f]+` に絞ってから保存する。
- **#34** mimetext はヘッダ行を折り返さない。`References` 200 個で 1 行 12,101 文字（実証済み）。
  件名も保存上限 2KB → base64 で 2.7KB。RFC 5322 の 998 文字を超える。中継 MTA が拒否するかは未確認。
  `referencesFor` で個数を絞る。
- **#35** `queryThreadMessages` に `limit` が無く本文付きで全件返す。`thread.ts` は同じ From の inbound を
  アンカーにするので、攻撃者は自分の過去メールに接ぎ木し続けて 1 スレッドを無限に伸ばせる。
- **#36** `admin/addresses.ts:199` PATCH は `target.kind === "alias"` だけを見て、自分がエイリアス先に
  なっているかを見ない。A→B がある状態で B を alias→C にできる。`resolve.ts:121` は 1 段しか辿らないので
  A 宛は B の行に配送され C に届かない。DELETE と同じ検査を PATCH にも付ける。
- **#37** `resolve.ts:118` は `archivedAt` を見ず、`outbound.ts` `assertCanSend` は `kind` / `archivedAt` を見ない。
  書き込み権限があればエイリアスやアーカイブ済みを `from` にできる。意図なら記録が要る。
- **#38** `contracts/rules.ts:24` の `target` は `z.string().max(500)`。`deliver` は他ドメインの id や存在しない id を
  指せる（存在しない id は `createThread` の insert が失敗し #20 の経路で消える。FK で落ちるかは未確認）。
  `forward` はメールアドレス形式すら検査されない。owner 限定。
- **#39** `parse.ts` `flattenAddresses` は `a.address` を `normalizeAddress` に通さず、`address.ts` `formatAddress` は
  改行を引用しない。表示名に CRLF を入れた `To:` は `"Alice\r\nX: 1 <bob@…>, carol@…"` として保存され、
  返信時に `parseAddressList` が bob を黙って落とす。`From: "a\tb"@example.org` は `fromAddr` にタブ入りで保存され、
  返信時 `normalizeAddress` が null → 宛先ゼロで失敗（実証済み）。注入はされない。
- **#40** `incoming.ts:38` は `X-Tsubame-Forwarded` にエンベロープ `to` を載せる。転送先に元の宛先が露出する。
  値は使っていないので `"1"` で足りる。

### 41〜48.【低】外部連携・シークレット・CI

- **#41** `AUTH_SECRET` は `worker-env.d.ts`、`deployment.md` §3（「3 つのシークレット」の 1 つで
  「漏れたら全セッションと API キーを失効」）、`.dev.vars.example`、`README.md` にあるが、`src/` で 0 件。
  `hashToken` は無ソルト SHA-256（トークンが 32 バイト CSPRNG なので強度の問題ではない）。
  ローテーションしても何も変わらない。逆に `INTERNAL_SECRET` は §3 に無く末尾の別節。README のローカル手順は
  `seed-local.mjs` が前提にする `INTERNAL_SECRET` に触れていない。型・docs から消し、§3 を直す。
- **#42** `webhooks.ts:184` `POST /deliveries/:id/retry` は `status` を見ずに `runDelivery` する。`success` を再送すると
  受け手に二重に届く。`pending` を再送して失敗すると `webhook.retry` がもう 1 本積まれ、以後 2 本のチェーンが並走する
  （`MAX_ATTEMPTS` で有界）。`failed` 以外は 409 にする。
- **#43** `serializeMessage` が `bcc` を載せるので、`message.sent` / `message.failed` で送信メールの Bcc が外部 URL に出る。
  `X-Tsubame-Signature` の検証手順（`<t>.<body>` の HMAC-SHA256、定数時間比較、`t` の許容幅）はどの文書にも無い。
- **#44** `addressIds` は `z.array(z.string())` で存在検査も個数上限も無い。`events` も重複を無制限に受ける。
  owner 限定なので今は実害無し。member に開放したときに権限外 id を入れられる。
- **#45** `actions/checkout@v4` / `actions/setup-node@v4` はタグ固定。SHA で固定する。
- **#46** `deploy.sh:40` `sed "s/$PLACEHOLDER/$DATABASE_ID/"`。値に `/` `&` が入ると生成設定が壊れる。
  `^[0-9a-f-]{36}$` を要求する。`trap` は生成直後に張られていて問題なし。
- **#47** `wrangler.jsonc` の `name` と `vars.EMAIL_WORKER_NAME` の一致を誰も確かめていない。
  `tests/domains-helpers.ts:14` は固定値を与えるだけ。読んで assert するテストを 1 本足す。
- **#48** `vitest.config.ts` と `seed-local.mjs` の既知の `INTERNAL_SECRET` は 20 文字以上で長さ検査を通る。
  本番に自動で流用される経路は無い。運用者がそのまま `wrangler secret put` した場合だけ成立する。
  bootstrap で既知の 2 値を拒否する。

### 49〜54.【低】表示・認証の残り

- **#49** `attachments.ts:80` `rawRouter` は `message/rfc822` + `inline`。`nosniff` と `default-src 'none'` が付くので
  外部読み込みは起きないが、`.eml` の中身は攻撃者の HTML。`attachment` にしない理由が無い。ブラウザ描画は未確認。
- **#50** Hono 4.13.7 の `HonoRequest.json()` は `text().then(JSON.parse)` で `Content-Type` を見ない。
  `<form enctype="text/plain">` で JSON 風ボディを POST されると受理される。Cookie が `Lax` なのでクロスサイトでは
  成立しないが、同じ登録ドメインの別サブドメインからは成立する。`readJson` で `application/json` を要求する。
- **#51** `architecture.md` §4 の表とのずれ: `GET/PATCH /me` は表では `read` だが実装はスコープ検査無し（自分の情報のみ）。
  `POST /messages/:id/reply` は表では `send` だが実装は `read` かつ `send`（厳しい側）。`GET /v1/openapi.json` は実装が無い。
  `sendMessageInput.threadId`（`contracts/send.ts:37`）は `outbound.ts` POST で使われていない。使い始めた瞬間に
  「他人のスレッドに自分の送信を刺す」検証無しの経路になる。消す。`createUserBody` の `superRefine` は no-op で、
  `agent` に `password` を付けると POST は黙って捨て PATCH は 400。zod に `strict()` は無く、Zod 4.5.4 の
  `z.object` は未知キーを落とす（`PATCH /me` に `role` を入れても無視される）ことを確認。方針として問題ないが自覚しておく。
- **#52** `LOGIN_RATE_LIMIT` の鍵が `login:${ip}:${email}` の組だけなので、1 IP から N メール、N IP から 1 メールの
  どちらも上限が無い。bootstrap には制限が無い（`auth.ts:146`）が、オーナーが 1 人でも居れば合言葉照合の前に 409 で
  抜けるので、窓はデプロイ直後〜初回 bootstrap の間だけ。`notes.md` の「未確認」が成立。
- **#53** `password.ts:93` `b % alphabet.length`（56 文字、256 % 56 = 32）で先頭 32 文字が 5/256、残りが 4/256。
  20 文字で 100 bit 超あるので実害は無い。
- **#54** `admin/users.ts:132-137, 176` は `countActiveOwners` → `update` の間にトランザクションが無い。
  オーナー 2 人が同時に互いを降格すると 0 人になりうる。D1 で再現はしていない。1 文の `UPDATE … WHERE (SELECT count(*) …) > 0` にする。

### 第 2 回で問題なしと確認した範囲

**S-1 認証**
- KDF は `pbkdf2$sha256$<iter>$<salt>$<hash>` の自己記述形式、100,000 回、`needsRehash` がログイン時に貼り替え。
  `timingSafeEqual` / `secretEquals` は長さを XOR に畳んで最大長まで回る。パスワードは 12〜200 文字。
- セッショントークン 32 バイト、API キー `tsb_` + 32 バイト、DB は SHA-256 のみ、平文は発行応答だけ。
  Cookie は `httpOnly / secure / SameSite=Lax / path=/` を 1 か所で決め発行と失効で共有。絶対期限 30 日、
  期限切れは弾いて削除、ログアウトは行を消す。パスワード変更・無効化・ロール変更で `sessions` を全削除し、
  `loadActiveUser` が null を返すので cascade に依存しない。
- API キーの `revokedAt` / `expiresAt` を毎リクエスト検査、持ち主の `status !== "active"` で即無効。
  `touchLastUsed` の失敗は認証結果に影響しない。成功時に毎回新しいセッション。
- 失敗文言は 4 ケース同一。`status !== "active"` の判定は KDF の後なので無効ユーザーは時間でも区別できない。
  agent は `passwordHash` null で `verifyPassword` が false。bootstrap は `INTERNAL_SECRET` 未設定・20 文字未満で
  誰も作れず、オーナーが居れば 409。最後の有効オーナーは降格・無効化・削除できず、自分自身への操作も同じコードを通る。
- `clientIp` は `cf-connecting-ip` 優先。Cloudflare の外でだけ XFF に落ちるが、そこには `LOGIN_RATE_LIMIT` も無い。
  用途はレート制限の鍵と記録のみで認可には使っていない。

**S-2 認可**
- `userId` で絞るメールデータのクエリは無い（該当は users / sessions / api_keys / address_grants）。
- IDOR: `messages.ts` PATCH は `getMessage`（addressIds）を通してから update。`threads.ts` は `getThread` と
  `queryThreadMessages` が両方 addressIds を見る。`attachments.ts` は親 message の `addressId` を `assertCanAccess`。
  reply は `canRead` → 404、`canSendFrom` → 403（`notes.md` の「返信だけ 403」は却下。読めない id は 404 に揃っており、
  403 は「読めるが書けない」ときだけで、存在は既に分かっている）。
- `addressFilter` の分岐は `buildMessageConditions`（`conds[0]`）、`queryThreads`、`getThread`、`queryThreadMessages`、
  `getMessage` で一貫。`"all"` は `role === "owner"` のときだけ。grant 0 件の member は `addressIds: []` で、
  drizzle 0.45.2 の `inArray(col, [])` は `false` を生成する（`conditions.js:73` で確認）。
- `resolveMailboxId` は権限外・不存在とも null → 空応答。
- API キーは積集合。`clampScopes` / `clampAddressIds` は principal 基準。admin 発行は対象ユーザーの `readable` で検査。
  未知スコープは `normalizeScopes` が落とす。member が `admin` スコープ付きキーを作れるが `requireOwner` / `isOwner` は
  `role === "owner"` を先に要求し、`hasScope("admin")` だけで通る箇所は無い。
- 書き込み集合: `assertCanSend`、PATCH の status、reply がすべて `writableAddressIds`。
- マスアサインメント無し。id は `<prefix>_<nanoid 21 桁>` で推測不能、別テーブルの id を混ぜても 404。
- **パスパターン**（Hono 4.13.7 で `app.ts` と同じ構成を 30 パターン実走）: `/api/v1/messages`（末尾スラッシュ無し）は
  `/api/v1/messages/*` の門を通る。`%61` は `decodeURI` で門もハンドラも同じ復号後パスを見る。`%2F` は復号されず 404。
  `/api/v1/Messages`、`//messages`、`/api//v1` は門にもハンドラにも当たらず 404。`..` と `%2e%2e` は `URL` が正規化して
  両門を通る。HEAD は GET に変換され門を通る。認証を飛ばして到達するハンドラは無い。
- **エンドポイント × スコープの表**を埋めた。空欄は無く、ずれは #51 に集約した。

| エンドポイント | read | send | admin | member | owner |
| --- | --- | --- | --- | --- | --- |
| GET/PATCH /me、/me/api-keys、GET /auth/session | 200 | 200 | 200 | 200 | 200 |
| GET /addresses | 200 grant 内 | 403 | 403 | 200 grant 内 | 200 |
| GET /messages、/messages/:id、/:id/raw、/threads、/threads/:id、/attachments/:id | 200 grant 内 | 403 | 403 | 200 grant 内 | 200 |
| PATCH /messages/:id（isRead / isStarred） | 200 grant 内 | 403 | 403 | 200 grant 内 | 200 |
| PATCH /messages/:id（status） | 403 | 403 | 403 | 200 write grant のみ | 200 |
| POST /messages | 403 | 202 write 集合内 | 403 | 202 write grant のみ | 202 |
| POST /messages/:id/reply | 403 | 403（read も要る） | 403 | 202 write grant のみ | 202 |
| /webhooks/*、/admin/* | 403 | 403 | 200 | 403 | 200 |

**S-3 受信**
- 受信ハンドラでパースしない。`setReject` / `forward` は `incoming.ts` のみ。25MB 判定は `rawSize` があるときは
  email ハンドラ、無いときはコンシューマの `rawObj.size` で、両方の経路が閉じている。
- 宛先解決はエンベロープ基準。順序は拒否 → 完全一致 → `+タグ` → ルール → catch-all で固定。`candidates = [to, base]` を
  拒否判定にも配送にも使い、`ruleTargets` で NFKC 小文字も当てる。`baseAddressOf` は最初の `+` 以降だけ落とす。
  `toAsciiDomain` は `URL` に通す前に `/?#:@\%` と空白を弾く。catch-all は完全一致とルールの後でドメインあたり 1 件。
- スレッド接ぎ木は `addressId` で絞り、`capReferenceIds` で 40 個に抑えて D1 のバインド上限内。
- `From` が無い・複数・グループ構文は `flattenAddresses` が先頭を取り、無ければ null（実証済み）。
- `spam_verdict` を書く側は無い（`notes.md` の「未確認」が成立。要件が「読むだけ」でよいかは要件側の判断）。
- R2 キーはサーバ採番のみ。二重処理は `rawR2Key` の重複検査で return。`clampUtf8` は多バイト文字の途中で切らない。
- CPU: 60,000 パート・2.5MB のパースが 506 ms、24MB の text/plain が 56 ms（node）。CPU 面の毒メッセージは見つからなかった。

**S-4 表示と配信**（Chrome 実機で確認）
- `dangerouslySetInnerHTML` / `innerHTML` は `src/ui` に 0 件。件名・差出人名・アドレス・スニペット・ファイル名・
  API エラー文はすべて JSX のテキスト。`href` は `AttachmentApi.url(a.id)`、`to=` は `/threads/${id}` のみ。
  `style={{background}}` は `hexColor` 検証済みの色だけ。`details` は描画していない。
- `sandbox="allow-same-origin"` のみ。根拠は `onLoad` で `contentDocument.body.scrollHeight` を読むため。
  スクリプトが動かないので srcdoc 側から親 DOM には触れない。`<script>`、`javascript:` リンク、`target="_top"`、
  フォーム送信はすべて不発。
- meta CSP は iframe の `head` の最初の要素になり、攻撃者の `<html><head>` はパーサに無視・マージされ標準モード。
  攻撃者の `<meta http-equiv=CSP content="img-src *">` は積集合で緩まず、`<base href>` は `base-uri 'none'` で無効。
- `<meta http-equiv="refresh">` は sandbox の automatic features フラグで止まる。**本文リンクのクリックによる枠内
  ナビゲーションは sandbox だけでは止まらず、親 `_headers` の `default-src 'self'`（`frame-src` にフォールバック）が止める。**
  同一オリジンへの遷移は `frame-ancestors 'none'` で表示されない。つまり枠内フィッシング対策は `_headers` に依存し、
  `npm run dev`（Vite）では再現しない。
- `_headers` は Vite が `dist/client` 直下へコピーし、`run_worker_first: ["/api/*"]` で `/api` 以外は Worker を通らないので
  効く条件を満たす。実機の応答ヘッダは未確認。
- API は `secureHeaders` で CSP、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy: no-referrer`、CORP / COOP、HSTS。
  `onError` の応答にも付く。`c.json` は `application/json`。
- 添付の `filename*=UTF-8''` + `encodeURIComponent` は `"` → `%22`、CRLF → `%0D%0A`。`Headers.set` 自体も CRLF を例外にする。
  `Attachments.tsx` は `target="_blank" rel="noopener noreferrer"`。
- `?next=` オープンリダイレクト: react-router 8.3.1 は `router.navigate` で `validateNavigationTarget(…, "reject")` を通し、
  `//evil.example`、`/\evil.example`、`https://evil.example` を拒否する（実物の router を Node で動かして 5 パターン確認）。
  `notes.md` の「未確認」は**却下**。ただしライブラリ依存なので `Login.tsx` で `/` 始まりかつ `^[\/\\]{2}` でないことを
  自前で検査しておくのを勧める。`api.ts:68` の `location.href` は自オリジン固定。
- GET に副作用なし（`last_used_at` の更新のみ）。変更系は全部 JSON ボディ。CORS 設定なし。

**S-5 送信**
- 差出人は `assertCanSend`（`requireScope("send")` → DB で解決 → `writableAddressIds`）。返信は `from` を受け取らず
  メッセージのメールボックスから導く。送信経路は `enqueueOutbound` → キュー → `processOutboundSend` の 1 本。
- ヘッダ注入: 件名・表示名は mimetext が base64 化。宛先アドレスは `toMailboxObjects` の `assertNoLineBreak`、
  Message-ID 系は `formatMessageIdList`、添付名は zod + `assertNoLineBreak` + `"` `\` エスケープ、Content-Type は
  `MIME_TYPE` 正規表現。受信由来の CRLF 入り件名・表示名・Message-ID をすべて返信経路に流して**注入が成立しないこと**を実証した。
- `Message-ID` は `<{messageId}@{from のドメイン}>` で自前採番。`collectRecipients` は正規化後の集合で重複排除。
  添付 base64 不正は 400。転送ループヘッダの付与と検査あり（2 つの tsubame ドメイン間の相互転送も 2 ホップ目で拒否）。
  ルール作成は owner かつ admin。バックオフ 10/60/300 秒、最大 4 回。

**S-6 検索**
- `sql.raw` は 0 件。`sql\`` の `${}` はすべて数値・カラム参照・事前生成の文字列で、連結後にタグへ渡す箇所は無い。
- `escapeFtsTerm`: `"` を空白に置換して全体を引用。sqlite 3.51.0 の trigram で `"subject:x"`、`"x OR y"`、`"x*"`、
  `"NEAR(...)"`、`"-x"`、`"^x"`、`"(x)"` はすべて 0 件、`""` もエラー無し（実証済み）。
- LIKE の `%` `_` は未エスケープだが、200,000 文字に対する 32 段の `%a%a…%` が 0.03 秒（実証済み）。DoS にはならず、
  `%` を文字として検索できないだけ。
- `order` は enum、`limit` は 1〜100、`cursor` は base64 → 正規表現で検証してからバインド。アドレス条件は `conds[0]` として
  カーソルと独立に付く。全経路（FTS / LIKE / 関連度順 / スレッド一覧 / スレッド内 / 単体）に `inArray`。
- `parseDate` は形式と範囲を検証、`boolParam` は enum。
- セキュリティ以外: `order=relevance` でもカーソルは `received_at` 基準なので、2 ページ目は 1 ページ目の最終行より新しい行を
  関連度に関係なく落とす。srcdoc 内の `<a href="#x">` は親 URL に対して解決され `frame-ancestors 'none'` で止まって
  本文領域がエラー表示になる（安全側だが目次付きニュースレターで表示が壊れる）。

**S-7 外部連携**
- SSRF 判定 `webhookUrlProblem` を node で 62 ケース呼んだ（再検査 #12 と同じ結果）。`user:pass@host` と任意ポートは通るが
  `https:` 固定で内部 IP は弾かれ、`fetch` は資格情報付き URL を TypeError で落とす。`[64:ff9b:1::/48]` と `[100::/64]`、
  `.corp` / `.lan` は通るが Workers から到達できる内部網ではない。`1.1.1.1.nip.io` のような DNS 名は文書どおり防げない。
- 署名は `HMAC-SHA256(secret, "<t>.<body>")`、`t` は `delivered_at`。`secret` は 32 バイト CSPRNG で作成応答にだけ出る。
  応答本文は保存せず `httpStatus` と `err.message` の先頭 500 文字のみ。`addressIds` の絞り込みは `message.addressId` の包含で効く。
- トークンは `#token` に閉じ `Authorization` にしか入らない。`ApiError` の `details`（`path` に zone_id、`bodySnippet` 200 文字）は
  owner の後ろでしか生成されない。`domains.last_error` に Cloudflare の応答文が入るが読めるのは owner だけ。
- `zoneId` は `listAllZones` の結果と突き合わせ `isWithinZone` を見てから使う。apex は `confirmApex` 必須、catch-all は
  `confirm` 必須かつ受け皿の存在確認。権限表と `cfEndpoints` の対応は一致（`Zone Settings – Edit` だけ対応する呼び出しが無く
  過剰の可能性。未確認）。

**S-8 シークレット・ログ**
- `.gitignore` が `.env*` / `.dev.vars` / `wrangler.local.jsonc` / `*.local` を覆う。全履歴で `tsb_[A-Za-z0-9_-]{16,}` 0 件、
  `INTERNAL_SECRET=` / `CF_API_TOKEN=` / `AUTH_SECRET=` の非空値 0 件、秘密ファイルがコミットされた履歴無し。
  `wrangler.jsonc` の `database_id` はプレースホルダのみ（`namespace_id: "1001"` はレート制限の任意 ID）。
- `console.*` 11 か所は id・件数・`err`・`lastError` のみ。`consumer.ts:21` は未知の種別のときだけ `body` を出す。
- `onError`: `ApiError` は `toJSON`、それ以外は固定文言の 500 でスタック無し。zod の issues は Zod 4 で `input` を含まない（実証済み）。
- `recordAudit` の対象は bootstrap / users / grants / api-keys のみ。webhooks / rules / domains / addresses は無記録
  （観点に既知として書かれているとおり）。`meta` に仮パスワード・トークンは入らない。記録失敗は catch で握る。
- `observability.enabled: true`、`upload_source_maps: true`（ソースマップは Cloudflare に上がる。docs に記述無し）、`keep_vars: true`。

**S-10 サプライチェーン**
- 実行時依存 18 パッケージは MIT / Apache-2.0 / BSD-3-Clause / MIT-0（`postal-mime`）のみ。dev の推移依存に MPL-2.0
  （`lightningcss`）と LGPL-3.0（`@img/sharp-*`）があるが配布物には入らない。
- `npm audit --omit=dev`: 0 件。`npm audit`（dev 込み）: 8 件（high 4 = `sharp` ← miniflare / wrangler、
  moderate 4 = `esbuild` ← drizzle-kit）。ビルド・テスト時のみ。
- `pull_request_target` 不使用。シークレットは `deploy.yml`（`workflow_dispatch` のみ）の `env:` だけ。
  `deploy.sh` の `trap` は生成直後。`migrations/*.sql` に資格情報・権限付与無し。`.githooks/pre-commit` はコメント検査のみ。

**S-11 テスト**
- `tests/webhook-api.test.ts` は `createApp()` を通し、さらにルータ単体でも 403 を検証（webhooks / rules）。
- 否定ケース: fr05（read だけのキーで送信 403・管理 403、send だけのキーで受信不可）、fr11（権限外 404）、
  fr12（他人のメッセージ 404、他人のキー削除不可）、fr04、fr03、fr10。
- テスト用 `INTERNAL_SECRET` は `vitest.config.ts` と `e2e/harness.ts` のみ。受信 e2e は長さ不明の `ReadableStream` で流し、
  エンベロープとヘッダを別に渡せる（fr01 に不一致ケースあり）。
- 第 1 回の 15 件すべてに再発防止テストがある（`outbound-security`、`scope-enforcement`、`inbound`、`security-headers`、
  `routing-resolve`、`thread`、`webhook-api`、`webhook-deliveries`、`auth-admin`、e2e fr05 / fr10 / fr01）。
  ただし #10 のテストは inbound アンカーの経路しか検査していない（再検査のとおり）。
  #13 のルータ単体テストは domains / addresses を含まない（#31）。#25 / #26 を検査するテストは無い。

### 未確認（判断できなかったもの）

- `_headers` が SPA フォールバック応答に実機で付くか。本番の応答ヘッダ全般。
- D1 に NaN / Infinity をバインドしたときの挙動（#32、および `decodeCursor` の巨大数値）。
- D1 の列サイズ上限で `messages` の insert が実際に失敗するか（#22 の空スレッド行）。
- 998 文字超のヘッダ行を Cloudflare Email Sending が拒否するか（#34）。
- 25MB メールのパースが Workers の 128MB メモリに収まるか（node では arrayBuffers +96MB、RSS 772MB）。
- ルール `target` に存在しない id を入れたとき D1 の FK 違反で落ちるか（#38）。
- #26 の遠隔からの判別可能性（Workers 上の KDF 所要時間とネットワーク揺らぎの比）。
- #54 の D1 上での同時実行の再現。
- `Zone Settings – Edit` 権限が実際に必要か。
- 生 MIME `inline` のブラウザ描画（#49）。
- 空 matcher の警告を UI が出しているか。
- `<a>` の pointerdown 時に Chrome が行う投機的 preconnect（クリック時点の漏えいなので画像許可と同程度）。

---

## 第 1 回の詳細

## 1. 【重大】`inReplyTo` から CRLF ヘッダインジェクション

`src/domain/mail/compose.ts:53`、入口は `POST /api/v1/messages`。

```ts
if (input.inReplyTo) msg.setHeader("In-Reply-To", input.inReplyTo);
```

スキーマは `inReplyTo: z.string().optional()`（`shared/contracts/send.ts:24`）で、
形式検査が無い。`mimetext` の `setHeader` は非標準ヘッダを**素通し**する
（件名と表示名は base64 エンコードされるので安全だが、ここは違う）。

**実証**: プロジェクトの `node_modules/mimetext` をそのまま使って確認した。

```
In-Reply-To: <a@b.com>
Bcc: attacker@evil.com     ← 注入された
X-Injected: yes            ← 注入された
```

`send` スコープを持つ相手なら誰でも、送信するメールに任意のヘッダを足せる。
`\r\n\r\n` で本文を丸ごと差し替えることもできる。

**直し方**: `composeMime` の `setHeader` 呼び出し前に `[\r\n]` を弾く。
併せて zod で `/^<[^\s<>]+>$/` を要求する。`referencesHeader` も同じ。

## 2. 【重大】`stripHeader` が注入された Bcc を残す

`src/services/sender.ts:31`。

```ts
const re = new RegExp(`^${name}:[ \\t].*(?:\\r?\\n[ \\t].*)*\\r?\\n?`, "im");
return raw.replace(re, "");
```

`g` フラグが無いので `replace` は**最初の 1 つ**しか消さない。
`mimetext` はヘッダの順序が固定で、正規の `Bcc` が先に出る。
その結果 #1 と組み合わさると、**正規の Bcc が消え、攻撃者の Bcc が残る**。

**実証**: `sender.ts` の正規表現をそのまま複製して確認した。

```
legit bcc still present   : false   ← 正規のBccは消えた
ATTACKER bcc still present: true    ← 攻撃者のBccは残った
```

Bcc をヘッダから隠すという対策自体が、注入があると逆に働く。
#1 が無くても、Bcc ヘッダが 2 行出る状況が生まれれば実 Bcc が漏れる。

**直し方**: `"gim"` にして、一致が無くなるまで回す。
そもそも Bcc ヘッダを組み立てず、エンベロープ宛先だけで配るほうが安全。

## 3. 【高】`read` スコープが受信系で一切検査されていない

`src/api/v1/messages.ts:107,137`、`threads.ts:20,72`、`attachments.ts:22,44`。

`src/api/` 全体で `requireScope` が一度も import されていない。
メールを読む主要 6 経路のどれも、スコープを見ていない。

**実証**: `scopes: ["send"]` だけのキーを発行し、受信メールを取得できた。

```
listStatus: 200
subjects:   ["秘密の件名"]     ← 読めてはいけないキーで読めた
threadStatus: 200
```

送信専用のつもりで AI に渡したキーが、受信箱・スレッド・添付・生 MIME を
すべて読める。アドレス集合だけが唯一の歯止めになっていて、
スコープは受信系に関しては飾りになっている。

要件 FR-5 は「キー単位でスコープを限定できる」ことを中心に据えているので、
これは要件そのものが満たせていない。

**直し方**: messages / threads / attachments のルータにまとめて
`requireScope(principal, "read")` を掛ける。

## 4. 【高】`read` だけのキーでメッセージを変更・削除できる

`src/api/v1/messages.ts:146` の `PATCH /:id`。欠陥は 2 つ重なっている。

- `requireScope` が無い（他の書き込み経路にはある）。
- 権限判定が `getMessage`、つまり**読み取り集合**で行われている。
  `writableAddressIds` を見ていない。

**実証**: `scopes: ["read"]` のキーでメッセージを `trash` にできた。

```
status: 200, newStatus: "trash"
```

`read` 権限だけを渡したはずの共有メールボックスで、相手がメールを
捨てられる。既読・スター状態も同様に書き換えられる。

**直し方**: `requireScope(principal, "send")` と
`canWrite(principal, cur.addressId)` を足す（不一致は 404 に揃える）。

## 5. 【高】受信経路にサイズ・件数の上限が無い

`domain/routing/incoming.ts:45`、`domain/mail/inbound.ts:86-146`。

```ts
const raw = new Uint8Array(await rawObj.arrayBuffer());  // 全体をメモリに載せる
const parsed = await parseRawMime(raw);                   // 添付も全部展開する
for (const att of parsed.attachments) { ... }             // 個数の上限が無い
```

`rawSize` の検査、添付の個数・サイズの検査、本文長の検査がどこにも無い。
D1 は 1 行あたり約 1MB が上限なので、大きな `html_body` は insert が例外になり、
`consumer.ts:26` が `item.retry()` を呼ぶ。**毒メッセージが再試行で回り続け**、
そのたびに R2 の読み直しとパースをやり直す。

見知らぬ第三者がメールを 1 通送るだけで起こせる。

**直し方**: email ハンドラで `message.rawSize` に上限（例 25MB）を設けて
`saveRaw` の前に弾く。コンシューマで添付の個数と 1 件あたりのサイズを制限し、
`textBody` / `htmlBody` / `snippet` は保存前に切り詰める。

## 6. 【高】セキュリティヘッダが 1 つも無い

`src/worker.ts:14-20` は素通しで、静的資産にも API にもヘッダを足していない。

```ts
if (url.pathname.startsWith("/api/")) return app.fetch(request, env, ctx);
return env.ASSETS.fetch(request);
```

`Content-Security-Policy` / `X-Content-Type-Options` / `X-Frame-Options` /
`Referrer-Policy` のいずれも `src/`・`index.html`・`public/_headers` に無い
（検索して 0 件）。

敵対的な HTML を毎日レンダリングするアプリで CSP が無いのは、
#8 と #11 の被害を止める最後の層が無いということ。クリックジャッキングも防げない。

**直し方**: `worker.ts` の応答に 4 つのヘッダを付ける。ここ 1 か所で #8 の
リスクも下げられる。

## 7. 【中】送信添付のファイル名が R2 キーに素通り

`src/api/v1/outbound.ts:60`。

```ts
const r2Key = `outbound/${messageId}/${i}-${att.filename}`;
```

`filename` は `z.string().min(1)` だけで文字種の制限が無い。
`"../../raw/2026/09/msg_xxx.eml"` のような名前を送ると、
`outbound/` の名前空間から**字面の上で**外へ出る。
R2 のキーは不透明な文字列なので `..` は解決されないが、
`raw/` や `att/` と衝突するキーは作れてしまう。
メッセージ id は送信 API が呼び出し元に返しているので、
**読む権限の無いメールボックスの生 MIME を上書きできる**。

受信側は安全（`att/{messageId}/{attachmentId}` でサーバ採番）。送信側だけが穴。

**直し方**: 送信側も `r2.ts` の `attachmentKey(messageId, attId)` を使う。
利用者の入力をキーに入れない。

## 8. 【中】添付配信が送信者の `Content-Type` をそのまま返す

`src/api/v1/attachments.ts:36`。

```ts
c.header("Content-Type", att.contentType);
```

`contentType` は `parse.ts:83` で送信者の MIME ヘッダから取った値そのもの。
検査も allowlist も無い。`Content-Disposition: attachment` が付いているので
通常のブラウザはダウンロード扱いにするが、`nosniff` も CSP も無い（#6）。
アプリ自身のオリジンから攻撃者の `text/html` を配る形になっている。

**直し方**: 型を allowlist するか `application/octet-stream` 固定にする。
`X-Content-Type-Options: nosniff` を付ける。できれば別オリジンから配る。

## 9. 【中】`+タグ` で拒否ルールを回避できる

`src/domain/routing/resolve.ts:41-51`。

拒否ルールの判定は `to` の**そのままの値**に対して行われる（`matchRule` は
部分一致）。その後の配送判定だけが `baseAddressOf(to)` で `+タグ` を落とす。

拒否ルール `to: "victim@example.com"` があるとき、
`victim+x@example.com` 宛に送ると:

1. 拒否の判定 — `victim+x@example.com` に `victim@example.com` は含まれないので**一致しない**
2. 配送の判定 — `+x` を落として `victim@example.com` として**配送される**

1 文字足すだけで拒否をすり抜ける。
`normalizeAddress` に Unicode / punycode の正規化も無いので、
同形異字のアドレスも同様に素通りする（catch-all が有効なら配送まで届く）。

**直し方**: `candidates` を拒否判定より先に組み立て、拒否ルールを
リテラルと基本アドレスの**両方**に対して評価する。

## 10. 【中】偽装 `In-Reply-To` で他人のスレッドに紛れ込める

`src/domain/mail/thread.ts:25-34`。アドレスによる絞り込み自体は正しく、
アドレスをまたぐ混入は起きない。

問題は、受信メールの `rfcMessageId` が**送信者が書いた `Message-ID`**
だということ。このメールボックスから返信を受け取ったことのある相手は、
その返信の `Message-ID` を知っている。それを `In-Reply-To` に入れて
新しいメールを送ると、**既存のスレッドに接ぎ木される**。

読む側には、信頼している会話の続きとして表示される。
そのままスレッドから「全員に返信」すると攻撃者が宛先に入る。

**直し方**: 接ぎ木の対象を `direction: "outbound"` のメッセージに限る
（またはスレッドの既存参加者からの送信に限る）。
受信メールの `Message-ID` を、後続の受信メールのアンカーとして信用しない。

## 11. 【中】リモート画像が既定で読み込まれる

`src/ui/components/MessageHtml.tsx`。

**XSS は成立しない。** `sandbox="allow-scripts"` を付けていないので、
`<script>`・`onerror=`・`javascript:` はすべて動かない。
ファイル冒頭のコメントどおり、この設計は意図的で、実際に効いている。
`dangerouslySetInnerHTML` も `innerHTML` も `src/` に 1 件も無い。

ただし CSP が無いため、外部のサブリソースは自由に読み込まれる。
`<img src="https://attacker/p.png">` はメールを開いた瞬間に発火し、
開封の事実・IP・おおよその位置が、メールを送ってきただけの他人に渡る。

**直し方**: iframe に `csp="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`
を付ける。リモート画像は「表示する」を明示的に押したときだけ読み込む。

## 12. 【中】Webhook が SSRF に使える（owner 限定）

`src/services/webhooks.ts:159`。

署名自体は正しい。`v1 = HMAC-SHA256(secret, "<t>.<body>")` にタイムスタンプが
入っていて、リプレイの窓を絞れる形になっている。`secret` はレスポンスにも
配信履歴にも出ていない。

一方 `fetch(webhook.url, …)` には `z.string().url()` 以外の制限が無く、
リダイレクトも既定で追う。`http://127.0.0.1/…` や、公開 URL から
リンクローカルへ 302 する経路が使える。

登録は owner 限定（`app.ts:50` の `requireOwner`）なので、権限昇格ではない。

**直し方**: `https:` のみ許可し、private / link-local / loopback を弾く。
`redirect: "manual"` にする。

## 13. 【中】権限判定の重複実装が 2 か所で弱い

現状は `app.ts:49-50` の `requireOwner` が先に効くので**悪用はできない**。
ただし判定が二重に書かれていて、内側が弱い。

`src/api/v1/webhooks.ts:17-21` — `policy.ts` の `requireOwner` は
「owner ロール **かつ** admin スコープ」だが、こちらは **または** になっている。

```ts
if (principal.role === "owner") return;          // admin スコープ無しでも通る
if (principal.scopes.includes("admin")) return;  // owner でなくても通る
```

`src/api/v1/admin/rules.ts:12-15` — ロールだけを見て `admin` スコープを見ていない。
ルーティングルールは受信メールの `reject` / `forward` を握るので、
ここが緩むと転送による持ち出しに直結する。

さらに `tests/webhook-api.test.ts:34` は `requireOwner` を通さずに
ルータを単体で載せているため、**テストは弱いほうの門を検査している**。
`app.ts` のマウントを変えた瞬間に、気付かないまま穴になる。

**直し方**: 重複実装を消して `policy.ts` の `requireOwner` を呼ぶ。
テストのマウントも本番と揃える。

## 14. 【低】受信の `to_addr` にヘッダ値を保存している

配送そのものは正しい。`handleIncomingEmail` は `message.to`（エンベロープ）で
解決していて、MIME の `To:` ヘッダを権限判断に使っている箇所は無い。

ただしエンベロープはキューに載せた後（`incoming.ts:50`）使われず、
`processInbound` は `toAddr: parsed.to`（**ヘッダ値**）を保存している
（`inbound.ts:119`）。ルールのマッチも同じ値で行う（`inbound.ts:158`）。

攻撃者は実際の宛先を含まない `To:` ヘッダを書けるので、
アドレススコープのルールをすり抜けられるし、UI にも誤った宛先が出る。

**直し方**: `msg.envelope.to` を併せて保存し、ルールの照合はエンベロープで行う。

## 15. 【低】一覧に上限が無いものがある

`admin/api-keys.ts:23`（`userId` クエリの zod 検証も無い）、
`admin/users.ts:53`、`webhooks.ts:59` は `next_cursor: null` 固定で
`limit` が無く、全件走査になる。owner 限定なので権限の問題ではないが、
アカウントが育つと重くなる。

---

## 第 1 回で問題なしと確認した範囲

数が多いので、**特に念入りに見て問題が無かった**ものを挙げる。

- **SQL インジェクション — 無い。** `src/` 全体で `sql.raw` が 0 件。
  検索の値はすべて drizzle のタグ付きテンプレートでバインドされる。
  `%…%` は JS 側で組んでから `like()` に**値として**渡しているので連結ではない。
- **FTS5 の MATCH 注入 — 塞がっている。** `escapeFtsTerm`（`sql.ts:86`）が
  `"` を除去して全体を引用符で囲む。実機の SQLite FTS5 に対して
  `subject:report`・`report OR notice`・`rep*`・`NEAR(...)`・`a" OR "b` を試して、
  すべて 0 件（ただの文字列として扱われる）ことを確認した。
- **検索のアドレス絞り込み — 落ちない。** `inArray(messages.addressId, …)` が
  分岐より**前**に `conds[0]` として積まれ、FTS は `exists (…)` の相関副問い合わせ。
  MATCH 式の中でスコープを表現していないので、クエリの形が変わっても外れない。
- **`limit` / `order` / `cursor`** — `limit` は 1〜100 に制限、`order` は enum で
  ORDER BY に文字列として入らない、`cursor` は正規表現で検証してからバインドされる。
  改竄しても、絞り込み済みの集合の中で位置がずれるだけ。
- **送信の差出人検証 — 正しい。** `assertCanSend`（`outbound.ts:34`）は
  DB でアドレスを解決してから `writableAddressIds` と `send` スコープを見る。
  返信経路は `from` をリクエストから取らず、メッセージ自身のメールボックスから導く。
- **API キーが権限を広げられない。** `resolvePrincipal`（`policy.ts:69`）が
  必ず積集合を取る。`me.ts` の `clampScopes` / `clampAddressIds` は
  「今のリクエストの権限」に対して制限するので、絞ったキーから広いキーは作れない。
  広げる経路を探したが作れなかった。
- **マスアサインメント — 無い。** すべての `.set()` / `.values()` が
  明示的に項目を組み立てている。リクエストボディを展開している箇所は無い。
- **秘密のログ出力 — 無い。** `console.*` は 10 か所すべて id かエラーのみ。
  Cloudflare API トークンは private field で、ヘッダにしか入らない。
- **`.env` は git に入っていない。** `git ls-files` に無く、`.gitignore:3` が
  カバーしていることを確認。全履歴を検索してもトークンは出てこなかった。
  ただし作業ツリーの `.env` には実キーが平文で置いてある（共有マシンなら注意）。
- **XSS — 成立しない。** #11 のとおり iframe の sandbox が効いている。
- **DNS の後片付け — 保守的。** `isOwnDnsRecord`（`cleanup.ts:57`）は
  apex を触らず、MX は `mx.cloudflare.net` 宛、SPF は `_spf.mx.cloudflare.net`
  参照、DKIM は `cf-bounce._domainkey.` に限定し、DMARC には触らない。
  条件に合わないものは消さずに `skippedDnsRecords` として報告する。
- **転送ループ防止 — ある。** `X-Tsubame-Forwarded` を付けて再入時に弾く。
- **CSRF — 実害のある経路は無い。** 変更系はすべて JSON ボディの
  POST/PATCH/DELETE で、`parseBody` / `formData` は 0 件。
  GET は 24 本すべて読み取り専用。Cookie は `httpOnly` / `secure` / `SameSite=Lax`。
- **CORS — 設定が無いのが正解。** 同一オリジン配信なので、無いことで
  クロスオリジンの呼び出しが自然に塞がっている。
- **`npm audit`** — 実行時依存の脆弱性は 0。指摘はすべて devDependencies
  （`drizzle-kit` → `esbuild`、`vitest-pool-workers` → `miniflare`）。
- **CI** — `pull_request_target` は使っておらず、シークレットは
  `workflow_dispatch` 限定の `deploy.yml` にのみ登場し、`env:` 経由で渡している。
- **マイグレーション** — 既定の資格情報や広い権限付与は無い。

## 直す順番（第 1 回。対応済み）

1. **#1 と #2**（ヘッダ注入と Bcc 漏れ）— 送信経路の 2 行。実証済みで、影響が最も重い。
2. **#3 と #4**（スコープ検査）— 要件 FR-5 の中心が機能していない。
   根本原因は 1 つで、`src/api/` が `policy.ts` の助けを一度も使わず、
   各ハンドラが自前で判定を書いていること。ここを通せば #13 も同時に消える。
3. **#5**（受信の上限）— 見知らぬ第三者が 1 通で起こせる。
4. **#6**（セキュリティヘッダ）— `worker.ts` の 1 か所で #8 と #11 の被害も下がる。
5. 残り。
