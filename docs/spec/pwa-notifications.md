# PWA とプッシュ通知

- ステータス: **実装中**。「3. 要件案」は `requirements.md` の FR-15 / FR-16 に移した（正はそちら）。
- 画面の設計は別冊 [スマホ画面設計](mobile-screens.md)。

## 1. 目的

スマホで Tsubame を「アプリとして」使えるようにする。

1. **ホーム画面に追加できる**（PWA）。アドレスバーのない全画面で起動する。
2. **新着をプッシュ通知で受け取れる**。アプリを開いていなくても届く。
3. **通知を細かく制御できる**。メールボックス・差出人・時間帯・端末ごとに、
   鳴らす / 静かに出す / 出さない / 後でまとめる を決められる。

ネイティブアプリ（App Store / Google Play）は作らない。配布・審査・二重実装のコストに
見合わず、Web Push が iOS でも使える以上、PWA で要件を満たせる。

## 2. 既存の要件・方針との関係

この機能は既存の方針とぶつかる箇所がある。黙って破らず、ここで扱いを決めておく。

| 既存の方針 | ぶつかる点 | 扱い |
| --- | --- | --- |
| FR-9「設定項目は最小限」「作り込まない」 | 通知設定を細かくする | **通知だけ例外にする**と明文化する。代わりに「既定値のまま触らなくても正しく動く」ことを要件にし、細かい設定は奥に畳む（段階的開示）。トップはプリセット 3 つで済むようにする。 |
| 非目標「WebSocket リアルタイム」 | 新着の即時通知 | Web Push はブラウザのプッシュ基盤経由で、常時接続を持たない。非目標には当たらない。 |
| 非目標「スヌーズ」 | 通知の一時停止 | メールのスヌーズ（後で受信箱に戻す）とは別物。通知だけを止める。 |
| 非機能「外部 SaaS 依存を増やさない」 | Apple / Google / Mozilla のプッシュサービスを経由する | 契約もキーの登録も要らない、ブラウザ標準の配送路。避けようがなく、依存と見なさない。本文は端末までの暗号化（RFC 8291）で中継者に読めない。 |
| ロール `agent` | UI を持たない | 通知の対象外。端末登録 API も API キーでは叩けない（セッション限定）。 |

## 3. 要件案

### FR-15 案 ホーム画面に追加（PWA）

- Web App Manifest と Service Worker を配り、iOS / Android / PC のブラウザで
  「ホーム画面に追加」「インストール」ができる。起動はアドレスバーのない単独ウィンドウ。
- スマホ幅（768px 未満）では、スマホ用の配置に切り替わる（[スマホ画面設計](mobile-screens.md)）。
- オフライン時もアプリの殻は開き、「オフラインです」を出す。**メール本文はオフライン保存しない**
  （端末紛失時に残るものを増やさない）。
- 追加の案内は、追加していない・スマホで開いている・3 回目以降の訪問、のときだけ出す。
  閉じたら 30 日出さない。

### FR-16 案 プッシュ通知

- 端末ごとに通知を購読できる。1 人が複数の端末を持てる。
- 通知の対象イベントは **新着受信** と **送信失敗**。
- 通知の判定は「4. 通知の判定」の順で行い、**判定の理由を利用者が後から確かめられる**
  （通知欄）。細かい設定で「なぜ鳴らなかったか」が分からなくなるのを防ぐ。
- **通知欄**: アプリの中で、通知の対象になったメールを時系列で見返せる。一時停止中・おやすみ中に
  止めた分は通知として出し直さず、通知欄に「一時停止中に届いた 8 件」のような束で残す。
- 権限の変化は即座に効く。アドレスの割り当てを外されたら、そのアドレスの通知は次の 1 通から来ない。
- **パスワードを変えると、その利用者の全端末の購読を消す**（FR-13 と同じ理屈。紛失時の対策）。
  その端末でログアウトすると、その端末の購読を消す。
- 90 日開かれていない端末の購読は自動で消す。
- 既定値だけで次のように動く: 割り当てられたメールボックスの新着を、差出人と件名つきで通知。
  owner にはキャッチオールの受け皿の新着も通知する（「キャッチオールを通知する」が既定でオン）。
  同じ会話は 1 件にまとめる。スパム判定は通知しない。
  おやすみ時間なし。
