# tsubame

独自ドメインのメールを Cloudflare 上で送受信する、自前のメール基盤。
**人間と AI エージェントが同じ API を使う**ことを前提に設計している。

- 受信は Cloudflare Email Routing、送信は Cloudflare の送信バインディング。
- データは自分のアカウントの D1（本文とメタ情報）と R2（生 MIME と添付）にだけ置く。
- 検索が主役。AI エージェントは API キーで自分の担当アドレスだけを読み書きする。
- UI は最小限の日本語 Web メール。設定項目は増やさない。

## 権限の考え方

| ロール | できること |
| --- | --- |
| `owner` | 全権。ドメイン・アドレス・ユーザー・API キー・ルールの管理 |
| `member` | 割り当てられたアドレスのみ読み書き |
| `agent` | AI 用。UI は使わず API キーだけで動く。権限は member と同じ仕組み |

API キーは**キー単位**でスコープ（`read` / `send` / `admin`）と対象アドレスを絞れる。
AI 用アカウントを作り、そのキーを 1 アドレスに限定すれば、他人の受信箱は構造的に見えない。

## 開発

```bash
npm install
cp .dev.vars.example .dev.vars   # AUTH_SECRET を入れる
npm run db:migrate:local
npm run dev:worker   # API・email・queue（wrangler dev）
npm run dev          # UI（Vite、/api は 8787 にプロキシ）
npm run typecheck
npm run test
```

## ドキュメント

- [要件定義](docs/spec/requirements.md)
- [設計](docs/spec/architecture.md)
- [デプロイ](docs/ops/deployment.md)
- [切り替え手順](docs/ops/cutover.md)

## ライセンス

MIT。`LICENSE` を参照。
