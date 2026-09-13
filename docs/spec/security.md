# セキュリティ観点 — tsubame

このアプリが守るべきものと、それを壊しうる経路を洗い出したもの。
コードレビューと監査のチェックリストとして使う。前提は
[要件](requirements.md) と [設計](architecture.md)。
この観点でコードを精査して、直さないと決めたものは [受け入れた制約](constraints.md)（以下「精査 #n」）。
読んで疑っただけのものも、確かめて却下したものも同じ場所に置く。
走らせないと確かめられないものは [これからやること](todo.md) §2。

## 1. 何を守るのか

| 資産 | 壊れたときに起きること | 置き場所 |
| --- | --- | --- |
| メール本文・添付 | 他人の受信箱が読まれる。業務上もっとも重い | D1 `messages` / R2 `raw/` `att/` `outbound/` |
| `INTERNAL_SECRET` | 誰でも最初のオーナーになれる = Cloudflare の DNS まで取られる | Worker Secret |
| Cloudflare API トークン（`CF_API_TOKEN`） | ゾーンの DNS を書き換えられる。ドメイン全体のメールを奪われる | Worker Secret |
| セッション Cookie / API キー | なりすまし。API キーは AI に渡す前提なので露出面が広い | D1 `sessions.token_hash` / `api_keys.key_hash` |
| パスワードハッシュ | 総当たりの起点 | D1 `users.password_hash` |
| ドメインの MX / DNS | 全メールの経路を奪われる。apex を奪うと巻き添えが最大 | Cloudflare ゾーン |
| 送信ドメインの評判 | 踏み台にされると SPF/DKIM ごと信頼を失う | Email Sending |
| Webhook の `secret` | 偽の受信通知を外部システムに信じ込ませられる | D1 `webhooks.secret` |

## 2. 誰が攻撃者になりうるか

このアプリの特徴は、**攻撃者の 1 つが「見知らぬ第三者」である**こと。
メールアドレスを公開している以上、誰でも任意のバイト列をこのシステムに流し込める。

| 攻撃者 | 持っているもの | 主な狙い |
| --- | --- | --- |
| 匿名の送信者 | 任意の MIME を送る能力のみ | XSS、パース段の DoS、スレッド汚染、拒否ルールの回避、返信先の差し込み |
| 匿名の HTTP クライアント | URL を知っているだけ | ブートストラップの奪取、ログイン総当たり、未認証エンドポイント |
| `member` | ログインと自分のアドレス | 他人のアドレスの閲覧、権限昇格 |
| `agent`（AI） | 絞られた API キー | スコープ外への逸脱。**プロンプトインジェクションで乗っ取られている前提で考える** |
| 漏れた API キー | キー 1 本 | キーに付いた範囲すべて |
| Webhook の受け手 | 通知を受ける URL | 応答を遅らせて Worker を拘束する程度。信頼しない |
| `owner` | 管理の全権。メールは割り当てたアドレスだけで、全部を読むには管理者モード（セッション限定・1 時間・監査ログ） | 脅威ではないが、誤操作の爆風（apex 奪取、catch-all、SSRF）を設計で抑える。管理者モードは「読めるだけ」にし、入った・出たを残す |

**AI エージェントは信頼された攻撃者として扱う。** 受信メールの本文には攻撃者の書いた
文章が入る。それを読んだエージェントが自分の API キーで動くので、
「キーのスコープ = 被害の上限」になる。スコープの実装は最後の砦であって、
運用の注意で補えない。

## 3. 入口と経路の早見表

攻撃者が触れる入口は 5 つしかない。観点を当てる前に、まずここを押さえる。

| 入口 | 誰が | 何を流し込めるか | コード |
| --- | --- | --- | --- |
| HTTP `/api/*` | 誰でも（認証前）／各ロール | JSON ボディ、クエリ、パス、ヘッダ、Cookie | `src/worker.ts` → `src/api/app.ts` → `src/api/v1/**` |
| email ハンドラ | 匿名の送信者 | エンベロープ（from / to）、生 MIME 全体 | `src/domain/routing/incoming.ts` |
| キュー | 上の 2 つが積んだもの（間接） | R2 に置いた生 MIME、送信ジョブ、Webhook の配信、通知の判定 | `src/services/consumer.ts` → `domain/mail/inbound.ts` / `outbound.ts` / `services/webhooks.ts` / `services/notify.ts` |
| Webhook の応答 | 通知先の運営者 | HTTP ステータス、応答遅延、リダイレクト | `src/services/webhooks.ts` |
| push サービスの応答 | Apple / Google / Mozilla（と、endpoint を登録した本人） | HTTP ステータス、応答遅延 | `src/services/webpush.ts` → `services/notify/deliver.ts` |

cron（`scheduled`）は外から入力を受けない。

HTTP の認証と認可がどこで掛かるかは `src/api/app.ts` の 1 か所で決まる。

| パス | 認証 | 追加の門 | ハンドラ |
| --- | --- | --- | --- |
| `/api/health`, `/auth/login`, `/auth/logout`, `/auth/setup-state`, `/auth/bootstrap` | 無し | — | `v1/auth.ts` |
| `/auth/session` | `requireAuth`（ルート単体） | — | `v1/auth.ts` |
| `/me/*` | `requireAuth` | ハンドラ内で `principal` を見る。キーの発行・失効は `requireKeyManagement`（セッションか admin キー、仮パスワード中は 403）。`/me/admin-mode` は `role === "owner"` かつ `via === "session"`（それ以外は 403）。`/me/external-email*` は `requireMeSession`（API キーは 403） | `v1/me.ts` |
| `/me/notifications/*`, `/me/devices/*`, `/push/*`, `/threads/:id/notification` | `requireAuth` | ハンドラ内で `via === "session"` を要求（API キーは 403）。`agent` は対象外 | `v1/notifications.ts`, `devices.ts`, `push.ts` |
| `/messages/*`, `/threads/*`, `/addresses/*`, `/attachments/*`, `/messages/:id/raw` | `requireAuth` | ハンドラ内で `addressIds` を見る。状態の変更（`PATCH /messages/:id`）は `canModify`（管理者モードでは自分の割り当てだけ）。`/addresses/:id/signature` はセッション限定。`/addresses/:id/hidden` は自分の `address_grants` の行だけ | `v1/messages.ts`, `outbound.ts`, `threads.ts`, `addresses.ts`, `attachments.ts` |
| `/admin/*`, `/webhooks/*` | `requireAuth` + `requireOwner`（role が owner **かつ** admin スコープ） | 各ルータの `use("*")` にも同じ `requireOwner` を重ねている（精査 #13）。変更系は `requireUnrestricted`（範囲を絞ったキーは 403。#129）、ユーザー管理の変更系と `/admin/users/:id/external-email` は `requireSession`（#121）、`/admin/audit-logs` は両方 | `v1/admin/**`, `v1/webhooks.ts` |

**信頼できない文字列の追跡表。** 受信メールの各フィールドが、どこを通ってどこで
「実行可能な文脈」に触れるか。監査ではこの表の右端を 1 つずつ確かめる。