- **キャッチオールの受け皿**（`addresses.is_catch_all`）は、メールボックスが出るすべての画面と通知で
  「キャッチオール」と分かるラベルを付ける。受け皿には実在しない宛先のメールが集まるので、
  通知には本来の宛先（例: `recruit@…`）も出す。
- **「キャッチオールを通知する」スイッチ**を 1 つ持つ。すべての受け皿にまとめて効き、あとからドメインを
  足して受け皿が増えても設定し直さなくてよい。キャッチオールの受け皿を 1 つでも見られる利用者にだけ出す。
  既定はオン。
- 送信失敗は、**そのメールを送った本人にだけ**通知する。

## 4. 通知の判定

1 通の受信について、そのメールボックスに触れられる利用者ごとに、上から順に評価する。
最初に決まったところで止まる。**判定は副作用のない関数 1 つに閉じる**（`src/domain/notify/decide.ts`）。
入力は「メッセージ・スレッド・利用者の設定・現在時刻」、出力は「送る / 後で / 送らない」と理由コード。

| # | 見るもの | 結果 | 理由コード |
| --- | --- | --- | --- |
| 1 | 利用者が `agent` / 無効 / 購読端末 0 | 対象外（履歴にも残さない） | — |
| 2 | アドレスへの割り当てが無い | member は対象外。owner は、**キャッチオールの受け皿は通知の候補に入れる**（10 で決まる）。それ以外の、特権で見えるだけのアドレスは既定でオフ（全アドレスを見られる owner が全部で鳴らないように） | — |
| 3 | 通知が全体でオフ | 送らない | `disabled` |
| 4 | 一時停止中 | 送らない。解除後にも出さない。通知欄に束で残す | `paused` |
| 5 | アドレスルールで破棄・既読にされた | 送らない | `rule_trashed` / `rule_read` |
| 6 | スパム判定 `spam` | 送らない。`suspicious` は設定次第 | `spam` |
| 7 | 会話をミュートしている | 送らない | `thread_muted` |
| 8 | **通知ルール**に一致（優先順で最初の 1 件） | ルールの動作に従う: 必ず通知 / 通知 / 音なしで通知 / 通知しない | `rule:<id>` |
| 9 | 会話をフォローしている | 通知 | `thread_followed` |
| 10 | メールボックスの通知レベル。キャッチオールの受け皿なら、先に「キャッチオールを通知する」を見て、オフなら通知しない | すべて / 新しい会話だけ / To に入っているときだけ / オフ | `mailbox_level` / `catch_all_off` |
| 11 | おやすみ時間中 | 「必ず通知」なら通す。それ以外は 送らない か 終わりにまとめて 1 通。どちらも通知欄に束で残す | `quiet_drop` / `quiet_digest` |
| 12 | 他の端末で使用中（設定したときだけ） | 送らない | `active_elsewhere` |
| 13 | 端末ごとの受け取るメールボックス | 端末単位で間引く | `device_filter` |
| 14 | 短時間に続いた | 1 通にまとめて「新着 5 件」に置き換える | `coalesced` |

送信失敗は 3・4・11 だけを見る。送信失敗は「自分が送ったもの」が壊れた知らせで、
メールボックスの通知レベルやルールで消えてはいけない。

### 通知ルール

ルーティングルール（FR-7）の `matcher` と同じ形を使い、条件を足す。
利用者本人のもので、他人からは見えない。

- 条件: 差出人・宛先・件名・本文（いずれも部分一致）、メールボックス、添付あり、
  自分たちが送った会話への返信、CC にだけ入っている
- 動作: **必ず通知（おやすみ時間も）** / 通知 / 音なしで通知 / 通知しない
- 並べ替えで優先順を決める。最初に一致したものだけが効く

## 5. 方式

### 全体の流れ

```
 受信キュー (processInbound)
   └─ 保存・ルール適用・Webhook の後に NOTIFY を積む  { kind: "notify", messageId }
                                   |
                      (queue consumer: notify)
                                   |
   利用者ごとに decide() ─┬─ 送る ── 端末ごとに暗号化して push サービスへ POST
                          ├─ 後で ── notification_digests に積む
                          └─ 送らない
                                   |
                         notification_log に理由つきで記録

 cron（5 分ごと）── 期限の来た digest を 1 通にして送る / 古い履歴・端末の掃除
```

