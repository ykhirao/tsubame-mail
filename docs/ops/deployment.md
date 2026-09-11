# 初回デプロイ手順（tsubame）

本番 Worker（`tsubame`）を Cloudflare に新規デプロイするための手順。
**上から順番に実行すれば最後まで完了する**ことを想定している。

## 0. 前提

- **Workers の有料プランが必要。** Queues が作れるかどうかで確認できる。
- 受信に使うドメインが Cloudflare のゾーンとして登録されていること。
- 実行マシンで wrangler（`npx wrangler`）と npm が使えること。
- Worker 名を `tsubame` 以外にする場合は、`wrangler.jsonc` の `name`・
  `vars.EMAIL_WORKER_NAME`・Email Routing のルール宛先の **3 箇所すべて**を揃える
  （ズレると受信が止まる。AGENTS.md 落とし穴 2）。

> **既にメールを受けているドメインに入れる場合**は、apex の MX を奪うと
> そのドメインの全メールがこのアプリに流れ込む（Cloudflare の catch-all は
> ゾーン単位）。サブドメイン（`mail.example.com` など）から始めるのが安全。
> 既存の受信経路からの切り替えは `docs/ops/cutover.md` を参照。

### 使うツール

| 項目 | 想定 |
| --- | --- |
| Node.js | 24.x（リポジトリの CI と同じ） |
| 認証 | `wrangler login`（ブラウザ OAuth、以降のローカル作業向け） | 
| 本番デプロイ | GitHub Actions（手動 `workflow_dispatch`）かローカルの `scripts/deploy.sh` |

---

## 1. 依存を揃える

```bash
npm ci
```

---

## 2. リソースを作る

既にあるものは `wrangler` がエラーを返す。未作成のものだけ実行する。

```bash
# D1（データベース）。database_id を控える。↓
npx wrangler d1 create tsubame

# R2（生 MIME と添付）
npx wrangler r2 bucket create tsubame-mail

# Queues（受信・送信とそれぞれの DLQ）
npx wrangler queue create tsubame-inbound
npx wrangler queue create tsubame-outbound
npx wrangler queue create tsubame-inbound-dlq
npx wrangler queue create tsubame-outbound-dlq
```

受信・送信のキューはどちらも 3 回失敗すると DLQ（`tsubame-inbound-dlq` /
`tsubame-outbound-dlq`）に落ちる。作っておかないとデプロイが失敗する。

`npx wrangler d1 create tsubame` の出力に `database_id = "<UUID>"` がある。

**この UUID が `wrangler.jsonc` の `d1_databases[].database_id` に入る値。**
アカウント固有の ID なのでコミットしない（第 4 節の注入方式に従う）。

> 補足: `wrangler.jsonc` の D1 はプレースホルダの UUID
> `00000000-0000-0000-0000-000000000000` になっている。実デプロイ時だけ実際の ID に置き換える。

---

## 3. Worker Secret を投入する

`tsubame` Worker に 3 つのシークレットを設定する。`wrangler login` 済みの状態で:

```bash
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put INTERNAL_SECRET
```

それぞれの値は以下。

### CF_API_TOKEN（Cloudflare API トークン）

Cloudflare ダッシュボード → *My Profile → API Tokens → Create Token*（カスタムトークン）。

必要権限:

| レベル | 権限 |
| --- | --- |
| Account | Email Routing Addresses – **Edit** |
| Account | Email Sending – **Edit** |
| Zone | Email Routing Rules – **Edit** |
| Zone | DNS – **Edit** |
| Zone | Zone Settings – **Edit** |
| Zone | Zone – **Read** |

Zone リソースは **最初に使う 1 ゾーンだけ**に限定する。
ドメインを増やすたびにこの Zone リソースの範囲を広げ直す必要がある
（詳細は `docs/ops/operations.md` の「新しいドメインを足すとき」参照）。

### CF_ACCOUNT_ID

アカウント ID（Cloudflare のダッシュボード右側に出る 32 桁の英数字）。

### INTERNAL_SECRET

最初のオーナーを作るときの合言葉（`worker-env.d.ts` 参照）。**20 文字以上**の乱数にする:

```bash
openssl rand -base64 32
```

未設定、または 20 文字未満だと `POST /api/v1/auth/bootstrap` が 403 を返し、
**誰もオーナーを作れない**（安全側に倒してある）。詳細は第 8 節。

> GitHub Actions でデプロイする場合は、上記 3 つに加えて
> `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID` を
> リポジトリの Secrets に登録する（第 7 節の GitHub Actions を参照）。

---

## 4. `database_id` の注入方針

