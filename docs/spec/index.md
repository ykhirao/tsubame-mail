# Tsubame 仕様書

独自ドメインのメールを Cloudflare 上で送受信する自前のメール基盤。
**人間と AI エージェントが同じ API を使う**ことを前提に設計している。

## この文書の読み方

- [要件](requirements.html) — 何を実現するか。`FR-1` … の番号が付く。
  **各要件には、それを検証する e2e が必ず 1 つ以上ある**（下の「検証状況」を参照）。
- [設計](architecture.html) — どう作るか。ディレクトリの所有権、データモデル、API 契約。
- [検索方式の決定](adr-search.html) — 日本語検索を実測で決めた記録。

運用は別冊: [デプロイ](../ops/deployment.html) / [切り替え](../ops/cutover.html) /
[日々の運用](../ops/operations.html)

## 仕様と検証がずれない仕組み

要件と e2e は機械で突き合わせている。

| 検査 | 落とすもの |
| --- | --- |
| `npm run spec:coverage` | 要件はあるのに e2e が無い |
| `npm run spec:drift` | 実装を変えたのに要件も e2e も触っていない |
| `npm run check:comments` | コードを読めば分かることを書いたコメント |

どれも CI で走る。要件を書き足すと、e2e を書くまで CI が通らない。