- 通知は受信処理とは別のキューメッセージにする。push サービスの遅延や失敗で
  受信処理の再試行を起こさないため。キューは既存の `tsubame-outbound` に種類を足す
  （`webhook.retry` と同じ扱い）。新しいキューは作らない。
- おやすみ時間の「終わりにまとめる」は 24 時間を超えうる（金曜夜〜月曜朝）。
  キューの遅延送信（上限 24 時間）では届かないので cron で拾う。`scheduled` ハンドラを新設する。
- **抑制は全部サーバで決める**。プッシュを受けた Service Worker は必ず通知を出さなければならない
  （出さないと iOS は数回で許可を取り消し、Chrome は「バックグラウンドで更新されました」を勝手に出す）。
  「他の端末で使用中なら送らない」「まとめる」を端末側で握りつぶす設計にはできない。
- 1 回の実行で送れる外部リクエストに上限がある（Free で 50）。キューメッセージは利用者 1 人分ずつに分ける。

### Web Push の送信

- **VAPID（RFC 8292）と本文の暗号化（RFC 8291, aes128gcm）を自前で実装する**。
  WebCrypto の ECDH / HKDF / AES-GCM / ECDSA で足りる。定番の `web-push` パッケージは
  MPL-2.0 で、依存に足せるライセンス（MIT / Apache-2.0 / BSD）に入らない。
  実装は RFC 8291 付録 A のテストベクタで単体テストする。
  - VAPID の秘密鍵は raw では読めない。JWK（`d`, `x`, `y`）で持つ。
  - ECDSA の署名は WebCrypto がそのまま r‖s の 64 バイトで返すので、ES256 の JWT に変換なしで使える。
  - Apple は JWT の作り直しを 1 時間に 1 回までにするよう求めている。isolate ごとに作ると超えうるので、
    push サービスの origin ごとに D1 の `settings` に有効期限つきで置いて使い回す。
- 応答の扱い: `201` 成功 / `404`・`410` 購読を削除 / `413` 本文を縮めて再送 /
  `429`・`5xx` 指数バックオフで再試行（Webhook と同じ段数）。
- ヘッダ: `TTL` は 1 日、`Urgency` は「必ず通知」で `high`、通常 `normal`、音なしで `low`。
  `Topic` に会話 ID（32 文字以内）を入れ、端末に届く前の古い通知を置き換える。
- 本文は **Declarative Web Push の形**（`{"web_push": 8030, "notification": {...}}`）で送る。
  Safari は Service Worker が動かなくても OS がそのまま表示し、`app_badge` でバッジも付く。
  Chrome / Firefox はこの形を直接は解釈しないので、Service Worker が同じ JSON を読んで表示する。
  本文の形は 1 つで済む。
- 鍵: `VAPID_PRIVATE_KEY` を Worker Secret、`VAPID_SUBJECT`（`mailto:`）を vars に置く。
  生成は `scripts/vapid-keys.mjs`。**鍵を変えると全購読が無効になる**。
  クライアントは起動時に公開鍵を照合し、違えば購読し直す。

### 通知の中身

本文は端末まで暗号化されるが、ロック画面には出る。表示内容を利用者が選ぶ。

| 設定 | タイトル | 本文 |
| --- | --- | --- |
| 差出人・件名・本文の冒頭（既定） | 差出人名 | 件名 ／ 冒頭 80 字 |
| 差出人と件名 | 差出人名 | 件名 |
| 最小限 | Tsubame | 「新着メール」とメールボックス名だけ |

キャッチオールの受け皿に届いたものは、どの表示でも本文の先頭に「キャッチオール ・ 宛先 recruit@minato.example」を足す
（最小限の表示では宛先を出さず「キャッチオール」だけ）。

- 同じ会話の通知は 1 件にまとめる。`tag` に会話 ID を入れるが、**iOS は `tag` を無視する**
  （WebKit bug 258922、2026 年 7 月時点で未修正）。iOS では Service Worker が表示前に
  `getNotifications()` で同じ会話 ID（`data` に入れておく）の通知を閉じる。
- タップで該当の会話を開く。開いているウィンドウがあればそこへ移る。
- 通知ボタン（Chrome・Firefox のみ。Safari は非対応）: 「既読にする」「ゴミ箱へ」。
  Service Worker からセッション Cookie つきで `PATCH /v1/messages/{id}` を呼ぶ。
