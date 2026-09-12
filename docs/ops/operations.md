# 日常運用（operating manual）

`tsubame` が動いている間の、ログ確認・トラブルシュート・メンテナンス手順。

## 0. 対象

- Worker: `tsubame`
- D1: `tsubame`、R2: `tsubame-mail`、Queues: `tsubame-inbound` / `tsubame-outbound`
- 公開ホスト: 初回は `mail.example.com`（切り替え前は検証用 `tsubame.example.com`）

---

## 1. ログの見方（`wrangler tail`）

Worker が実時間で出したログをリアルタイムで見る:

```bash
npx wrangler tail tsubame
```

- 受信パイプラインの流れを追うのが目的なら、受信ハンドラと Queue コンシューマの
  `console.log`（`inbound` / `outbound` 処理の開始・完了）を追う。
- フィルタしたいときは `wrangler tail --format pretty` や、出力を `grep` で絞る。
- 大量にログが出るときは `--status` や `--format` 等で絞る（`wrangler tail --help` を参照）。

ログが出ないとき:
- デプロイが最新か（`npm run deploy` を走らせたか）。
- `wrangler tail` を別端末で一度止めて掛け直す。
- そもそも Worker にリクエスト・イベントが届いていない（ルーティングが `旧 Worker` のまま
  等）。`docs/ops/cutover.md` のルール宛先を確認。

---

## 2. キューが詰まったとき

受信・送信それぞれにキューがある。遅延・滞留を確認する手順。

### 2.1 キューの状態を見る

```bash
npx wrangler queues list
npx wrangler queues info tsubame-inbound
npx wrangler queues info tsubame-outbound
```

### 2.2 詰まりの切り分け

- **`tsubame-inbound` が詰まる**: コンシューマ（`src/services/consumer.ts`）が
  失敗して再試行を繰り返している可能性。R2 からの読み出しや D1 への保存で例外が出ていないか、
  `wrangler tail` を流しながら確認する。
- **`tsubame-outbound` が詰まる**: このキューには送信（`outbound.send`）のほか、Webhook の配信（`webhook.retry`）と
  プッシュ通知の判定（`notify`）も流れる（`src/services/queue.ts`）。送信が失敗し続けている（`outbound_jobs` が `failed` /
  `queued` のまま増える）なら次節、Webhook なら第 3.5 節。通知は push サービスの一時失敗を 30 秒・5 分・30 分の
  遅延で 3 回まで再試行する。

再試行回数を超えるとメッセージは DLQ（`tsubame-inbound-dlq` / `tsubame-outbound-dlq`）に落ちる。
`wrangler.jsonc` の `queues.consumers[].max_retries` が再試行上限、`dead_letter_queue` が送り先。
DLQ まで落ちた場合は次節の手順で内容を確認する。

### 2.3 メッセージが落ちた/DLQ の見方・再投入

DLQ に滞留していないかは `npx wrangler queues info <dlq>` の遅延・滞留数で見る。

```bash
npx wrangler queues info tsubame-inbound-dlq
npx wrangler queues info tsubame-outbound-dlq
```

- **受信の DLQ（`tsubame-inbound-dlq`）**: 落ちたメッセージの `rawKey` には、送信側で
  先に R2（`tsubame-mail` の `raw/`）へ置いた**生 MIME の場所**だけが入っている。中身そのものは
  R2 に残るので、`rawKey` を控えて `src/services/queue.ts` の `InboundQueueMessage`
  （`kind: "inbound"` / `addressId` / `rawKey` / `envelope` / `receivedAt`）の形で
  `wrangler queues message put tsubame-inbound ...` から積み直す。原因を取り除いてから積めば
  コンシューマが通常処理する。
- **送信の DLQ（`tsubame-outbound-dlq`）**: メッセージの `kind` で分ける。
  - `outbound.send`（`jobId` / `messageId`）: 送るべき MIME は残っていない。
    落ちた原因を直したあと、該当メールはアプリの作成画面（または `POST /api/v1/messages`）から
    **作り直して送る**。`outbound_jobs` 行を `queued` に戻しても再送の引き金にはならない
    （再配達は OUTBOUND キューをコンシューマが拾うことで起きる。第 3 節参照）。
  - `webhook.retry`（`deliveryId` / `attempt`）: `webhook_deliveries` の行は `pending` のまま残る。
    再試行の予定から 30 分経てば、管理画面の Webhook の詳細か `POST /api/v1/webhooks/deliveries/{id}/retry` で手動で再送できる（第 3.5 節）。
  - `notify`（`messageId` / `userId`）: プッシュ通知の判定が走らなかっただけで、メールは届いている。積み直す価値は薄い。