| 受信フィールド | 取り出し | 保存 | 出口（実行可能な文脈になる場所） |
| --- | --- | --- | --- |
| エンベロープ `to` | `incoming.ts` | キューの `envelope`（D1 には無い。精査 #14） | 宛先解決 `resolve.ts`、転送ループヘッダ |
| エンベロープ `from` | `incoming.ts` | 無し | 拒否ルールの照合 `resolve.ts` |
| `From` ヘッダ | `parse.ts` | `from_addr` / `from_name` | UI の差出人表示、返信の宛先 `outbound.ts`、引用ヘッダ `quote.ts`、Webhook 本文 |
| `To` / `Cc` ヘッダ | `parse.ts` | `to_addr` / `cc_addr` | アドレスルールの照合 `inbound.ts`、**全員に返信の宛先** `outbound.ts`、UI |
| `Subject` | `parse.ts` | `subject`、`threads.subject` | UI、返信の `Subject` ヘッダ（`quote.ts` → `compose.ts`）、FTS |
| `Message-ID` / `In-Reply-To` / `References` | `parse.ts` | `rfc_message_id` / `in_reply_to` / `references_header` | スレッド接ぎ木 `thread.ts`、**返信の送信ヘッダ** `outbound.ts` → `compose.ts` |
| `Date` | `parse.ts` | `received_at` | 並び順・カーソル `search/sql.ts`、スレッドの `last_message_at` |
| `text/plain` | `parse.ts` | `text_body` / `snippet` | UI（React がエスケープ）、FTS、返信の引用 `quote.ts`、ルールの `contains` |
| `text/html` | `parse.ts` | `html_body` | **iframe `srcDoc`** `MessageHtml.tsx`（リンクは `rewriteLinks` が新しいタブへ）、返信の引用 `quote.ts`（`stripHtml → escapeHtml → <pre>` に落とす。精査 #16） |
| `X-CF-SpamH-Score` / `Authentication-Results`（CF ブロック） | `parse.ts` | `spam_verdict` | 通知の判定 `decide.ts`（`suspicious` は設定次第）、スレッド接ぎ木の許可 `thread.ts`（DMARC / DKIM pass。精査 #127） |
| 添付のファイル名・型・中身 | `parse.ts` | `attachments`、R2 `att/{msg}/{att}` | `Content-Disposition` / `Content-Type` `attachments.ts`、UI のリンク文字列 |
| 生 MIME 全体 | `incoming.ts` | R2 `raw/` | `GET /messages/:id/raw` `attachments.ts` |

## 4. 観点

各項目の末尾に「見る場所」を付けてある。行番号は書かない（すぐずれる）。
関数名で探すこと。

### S-1 認証 — 「誰か」を確定するまで

見る場所: `src/api/v1/auth.ts`（login / logout / bootstrap / setup-state）、
`src/api/middleware/auth.ts`（Cookie と Bearer の解決）、`src/lib/password.ts`、
`src/lib/tokens.ts`、`src/api/v1/me.ts`（パスワード変更・外部アドレス・管理者モード）、
`src/services/verification-mail.ts`（確認コード）、`src/api/v1/admin/external-email.ts`、
`src/api/v1/admin/users.ts`（無効化・ロール変更・プライマリ）、`wrangler.jsonc` の `ratelimits`。

**ログインの識別子（誰として入るか）**
- [ ] ログインに使えるのが「プライマリアドレス」と「確認済みの外部アドレス」だけか。未確認の外部アドレスで入れるのは
      プライマリがまだ無い利用者（ドメインを繋ぐ前の最初の owner）に限るか → `auth.ts` `findLoginUser`
- [ ] 外部アドレスとプライマリが別の利用者を指せないか（外部アドレスは全利用者で一意、かつ `addresses.address` と重ならない。
      解決は外部 → プライマリの順なので、重なると誰として入ったかが曖昧になる） → `verification-mail.ts` `assertExternalEmailAvailable`、
      `admin/users.ts` POST、`db/schema.ts` `users_external_email_idx` / `users_primary_address_idx`
- [ ] 旧 `users.email` 列をログインや一意性の判定に使う経路が残っていないか（今は外部アドレスの写しで、無い利用者は `<id>@users.invalid`）
      → `grep -rn "users.email" src`
- [ ] プライマリの変更・剥奪でログイン識別子が変わることを把握しているか（プライマリは削除・アーカイブ・エイリアス化できず、
      grants から外しても write で残る） → `admin/addresses.ts` `primaryHolder`、`admin/users.ts` PUT grants

**外部アドレスの確認**
- [ ] 確認コードが CSPRNG 由来で偏りが無く、DB にはハッシュだけを置くか → `verification-mail.ts` `generateVerificationCode`、`email_verifications.code_hash`
- [ ] 6 桁のコードに対して、試行回数（5 回で行を消す）と期限（30 分）があるか。総当たりをオンラインで止めているか
      → `verifyExternalEmail`、`VERIFICATION_MAX_ATTEMPTS` / `VERIFICATION_CODE_TTL_SECONDS`
- [ ] 再送に間隔（60 秒）があるか。第三者のアドレスへ確認メールを大量に送る踏み台にならないか
      （登録 `POST /me/external-email` 自体には間隔が無い。宛先を変えれば毎回送れる） → `resendExternalEmail`、`registerExternalEmail`
- [ ] 登録し直すと未確認に戻るか（確認済みのまま宛先だけ差し替えられないか） → `registerExternalEmail` の `externalVerifiedAt: null`
- [ ] 外部アドレスの登録・確認が API キーからできないか（ログイン先そのものを変える操作） → `me.ts` `requireMeSession`、`admin/external-email.ts` `requireSession`
- [ ] owner が他人の外部アドレスを登録できることを把握しているか（監査ログ `user.external_email.set` に `actorId` が残る）
- [ ] 確認メールの差出人の選び方（本人のプライマリ → owner のプライマリ → 送信できる最古のメールボックス）が、
      送信を無効にしたドメインを使わないか → `pickSender`（`domains.sending_status = 'active'` だけ）

**パスワード**
- [ ] KDF（PBKDF2 等）で保存し、反復回数を保存形式に含めて上げられるか。
      Workers の上限（100,000）も把握しているか → `password.ts` `hashPassword` / `needsRehash`
- [ ] ハッシュ比較・シークレット比較が定数時間か（長さでも内容でも早期 return しない）
      → `password.ts` `timingSafeEqual`、`tokens.ts` `secretEquals`
- [ ] 最小長・最大長があるか（最大が無いと KDF が DoS になる） → `contracts/auth.ts` `passwordSchema`
- [ ] 仮パスワードが CSPRNG 由来で、作成応答にしか出ないか → `password.ts` `generateTemporaryPassword`、`admin/users.ts` POST
- [ ] 仮パスワードの利用者が「変更するまで進めない」制御が **UI だけ**になっていないか。
      API 経由なら仮パスワードのまま何でもできるなら、それを要件として意図しているか
      → `ui/routes/AppLayout.tsx`（`mustChangePassword` で遷移）、`me.ts` `requireKeyManagement`（キーの発行・失効だけ 403。#64）、
      `middleware/auth.ts`（他の API は見ていない。精査 #25 の残件として受け入れ）

**ログイン**
- [ ] 失敗の応答が「居ない／無効／agent／パスワード違い」で区別できないか（列挙対策）
      → `auth.ts` `loginFailed`
- [ ] レート制限があり、鍵が IP だけでもメールだけでもないか → `auth.ts` login、`wrangler.jsonc` `LOGIN_RATE_LIMIT`
- [ ] バインディングが無い環境（ローカル、テスト）で制限が黙って消える設計を把握しているか → `auth.ts` `if (limiter)`
- [ ] クライアント IP の取り方が偽装できないか。`cf-connecting-ip` が無いときに
      `x-forwarded-for` へ落ちる経路は Cloudflare の外で動かすと偽装できる → `middleware/auth.ts` `clientIp`
- [ ] 成功時にセッションを新規発行しているか（固定化させない） → `auth.ts` `createSession`

**セッション**
- [ ] トークンが CSPRNG 由来で 32 バイト以上か → `tokens.ts` `generateSessionToken`
- [ ] DB に平文を保存していないか（ハッシュのみ） → `db/schema.ts` `sessions.token_hash`
- [ ] Cookie が `HttpOnly` / `Secure` / `SameSite` / `Path=/` を持ち、発行と失効で属性が一致するか
      → `auth.ts` `sessionCookieOptions`
