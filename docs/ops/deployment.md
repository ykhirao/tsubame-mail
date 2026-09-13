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

`npm ci` は install script を持つ依存（`workerd`、`esbuild`、`core-js-pure`、`fsevents`）の
postinstall を実行する。これらは配布物（`dist/client`）には入らないが、ビルド・テストに要るので
`--ignore-scripts` での実行は想定していない。

---

## 2. リソースを作る

既にあるものは `wrangler` がエラーを返す。未作成のものだけ実行する。

```bash
# D1（データベース）。database_id を控える。↓
npx wrangler d1 create tsubame

# R2（生 MIME と添付）
npx wrangler r2 bucket create tsubame-mail

# Queues（受信・送信とそれぞれの DLQ）
npx wrangler queues create tsubame-inbound
npx wrangler queues create tsubame-outbound
npx wrangler queues create tsubame-inbound-dlq
npx wrangler queues create tsubame-outbound-dlq
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

`tsubame` Worker にシークレットを 5 つ設定する（**プッシュ通知を使わないなら 3 つ**）。
`wrangler login` 済みの状態で:

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

`Zone Settings – Edit` は Email Routing の有効化・無効化と MX などの DNS の作成に要る（Cloudflare の API 仕様でこの 3 つはこの権限だけを受け付ける）。
削ると独自ドメインの接続が失敗する。

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

ログイン・送信のレート制限（`ratelimits` の `LOGIN_RATE_LIMIT` / `SEND_RATE_LIMIT`）と
定時実行の cron（`*/5 * * * *`）はどちらも `wrangler.jsonc` が持つもので、
シークレットや追加の設定は要らない。

### VAPID_PRIVATE_KEY（プッシュ通知の鍵）

プッシュ通知（FR-16）を使うときだけ要る。未設定なら通知は送らず、判定の履歴だけが残る。

```bash
node scripts/vapid-keys.mjs          # 2 行目の JSON を控える
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT   # 例: mailto:postmaster@<自分のドメイン>
```

`VAPID_SUBJECT` は push サービスが問題のあるときに連絡してくる宛先。実環境の値なのでリポジトリには書かない。
**鍵を変えると、全端末の購読が無効になる**。アプリは次に開いたとき公開鍵の違いに気付いて購読し直すが、
それまでは通知が届かない。漏れたとき以外は変えない。

> GitHub Actions でデプロイする場合は、上記 3 つに加えて
> `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID` を
> リポジトリの Secrets に登録する（第 7 節の GitHub Actions を参照）。

### 3.1 シークレットのローテーションと失効

**`CF_API_TOKEN`（Zone / Email Routing / Email Sending の編集権を持つ）**。漏れた、または
定期的に入れ替えるときは:

1. Cloudflare ダッシュボードで**新しいトークンを発行**し、古いトークンと同じ権限・Zone 範囲にする。
2. `npx wrangler secret put CF_API_TOKEN` で新トークンを投入する（GitHub Actions を使うなら
   `CLOUDFLARE_API_TOKEN` 側も同じ値に更新する）。
3. 切り替えを確認したら、ダッシュボードから**古いトークンを失効**させる。新トークンはこの手順で
   `wrangler.local.jsonc` の再生成や再デプロイを要しない（Worker のシークレットは即時反映）が、
   古いトークンを残すと漏洩範囲が減らない。

**`INTERNAL_SECRET`**。`src/api/v1/auth.ts` で参照するのは **`POST /api/v1/auth/bootstrap` だけ**。
オーナーが 1 人でも居ると bootstrap は 409 を返すため、**初回セットアップ後は使われない**。
秘密を残しておく価値より消す方が安全なので、オーナーを作ったら:

```bash
npx wrangler secret delete INTERNAL_SECRET
```

消すと、万一オーナーを全員削除した「再セットアップ」はできなくなる（bootstrap が 403 になる）。
再セットアップが必要になる環境では、その時だけ再度 `wrangler secret put INTERNAL_SECRET` で投入する。

**Webhook の `secret`**。`POST /api/v1/webhooks` の登録応答に一度だけ平文で出て、以後は取得できない
再発行 API が無い。漏れた場合は**既存の webhook を作り直す**（`DELETE` → 新しい `secret` 付きで再登録）しかない。

**API キー**。漏洩時は管理画面・`/api/v1/me/api-keys` で該当キーを**失効（revoke）** する。
キーは `revokedAt` / `expiresAt` を毎リクエスト検査するため、失効は即有効になる。
そのキーから発行されたキー（孫以降も）も一緒に失効する（`api_keys.parent_key_id`、精査 #25）。
同じ設定で使い続けるなら「再発行」（旧キーを失効させて同じ設定で作り直す。トークンは変わる）。
パスワードが流出した場合は `PATCH /api/v1/me` でパスワードを変える。その利用者の全セッションと購読端末が落ち、
未失効の API キーと、そこから他の利用者向けに発行されたキーもすべて失効する（精査 #99 / #142）。
キーを使う連携はキーを発行し直して入れ替える。

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

手動で `wrangler.local.jsonc` を d1 系コマンドに使いたいときは、`--keep-config` で生成物を残して使う:

```bash
D1_DATABASE_ID="<UUID>" ./scripts/deploy.sh --skip-build --keep-config
# 以後、このシェルで手動の d1 execute に --config wrangler.local.jsonc を付けられる
```

`wrangler.local.jsonc` はコミット対象外（`.gitignore` に明示）なので、生成し直せばいくらでも作り直せる。

---

## 5. マイグレーションを適用する

`scripts/deploy.sh` が実行するため、通常は単独で叩く必要はない。
手動で行う場合（`--keep-config` で `wrangler.local.jsonc` を残してから）:

```bash
D1_DATABASE_ID="<UUID>" npx wrangler d1 migrations apply DB --config wrangler.local.jsonc --remote
```

`wrangler.local.jsonc` は生成物なので、**必ず `scripts/deploy.sh` 経由で**まとめて実行することを推奨する。
`--keep-config` は手動の `d1 execute` / `d1 migrations` をそのまま流したいときのための導線で、
不要になったら生成物は消してよい（再実行で作り直せる）。

### 5.1 既存環境への `0004_fts_delete_triggers` 適用について

`0004` は最後に `INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')` を実行し、FTS 索引を**バッチ無しで
全件再構築**する。`deploy.sh` は `wrangler deploy` の**前**に `--remote` でマイグレーションを流すので、
`messages` の行数が増えると D1 の実行時間上限（数万行を超えるあたりから現実的）に当たり得る。