基本的に落ちたメッセージの単純な再投入はせず、`wrangler tail` のエラー内容を元に原因を直して
再度受信が来るのを待つ。DLQ が空になるまで原因を直せないときだけ、上の手順で積み直す。
送信ジョブの失敗は `outbound_jobs` で管理しているので（次節）、再試行をその仕組みに委ねる。

---

## 3. 送信が失敗し続けるとき

送信は `outbound_jobs` テーブルで状態管理している。ここを見るのが最初の手。

### 3.1 `outbound_jobs` を確認する

```bash
# scripts/deploy.sh --keep-config で生成した設定を使う（database_id の実 ID が要る）
npx wrangler d1 execute DB --config wrangler.local.jsonc --remote --command \
  "SELECT id, message_id, status, attempts, last_error, next_attempt_at FROM outbound_jobs ORDER BY created_at DESC LIMIT 20;"
```

（`id` などの実カラム名は `src/db/schema.ts` の `outbound_jobs` を確認。）

### 3.2 典型的な原因

- **Email Sending の権限 / 設定不足**: `CF_API_TOKEN` に `Email Sending – Edit` が無い、
  またはドメインで Email Sending（SPF / DKIM / DMARC）が未整備。
  `last_error` に権限・認証系のメッセージが入る。
- **差出人が許可されていない**: Email Sending で送れる送信元アドレスの承認が漏れている。
- **ゾーン設定エラー**: 送信ドメインの SPF / DKIM レコードが古い・無い。
- **ドメインの送信を無効にしている**: 管理画面のドメインで送信を無効にすると、API は 409 を返し、
  無効化の前に積まれた分は `last_error` が「このドメインは送信が無効になっています」で `failed` になる。
  有効に戻しても `failed` は再送されない（作り直す）。

対処は原因に応じた設定修正。

`sent` は Cloudflare Email Sending が受け付けたという意味で、届いたことではない。スパムとして拒否された・
存在しない宛先だった、はダッシュボードの Email Sending の Activity log でしか分からず、送信ドメインの評判
（Bounce rate / Spam rejection rate）に数えられる。検証で存在しない宛先やスパムの見本を送るときは本番の送信ドメインを使わない。

**直したあと、`failed` ジョブを SQL で `status='queued'` に戻しても再送はされない。** 送信ジョブの
再配達は OUTBOUND キュー（`OUTBOUND_QUEUE`）のメッセージをコンシューマが拾うことで起き、
`outbound_jobs` の行を表から拾うスイープは無い。試行回数の上限（`src/domain/mail/outbound.ts` の
`OUTBOUND_MAX_ATTEMPTS`）を超えた `failed` はそのまま終端し、対応するメッセージも `failed` になる。

再送したいなら、アプリの作成画面（または `POST /api/v1/messages`）から**そのメールを作り直して送る**。
一時的な失敗（権限・SPF/DKIM の整備待ちなど）は、そもそも上限内の指数バックオフで自動再送されるので、
設定修正はその再送が追いつく前に終えるのが正しい。

### 3.5 Webhook の配信が失敗するとき

配信の流れ（`src/services/webhooks.ts`）:

1. 受信・送信の処理が `webhook_deliveries` に `pending`（`attempt=0`）の行を作り、`webhook.retry` を `tsubame-outbound` に積む。
   受け手への POST（最大 10 秒）はここでは待たない。
2. コンシューマが POST する。2xx で `success`。それ以外と接続失敗は 30 秒 / 300 秒 / 1800 秒の遅延で積み直し、5 回目で `failed`。
   リダイレクト（3xx）は追わず失敗として扱う。
3. `pending` のまま止まった配信（キューのメッセージを失った・無効化で claim だけ残った）は、再試行の予定（無ければ作成）から
   30 分経つと手動で再送できる。`failed` はいつでも再送できる。

