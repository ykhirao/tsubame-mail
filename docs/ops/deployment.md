# 初回デプロイ手順（tsubame）

本番 Worker（`tsubame`）を Cloudflare に新規デプロイするための手順。
**上から順番に実行すれば最後まで完了する**ことを想定している。

## 0. 前提と方針

- **既存の `旧 Worker` Worker と、その D1 / R2 / Queues には一切触らない。**
  新リソースはすべて別名（`tsubame` 系）で作る。
- 過去メールの移行はしない（捨てる方針で決定済み）。
- `example.com` の apex は Google Workspace が本番。**絶対に触らない。**
- Workers（旧 Workers Paid）契約が必要。Queues が作れることで確認済み。
- 実行マシンには wrangler（`npx wrangler`）と npm が使えること。

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

`node_modules` は既に symlink されていて使えるが、確実に揃えるならこの 1 行を実行する。

---

## 2. リソースを作る（別名）

すべて実行済みなら既に存在する（`wrangler` は存在するとエラーを返す）。未作成のものだけ実行する。

```bash
# D1（データベース）。database_id を控える。↓
npx wrangler d1 create tsubame

# R2（生 MIME と添付）
npx wrangler r2 bucket create tsubame-mail

# Queues（受信・送信）
npx wrangler queue create tsubame-inbound
npx wrangler queue create tsubame-outbound
```

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
npx wrangler secret put AUTH_SECRET
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

Zone リソースは **初期は `example.com` の 1 ゾーンだけ**に限定する。
ドメインを増やすたびにこの Zone リソースの範囲を広げ直す必要がある
（詳細は `docs/ops/operations.md` の「新しいドメインを足すとき」参照）。

### CF_ACCOUNT_ID

アカウント ID（Cloudflare のダッシュボード右側に出る 32 桁の英数字）。

### AUTH_SECRET

セッション Cookie と API キーのハッシュ用ソルト（`worker-env.d.ts` 参照）。
必ず 32 バイト以上の乱数を値にする:

```bash
openssl rand -hex 32
```

出力された 48 文字の hex を `AUTH_SECRET` として投入する。**漏れたら全セッションと API キーを失効させる**想定で取り扱う。

> GitHub Actions でデプロイする場合は、上記 3 つに加えて
> `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `RIDLEY_DATABASE_ID` を
> リポジトリの Secrets に登録する（第 7 節の GitHub Actions を参照）。

---

## 4. `database_id` の注入方針

`wrangler.jsonc` にはプレースホルダの UUID が入っており、**アカウント固有の `database_id` をリポジトリにコミットしない**。これを実現するため、次の方式を採用する。

### 採用方式: デプロイ時に `wrangler.local.jsonc` を生成して注入

- `scripts/deploy.sh` が、コミット済み `wrangler.jsonc` のプレースホルダ UUID を
  環境変数 `RIDLEY_DATABASE_ID` で受け取った実 ID に**置き換えて**
  `wrangler.local.jsonc` を生成する。
- `wrangler.local.jsonc` は `.gitignore` に明示してあるため**コミットされない**。
- 生成した設定ファイルを使って D1 マイグレーション適用と `wrangler deploy --config` を実行する。

**この方式を選んだ理由**:
1. リポジトリにアカウント固有の ID を一切書かない（要件・設計の制約を満たす）。
2. ローカル実行と CI が**同じ 1 本のスクリプト**で動く。CI では `RIDLEY_DATABASE_ID` を
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
RIDLEY_DATABASE_ID="<手順2で控えたUUID>" ./scripts/deploy.sh --skip-build
```

（`--skip-build` はビルド済みのとき用。初回は外してビルドから通す。）

---

## 5. マイグレーションを適用する

`scripts/deploy.sh` が実行するため、通常は単独で叩く必要はない。
手動で行う場合:

```bash
RIDLEY_DATABASE_ID="<UUID>" npx wrangler d1 migrations apply DB --config wrangler.local.jsonc --remote
```

ただし `wrangler.local.jsonc` は生成物なので、**必ず `scripts/deploy.sh` 経由で**
まとめて実行することを推奨する。

---

## 6. ビルドとデプロイ

`scripts/deploy.sh` が「ビルド → マイグレーション適用 → `wrangler deploy`」を順に実行する。

```bash
RIDLEY_DATABASE_ID="<UUID>" ./scripts/deploy.sh
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

リポジトリ（この worktree の親 `tsubame`）の *Settings → Secrets and variables → Actions* に以下を登録する:

| シークレット名 | 値 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 第 3 節の CF_API_TOKEN と同じ値 |
| `CLOUDFLARE_ACCOUNT_ID` | アカウント ID |
| `RIDLEY_DATABASE_ID` | 第 2 節で控えた D1 の UUID |

`CLOUDFLARE_API_TOKEN` は wrangler 本体の認証にも使う（Workers Scripts Edit 等の
権限が必要になる場合がある。トークンに Workers Scripts: Edit を加える）。

実行: *Actions → Deploy → Run workflow*。

---

## 8. 最初のオーナーを作る（bootstrap）

`POST /api/v1/auth/bootstrap` は **owner が 1 人も居ないときだけ通る**（以後 409）。
初回デプロイ直後の空 DB なら owner を作成できる。UI からは `/bootstrap` ページを開く。

cURL で:

```bash
curl -X POST "https://<あなたの公開ホスト>/api/v1/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@example.com",
    "name": "オーナー",
    "password": "強力なパスワード"
  }'
```

レスポンスに `Set-Cookie: tsb_session=...` が返れば成功。owner が既に居る状態で叩くと 409 になる。

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
- [ ] **API キーでの取得**: 管理画面で API キーを発行し、`rid_...` を
      `Authorization: Bearer` に載せて `GET /api/v1/messages` が読める（scope: read）

受信の詳細な観測は `docs/ops/operations.md` の `wrangler tail` を参照。

---

## 次のステップ

リソースと Worker が動けば、`docs/ops/cutover.md` の手順で
`mail.example.com` を `旧 Worker` → `tsubame` に切り替える。


## 最初のオーナーを作る（INTERNAL_SECRET）

オーナーは Cloudflare の DNS とメールルーティングまで触れる。デプロイ直後に URL を
見つけただけの相手にオーナーを取られないよう、**合言葉を知っている人しか作れない**。

```bash
# 20 文字以上のランダムな値を作って Worker のシークレットに入れる
openssl rand -base64 32
npx wrangler secret put INTERNAL_SECRET
```

未設定、または 20 文字未満だと `POST /api/v1/auth/bootstrap` は 403 を返し、
**誰もオーナーを作れない**（安全側に倒してある）。

デプロイ後 `/bootstrap` を開き、メールアドレス（普段使っている Gmail などでよい。
このアプリで受信するアドレスである必要はない）・名前・パスワード・合言葉を入れる。

オーナーが 1 人でも居ると `/bootstrap` は 409 を返し、ログイン画面からも導線が消える。
以後のメンバーはオーナーが管理画面から追加する。

**メールで使い捨てパスワードを送る方式は使えない。** この時点ではまだ送信ドメインを
1 つも繋いでいないため、アプリからメールを出せない。