- 0004 が未適用の既存環境に流す前に、**行数の目安を確認する**:
  `npx wrangler d1 execute DB --remote --config wrangler.local.jsonc --command 'select count(*) from messages'`
- **失敗したときの状態**は「トリガは新形式・索引は古いまま・デプロイ未実施」で止まる。
  `deploy.sh` は `set -euo pipefail` なので、この状態でデプロイには進まない。
- **復旧手順**: `0004` の `'rebuild'` は後から単独で流し直せる。
  `npx wrangler d1 execute DB --remote --config wrangler.local.jsonc --command "INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')"`
  を実行して索引を構築してからデプロイを続ける。
- 0004 は既存 SQL として書き換えない（スキーマの二重管理を避けるため）。

### 5.2 `0007_add_api_key_parent`

`api_keys` に `parent_key_id` と索引を足すだけ（`ALTER TABLE`）。行数に関係なく一瞬で終わり、手作業は無い。
適用より前に API キーから発行されたキーは親を持たないので、親の失効では連鎖しない（本人の削除・パスワード変更では従来どおり失効する）。
連鎖させたいキーは失効させて発行し直す。

### 5.3 `0008_visibility_and_primary`（見る範囲・プライマリ・外部アドレス）

`scripts/deploy.sh` で入るが、**データ移行を含み、デプロイ直後にオーナーが見えるメールが変わる**。流す前に読む。