- [ ] 有効期限が妥当か。絶対期限・アイドル期限のどちらを持つか → `tokens.ts` `SESSION_TTL_SECONDS`、`middleware/auth.ts` `principalFromSession`
- [ ] 期限切れが確実に弾かれ、掃除されるか → `principalFromSession`
- [ ] ログアウトがサーバ側の行を消すか（Cookie を消すだけでないか） → `auth.ts` logout
- [ ] パスワード変更・ロール変更・無効化で既存セッションが落ちるか。購読端末も一緒に消えるか（#130）
      → `me.ts` PATCH、`admin/users.ts` PATCH / DELETE、`auth.ts` logout（その端末の購読）
- [ ] 管理者モード（`sessions.admin_mode_until`）がセッションにだけ付き、期限を**毎リクエスト**見ているか。
      owner から降格されたセッションで残らないか（降格でセッションごと消える） → `middleware/auth.ts` `principalFromSession`、`policy.ts` `resolvePrincipal`

**API キー**
- [ ] 生成が CSPRNG 由来で十分な長さか。接頭辞 `tsb_` で Cookie と混同しないか
      → `tokens.ts` `generateApiKey` / `looksLikeApiKey`
- [ ] ハッシュのみ保存し、平文は発行応答にしか出ないか → `me.ts` / `admin/api-keys.ts` POST、`serializeKey`
- [ ] `expires_at` / `revoked_at` が毎リクエスト検査されるか → `middleware/auth.ts` `principalFromApiKey`
- [ ] 持ち主が `status != active` になった瞬間に効かなくなるか → `loadActiveUser`
- [ ] `last_used_at` の更新が認証結果に影響しないか（失敗しても通す／落とす、どちらを意図しているか） → `touchLastUsed`
- [ ] キーから発行したキーが親に連なり、親の失効・差し替え・持ち主の削除・パスワード変更・無効化で子孫も失効するか（#25 / #142）
      → `api_keys.parent_key_id`、`me.ts` `revokeKeyTree` / `revokeKeysIssuedBy`、`admin/users.ts` PATCH / DELETE

**ブートストラップ**
- [ ] `INTERNAL_SECRET` の一致でしか通らず、未設定・短すぎなら誰も作れないか → `auth.ts` bootstrap
- [ ] オーナーが 1 人でも居れば閉じるか。「居る」の判定が `status` を見るべきか検討したか
      （無効化された唯一のオーナーが居る状態で再ブートストラップできるべきか）
- [ ] 合言葉の照合に**レート制限があるか**。鍵が IP だけなので、バインディングの無い環境では消える
      → `auth.ts` bootstrap（`LOGIN_RATE_LIMIT` を `bootstrap:ip:` の鍵で使う。精査 #52）。
      **ただし本番では binding 自体が発火しない（精査 #147）。今この門は数えていないものとして見る。**
- [ ] `setup-state` が認証無しで「オーナー未作成」を晒すことを許容しているか → `auth.ts` setup-state

### S-2 認可 — 「その人が何をしてよいか」（このアプリの中心）

設計上の不変条件は 1 つ。**すべてのメールデータへのアクセスは、先に確定した
`address_id` の集合で絞られる**（`docs/spec/architecture.md` §5）。

見る場所: `src/domain/access/policy.ts`（`resolvePrincipal` / `resolveUserAddressAccess` / `canRead` / `canWrite` / `canModify` /
`requireScope` / `requireOwner` / `addressFilter`）、`src/api/app.ts`（門の掛け方）、
`src/api/v1/**` の各ハンドラ、`src/domain/search/sql.ts`（`getMessage` / `queryMessages` /
`resolveMailboxId` / `hiddenAddressIds`）、`src/shared/contracts/*.ts`（何を受け付けるか）。

**不変条件**
- [ ] メールデータ（messages / threads / attachments / raw）を `userId` で絞るクエリが無いか
      （共有アドレスと API キーのスコープが同時に壊れる）。
      逆に `api_keys` / `sessions` / `address_grants.hidden` のような**本人所有物**は `userId` で絞るのが正しい
      → `grep -rn "users.id\|userId" src/api src/domain/search`
- [ ] 単体取得・更新・削除が id だけで引かれていないか（IDOR）
      → `messages.ts` PATCH、`threads.ts` `/:id`、`attachments.ts` 両ルート、`outbound.ts` reply
- [ ] `addressFilter()` / `principal.addressIds !== "all"` の分岐で、管理者モードでないのに
      フィルタが消える経路が無いか。**owner でも `"all"` にならない**（`resolveUserAddressAccess` に role の分岐が無い）
      → `policy.ts` `resolvePrincipal` / `addressFilter`、`sql.ts` の各 `conds`

**管理者モード（FR-19）**
- [ ] 入れるのが owner の**セッション**だけで、API キー（owner の admin キーでも）では 403 か → `me.ts` `/admin-mode`
- [ ] 広がるのが**読む範囲だけ**か。送信（`writableAddressIds`）・既読・スター・ゴミ箱（`canModify` → `ownAddressIds`）・署名・非表示は
      割り当てたアドレスに留まるか → `policy.ts` `resolvePrincipal` / `canModify`、`messages.ts` PATCH、`addresses.ts` `/hidden`
- [ ] 通知・未読数・通知設定の対象が管理者モードで広がらないか → `services/notify/load.ts` `eligibleUserIds`、`prefs.ts` `countUnread`、`notifications.ts` `loadVisibleAddresses`
- [ ] 期限（1 時間）が固定で、延長の API が無いか。期限切れがサーバで判定されるか（UI の帯は表示だけ） → `me.ts` `ADMIN_MODE_SECONDS`、`resolvePrincipal`
- [ ] 入った・出たが監査ログに残るか（`admin_mode.enter` / `admin_mode.exit`。`meta.until`） → `me.ts` `/admin-mode`
- [ ] 管理者モードで読んだメールの記録は**無い**（読んだことは監査ログに残らない）ことを把握しているか
- [ ] `GET /addresses` / `GET /me` が管理者モードでは全アドレスを返すことを、UI が「読めるだけ」として扱うか
      → `ui/routes/ThreadDetail.tsx` `canModify`（自動既読・スター・メニューを出さない）、`ui/components/AdminModeBanner.tsx`

**非表示（見え方であって権限ではない）**
- [ ] `hidden` が一覧・検索の**既定の絞り込み**だけに効き、`address=` の名指し・単体取得・添付・生 MIME・通知・未読数には効かないか
      （非表示にしても届く・読める・鳴る） → `messages.ts` / `threads.ts` の `hiddenIds`、`sql.ts` `buildMessageConditions` / `queryThreads`
- [ ] 他人の `hidden` が自分の一覧に影響しないか（`address_grants` を `userId` で引く） → `sql.ts` `hiddenAddressIds`
- [ ] 非表示の id が 100 件を超えても D1 のバインド上限に当たらないか（JSON 1 本） → `sql.ts` `jsonIdsNotIn`
- [ ] 割り当ての無いアドレス（管理者モードで見えるだけを含む）を非表示にしようとすると 404 か → `addresses.ts` `/:id/hidden`

**プライマリアドレス**
- [ ] member / agent の作成で必ずプライマリが付き、write で割り当てられるか。既存のアドレスを指すとき、
      アーカイブ済み・エイリアス・他人のプライマリを弾くか → `admin/users.ts` POST / PATCH
- [ ] プライマリを消せない・下げられないか（削除・アーカイブ・エイリアス化は 409、grants で `read` は 400、一覧から外しても write で残る）
      → `admin/addresses.ts` `primaryHolder`、`admin/users.ts` PUT grants
- [ ] 最初のメールボックスを作った owner に自動で write の割り当てとプライマリが付くこと、`assignToMe` が作った本人にしか付かないことを把握しているか
      → `admin/addresses.ts` POST（`firstPrimary` / `assignToMe`）
- [ ] 検索の**全経路**（FTS、LIKE フォールバック、関連度順、スレッド一覧、スレッド内一覧）に
      アドレスの絞り込みが付くか → `sql.ts` `buildMessageConditions` / `queryThreads` / `queryThreadMessages`
