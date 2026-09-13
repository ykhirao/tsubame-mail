# あなたがやること

**Cloudflare の操作が要るので、エージェントでは進められない作業**をここに集める。
コード側は全部できていて、本番にも入っている（2026-09-13 時点）。

コードの残作業は [これからやること](spec/todo.md)。この文書はそれとは別で、
**人が Cloudflare のダッシュボードや `wrangler` を叩く必要があるもの**だけを載せる。

| # | やること | なぜ要るか | かかる手間 |
| --- | --- | --- | --- |
| 1 | [Turnstile を有効にする](#1-turnstile-を有効にする) | **今ログインが総当たりに無防備**。コードは入っているがキーが無いので黙って無効 | 15 分 |
| 2 | [ステージングを作る](#2-ステージングを作る) | UI の確認を本番でやらずに済ませる | 1 時間 |

---

## 1. Turnstile を有効にする

**優先度: 高。** 本番の Rate Limiting binding が発火しない（[受け入れた制約](spec/constraints.md) §2 の #147）ため、
**今、画面のログインには回数制限が 1 つも掛かっていない**。Turnstile がその代わりになる。

コードは本番に入っているが、**`TURNSTILE_SECRET` が無い間は検査そのものを行わない**（黙って素通り）。
ローカル開発のための逃げ道だが、本番で入れ忘れると門が無いままになる。

### 手順

1. **ウィジェットを作る** — Cloudflare ダッシュボード → Turnstile → Add widget
   - ドメインは **`tsubame.forte.llc` だけ**（`localhost` を入れない。入れると手元から本番の門を抜けられる）
   - モードは Managed でよい
   - `Sitekey` と `Secret Key` を控える

2. **`wrangler.jsonc` の `vars` に 2 つ足す**（sitekey は秘密ではない。画面の HTML に出る値）

   ```jsonc
   "vars": {
     "APP_NAME": "tsubame",
     "EMAIL_WORKER_NAME": "tsubame",
     "TURNSTILE_SITEKEY": "0x4AAA...",
     "TURNSTILE_HOSTNAMES": "tsubame.forte.llc"
   }
   ```

3. **Secret を入れる**

   ```bash
   npx wrangler secret put TURNSTILE_SECRET
   ```

4. **デプロイ** — Actions → Deploy → Run workflow → `production`

### 効いたことの確かめ方

```bash
# sitekey が配られているか
curl -s https://tsubame.forte.llc/api/v1/auth/setup-state
# => {"needsSetup":false,"turnstileSitekey":"0x4AAA..."} を期待

# 正しいパスワードでもトークン無しなら弾かれるか
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://tsubame.forte.llc/api/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"<実在するアドレス>","password":"<正しいパスワード>"}'
# => 403 を期待
```

**正しいパスワードでも 403 になるのが正常。** ここが 200 なら secret が入っていない。
そのあと画面から普通にログインできることも必ず確かめる（チェックボックスが出る）。

### 落とし穴

- **テスト用キー（`1x0000…`）では必ず 403 になる。** 実トークンでも `action` を返さず、
  `hostname` が常に `example.com` になるため（2026-09-13 に実測。公式ドキュメントの例とは違う）。
  確認は本物のキーで行う。
- `TURNSTILE_HOSTNAMES` だけ空にすると 500 で止まる（設定の誤りに気付けるように、わざとそうしている）。
- **API キーの経路には影響しない。** エージェントの自動化は何も変わらない。

詳細は [デプロイ](ops/deployment.md) §11。

---

## 2. ステージングを作る

**優先度: 中。** UI の確認を本番でやらずに済むようにする。
コード側（`env.staging` / `--env` 対応 / Actions の環境選択）は入っているので、
**Cloudflare のリソースと Secret を作るだけ**で動く。

受信は **`test.hirao.cc`** に割り当てる方針（本番と同じ `forte.llc` ゾーンで受けると、
catch-all がゾーン単位なのでルールが混ざる）。

### 手順

1. **リソースを 6 つ作る**

   ```bash
   npx wrangler d1 create tsubame-staging          # database_id を控える
   npx wrangler r2 bucket create tsubame-staging-mail
   npx wrangler queues create tsubame-staging-inbound
   npx wrangler queues create tsubame-staging-outbound
   npx wrangler queues create tsubame-staging-inbound-dlq
   npx wrangler queues create tsubame-staging-outbound-dlq
   ```

   DLQ を先に作らないとデプロイが落ちる。

2. **Worker Secret を 6 つ入れる**（`--env staging` を忘れない）

   ```bash
   npx wrangler secret put INTERNAL_SECRET --env staging      # 本番とは別の値
   npx wrangler secret put CF_API_TOKEN --env staging         # ステージングのゾーンだけに絞る
   npx wrangler secret put CF_ACCOUNT_ID --env staging
   npx wrangler secret put VAPID_PRIVATE_KEY --env staging    # node scripts/vapid-keys.mjs で別に作る
   npx wrangler secret put VAPID_SUBJECT --env staging
   npx wrangler secret put TURNSTILE_SECRET --env staging     # 別のウィジェットを作る
   ```

   - `CF_API_TOKEN` は**本番と同じものを使わない**。同じだとステージングの管理画面から
     本番ゾーンの DNS を書き換えられる。
   - `INTERNAL_SECRET` は空の DB で bootstrap をやり直すので必ず別の値。

3. **GitHub Secrets を 2 つ足す**（Settings → Secrets and variables → Actions）
   - `STAGING_CLOUDFLARE_API_TOKEN`
   - `STAGING_D1_DATABASE_ID`（1 で控えた UUID）

4. **`wrangler.jsonc` の `env.staging.vars`** に Turnstile の sitekey とホスト名を入れる
   （ステージング用のウィジェットを別に作る。本番のを使い回すと `hostname` が食い違って必ず 403）

5. **カスタムドメインを割り当てる** — `tsubame-stg.forte.llc` を `tsubame-staging` Worker に
   （手順は [切り替え](ops/cutover.md) §1.1〜1.2 と同じ）

6. **デプロイ** — Actions → Deploy → Run workflow → `staging`

### 効いたことの確かめ方

```bash
curl -s https://tsubame-stg.forte.llc/api/health
# => {"ok":true,"app":"tsubame-staging"} を期待（本番は "tsubame"）
```

`app` の値で環境を見分けられる。**本番のつもりでステージングを触っていないか、ここで確かめる。**

詳細は [デプロイ](ops/deployment.md) §12。

---

## 参考: 今の守りの状態

| 守り | 状態 |
| --- | --- |
| API キーの総当たり・負荷 | **有効**（無効なキーを IP 単位で数えて一時的に 401。2026-09-13 に本番で確認） |
| 画面ログインのボット対策 | **未設定**（コードは入っている。上の «1» で有効になる） |
| Rate Limiting binding | **効かない**（Cloudflare 側の問題。#147。直せないので上の 2 つで補っている） |

---

## 参考: エージェントに頼めること

Cloudflare の操作が済んだら、次はエージェント側でできる:

- Turnstile を有効にしたあとの**画面の確認**（チェックボックスが出るか、ログインできるか）
- ステージングができたあとの**UI の確認**全般
- [これからやること](spec/todo.md) §2 の「実機でしか確かめられない」4 件のうち、
  条件が揃ったもの