スキーマ: `email_verifications` 表、`address_grants.hidden`、`sessions.admin_mode_until`、
`users.external_email` / `external_verified_at` / `primary_address_id`（後 2 つに一意索引）。`ALTER TABLE` なので行数に関係なく一瞬で終わる。

データ移行（同じマイグレーションの中で順に走る）:

1. 全利用者の今のログイン用アドレス（`users.email`）を **確認済みの外部アドレス**（`external_email` / `external_verified_at = 今`）に写す。
   今までのアドレスとパスワードでそのままログインできる。
2. **誰にも割り当てていないアドレス**を、全 owner に `write` で割り当てる。
   誰か 1 人にでも（`read` でも）割り当て済みのアドレスは owner に割り当てない。owner はもう特権で全アドレスを見ないので、
   **そのメールはデプロイ直後に owner の受信箱・一覧・検索・通知・未読数から消える**（データは消えていない。管理者モードで読める）。
   キャッチオールの受け皿も同じ扱い。
3. プライマリが無い利用者に、`write` で割り当てたメールボックス（エイリアス・アーカイブ済みを除く。他の人のプライマリになったものを除く）のうち
   最初に割り当てた 1 つをプライマリにする。owner なら 2 の割り当てのうち最古のメールボックス。
   `write` のメールボックスが無い利用者（`read` だけの member、全部が他人に割り当て済みだった owner）はプライマリ無しのまま。

デプロイ後にオーナーがやること（画面。`docs/ops/operations.md` §8 に SQL もある）:

- 自分が見るべきアドレスを自分に割り当て直す: 管理 → ユーザー → 自分 → 権限を編集。他の人に割り当て済みで自分にも要るものを `write`（読むだけなら `read`）で足す。
- `⚠`（プライマリ未設定）の member / agent にプライマリを付ける: 先に権限の編集でメールボックスを `write` で割り当て、「プライマリを変更」で選ぶ。
  無ければメールボックスを作ってから。owner のプライマリ無しは、次に作ったメールボックスが自動でプライマリになる。
- 通知: owner に届いていたキャッチオールや共有メールボックスの通知は、2 で割り当てられた分だけ続く。要るものは割り当ててから通知設定で確かめる。

一度流したら戻せない（`address_grants` の追加行と `primary_address_id` は手で消せるが、消す前の状態と同じにはならない）。
流す前に §「D1 のバックアップ」（`docs/ops/operations.md` §5）を取る。

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
| `CLOUDFLARE_API_TOKEN` | デプロイ用のトークン（下の権限で発行する。第 3 節の CF_API_TOKEN とは分ける） |
| `CLOUDFLARE_ACCOUNT_ID` | アカウント ID（本番・ステージングで共通） |
| `D1_DATABASE_ID` | 第 2 節で控えた D1 の UUID |
| `STAGING_CLOUDFLARE_API_TOKEN` | ステージング用（§11）。無ければステージングのデプロイだけが落ちる |
| `STAGING_D1_DATABASE_ID` | ステージングの D1 の UUID（§11） |

`CLOUDFLARE_API_TOKEN` は wrangler 本体がマイグレーションとデプロイに使う。アプリ用の CF_API_TOKEN には
D1 の権限が無いので、同じ値を入れるとマイグレーションで `code: 7403` になる。デプロイ用に別に発行する
（ダッシュボードのテンプレート「Edit Cloudflare Workers」から始めて D1 と Queues を足すと早い）:

| レベル | 権限 | 使う場面 |
| --- | --- | --- |
| Account | D1 – Edit | マイグレーションの適用 |
| Account | Workers Scripts – Edit | Worker の本体と cron の登録 |
| Account | Queues – Edit | キューのコンシューマの設定 |
| Account | Workers R2 Storage – Edit | R2 バインディング |
| Account | Account Settings – Read | wrangler がアカウントを確かめる |
| User | User Details – Read | 同上 |
| User | Memberships – Read | 同上 |

アカウントリソースは本番のアカウントだけに絞る。この 7 つで Deploy が通ることを 2026-09-12 に確かめた。