- バッジ: 通知と一緒に未読数を送る（`app_badge` と Service Worker の `setAppBadge`）。
  数える範囲は「全メールボックスの未読」「通知するメールボックスの未読」「出さない」から選ぶ。
  iOS と PC で効く。Android は数字のバッジを持たず、未読の通知があれば点が付くだけ。
  **バッジだけを更新するプッシュは送れない**（通知を出さないプッシュになる）。
  他の端末で読んだ分はアプリを開いたときに直す。

### PWA の配り方

- `manifest.webmanifest`: `name` Tsubame Mail / `short_name` Tsubame / `start_url` `/?source=pwa` /
  `display` standalone / `id` `/` / アイコン 192・512・maskable、`apple-touch-icon` 180。
  ショートカットに「作成」「検索」。
- `theme_color` はテーマ切り替え（`src/ui/lib/theme.ts`）に合わせて `<meta name="theme-color">` を書き換える。
  ダークは OS に従わない既存方針のまま。
- Service Worker は `src/ui/sw.ts` を Vite の別エントリとして `/sw.js`（ハッシュなし）に出す。
  `not_found_handling: single-page-application` のため、**`sw.js` が無いと `index.html` が返って登録が壊れる**。
  ビルドの検査に「`dist/client/sw.js` がある」を足す。
- キャッシュはアプリの殻（`index.html` と `assets/`）だけ。`/api/*` は常にネットワーク。
- `sw.js` と `manifest.webmanifest` は `Cache-Control: no-cache` で配る。

### 端末ごとの差（2026 年 9 月時点で確認）

| 項目 | iOS / iPadOS（ホーム画面） | Android Chrome | PC（Chrome / Edge / Firefox / Safari） |
| --- | --- | --- | --- |
| プッシュ通知 | 16.4 以降。**ホーム画面から開いたときだけ** | ○ | ○ |
| インストールボタン（`beforeinstallprompt`） | ×（共有メニューから手で追加） | ○ | Chrome・Edge のみ |
| 同じ会話の置き換え（`tag`） | ×（無視される） | ○ | ○ |
| 音なし（`silent`） | × | ○ | ○ |
| 通知のボタン（`actions`） | × | ○ | Chrome・Edge・Firefox 152 以降。Safari × |
| 数字のバッジ | ○（利用者が通知設定で切れる） | ×（点のみ） | Chrome・Edge ○ |
| 通知を出さないプッシュ | ×（数回で許可が取り消される） | △（汎用の通知が出る） | △ |
| 集中モード・時刻指定要約 | 通常の通知として扱われる。「即時通知」にはできない | — | — |

設計に効くこと:

- 通知は **ホーム画面に追加したアプリからしか許可できない**。Safari のタブでは許可を求めない。
  そのため「追加 → 追加したアイコンから開く → 許可」の 3 段を画面で案内する。
- 許可を求めるのは **ボタンを押した直後だけ**。iOS は購読の呼び出しもそのタップの処理中に
  すぐ行うことを求める。起動時に自動で求めない（どの OS でも同じにする）。
- iOS 26 から、ホーム画面に追加したサイトは manifest が無くても Web アプリとして開く。
  追加の手順は「…」→「共有」→「ホーム画面に追加」→「Web アプリとして開く」をオンのまま「追加」。
  共有ボタンがツールバーに出ている配置もあるので、文言は両方に通じるようにする。
- ホーム画面のアプリは Safari とログイン状態を共有しないことがある。追加後の初回はログインし直す前提で案内する。
- 「音なしで通知」は iOS では通常の通知と同じになる。「必ず通知」も集中モードを突き抜けられない。
  画面ではできないことを約束しない（注記を出す）。
- Chrome は通知が多く反応の少ないサイトの許可を自動で取り消すようになった（2025 年 10 月〜）。
  **インストールした Web アプリは対象外**なので、PC でもインストールを勧める理由になる。

## 6. データモデル案

`src/db/schema.ts` への追記（W1 への**要依頼**）。ID 接頭辞は `dev_` `nrl_` `ntf_`。

