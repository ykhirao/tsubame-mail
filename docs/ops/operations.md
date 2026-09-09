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
npx wrangler queue list
npx wrangler queue info tsubame-inbound
npx wrangler queue info tsubame-outbound
```

### 2.2 詰まりの切り分け

- **`tsubame-inbound` が詰まる**: コンシューマ（`src/services/consumer.ts`）が
  失敗して再試行を繰り返している可能性。R2 からの読み出しや D1 への保存で例外が出ていないか、
  `wrangler tail` を流しながら確認する。
- **`tsubame-outbound` が詰まる**: 送信が失敗し続けている（`outbound_jobs` が `failed` /
  `queued` のまま増える）。次節を参照。

再試行回数を超えるとメッセージはキューから落ちる。`wrangler.jsonc` の
`queues.consumers[].max_retries` が再試行上限。

### 2.3 メッセージが落ちた/手動再投入が必要なとき

基本は落ちたメッセージの再投入は行わず、`wrangler tail` のエラー内容を元に原因を直して
再度受信が来るのを待つ。送信ジョブだけは失敗を `outbound_jobs` で管理しているので
（次節）、再試行をその仕組みに委ねる。

---

## 3. 送信が失敗し続けるとき

送信は `outbound_jobs` テーブルで状態管理している。ここを見るのが最初の手。

### 3.1 `outbound_jobs` を確認する

```bash
# D1 をローカルで触る場合（実際は本番なので --remote）
npx wrangler d1 execute tsubame --remote --command \
  "SELECT job_id, message_id, status, attempts, last_error, next_attempt_at FROM outbound_jobs ORDER BY created_at DESC LIMIT 20;"
```

（`job_id` などの実カラム名は `src/db/schema.ts` の `outbound_jobs` を確認。）

### 3.2 典型的な原因

- **Email Sending の権限 / 設定不足**: `CF_API_TOKEN` に `Email Sending – Edit` が無い、
  またはドメインで Email Sending（SPF / DKIM / DMARC）が未整備。
  `last_error` に権限・認証系のメッセージが入る。
- **差出人が許可されていない**: Email Sending で送れる送信元アドレスの承認が漏れている。
- **ゾーン設定エラー**: 送信ドメインの SPF / DKIM レコードが古い・無い。

対処は原因に応じた設定修正。直したら失敗ジョブを再試行に戻す:
```bash
npx wrangler d1 execute tsubame --remote --command \
  "UPDATE outbound_jobs SET status='queued', attempts=0, last_error=NULL, next_attempt_at=strftime('%s','now') WHERE status='failed';"
```
（必要に応じて対象のジョブ ID で絞る。実行前に必ずバックアップを取る）

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
- [ ] 送信：`outbound_jobs` に `failed` が増えていない
- [ ] キュー：`tsubame-inbound` / `tsubame-outbound` が滞留していない
- [ ] D1 バックアップが最新
- [ ] `CF_API_TOKEN` に未使用の権限が付いていないか（最小権限の維持）

---

## 7. トラブル時に確認する順（フロー）

1. `npx wrangler tail tsubame` でエラーが出ているか
2. キューが詰まっていないか → 第 2 節
3. 送信なら `outbound_jobs` → 第 3 節
4. 受信が来ないなら Email Routing ルールの宛先 Worker（`tsubame` か）と DNS → `docs/ops/cutover.md`
5. それでも分からなければ DB / ログを統合担当に相談