`wrangler.jsonc` にはプレースホルダの UUID が入っており、**アカウント固有の `database_id` をリポジトリにコミットしない**。これを実現するため、次の方式を採用する。

### 採用方式: デプロイ時に `wrangler.local.jsonc` を生成して注入

- `scripts/deploy.sh` が、コミット済み `wrangler.jsonc` のプレースホルダ UUID を
  環境変数 `D1_DATABASE_ID` で受け取った実 ID に**置き換えて**
  `wrangler.local.jsonc` を生成する。
- `wrangler.local.jsonc` は `.gitignore` に明示してあるため**コミットされない**。
- 生成した設定ファイルを使って D1 マイグレーション適用と `wrangler deploy --config` を実行する。

**この方式を選んだ理由**:
1. リポジトリにアカウント固有の ID を一切書かない（要件・設計の制約を満たす）。
2. ローカル実行と CI が**同じ 1 本のスクリプト**で動く。CI では `D1_DATABASE_ID` を
   GitHub Actions の Secrets から渡すだけでよい。
3. `wrangler.jsonc` 本体（他の担当が編集する可能性があるファイル）に手を入れない。
4. 生成ファイルをリポジトリ直下に置くので `migrations_dir` / `main` など相対パスが
   壊れない（設定ファイルの位置基準で解決されるため）。

代替候補（不採用）:
- **`.gitignore` して実 ID 入り `wrangler.jsonc` を各所に配る** → 実ファイルと管理ファイルが
  ズレやすく、差分を見失いやすい。開発者ごとの手動作業が増える。
- **`wrangler.jsonc.example` を配る** → 参照用として付属させるが、注入の自動化には
  向かないため主方式にはしない（第 4.1 節）。

### 4.1 `wrangler.jsonc.example`

`wrangler.jsonc.example` は設定の**リファレンス用**のコピーとして置いてある。
プレースホルダの UUID を含めた構成が書かれており、`database_id` をどこで注入するかの
確認に使う。実行には使わない（実行は常に `scripts/deploy.sh` 経由）。

### 4.2 ローカルでの確認手順

開発時にログイン済みの状態で、実 ID を入れて試す:

```bash
D1_DATABASE_ID="<手順2で控えたUUID>" ./scripts/deploy.sh --skip-build
```

（`--skip-build` はビルド済みのとき用。初回は外してビルドから通す。）

---

## 5. マイグレーションを適用する

`scripts/deploy.sh` が実行するため、通常は単独で叩く必要はない。
手動で行う場合:

```bash
D1_DATABASE_ID="<UUID>" npx wrangler d1 migrations apply DB --config wrangler.local.jsonc --remote
```

ただし `wrangler.local.jsonc` は生成物なので、**必ず `scripts/deploy.sh` 経由で**
まとめて実行することを推奨する。

---

## 6. ビルドとデプロイ

`scripts/deploy.sh` が「ビルド → マイグレーション適用 → `wrangler deploy`」を順に実行する。

```bash
D1_DATABASE_ID="<UUID>" ./scripts/deploy.sh
```

中身の流れ:

1. `npm run build`（Vite で `dist/client` を作る。`assets.directory` を指す）
2. `npx wrangler d1 migrations apply DB --config wrangler.local.jsonc --remote`
3. `npx wrangler deploy --config wrangler.local.jsonc`

`workers_dev: false` なので `workers.dev` サブドメインは公開されない。
公開経路（カスタムドメイン）の付け方は `docs/ops/cutover.md` を参照。

---

## 7. GitHub Actions でのデプロイ（手動）

自動デプロイはしない。**手動（`workflow_dispatch`）だけ**で本番に書き込む。

リポジトリの *Settings → Secrets and variables → Actions* に以下を登録する:

| シークレット名 | 値 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 第 3 節の CF_API_TOKEN と同じ値 |
| `CLOUDFLARE_ACCOUNT_ID` | アカウント ID |
| `D1_DATABASE_ID` | 第 2 節で控えた D1 の UUID |

`CLOUDFLARE_API_TOKEN` は wrangler 本体の認証にも使う（Workers Scripts Edit 等の
権限が必要になる場合がある。トークンに Workers Scripts: Edit を加える）。

実行: *Actions → Deploy → Run workflow*。

---

## 8. 最初のオーナーを作る（bootstrap）

`POST /api/v1/auth/bootstrap` は **owner が 1 人も居ないときだけ通る**（以後 409）。
初回デプロイ直後の空 DB なら owner を作成できる。UI からは `/bootstrap` ページを開き、
メールアドレス・名前・パスワード・合言葉（第 3 節の `INTERNAL_SECRET`）を入れる。