- [ ] クエリ引数のアドレス指定（`address=` / `in:`）が権限外なら空で返るか → `sql.ts` `resolveMailboxId`

**API キーの範囲**
- [ ] キーの権限が持ち主の権限を**超えられない**（必ず積集合）か → `policy.ts` `resolvePrincipal` / `intersectAddressSets`
- [ ] 絞られたキーから、より広いキーを発行できないか（principal 基準で clamp しているか）
      → `me.ts` `clampScopes` / `clampAddressIds`
- [ ] オーナーが他人に発行するキーが、その人の grants の外を指さないか → `admin/api-keys.ts` POST
- [ ] 未知のスコープ文字列が DB に入っても無視されるか → `policy.ts` `normalizeScopes`

**スコープ**
- [ ] 読み取り集合と書き込み集合が別に管理され、送信・変更は書き込み集合で検査されるか
      → `policy.ts` `writableAddressIds`、`outbound.ts` `assertCanSend`、`messages.ts` PATCH（精査 #4）
- [ ] `read` / `send` / `admin` が**全エンドポイント**で検査されるか。
      `src/api/` が `policy.ts` の `requireScope` / `requireRead` / `requireWrite` を使っているか、
      各ハンドラが自前で `scopes.includes` を書いていないか → `grep -rn "requireScope\|scopes.includes" src/api`（精査 #3）
- [ ] 表にして塞ぐ。行 = エンドポイント、列 = `read` のみ / `send` のみ / `admin` のみのキー、
      セル = 期待する応答。表の空欄が未検証 → `docs/spec/architecture.md` §4 の API 表を起点にする
- [ ] オーナー専用操作が `role == owner` **かつ** `admin` スコープを要求するか。
      重複実装が「または」になっていないか → `policy.ts` `requireOwner`、各ルータの `use("*", requireOwner)`（精査 #13）
- [ ] 範囲を絞った admin キー（`addressIds` あり）で、キーより広い範囲を変える管理 API（ドメイン・アドレス・ルール・Webhook・
      他人のキーの失効）を叩けないか。「絞った」の判定が `keyRestricted`（キーが `address_ids` を持つ）で、
      `addressIds !== "all"`（owner も割り当てでしか見ないので、絞っていないキーでも真になる）に戻っていないか
      → `middleware/auth.ts` `requireUnrestricted`、`grep -rn "keyRestricted" src/api`（精査 #129）
- [ ] 絞っていないキーの clamp の基準が「持ち主の割り当て」ではなく「制限なし」か（持ち主の割り当てで凍結すると、
      owner が他人向けに発行するキーや Webhook の `addressIds` が壊れる） → `admin/api-keys.ts` POST、`webhooks.ts` `assertAddressIdsValid`
- [ ] パスワード・ロール・外部アドレス・管理者モードのように期限や範囲で縛れない資格情報を、API キーから変えられないか
      → `requireSession`（ユーザー管理の変更系・`/admin/users/:id/external-email`）、`me.ts` `requireMeSession` / `/admin-mode`、
      `addresses.ts` PATCH signature、`notifications.ts` / `devices.ts`（`via === "session"`）（#121 / #143）
- [ ] 認証ミドルウェアがパス前置で掛かっているので、広いプレフィックスに載るルータ
      （`rawRouter` は `/api/v1` に載る）へ後からルートを足すと未認証になりうる → `app.ts` `app.route`
- [ ] ミドルウェアのパスパターンが、末尾スラッシュ無し・大文字・エンコード違いを含めて
      マウント先の全パスを覆うか → `app.ts` `app.use("/api/v1/.../*")`

**応答の揃え方**
- [ ] 権限外の id が 403 ではなく 404 を返すか（存在の推測を防ぐ意図的な挙動）。
      返信経路も 404 に揃えてある（403 は「読めるが書けない」ときだけ） → `messages.ts` / `attachments.ts` / `outbound.ts` reply
- [ ] 一覧で「権限外のアドレスを指定」したとき、空ではなくエラーになって存在を漏らしていないか → `sql.ts` `resolveMailboxId`

**メンバーと owner の境界**
- [ ] `member` が自分のロール・ステータス・他人のアドレス付与・他人のキー／Webhook／ルールを触れないか
      → `me.ts` PATCH（`role` を受けない）、`me.ts` DELETE api-keys（`userId` で絞る）
- [ ] 最後のオーナーを消せない・降格できない・無効化できないか → `admin/users.ts` PATCH / DELETE、`policy.ts` `countActiveOwners`
- [ ] オーナーが自分自身を降格・無効化する経路も同じ検査を通るか
- [ ] `agent` ロールがログインできないか（`password_hash` が null で `verifyPassword` が false）
      → `auth.ts` login、`admin/users.ts`（`agent` に password を付けられない）

**入力の受け付け**
- [ ] PATCH/POST でリクエストボディをそのまま `set()` / `values()` に渡していないか
      （`role` / `status` / `password_hash` / `user_id` / `address_id` の書き換え）
      → `grep -rn "\.set(\|\.values(" src/api`
- [ ] スキーマにあるが**ハンドラが使っていない**項目が無いか。使わないなら消す。
      使うようになった瞬間に検証無しで効く（かつて `sendMessageInput.threadId` がそうだった。今は無い）
      → `contracts/send.ts` と `outbound.ts` POST、`contracts/*.ts` の各項目
- [ ] zod スキーマが未知のキーを落とすか（`strict`）。落とさないなら、その方針を自覚しているか
- [ ] パスパラメータ（`:id`）が形式検査され、別テーブルの id を混ぜても安全か

### S-3 受信メール — 信頼できない入力の解釈

「量」の上限は S-9 に寄せた。ここは「意味」の検証だけを見る。

見る場所: `src/domain/routing/incoming.ts`、`resolve.ts`、`rules.ts`、
`src/domain/mail/parse.ts`、`address.ts`、`thread.ts`、`inbound.ts`、`src/services/r2.ts`。

**受信ハンドラ**
- [ ] 受信ハンドラでパースせず、R2 に置いてキューへ逃がしているか（設計上の必須） → `incoming.ts` `deliver`
- [ ] `setReject()` / `forward()` を email ハンドラの外で呼んでいないか → `grep -rn "setReject\|\.forward(" src`
- [ ] R2 に置いた**後**にキュー投入が失敗したとき、メールが黙って消えないか
      （`waitUntil` の失敗は誰も観測しない。今は `await` して例外にし、Email Routing に一時失敗を返して送信側に再送させる。精査 #24）
      → `incoming.ts` `await env.INBOUND_QUEUE.send`
- [ ] 転送に付けるヘッダが受信者に露出してよい内容か（`X-Tsubamail-Forwarded` にエンベロープ `to` を入れている）

**宛先解決**
- [ ] 宛先解決が**エンベロープ**（`message.to`）基準で、MIME の `To:` ヘッダを信用していないか → `incoming.ts` → `resolve.ts`
- [ ] 順序が「拒否 → 完全一致 → `+タグ` の基本アドレス → ルール → catch-all」で固定されているか → `resolve.ts` `resolveIncoming`
- [ ] 拒否ルールが `+タグ` 付きのリテラルと基本アドレスの**両方**で評価されるか（精査 #9）
- [ ] アドレス正規化の穴が無いか（大文字小文字、末尾ドット、空白、引用ローカル部、
      Unicode / punycode、`+タグ`）。正規化は 1 か所か → `address.ts` `normalizeAddress` / `baseAddressOf`
- [ ] catch-all が実在アドレスを覆い隠さないか。既定で無効か → `resolve.ts`、`provision.ts` `setCatchAll`
- [ ] エイリアスの連鎖（alias → alias）を作れないか → `admin/addresses.ts` POST / PATCH
- [ ] アーカイブ済みアドレス宛の扱いが崩れていないか（実在しないのと同じに扱い、catch-all があればそこへ落ちる。精査 #37 / #62） → `resolve.ts` `resolveIncoming`
- [ ] ドメインルールの `deliver` / `forward` の `target` が、そのドメインの外や存在しない id を指せることを許容しているか
      → `admin/rules.ts`（検証無し）、`resolve.ts`