| テーブル | 目的 | 要点 |
| --- | --- | --- |
| `push_devices` | 購読端末 | `user_id`, `endpoint`(一意), `p256dh`, `auth`, `name`, `platform: ios \| android \| desktop`, `enabled`, `address_ids[] \| null`（受け取るメールボックス）, `last_seen_at`, `last_success_at`, `failure_count` |
| `notification_prefs` | 利用者の設定 1 行 | `enabled`, `paused_until`, `display: full \| sender_subject \| minimal`, `badge: all \| notified \| off`, `group_by_thread`, `burst_window_sec`, `suppress_when_active`, `spam_suspicious: notify \| drop`, `quiet`(JSON: `tz`, 曜日と時間帯の配列, `mode: drop \| digest`), `notify_send_failure`, `notify_catch_all`（既定 true）, `feed_seen_at`（通知欄を最後に開いた時刻。未確認数に使う） |
| `notification_mailbox_prefs` | メールボックスごと | `(user_id, address_id)` 主キー, `level: all \| new_thread \| direct \| off` |
| `notification_rules` | 通知ルール | `user_id`, `name`, `matcher`(JSON), `action: always \| normal \| silent \| never`, `priority`, `enabled` |
| `thread_notification_prefs` | 会話ごと | `(user_id, thread_id)` 主キー, `mode: follow \| mute` |
| `notification_digests` | 後でまとめる分 | `user_id`, `due_at`, `message_ids[]` |
| `notification_log` | 判定の履歴。通知欄の中身 | `user_id`, `message_id`, `decision: sent \| held \| digest \| dropped`, `reason`, `hold_group`（同じ一時停止・おやすみの束）, `device_count`, `created_at`。30 日で消す |

- 設定の行が無い利用者は既定値で動く。**設定を作らないと通知が来ない、にはしない**。
- 「自分たちが送った会話への返信」は、スレッドに `direction=outbound` があるかで判定する。
  共有メールボックスで「自分が」送ったかまで見るなら、下の `sent_by_user_id` を使える。

既存のテーブルへの追記（W1 への**要依頼**）:

| 列 | 目的 | 要点 |
| --- | --- | --- |
| `messages.sent_by_user_id` | 送信失敗を本人にだけ知らせる | `POST /v1/messages` と返信で、`principal.userId` を入れる（API キーで送ったらキーの持ち主）。受信メールと既存の送信済みは null。null の送信失敗は、そのメールボックスに `write` を持つ全員に知らせる |
| `messages.envelope_to` | キャッチオールに届いたメールの本来の宛先 | 受信キューのメッセージには `envelope.to` として既に載っているが、保存していない。`processInbound` で保存する。To ヘッダは BCC やメーリングリストで本来の宛先と食い違うので代わりにならない |

## 7. API 案

すべて `/api/v1/*`。**セッション限定**（API キーで叩くと 403）。自分の分しか触れない。

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/v1/me/notifications` | 設定一式（全体・メールボックスごと・ルール） |
| PATCH | `/v1/me/notifications` | 全体設定の部分更新。プリセットの適用もここ |
| PUT | `/v1/me/notifications/mailboxes/{addressId}` | メールボックスの通知レベル |
| GET/POST/PATCH/DELETE | `/v1/me/notifications/rules` | 通知ルール |
| POST | `/v1/me/notifications/rules/reorder` | 並べ替え |
| POST | `/v1/me/notifications/dry-run` | 最近のメールに今の設定を当てて、どう判定されるかを返す（ルール編集画面の「試す」） |
| GET | `/v1/me/notifications/feed` | 通知欄（カーソルページング）。`include_dropped=1` で対象外も理由つきで返す |
| POST | `/v1/me/notifications/feed/seen` | 通知欄を開いた（未確認数を 0 にする） |
| PUT/DELETE | `/v1/threads/{id}/notification` | 会話のフォロー / ミュート |
| GET | `/v1/me/devices` | 自分の端末一覧 |
| POST | `/v1/me/devices` | 購読の登録（`endpoint`, `keys`, `name`, `platform`）。同じ `endpoint` は上書き |
| PATCH/DELETE | `/v1/me/devices/{id}` | 名前・有効・受け取るメールボックス / 削除 |
| POST | `/v1/me/devices/{id}/test` | テスト通知 |
| POST | `/v1/me/devices/{id}/seen` | 使用中の合図（「他の端末で使用中なら送らない」用。表示中だけ 60 秒ごと） |
| GET | `/v1/push/key` | VAPID 公開鍵 |

## 8. 担当と置き場所

ワークストリーム **W11（通知）・W7（UI・SW）**。

```
src/domain/notify/
  decide.ts              [W11] 判定。副作用なし。単体テストの主戦場
  schedule.ts            [W11] おやすみ時間の計算（タイムゾーン込み）