見る場所は管理画面の Webhook の詳細（配信履歴の全件と、その Webhook への操作の記録）か、
`GET /api/v1/webhooks/{id}/deliveries`。`http_status` / `error` / `attempt` / `next_retry_at` が入る。

```bash
curl -X POST "$HOST/api/v1/webhooks/deliveries/<dlv_...>/retry" -H "Authorization: Bearer tsb_..."
# 今は再送できない（30 分経っていない・無効化した Webhook）なら 409
```

再送は同期で POST し、結果を返す。同じ試行が重なっても受け手に届くのは 1 回。
`secret` は作成の応答にしか出ず、失くしたら Webhook を作り直す（`docs/ops/deployment.md` §3.1）。

---

## 4. 新しいドメインを足すとき

ドメイン接続はアプリの管理画面（`/admin/domains` 系 API）から行うが、
**Cloudflare 側の `CF_API_TOKEN` の Zone リソース範囲が、そのドメイン（ゾーン）を
含むまで広がっていないと接続できない**。

1. **トークンの Zone リソースを広げ直す**。
   Cloudflare ダッシュボード → *My Profile → API Tokens* → `CF_API_TOKEN` の編集 →
   Zone リソースを、追加したいゾーンを含むように変更（例: 特定ゾーンの列挙に
   新ドメインのゾーンを足す）。
2. 変更を保存し、その値で **Worker の `CF_API_TOKEN` シークレットを更新**する。
   ```bash
   npx wrangler secret put CF_API_TOKEN
   ```
3. アプリの管理画面で新しいドメインを接続する。Email Routing と Email Sending の
   DNS が自動で整う（`docs/spec/architecture.md` 第 8 節）。

> 注意: **catch-all はゾーン単位**で全メールを飲む。apex の MX が他（例: Google
> Workspace）を向いているドメインで catch-all を有効化すると全部吸い込む。
> apex を Cloudflare に向けない限り無害だが、既定では有効化しないのが方針。

---

## 5. D1 のバックアップ（`wrangler d1 export`）

```bash
npx wrangler d1 export tsubame --remote --output ./backup-$(date +%Y%m%d).sql
```

- フルダンプ（SQL）。復元は `wrangler d1 execute ... --file` 経由で行う。
- スキーマと実データの両方が取れる。
- 定期的に取る目安: 重要な受信がある運用なら日次、小規模なら週次から。
- 添付と生 MIME は R2（`tsubame-mail`）にあるので、そちらもバックアップ対象にする
  （R2 は Cloudflare 側のバケット管理画面からオブジェクトを取得できる）。

---

## 6. 定期的な確認（チェックリスト）

- [ ] 受信：新着メールが D1 に増えている（`GET /api/v1/messages`）
- [ ] 送信：`outbound_jobs` に `failed` が増えていない。Cloudflare の Email Sending の評判（Bounce / Spam rejection）が悪化していない
- [ ] Webhook：`webhook_deliveries` に `failed` や 30 分以上の `pending` が溜まっていない（第 3.5 節）
- [ ] キュー：`tsubame-inbound` / `tsubame-outbound` と DLQ が滞留していない
- [ ] 通知：`push_devices` で `enabled=false`（恒久失敗が 3 回続いた端末）が増えていない
- [ ] D1 バックアップが最新
- [ ] `CF_API_TOKEN` に未使用の権限が付いていないか（最小権限の維持）
- [ ] 監査ログ（`GET /api/v1/admin/audit-logs`）に覚えのない管理操作が無い。400 日で消えるので、長く残すなら書き出す（`docs/ops/audit-log.md`）
- [ ] 監査ログの `admin_mode.enter` に覚えのないものが無い（owner のセッションが取られると全員のメールが読める）
- [ ] プライマリ未設定（`⚠`）の member / agent と、未確認のまま止まっている外部アドレスが増えていない（第 8 節）

---

## 7. トラブル時に確認する順（フロー）

1. `npx wrangler tail tsubame` でエラーが出ているか
2. キューが詰まっていないか → 第 2 節
3. 送信なら `outbound_jobs` → 第 3 節
4. 受信が来ないなら Email Routing ルールの宛先 Worker（`tsubame` か）と DNS → `docs/ops/cutover.md`
5. 「届いているのに画面に出ない」なら、そのアドレスが自分に割り当たっているか（第 8 節）。owner でも割り当てが要る
6. それでも分からなければ DB / ログを統合担当に相談