**パース結果の解釈**
- [ ] `In-Reply-To` / `References` の突き合わせが**同一アドレススコープ内**に閉じているか → `thread.ts` `findExistingThreadId`
- [ ] 受信メールの `Message-ID` を、後続の受信メールの接ぎ木アンカーとして信用していないか
      （outbound の `rfc_message_id` だけを信用する等。精査 #10）
- [ ] `Date` ヘッダを `received_at` にそのまま使っていないか。未来日付で一覧の先頭に居座れる／
      カーソルの外に逃げられる → `inbound.ts` `resolveReceivedAt`（投入時刻の 1 年前〜10 分後の外は投入時刻。精査 #19）、`sql.ts` `cursorCondition`
- [ ] `From` が無い・複数ある・グループ構文のとき、`from_addr` が空や別人にならないか → `parse.ts` `flattenAddresses`
- [ ] アドレススコープのルール照合がヘッダ値ではなくエンベロープで行われるか（精査 #14） → `inbound.ts` `matchAddressRules`
- [ ] 受信メールの `In-Reply-To` で既存スレッドに接ぐとき、Cloudflare の認証結果（DMARC pass か From ドメインの DKIM pass）を
      要求しているか。CF ブロックの判定が偽の ARC で崩れないか（精査 #127） → `parse.ts`、`thread.ts`
- [ ] ルールの `contains` が本文全体を対象にするなら、その計算量を把握しているか → `rules.ts` `matchRule`
- [x] Cloudflare の判定ヘッダを読んで `spam_verdict` に**書いて**いるか。読む側だけあって書く側が無い状態になっていないか
      → `inbound.ts` の insert（`spamVerdictFromScore`）、`grep -rn "spamVerdict" src`

**保存**
- [ ] 添付のファイル名・`content_id` が R2 キーに素通りしていないか（受信側はサーバ採番） → `r2.ts` `attachmentKey`、`inbound.ts`
- [ ] 送信側の添付も同じ採番を使っているか（精査 #7） → `outbound.ts` `storeAttachments`
- [ ] 二重処理（at-least-once）で行が増えないか → `inbound.ts` `rawR2Key` の重複検査

### S-4 表示と配信 — ブラウザに渡す瞬間

**このアプリで最も現実的な攻撃経路。** 攻撃者は HTML メールを 1 通送るだけでよい。
S-3 の追跡表の右端を、ここで 1 つずつ潰す。

見る場所: `src/ui/components/MessageHtml.tsx`、`Attachments.tsx`、
`src/ui/routes/ThreadDetail.tsx`、`Inbox.tsx`、`Search.tsx`、`src/ui/lib/api.ts`、
`Login.tsx`、`src/api/v1/attachments.ts`、`src/worker.ts`、`index.html`、`public/_headers`（無ければ無い）。

**HTML 本文**
- [ ] `html_body` を `dangerouslySetInnerHTML` 等で直接描画していないか → `grep -rn "dangerouslySetInnerHTML\|innerHTML" src/ui`
- [ ] 描画するならサンドボックス化した iframe に隔離しているか。`sandbox` の各 allow を 1 つずつ根拠付きで持つか。
      `allow-scripts` が無い、`allow-forms` が無い、`allow-top-navigation` が無い、
      `allow-same-origin` は何のために要るか（高さを読むため）、`allow-popups allow-popups-to-escape-sandbox` は
      リンクを新しいタブで開くため（#141）で、開ける `href` を `rewriteLinks` が http(s) / mailto に絞っているか → `MessageHtml.tsx`
- [ ] iframe 内での `<meta http-equiv="refresh">` や自己ナビゲーションで、枠の中身が攻撃者のサイトに
      差し替わらないか（フィッシングの土台になる）
- [ ] リモート画像・外部 CSS・フォントを既定でブロックするか（開封トラッキング対策。精査 #11）。
      iframe の `csp` 属性か、`srcDoc` に埋める `<meta http-equiv="Content-Security-Policy">` か
- [ ] `referrerPolicy` が iframe に付いているか（本文中のリンクから自分の URL を漏らさない）
- [ ] 本文中のリンクをどう扱うか決めているか。`javascript:` / `data:` を弾くか、そもそも開かせないか
      → `MessageHtml.tsx` `safeLinkHref` / `rewriteLinks`（`target="_blank" rel="noopener noreferrer"`、`<base>` は落とす）。
      DOMParser の経路は vitest で通らず、ブラウザ実機でしか確かめられない
- [ ] 件名・差出人名・ファイル名・スニペットなど**属性値やテキストに入る攻撃者文字列**を React の
      エスケープに任せているか。文字列連結で DOM を組んでいないか → `ThreadDetail.tsx`、`Inbox.tsx`、`Search.tsx`
- [ ] API のエラーメッセージや `details` を UI が HTML として描画していないか → `ui/lib/api.ts`、各画面の `error` 表示

**添付と生 MIME の配信**
- [ ] 添付が `Content-Disposition: attachment` と**安全な** `Content-Type` で返るか。
      送信者の MIME 型（`text/html`、`image/svg+xml`）をそのまま返していないか（精査 #8） → `attachments.ts` `attachmentsRouter`
- [ ] 生 MIME が `inline` になっていないか。`.eml` の中には HTML が入る → `attachments.ts` `rawRouter`
- [ ] `Content-Disposition` のファイル名がエンコードされ、`"` や CRLF が壊せないか → `attachments.ts`
- [ ] できれば添付・生 MIME を別オリジン／別ホストから配るか。同一オリジンなら CSP と `nosniff` が必須になる
- [ ] 添付の URL がセッション Cookie で守られている前提を UI が守っているか
      （`<a target=_blank>` で開く。要件 FR-10 の「認可付きの一時 URL」との差を自覚しているか） → `Attachments.tsx`

**HTTP ヘッダ**
- [ ] `Content-Security-Policy`（`default-src 'none'`、`frame-ancestors 'none'`、`base-uri 'none'`）を API と添付・生 MIME の応答に返すか（精査 #6）
      → `app.ts` `secureHeaders`（`/api/*` だけ。静的資産は `ASSETS` が返すので `worker.ts` は素通し）
- [ ] `X-Content-Type-Options: nosniff` / `Referrer-Policy` / `X-Frame-Options` を返すか
- [ ] API の JSON 応答に `nosniff` が付き、ブラウザで直接開いたときに HTML と解釈されないか
- [ ] エラー応答で `Content-Type` が `application/json` に揃っているか

**UI のナビゲーション**
- [ ] ログイン後の戻り先 `?next=` が同一オリジンの相対パスに限定されているか
      （`//evil.example` や `https://` を弾く）。オープンリダイレクトになっていないか
      → `ui/lib/api.ts`（`location.href = /login?next=`）、`Login.tsx` `navigate(next)`
- [ ] 管理画面のゲートが UI 側だけでなく API 側にもあるか（UI は見せない工夫、API が本体） → `ui/routes/admin/gate.tsx` と `app.ts`

**CSRF**
- [ ] 変更系がすべて JSON ボディの POST/PATCH/DELETE で、フォーム送信を受け付けないか → `grep -rn "parseBody\|formData" src/api`
- [ ] `Content-Type: application/json` を要求しているか。要求していないなら、
      防御が Cookie の `SameSite=Lax` **だけ**に依っていることを自覚しているか → `lib/validate.ts` `readJson`、`middleware`
- [ ] GET に副作用が無いか → `docs/spec/architecture.md` §4 の表と `src/api/v1/**` の `.get(`
- [ ] CORS を設定していないことが意図的か（同一オリジン配信なので、無いことで塞がる）

### S-5 送信 — 自分の名前で外に出るもの

