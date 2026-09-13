# あなたがやること

**Cloudflare の操作が要るので、エージェントでは進められない作業**をここに集める。
コード側は全部できていて、本番にも入っている（2026-09-13 時点）。

コードの残作業は [これからやること](spec/todo.md)。この文書はそれとは別で、
**人が Cloudflare のダッシュボードや `wrangler` を叩く必要があるもの**だけを載せる。

実際のドメイン名は書かない（このリポジトリは公開している。[AGENTS.md](../AGENTS.md) の
「実環境の値をコミットしない」）。`<本番ホスト>` `<stg ホスト>` と書いてある箇所は
自分の値に読み替える。

| # | やること | なぜ要るか | かかる手間 |
| --- | --- | --- | --- |
| 1 | [Turnstile を有効にする](#1-turnstile-を有効にする) | **今ログインが総当たりに無防備**。鍵を渡すまで検査そのものをしない | 10 分 |
| 2 | [ステージングを仕上げる](#2-ステージングを仕上げる) | UI の確認を本番でやらずに済ませる | 30 分 |

---

## 1. Turnstile を有効にする

**優先度: 高。** 本番の Rate Limiting binding が発火しない（[受け入れた制約](spec/constraints.md) §2 の #147）ため、
**今、画面のログインには回数制限が 1 つも掛かっていない**。Turnstile がその代わりになる。

ウィジェットは作成済み（2026-09-14）。コードも入っている。
残りは**鍵をデプロイ経路に渡すこと**だけ。

sitekey とホスト名は `wrangler.jsonc` に直接書かない。`database_id` と同じく
プレースホルダを置き、`scripts/deploy.sh` が GitHub Secrets の値を注入する。

### 手順

1. **GitHub Secrets に 2 つ足す**（Settings → Secrets and variables → Actions）

   | 名前 | 値 |
   | --- | --- |
   | `TURNSTILE_SITEKEY` | ウィジェットの Sitekey（`0x4AAA…`） |
   | `TURNSTILE_HOSTNAMES` | `<本番ホスト>`（カンマ区切りで複数可） |

   **`localhost` を入れない。** 入れると手元から本番の門を抜けられる（deploy.sh が弾く）。

2. **Secret を入れる**

   ```bash
   npx wrangler secret put TURNSTILE_SECRET
   ```

3. **デプロイ** — Actions → Deploy → Run workflow → `production`

**1 と 2 は揃えて行う。** どちらか片方だけだと、画面にウィジェットが出るのに
サーバが検査しない（または必ず 403）という紛らわしい状態になる。

### 効いたことの確かめ方

```bash
# sitekey が配られているか
curl -s https://<本番ホスト>/api/v1/auth/setup-state
# => {"needsSetup":false,"turnstileSitekey":"0x4AAA..."} を期待

# 正しいパスワードでもトークン無しなら弾かれるか
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<本番ホスト>/api/v1/auth/login \
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
- **Secrets を入れずにデプロイすると、プレースホルダ（`production.invalid`）のまま本番に入る。**
  `.invalid` は実在しない TLD なので、secret を入れた後なら必ず 403 になって気付ける。
- **API キーの経路には影響しない。** エージェントの自動化は何も変わらない。

詳細は [デプロイ](ops/deployment.md) §11。

---

## 2. ステージングを仕上げる

**優先度: 中。** UI の確認を本番でやらずに済むようにする。

コードも Cloudflare のリソースも揃っている（2026-09-14 に D1・R2・キュー 4 本を作成）。
残りは **Secret とドメインの割り当て**だけ。

受信は**本番とは別のゾーン**に割り当てる（本番と同じゾーンで受けると、
catch-all がゾーン単位なのでルールが混ざる）。

### 手順

1. **GitHub Secrets を足す**（Settings → Secrets and variables → Actions）

   | 名前 | 値 |
   | --- | --- |
   | `STAGING_D1_DATABASE_ID` | `tsubame-staging` の database_id（`npx wrangler d1 list` で引く） |
   | `STAGING_CLOUDFLARE_API_TOKEN` | ステージング用に絞ったトークン |
   | `STAGING_TURNSTILE_SITEKEY` | ウィジェットの Sitekey（本番と同じものを共用する場合は同値） |
   | `STAGING_TURNSTILE_HOSTNAMES` | `<stg ホスト>` |

   `STAGING_CLOUDFLARE_API_TOKEN` は**本番と同じものを使わない**。
   同じだとステージングの管理画面から本番ゾーンの DNS を書き換えられる。

2. **Worker Secret を 6 つ入れる**（`--env staging` を忘れない）

   ```bash
   npx wrangler secret put INTERNAL_SECRET --env staging      # 本番とは別の値
   npx wrangler secret put CF_API_TOKEN --env staging         # ステージングのゾーンだけに絞る
   npx wrangler secret put CF_ACCOUNT_ID --env staging
   npx wrangler secret put VAPID_PRIVATE_KEY --env staging    # node scripts/vapid-keys.mjs で別に作る
   npx wrangler secret put VAPID_SUBJECT --env staging
   npx wrangler secret put TURNSTILE_SECRET --env staging
   ```

   `INTERNAL_SECRET` は空の DB で bootstrap をやり直すので必ず別の値。

3. **Turnstile のウィジェットに `<stg ホスト>` を足す** — ダッシュボード → Turnstile →
   該当ウィジェット → Settings → Domains。
   本番と別のウィジェットを作る場合はこれは要らないが、secret も分けること。

4. **カスタムドメインを割り当てる** — `<stg ホスト>` を `tsubame-staging` Worker に
   （手順は [切り替え](ops/cutover.md) §1.1〜1.2 と同じ）

5. **デプロイ** — Actions → Deploy → Run workflow → `staging`

### 効いたことの確かめ方

```bash
curl -s https://<stg ホスト>/api/health
# => {"ok":true,"app":"tsubame-staging"} を期待（本番は "tsubame"）
```

`app` の値で環境を見分けられる。**本番のつもりでステージングを触っていないか、ここで確かめる。**

詳細は [デプロイ](ops/deployment.md) §12。

---

## 参考: 今の守りの状態

| 守り | 状態 |
| --- | --- |
| API キーの総当たり・負荷 | **有効**（無効なキーを IP 単位で数えて一時的に 401。2026-09-13 に本番で確認） |
| 画面ログインのボット対策 | **未設定**（コードとウィジェットは用意済み。上の «1» で有効になる） |
| Rate Limiting binding | **効かない**（Cloudflare 側の問題。#147。直せないので上の 2 つで補っている） |

---

## 参考: エージェントに頼めること

Cloudflare の操作が済んだら、次はエージェント側でできる:

- Turnstile を有効にしたあとの**画面の確認**（チェックボックスが出るか、ログインできるか）
- ステージングができたあとの**UI の確認**全般
- [これからやること](spec/todo.md) §2 の「実機でしか確かめられない」4 件のうち、
  条件が揃ったもの