実行: *Actions → Deploy → Run workflow*。**書き込む先（`staging` / `production`）を選ぶ。**
押し間違いで本番に書かないよう、既定は `staging` にしてある。本番に出すときは毎回選び直す。

---

## 8. 最初のオーナーを作る（bootstrap）

`POST /api/v1/auth/bootstrap` は **owner が 1 人も居ないときだけ通る**（以後 409）。
初回デプロイ直後の空 DB なら owner を作成できる。UI からは `/bootstrap` ページを開き、
メールアドレス・名前・パスワード・合言葉（第 3 節の `INTERNAL_SECRET`）を入れる。

オーナーは Cloudflare の DNS とメールルーティングまで触れる。デプロイ直後に URL を
見つけただけの相手にオーナーを取られないよう、**合言葉を知っている人しか作れない**。

メールアドレスは普段使っているもの（Gmail など）を入れる。これは**外部アドレス**として保存され、
**このアプリで受信する予定のアドレスにしない**（同じアドレスのメールボックスを後から作れてしまい、ログインの解決が外部アドレス優先で曖昧になる。
外部アドレスの登録側は既存のメールボックスと重なると 409 で弾くが、アドレス作成側は外部アドレスを見ない）。
この時点ではまだ送信ドメインを 1 つも繋いでいないため、アプリからメールを出せず、確認コードも使い捨てパスワードも送れない。
そのため最初のオーナーだけは、**未確認の外部アドレスでログインできる**（プライマリアドレスがまだ無い間）。

その後の流れ（`docs/spec/requirements.md` FR-4）:

1. ドメインを繋ぎ、最初のメールボックスを作る。**それが自動でオーナーのプライマリアドレスになり、`write` で割り当てられる。**
2. プライマリが付いた瞬間から、未確認の外部アドレスではログインできなくなる。**以後のログインはプライマリアドレス**（例: `owner@mail.example.com`）で行う。
3. 外部アドレスでもログインしたいなら、そのドメインで送信を有効にしてから、設定 → 外部アドレス → 「登録して確認メールを送る」→ 届いた 6 桁のコードを入れて確認する。
   送信できるドメインが無い間は「送信できるアドレスがまだありません」と出て送れない。

2 で入れなくなるのが分かりにくいので、最初のメールボックスを作ったらその場でプライマリのアドレスを控える。

cURL で（ボディには第 3 節で `INTERNAL_SECRET` に入れた合言葉を `secret` として入れる。無いと 400）:

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

レスポンスに `Set-Cookie: __Host-tsb_session=...` が返れば成功。owner が既に居る状態で叩くと
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
- [ ] 最初のメールボックスを作ると、管理 → ユーザー → 自分に「プライマリ」として出て、そのアドレスでログインし直せる
      （`GET /api/v1/me` の `primaryAddressId`）。以後は bootstrap で入れた外部アドレスでは（確認するまで）入れない
- [ ] **受信**: どこかの実メールから `mail.example.com` の実在アドレスへメールを送り、
      Email Routing → Worker の受信ハンドラ → R2 → Queues → D1 の順に処理され、
      `GET /api/v1/messages`（API キー or セッション）で見える。
      **見えるのは自分に割り当てたアドレスだけ**（owner でも）。宛先のアドレスが自分に割り当たっていなければ、
      管理 → ユーザー → 自分 → 権限を編集で足すか、アドレス作成時に「自分に write で割り当てる」を付ける
- [ ] **送信**: API キーか UI から `POST /api/v1/messages`（scope: send）で送信し、
      相手に届く。`outbound_jobs` の status が `sent` になる
- [ ] **API キーでの取得**: 管理画面で API キーを発行し、`tsb_...` を
      `Authorization: Bearer` に載せて `GET /api/v1/messages` が読める（scope: read）

受信の詳細な観測は `docs/ops/operations.md` の `wrangler tail` を参照。

---

## 10. Webhook の署名検証（受け手向け）

登録した Webhook の URL には、`message.received` / `message.sent` / `message.failed` の
通知が `X-Tsubamail-Signature` ヘッダ付きで届く。受け手はこのヘッダを検証してから本文を信用すること。