---

## 8. 見る範囲・割り当て・プライマリ（`0008` の後）

owner も含めて、**自分に割り当てたアドレスのメールしか見えない**（FR-11）。全部を読むのは管理者モード（画面のアカウントメニュー。1 時間で切れ、
入った・出たが監査ログ `admin_mode.enter` / `exit` に残る。読めるだけで、送信・既読・ゴミ箱は自分の割り当てだけ）。
`0008_visibility_and_primary` を流した直後の変化は `docs/ops/deployment.md` §5.3。

### 8.1 デプロイ後にオーナーが自分に割り当て直す

`0008` は「誰にも割り当てていないアドレス」だけを owner に割り当てる。他の人に割り当て済みだったアドレスは owner から消えているので、要るものを足す。

1. 何が自分から消えたかを見る（誰かに割り当て済みで、自分には無いアドレス）:
   ```bash
   npx wrangler d1 execute DB --config wrangler.local.jsonc --remote --command \
     "SELECT a.address FROM addresses a WHERE a.archived_at IS NULL AND EXISTS (SELECT 1 FROM address_grants g WHERE g.address_id = a.id) AND NOT EXISTS (SELECT 1 FROM address_grants g JOIN users u ON u.id = g.user_id WHERE g.address_id = a.id AND u.role = 'owner') ORDER BY a.address;"
   ```
2. 画面: 管理 → ユーザー → 自分 → 権限を編集 → 要るアドレスに `write`（読むだけなら `read`）→ 保存。
   API なら `PUT /api/v1/admin/users/{自分の id}/grants`（セッション限定。今の割り当てに足す形で全件を渡す。プライマリは外しても write で残る）。
3. 通知が要るメールボックスは、割り当てた後に 設定 → 通知 → メールボックスごと で確かめる（割り当てが無い間は通知の対象外）。

新しく作るアドレスは、作成画面の「自分（作成したオーナー）に write で割り当てる」を付けないと誰にも見えない。

### 8.2 プライマリの無い member / agent を見つける

member / agent はプライマリアドレス（本人のメールボックス。ログインにも使う）が必須だが、`0008` は `write` のメールボックスが無い人には付けられない。
管理 → ユーザー の一覧で名前の横に `⚠`（プライマリ未設定）が出る。SQL なら:

```console
SELECT id, name, role, external_email, external_verified_at
FROM users
WHERE primary_address_id IS NULL AND role IN ('member', 'agent') AND status = 'active';
```

付け方: ユーザーの詳細 → 権限を編集 でメールボックスを `write` で割り当て → 「プライマリを変更」で選ぶ（`PATCH /api/v1/admin/users/{id}` の `primaryAddressId`）。
メールボックスが無ければ先に作る（アドレス作成、または「ユーザーを作成」の「この場で新しいアドレスを作る」と同じ形）。
プライマリの無い人は、移行で確認済みになった外部アドレスでログインできるので急がないが、外部アドレスも無い agent は影響が無い（API キーで動く）。

### 8.3 外部アドレスとログイン

- ログインに使えるのは **プライマリアドレス** か **確認済みの外部アドレス**。`0008` で写した既存のログイン用アドレスは確認済み。
- 外部アドレスを登録し直すと未確認に戻り、確認するまでそのアドレスでは入れない（プライマリでは入れる）。
  確認メールは送信が有効なドメインのメールボックスから出る。無ければ `sent: false` で、ドメインの送信を有効にしてから設定画面で「確認メールを送り直す」。
- owner が代わりに登録できる: ユーザーの詳細ではなく API `PUT /api/v1/admin/users/{id}/external-email`（セッション限定）。コードは本人のアドレスに届く。
- 未確認のまま止まっている人:
  ```console
  SELECT id, name, external_email FROM users WHERE external_email IS NOT NULL AND external_verified_at IS NULL;
  ```
- 旧 `users.email` 列は外部アドレスの写し（無い人は `<id>@users.invalid`）。SQL で見るときは `external_email` を使う。