見る場所: `src/api/v1/outbound.ts`（POST / reply）、`src/domain/mail/compose.ts`、
`quote.ts`、`outbound.ts`、`src/services/sender.ts`、`src/shared/contracts/send.ts`、
`src/domain/routing/incoming.ts`（転送）、`admin/rules.ts`。

**差出人**
- [ ] `from` が principal の**書き込み可能**アドレス集合で検証されるか（詐称は 403） → `outbound.ts` `assertCanSend`
- [ ] 返信でも同じ検証が効き、`from` をリクエストから取らずにメッセージ自身のメールボックスから導くか → `outbound.ts` reply
- [ ] 送信経路が 1 本（`enqueueOutbound` → キュー → `processOutboundSend`）に集約されているか
- [ ] エイリアスやアーカイブ済みアドレスを `from` にできるか。できるなら意図か

**ヘッダ**
- [ ] MIME 組み立てで `\r\n` によるヘッダインジェクションが起きないか。
      件名・表示名・宛先・ファイル名・`In-Reply-To`・`References`・`Message-ID` すべてを対象に、
      「ライブラリがエンコードするもの」と「素通しするもの」を分けて確認する（精査 #1） → `compose.ts` `composeMime`
- [ ] **受信ヘッダ由来の値が送信ヘッダに戻る経路**（返信の `In-Reply-To` / `References` は受信メールの
      `Message-ID` をそのまま使う）で、値の形式を検証しているか → `outbound.ts` reply、`quote.ts` `referencesFor`
- [ ] `bcc` がヘッダに出ていないか。消す処理が「複数行」「注入された行」にも効くか（精査 #2） → `sender.ts` `stripHeader`
- [ ] `Message-ID` を自前で採番し、そのドメインが `from` のドメインと一致するか → `compose.ts` `generateMessageId`

**本文**
- [ ] 返信の引用に、受信 HTML を**サニタイズせずそのまま**埋め込んでいないか。
      攻撃者の HTML（トラッキング画像、フィッシングリンク）が自ドメインの署名付きで第三者に届く
      → `quote.ts` `buildReplyQuote` / `quoteHtml`
- [ ] 引用のヘッダ（差出人名・アドレス）がエスケープされているか → `quote.ts` `quoteHeader` / `escapeHtml`
- [ ] 添付の `base64` が不正なとき 500 ではなく 400 で落ちるか → `outbound.ts` `storeAttachments` `atob`

**宛先**
- [ ] 「全員に返信」の宛先が受信メールの `To` / `Cc` ヘッダ（攻撃者が書ける）から作られることを
      UI が利用者に見せているか。自分のアドレスの除外が正規化後の比較か → `outbound.ts` `replyAllRecipients`、`Compose.tsx`
- [ ] 宛先の重複排除が正規化後か → `sender.ts` `collectRecipients`
- [ ] 宛先数に上限があるか（量の観点は S-9 だが、踏み台の観点でもここで見る）

**転送とループ**
- [ ] 転送ルールにループ防止ヘッダの付与と検査があるか → `incoming.ts` `FORWARD_HEADER`
- [ ] 任意の外部アドレスへ転送するルールを誰が作れるか。member に作らせていないか。
      `matcher` が空だと全件一致になることを UI が警告するか → `admin/rules.ts`、`rules.ts` `matchRule`
- [ ] ルールの `scope` / `domainId` / `addressId` を PATCH で付け替えられるとき、権限の境界を越えないか → `admin/rules.ts` PATCH

**再送と二重送信**
- [ ] キューの at-least-once で二重送信しないか。「読んでから更新」ではなく
      `UPDATE … WHERE status='queued'` の結果で判定しているか → `domain/mail/outbound.ts` `processOutboundSend`
- [ ] 再試行に上限とバックオフがあるか → `OUTBOUND_MAX_ATTEMPTS` / `backoffDelaySeconds`
- [ ] 送信のレート制限（キー単位）があるか。Rate Limiting binding の概算で、バインディングの無い環境では消える
      → `outbound.ts` `checkSendRateLimit`、`wrangler.jsonc` `SEND_RATE_LIMIT`（100 回 / 60 秒。精査 #106）。
      **本番では発火しない（精査 #147）。送信量の上限は今は無いものとして見る。**
- [ ] 送信を無効にしたドメインから、API と積み済みのジョブの両方で送らないか（#144） → `sender.ts` `isSendingDisabled`、`outbound.ts` `assertCanSend` / reply、`domain/mail/outbound.ts`

### S-6 検索とクエリ生成

見る場所: `src/domain/search/sql.ts`、`query.ts`、`src/shared/contracts/messages.ts`、
`src/shared/contracts/common.ts`（`paginationQuery`）、`migrations/0001_search_fts.sql`、
`src/api/v1/webhooks.ts`（独自のカーソル実装）。

- [ ] ユーザー入力が `sql.raw()` や文字列連結で SQL に入っていないか。
      drizzle の `sql` タグの `${}` はバインドされるが、**タグに渡す前に連結した文字列**はバインドされない
      → `grep -rn "sql.raw\|sql\`" src`
- [ ] `order` が enum で、ORDER BY に文字列として入らないか → `contracts/messages.ts` `order`、`sql.ts` `orderBy`
- [ ] `limit` に上限があり、**すべての一覧**に付いているか（精査 #15） → `paginationQuery`、`admin/api-keys.ts` / `admin/users.ts` / `v1/webhooks.ts` GET
- [ ] カーソルが改竄されてもフィルタを飛び越えられないか（値を検証してからバインドする。アドレス絞り込みは
      カーソルと独立に付く） → `sql.ts` `decodeCursor` / `cursorCondition`、`v1/webhooks.ts` deliveries の `cursor`
- [ ] FTS5 の MATCH 式に入力を渡す前にエスケープしているか（二重引用符で囲み、内部の `"` を処理）。
      `OR` / `NEAR` / `*` / 列指定の注入で範囲を広げられないか → `sql.ts` `escapeFtsTerm`
- [ ] LIKE フォールバックで `%` / `_` をエスケープしているか。漏えいにはならないが、
      `%_%_%_%` のようなパターンで走査が重くなる → `sql.ts` `freeWordCondition`、`buildMessageConditions`
- [ ] 検索の**全経路**（FTS、LIKE、関連度順、スレッド）にアドレススコープの `WHERE` が付くか（S-2 と同じ項目。ここでも見る）
- [ ] 日付・真偽値のクエリ引数が正規化され、不正値が 400 になるか → `query.ts` `parseDayStart` / `parseDayEnd`、`contracts/messages.ts` `boolParam`
- [ ] FTS の同期トリガが `UPDATE` / `DELETE` でも索引を消し、消したメッセージが検索に残らないか → `migrations/0001_search_fts.sql`

### S-7 外部連携 — Webhook と Cloudflare API と DNS

見る場所: `src/services/webhooks.ts`、`src/api/v1/webhooks.ts`、
`src/shared/contracts/webhooks.ts`、`src/services/cloudflare-api.ts`、
`src/domain/domains/provision.ts`、`cleanup.ts`、`dns-check.ts`、`src/api/v1/admin/domains.ts`、`admin/addresses.ts`。

**Webhook（こちらから外へ）**
- [ ] 署名が本文全体に対する HMAC で、タイムスタンプを含み、リプレイの窓を絞れるか → `webhooks.ts` `buildSignatureHeader`
- [ ] `secret` が CSPRNG 由来で、作成応答にしか出ず、一覧・詳細・配信履歴に出ないか → `v1/webhooks.ts` `generateSecret` / `toResponse`
- [ ] 受け手向けの検証手順（定数時間比較、`t` の許容幅）をドキュメントに書いているか
- [ ] URL が SSRF に使えないか（`http:`、内部アドレス、リンクローカル、メタデータ、`localhost`）。
      リダイレクトを追わないか（`redirect: "manual"`）。誰が登録できるか（精査 #12）
      → `contracts/webhooks.ts` `url`、`webhooks.ts` `runDelivery` `fetch`