オーナーは Cloudflare の DNS とメールルーティングまで触れる。デプロイ直後に URL を
見つけただけの相手にオーナーを取られないよう、**合言葉を知っている人しか作れない**。

メールアドレスは普段使っているもの（Gmail など）でよい。**このアプリで受信する
アドレスである必要はない。** この時点ではまだ送信ドメインを 1 つも繋いでいないため、
アプリからメールを出せず、使い捨てパスワードを送る方式が使えないため。

cURL で:

```bash
curl -X POST "https://<あなたの公開ホスト>/api/v1/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@example.com",
    "name": "オーナー",
    "password": "強力なパスワード",
    "secret": "<INTERNAL_SECRET と同じ値>"
  }'
```

レスポンスに `Set-Cookie: tsb_session=...` が返れば成功。owner が既に居る状態で叩くと
409 になり、ログイン画面からも `/bootstrap` への導線が消える。
以後のメンバーはオーナーが管理画面から追加する。

> まだカスタムドメインを付けていない段階では、一時的に `wrangler dev --remote`
> かローカルでポートを開いて bootstrap だけ先に行う、という手もある
> （`wrangler dev` はローカルで完結するので外部に公開しない）。

---

## 9. 動作確認チェックリスト

リソース → シークレット → マイグレーション → デプロイ → bootstrap がすべて終わった後に確認する。

- [ ] `https://<公開ホスト>/api/health` が `{"ok":true,"app":"tsubame"}` を返す
- [ ] bootstrap が 201（または Cookie セット）を返し、owner が登録された
- [ ] `POST /api/v1/auth/login` で owner としてログインできる（UI `/login` でも可）
- [ ] 管理画面でドメイン接続（`/api/v1/admin/domains`）で `example.com` が選べる
      （CF_API_TOKEN の Zone スコープに含まれているか）
- [ ] **受信**: どこかの実メールから `mail.example.com` の実在アドレスへメールを送り、
      Email Routing → Worker の受信ハンドラ → R2 → Queues → D1 の順に処理され、
      `GET /api/v1/messages`（API キー or セッション）で見える
- [ ] **送信**: API キーか UI から `POST /api/v1/messages`（scope: send）で送信し、
      相手に届く。`outbound_jobs` の status が `sent` になる
- [ ] **API キーでの取得**: 管理画面で API キーを発行し、`tsb_...` を
      `Authorization: Bearer` に載せて `GET /api/v1/messages` が読める（scope: read）

受信の詳細な観測は `docs/ops/operations.md` の `wrangler tail` を参照。

---

## 10. Webhook の署名検証（受け手向け）

登録した Webhook の URL には、`message.received` / `message.sent` / `message.failed` の
通知が `X-Tsubame-Signature` ヘッダ付きで届く。受け手はこのヘッダを検証してから本文を信用すること。

### ヘッダの形式

```
X-Tsubame-Signature: t=<配信時刻の unix 秒>,v1=<HMAC-SHA256 の hex>
```

`v1` は、Webhook 作成時に一度だけ表示される `secret` を鍵にした
`HMAC-SHA256("<t>.<body>")` の 16 進数表現。`<t>.<body>` はドットで結合した文字列で、
`body` は実際に送信された JSON のバイト列そのもの（受信後に整形・再パースしたものではない）。

### 検証手順

1. ヘッダを `t=...,v1=...` でパースする。
2. `HMAC-SHA256(secret, ` + `` `${t}.${body}` `` + `)` を自分で計算する。
3. 計算した値と受け取った `v1` を**定数時間比較**する（`v1` の文字列比較に
   単純な `===` を使うとタイミング攻撃の余地が残る。Node の `crypto.timingSafeEqual`、
   Workers なら固定長のバイト列を XOR して OR で畳み込む自作関数などを使う）。
4. `t` が現在時刻から離れすぎていないか確認する（**許容幅の目安は前後 5 分**）。
   古い署名済みリクエストのリプレイを防ぐため。

### 実装例（Node.js）

```js
import { timingSafeEqual, createHmac } from "node:crypto";

function verify(secret, header, body, toleranceSec = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header);
  if (!m) return false;
  const [, tStr, v1] = m;
  const t = Number(tStr);
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

`secret` は作成レスポンス（`POST /api/v1/webhooks`）にのみ平文で含まれ、以後は取得できない。
紛失した場合は Webhook を作り直す。

---

## 次のステップ

リソースと Worker が動けば、`docs/ops/cutover.md` の手順で
受信ドメインをこの Worker に向ける。既存の受信経路がある場合の切り替えもそこに書いてある。
