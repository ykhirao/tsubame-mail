---
name: e2e
description: 要件から e2e を起こして育てる手順
---

単体テストが全部緑でも、`wrangler dev` に本物のメールを 1 通流した瞬間に落ちたことがある
（生 MIME を長さ不明のストリームのまま R2 に渡していた）。単体では届かない層があるので、
**`src/worker.ts` が export しているハンドラごと動かす** e2e を必ず持つ。

## 書き方

```bash
npm run e2e:new FR-5      # docs/spec/requirements.md の FR-5 の全箇条書きから雛形を起こす
npm run e2e:new FR-5-3    # 箇条書き 1 つ分。ファイルが既にあれば標準出力に出すので貼り付ける
```

雛形は要件の箇条書きをそのままシナリオ名にして `expect.fail("未実装")` を置く。
**雛形のままコミットしない。** 中身を実装してからコミットする。

### 要件 ID は箇条書き単位

`### FR-n` の節の中のトップレベルの箇条書き（行頭の `- `。続きのインデント行はその一部）を、
出現順に `FR-n-1`, `FR-n-2`… と数える。**文書には番号を書かない。** `spec:coverage` が数える。
`npm run spec:coverage` の出力で、どの番号がどの箇条書きかを確かめられる。

シナリオは、確かめている箇条書きの ID を第1引数に書く（静的に走査するのでリテラルで書く）。
複数の箇条書きを確かめるなら配列。FR をまたいでもよい。FR 見出しだけの `"FR-5"` は失敗になる。

```ts
scenario("FR-5-1", "オーナー自身のキーでも addressIds で絞れば他のアドレスは見えない", async () => { … });
scenario(["FR-7-1", "FR-1-4"], "宛先の reject は +タグ を足しても効く", async () => { … });
```

**要件の箇条書きの順を入れ替えたり、間に足したり消したりしたら、後ろの番号がずれる。**
`npm run spec:coverage` を見て、ずれた ID を e2e と `e2e/untestable.ts` の両方で直す
（未知の ID や、箇条書きと名前が食い違うシナリオはここで気づける）。

### e2e で確かめられない箇条書き

見た目・方針・非機能のように、API か worker の振る舞いとして確かめようが無い箇条書きは
`e2e/untestable.ts` に理由つきで並べる。**安易に逃がさない。** UI の振る舞いでも、
それを支える API があれば API で確かめる（fr17 の「まとめて既読」は API で確かめている）。

```ts
untestable("FR-9-1", "日本語で直接書く方針。翻訳レイヤーが無いことは振る舞いとして観測できない");
```

引数はどちらもリテラル。同じ箇条書きに scenario もあると失敗する（どちらかが嘘なので）。

## 土台（e2e/harness.ts）

- `freshHarness()` — D1 と R2 を空にし、キューを捕まえる env を用意する
- `loginAsOwner(h)` — 最初のオーナーを作ってログイン済みのクライアントを返す
- `seedDomain(h, { addresses: ["ai"] })` — Cloudflare API を叩かずにドメインとアドレスを作る
- `deliverEmail(h, { from, to, raw })` — 受信ハンドラに 1 通配送する。
  **raw は長さの分からない ReadableStream** にしてある（実機と同じ条件にするため。
  長さ既知のストリームで代用すると、実機で落ちる類のバグを取り逃がす）
- `drainQueues(h)` — 溜まったキューを本物のコンシューマに流す。`h.retried` で再試行を検証できる
- `drainOne(h)` — 1 件だけ流す。再試行の途中経過を見たいとき
- `captureSentEmails(h)` — EMAIL バインディングを差し替えて、送られた MIME を捕まえる
- `mime({ ... })` — 素朴な MIME を組み立てる

バインディングは差し替えない。D1 も R2 も本物（miniflare）を使う。
モックするのは外部への `fetch`（Cloudflare API・Webhook 送信先）だけ。

## 落ちないための約束

- テストの独立性は `freshHarness()` が担保する。`cloudflare:test` の `reset()` は呼ばない
  （スキーマごと消えて、後続のテストが壊れる）
- マイグレーションは `tests/setup.ts` が一度だけ流す。テストの中で流し直さない
- **テストの中でスキーマを作り直さない。** `0000_init.sql` を読んで CREATE TABLE する
  ヘルパを書くと、後から足したマイグレーション（列の追加など）が反映されず、
  実装とだけ食い違う。片付けは `tests/helpers/migrate.ts` の `applyMigrations()`（DELETE のみ）
- 時刻や ID に依存した検証を書かない

## 仕様との対応

```bash
npm run spec:coverage     # 要件と e2e の対応表。未カバーがあれば exit 1
npm run spec:drift        # 仕様を書かずに機能を足していないか
```

どちらも CI で走る。

- `spec:coverage` は「**要件の箇条書きがあるのに e2e が無い**」を落とす。
  全箇条書きが「1 本以上の scenario に紐づく」か「`e2e/untestable.ts` に載っている」ことを要求する。
  箇条書きを足すと必ず赤くなるので、仕様と検証がずれたまま進めない。
  箇条書きを削るときは対応する e2e（と untestable の行）も削り、後ろの番号のずれも直す。
  存在しない ID（範囲外の `FR-5-9` など）と、FR 見出しだけの古い `"FR-5"` も落とす。
  `--json` で同じ情報（箇条書きの本文・紐づく scenario 名・untestable の理由）が取れる。
- `spec:drift` は逆向きで、「**実装を変えたのに要件も e2e も触っていない**」を落とす。
  `src/api` `src/domain` `src/services` `src/db/schema.ts` が対象（`src/ui` は見た目なので対象外）。
  仕様が変わらないリファクタや修正のときだけ、コミットメッセージに `[no-spec]` を入れて外せる。

## 実機（workerd）での確認

miniflare で通っても、最後に一度は本物で通す。

```bash
npm run build && npm run db:migrate:local
npx wrangler dev
curl -X POST "http://127.0.0.1:8787/cdn-cgi/handler/email?from=a@ext.jp&to=ai@example.com" \
  -H "content-type: message/rfc822" --data-binary @mail.eml
```