- [ ] URL の検証が**作成時だけでなく更新時**にも同じか → `v1/webhooks.ts` PATCH
- [ ] 手動再送 API が同じ SSRF 面を持つことを把握しているか → `v1/webhooks.ts` `/deliveries/:id/retry`
- [ ] 再送にバックオフと上限があるか（外部への増幅攻撃にしない） → `webhooks.ts` `MAX_ATTEMPTS` / `RETRY_DELAYS`
- [ ] 同じ配信を 2 経路（キューの再配達と手動再送）が同時に走らせても POST が 1 回か → `webhooks.ts` `runDelivery` の claim（#86 / #118）
- [ ] 応答待ちにタイムアウトがあるか（受け手が Worker を拘束できない）。受信・送信のコンシューマが POST を待たないか → `TIMEOUT_MS`、`dispatchMessageEvent`（キューに積むだけ）
- [ ] 通知本文に何を載せるか決めているか（件名・スニペット・宛先は外に出る）。`addressIds` の絞り込みが効くか
      → `webhooks.ts` `serializeMessage` / `dispatchMessageEvent`
- [ ] `addressIds` に存在しない id や、将来 member が登録できるようになったとき権限外の id を入れられないか → `v1/webhooks.ts` POST

**Cloudflare API（こちらから Cloudflare へ）**
- [ ] トークンがログ・レスポンス・エラーに出ていないか。private field に閉じ、ヘッダにしか入らないか → `cloudflare-api.ts` `#request`
- [ ] エラー応答の `details`（`path` に zone_id、`bodySnippet`）が owner 以外に出ないか → `cloudflare-api.ts` の `ApiError` 生成箇所、`app.ts` `onError`
- [ ] `zone_id` などがユーザー入力から API パスに素通りしていないか。ゾーンは `listAllZones` の結果から選ぶか
      → `provision.ts` `resolveZone`、`cfEndpoints`
- [ ] 必要権限が最小か（ドキュメントの権限表と実際に呼ぶエンドポイントが一致するか） → `docs/ops/deployment.md` §3、`cfEndpoints`
- [ ] トークンのゾーン範囲を広げる手順が「最小権限の維持」の定期確認に入っているか → `docs/ops/operations.md` §4 / §6

**DNS とルーティング（取り返しがつかない操作）**
- [ ] apex の MX を奪う操作に明示的な確認があるか（既定はサブドメイン） → `provision.ts` `confirmApex`、`dns-check.ts` `inspectDnsRecords`
- [ ] catch-all の有効化に `confirm` を要求し、受け皿アドレスの存在を先に確認するか → `admin/domains.ts` `/catch-all`、`provision.ts` `setCatchAll`
- [ ] 切断時の後始末が、このアプリが作ったレコード・ルールだけを消すか。判定が保守的か
      （迷ったら消さず報告する） → `cleanup.ts` `isOwnDnsRecord` / `isOwnRoutingRule`
- [ ] 切断が `cleanup=true` 既定で DNS を触ることを UI が確認し、監査ログ `domain.disconnect` に消したレコードとルールが残るか → `admin/domains.ts` DELETE
- [ ] Email Sending の無効化が Cloudflare 側と DNS を触らないこと（tsubame の中で止めるだけ）を把握しているか → `admin/domains.ts` `/sending`
- [ ] Worker 名（`wrangler.jsonc` の `name` / `vars.EMAIL_WORKER_NAME` / ルールの宛先）がずれると
      受信が止まる。ずれを検出する手段があるか → `provision.ts` `emailWorkerName`、`docs/ops/cutover.md`

### S-8 シークレット・ログ・監査

見る場所: `.gitignore`、`git ls-files`、`git log -p -S`、`wrangler.jsonc`、`wrangler.jsonc.example`、
`worker-env.d.ts`、`docs/ops/deployment.md`、`src/api/app.ts`（`onError`）、
`src/domain/access/policy.ts`（`recordAudit`）、`grep -rn "console\." src`。

**シークレットの置き場**
- [ ] `.env` / `.dev.vars` / `wrangler.local.jsonc` / 実 ID を含む設定が git に入っていないか。
      **履歴も見る**（一度入ったら失効させるまで漏れたまま） → `.gitignore`、`git log --all -p -S "tsb_"`
- [ ] `wrangler.jsonc` にアカウント固有の ID を書いていないか（規約） → `d1_databases[].database_id`、`scripts/deploy.sh`
- [ ] 作業ツリーの `.env` に実キーが平文で置いてある運用を共有マシンで許容しているか
- [ ] **ドキュメントと型定義に書かれたシークレットが、実際にコードで使われているか**。
      使われていないシークレット（`AUTH_SECRET`）は「漏れたら失効」の手順を無駄にし、
      逆に本当に必要なもの（`INTERNAL_SECRET`）の手順が抜ける
      → `worker-env.d.ts`、`docs/ops/deployment.md` §3、`grep -rn "AUTH_SECRET\|INTERNAL_SECRET" src`
- [ ] シークレットのローテーション手順があるか（`CF_API_TOKEN`、`INTERNAL_SECRET`、Webhook `secret`）

**ログ**
- [ ] パスワード・トークン・キー・メール本文・添付を `console.*` に出していないか。
      `err` オブジェクトごと出す箇所で、例外メッセージにバインド値や本文が含まれないか
      → `app.ts` `onError`、`consumer.ts`、`outbound.ts` `lastError`
- [ ] `observability.enabled` でログが Cloudflare に保存されることを前提に、上の項目を見ているか → `wrangler.jsonc`
- [ ] `outbound_jobs.last_error` / `webhook_deliveries.error` / `domains.last_error` に外部の応答本文が
      そのまま入り、それが API 経由で見えることを許容しているか
- [ ] エラーレスポンスにスタックトレースや内部の詳細が出ていないか。`details` に何を入れてよいか決めているか
      → `shared/errors.ts` `ApiError.toJSON`、`lib/validate.ts`（zod の issues をそのまま返す）

**監査ログ**
- [ ] owner の管理操作のうち**記録されていないもの**を列挙したか。記録する action の一覧は `docs/ops/audit-log.md`。
      新しい変更系のエンドポイントを足したら `recordAudit` と一覧の両方に足す
      → `grep -rn "recordAudit" src/api`
- [ ] 記録の失敗で本処理を落とさないか → `policy.ts` `recordAudit`
- [ ] 監査ログにシークレット・パスワード・仮パスワード・署名の本文・確認コードを書いていないか → 各 `recordAudit` の `meta`
- [ ] 見る範囲が広がる操作（`admin_mode.enter` / `exit`）とログイン先が変わる操作（`user.external_email.set` / `verify`）が記録されるか。
      プライマリの変更（`PATCH /admin/users/:id` の `primaryAddressId`）は `user.update` に含まれるが `meta` には出ない → `me.ts`、`admin/users.ts`
- [ ] 監査ログを読む手段と保持期間が文書どおりか（`GET /v1/admin/audit-logs` は owner のセッションか範囲を絞っていない admin キー、
      400 日で消す） → `admin/audit-logs.ts`、`maintenance.ts` `pruneAuditLogs`、`docs/ops/audit-log.md`

### S-9 可用性と資源の上限 — 「量」はすべてここで見る

S-3 / S-5 の「意味」の検証とは別に、入口ごとの**上限**をここに集める。
上限が無い項目は、匿名の送信者か漏れたキー 1 本で資源を使い切れる。

見る場所: `src/domain/routing/incoming.ts`、`src/domain/mail/inbound.ts`、`parse.ts`、
`src/api/v1/outbound.ts`、`src/shared/contracts/send.ts`、`src/services/consumer.ts`、
`wrangler.jsonc`（`queues.consumers`）、`src/services/webhooks.ts`。