### ヘッダの形式

```
X-Tsubamail-Signature: t=<配信時刻の unix 秒>,v1=<HMAC-SHA256 の hex>
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

## 11. ステージング環境

`tsubame-staging` Worker（`https://tsubame-stg.forte.llc`）。**本番と共有するのは
Cloudflare アカウントだけ**で、Worker・D1・R2・キュー・シークレットは全部別にする。

### 11.1 なぜ全部分けるのか

- **Worker 名を共有できない。** `wrangler.jsonc` の `name`・`vars.EMAIL_WORKER_NAME`・
  Email Routing のルール宛先の 3 つは一致していなければならない（§0 と `requirements.md` §5）。
  ステージングは `tsubame-staging` で揃える。`EMAIL_WORKER_NAME` を入れ忘れると
  `emailWorkerName()` が例外を投げて止まる（黙って本番の名前に落ちないようにしてある）。
- **受信ドメインを本番と同じゾーンに置かない。** catch-all は**ゾーン単位**なので、
  `forte.llc` でステージングも受けるとルールが混ざり、どちらかの catch-all が
  もう一方の宛先も飲み込む。**受信は `test.hirao.cc` に割り当てる。**
- **送信も本番ドメインを使わない。** スパムの見本や存在しない宛先に送ると送信ドメインの
  評判が落ち、Cloudflare が送信を止めうる（`constraints.md` §2「送信」。実際に「At Risk」になった記録がある）。

### 11.2 リソースを作る

本番（§2）と同じ手順で、名前だけ変えて作る。

```bash
npx wrangler d1 create tsubame-staging          # database_id を控える
npx wrangler r2 bucket create tsubame-staging-mail
npx wrangler queues create tsubame-staging-inbound
npx wrangler queues create tsubame-staging-outbound
npx wrangler queues create tsubame-staging-inbound-dlq
npx wrangler queues create tsubame-staging-outbound-dlq
```

DLQ を先に作らないとデプロイが落ちるのは本番と同じ。

### 11.3 シークレット

`--env staging` を付けて、ステージングの Worker に入れる。

```bash
npx wrangler secret put INTERNAL_SECRET --env staging      # 本番とは別の値
npx wrangler secret put CF_API_TOKEN --env staging
npx wrangler secret put CF_ACCOUNT_ID --env staging
npx wrangler secret put VAPID_PRIVATE_KEY --env staging    # 別に生成する
npx wrangler secret put VAPID_SUBJECT --env staging
```

- `INTERNAL_SECRET` は**必ず別の値**。ステージングの DB は空なので bootstrap をやり直す。
- `CF_API_TOKEN` は**ステージングで使うゾーンだけに絞ったトークンを別に発行する**。
  本番と同じものを入れると、ステージングの管理画面から本番ゾーンの DNS を書き換えられる。
- `VAPID_PRIVATE_KEY` は `node scripts/vapid-keys.mjs` で別に作る。オリジンが違うので
  本番の購読とは無関係で、鍵を共有する利点が無い。

### 11.4 デプロイと公開

*Actions → Deploy → Run workflow* で `staging` を選ぶ（§7）。手元から出すなら:

```bash
D1_DATABASE_ID="<ステージングの UUID>" ./scripts/deploy.sh --env staging
```

公開ホスト名の付け方は `cutover.md` §1.1〜1.2 と同じ（DNS に CNAME を足して、
Workers のダッシュボードで Add custom domain）。向き先を `tsubame-staging` にする。

### 11.5 確認

```bash
curl -s https://tsubame-stg.forte.llc/api/health
# → {"ok":true,"app":"tsubame-staging"} を期待（本番は "tsubame"）
```

`app` の値で環境を見分けられる。**本番のつもりでステージングを触っていないか、ここで確かめる。**

---

## 次のステップ

リソースと Worker が動けば、`docs/ops/cutover.md` の手順で
受信ドメインをこの Worker に向ける。既存の受信経路がある場合の切り替えもそこに書いてある。