src/services/notify.ts        [W11] キューのコンシューマ、digest の送信、cron
src/services/notify/
  deliver.ts             [W11] 端末ごとの送信と応答の処理
  load.ts                [W11] 通知対象の読み込み
  prefs.ts               [W11] 設定の読み込み・未読数
  render.ts              [W11] 本文の描画（Declarative Web Push の JSON）
  token-cache.ts         [W11] VAPID JWT の D1 キャッシュ
src/services/webpush.ts       [W11] VAPID と暗号化と送信
src/api/v1/notifications.ts   [W11]
src/api/v1/devices.ts         [W11]
src/api/v1/push.ts            [W11] VAPID 公開鍵
src/shared/contracts/notifications.ts [W11]
src/ui/sw.ts                  [W7]  Service Worker
src/ui/routes/settings/notifications/ [W7]
src/ui/routes/welcome/notifications.tsx [W7]
src/ui/routes/NotificationsFeed.tsx     [W7]
public/manifest.webmanifest, public/icons/  [W7]
```

要依頼: `schema.ts`（テーブル追加）、`queue.ts`（`notify` 種別）、`worker.ts`（`scheduled`）、
`wrangler.jsonc`（cron）、`vite.config.ts`（SW のエントリ）、`inbound.ts`（NOTIFY を積む 1 行）、
`AppLayout.tsx`（スマホ配置）— はすべて実装済み。残るは統合（`app.ts` への push ルート載せ等）。

## 9. 段階

| 段階 | 中身 | 出せる状態 |
| --- | --- | --- |
| 1 | manifest / アイコン / SW（殻だけ）/ スマホ配置 / 追加の案内 | ホーム画面から使える |
| 2 | Web Push 送信、端末登録、全体オン・オフ、メールボックスごとのレベル、表示内容、テスト通知 | 通知が来る |
| 3 | 通知ルール、会話のフォロー・ミュート、おやすみ時間（まとめ含む）、通知欄 | 細かく制御できる |
| 4 | バッジ、連続まとめ、他端末使用中の抑制、端末ごとのメールボックス、通知ボタン | 仕上げ |

e2e は段階 2 から FR-16 に付ける。判定関数は段階 2 の時点で全分岐の単体テストを持つ。

## 10. 決定事項と未決事項

決定済み:

- 一時停止の解除後に、止めていた間の分は**通知として出さない**。通知欄で束として見えるようにする。
- 送信失敗は**送った本人にだけ**通知する（`messages.sent_by_user_id` を足す）。
- owner には**キャッチオールの受け皿を既定で通知**する。キャッチオールは画面でラベルを付けて見分けられるようにする。
- キャッチオールは**専用のスイッチ「キャッチオールを通知する」**でまとめてオン・オフできる。
  通知ルールはこのスイッチより先に効く（「必ず通知」に一致すれば、スイッチがオフでも通知する）。
  それ以外の、owner の特権で見えるだけのメールボックスは既定でオフ。

未決:

1. おやすみ時間を利用者に 1 つにするか、端末ごとに持たせるか（案は利用者に 1 つ）。
2. Android の「共有」から作成画面を開く（`share_target`）を入れるか（案は段階 4 以降）。
3. 管理画面のバッジは今「catch-all」と英語で出ている。スマホ側の「キャッチオール」に揃えるか。

## 参考

- Apple: [Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- WebKit: [Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) /
  [Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/) /
  [WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) /
  [bug 258922（`tag` が効かない）](https://bugs.webkit.org/show_bug.cgi?id=258922)
- Chrome: [Badging API](https://developer.chrome.com/docs/capabilities/web-apis/badging-api) /
  [通知の許可の自動取り消し](https://blog.google/chromium/automatic-notification-permission/)
- web.dev: [The Web Push Protocol](https://web.dev/articles/push-notifications-web-push-protocol)
- Cloudflare: [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) /
  [Queues の上限](https://developers.cloudflare.com/queues/platform/limits/) /
  [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- RFC 8030（Web Push）/ RFC 8291（本文の暗号化）/ RFC 8292（VAPID）