| 入口 | 上限が要るもの | 今どこで決まるか |
| --- | --- | --- |
| 受信 | メール全体（`rawSize`）、添付 1 件、添付の個数、`text_body` / `html_body` / 件名 / アドレス列の長さ（D1 の 1 行上限） | `incoming.ts` `MAX_RAW_BYTES`、`inbound.ts` `MAX_ATTACHMENTS` / `MAX_ATTACHMENT_BYTES` / `STORED_BYTES`。MIME のパート数・入れ子は postal-mime 任せ（例外は placeholder） |
| 送信 API | リクエストボディ、宛先数、本文長、添付 1 件と合計、件名、送信回数 | `outbound.ts` `bodyLimit`、`contracts/send.ts` の `MAX_*`、`SEND_RATE_LIMIT`（精査 #106） |
| 検索 API | `limit`、`q` の長さと語数 | `paginationQuery`、`query.ts` `MAX_QUERY_CHARS` / `MAX_FREE_WORDS` |
| 認証 API | KDF の回数、ログイン試行、bootstrap 試行 | `LOGIN_RATE_LIMIT`（login と bootstrap） |
| 管理 API | 一覧のページング、`localParts` の個数、ルール数、Webhook の `addressIds` | `paginationQuery`、`contracts/domains.ts`（`localParts` 50）、`contracts/webhooks.ts`（100）。ルール数・Webhook 数の上限は無い |
| 通知 API | 端末数、通知ルール数 | `devices.ts` 10 台、`notifications.ts` 50 件（精査 #133） |
| キュー | 再試行回数、DLQ の有無、1 メッセージの処理時間 | `wrangler.jsonc` `max_retries: 3` と `dead_letter_queue`。DLQ の見方は `docs/ops/operations.md` §2 |
| Webhook | 再送回数、タイムアウト、同時配信数 | `webhooks.ts` `MAX_ATTEMPTS` / `TIMEOUT_MS`。配信は 1 件 1 キューメッセージで、同時配信数はキューのバッチ（5）に従う |
| push サービス | 1 実行の外部リクエスト数（Free で 50）、タイムアウト、再試行 | 利用者 1 人 1 メッセージに分割（`notify.ts`）、`webpush.ts` `PUSH_FETCH_TIMEOUT_MS`、`consumer.ts` `NOTIFY_RETRY_DELAYS` / `NOTIFY_MAX_RETRIES` |

- [ ] 上の表の空欄を埋めたか。空欄ごとに「無くてよい理由」か「上限値」のどちらかがあるか
- [ ] キューのコンシューマが毒メッセージで再試行し続けないか。`max_retries` を超えたメッセージが
      **黙って消える**のか DLQ に残るのかを決めているか → `consumer.ts` `item.retry`、`wrangler.jsonc`
- [ ] 巨大メール・巨大添付で Worker の CPU / メモリ制限に当たらないか。受信ハンドラはストリームで R2 に流すが、
      コンシューマは全体をメモリに載せる → `r2.ts` `saveRaw`、`inbound.ts` `arrayBuffer()`
- [ ] R2 / D1 への書き込み量に歯止めがあるか（ストレージ枯渇）。受信は誰でも書き込める
- [ ] 認証前に重い処理（KDF を含む）へ到達できる経路にレート制限があるか → `auth.ts` login / bootstrap
- [ ] 認証後でも、`send` スコープ 1 本で送信量・添付量を無制限に使えないか
- [ ] 一覧系が全件走査にならないか（精査 #15）
- [ ] 外部への待ち（Webhook、push サービス、Cloudflare API）にタイムアウトがあるか
      → `webhooks.ts` `TIMEOUT_MS`、`webpush.ts` `PUSH_FETCH_TIMEOUT_MS`、`cloudflare-api.ts` `DEFAULT_TIMEOUT_MS`（ページ走査は `#pageDeadlineMs`）

### S-10 サプライチェーンと CI・デプロイ

見る場所: `package.json`、`package-lock.json`、`.github/workflows/ci.yml`、`deploy.yml`、
`scripts/deploy.sh`、`wrangler.jsonc`、`.githooks/`。

- [ ] 依存が MIT / Apache-2.0 / BSD のみか（ライセンス規約） → `package.json`
- [ ] `npm audit` の High 以上が残っていないか。devDependencies と実行時依存を分けて評価しているか
- [ ] メール・MIME を扱うライブラリ（`postal-mime`、`mimetext`）の**セキュリティ上の前提**
      （何をエンコードし、何を素通しするか）を把握しているか。S-5 の検証はここに依存する
- [ ] CI のサードパーティ Action が SHA で固定されているか（`@v4` はタグで、動く） → `ci.yml`、`deploy.yml`
- [ ] `pull_request_target` でフォークのコードを特権付きで実行していないか → `ci.yml`
- [ ] デプロイのシークレットが `workflow_dispatch` 限定のジョブにしか無く、`env:` 経由で渡されるか → `deploy.yml`
- [ ] デプロイスクリプトが生成する設定（実 ID 入り）を確実に消すか → `scripts/deploy.sh` `trap`
- [ ] `upload_source_maps` / `keep_vars` の意味を把握しているか（ソースマップは Cloudflare に上がる） → `wrangler.jsonc`
- [ ] マイグレーションに既定の資格情報や広い権限付与が無いか → `migrations/*.sql`
- [ ] ローカルの git フックがセキュリティ検査を肩代わりしていないか（フックは `--no-verify` で外せる。本体は CI）

### S-11 検証の仕組み — テストが本番と同じ門を見ているか

セキュリティの回帰は、機能テストが緑のまま起きる。テスト自体を観点にする。

見る場所: `tests/*.test.ts`、`e2e/specs/*.e2e.test.ts`、`e2e/harness.ts`、`tests/helpers.ts`、
`vitest.config.ts`、`scripts/spec-coverage.mjs`。

- [ ] ルータを単体で載せるテストが、本番の `app.ts` と**同じミドルウェア**を通しているか。
      弱いほうの門だけを検査していないか（精査 #13） → `tests/webhook-api.test.ts` `app.route`
- [ ] 各要件の e2e に**否定のケース**（権限外 → 404、スコープ不足 → 403、他人のキー → 404）があるか
      → `e2e/specs/fr05-*`、`fr11-*`、`fr12-*`
- [ ] S-2 の「エンドポイント × スコープ」表の各セルに対応するテストがあるか
- [ ] テスト用の `INTERNAL_SECRET` が本番に流用されない仕組みか → `vitest.config.ts`、`e2e/harness.ts` `OWNER.secret`
- [ ] 受信の e2e が本物と同じ形（長さ不明のストリーム、エンベロープとヘッダの不一致）で流しているか → `e2e/harness.ts` `deliverEmail`
- [ ] 精査で「実証済み」になった項目に、再発を止めるテストが追加されたか

## 5. 監査の進め方

1. **入口を数える。** §3 の表で「誰が」「何を」流し込めるかを先に書き出す。
   新しいエンドポイント・ハンドラ・キュー種別が増えていたら表を更新する。
2. **不変条件から破る。** S-2 の「必ず address_id で絞る」を破れる経路を探す。
   1 か所でも破れれば、他の対策の大半は迂回される。
3. **信頼できない文字列を追跡する。** §3 の追跡表を右端まで辿り、実行可能な文脈
   （iframe、ヘッダ、SQL、R2 キー、外部 URL）に入る直前の検証を確かめる。
4. **境界ごとに検証する。** 検証はハンドラの入口（zod）と、副作用の直前（権限チェック）の
   両方で行う。片方だけにしない。
5. **量を数える。** S-9 の表の空欄を埋める。上限の無い入口は、それだけで DoS の候補。
6. **成立を確かめる。** コードを読んで疑ったものは、可能な限り実際に走らせて成立を確認し、
   精査の記録に「実証済み」と書く。推測は載せない。
7. **直したら門を増やす。** 修正と同時に S-11 のテストを足す。テストが無い修正は次の変更で戻る。
