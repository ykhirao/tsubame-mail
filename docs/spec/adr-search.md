# ADR: 全文検索の方式決定（実測に基づく）

- ステータス: 採用
- 担当: W6
- 対象: FR-3（検索）・設計「3. データモデル > 全文検索」

## 背景と方針

要件 FR-3 は「日本語の部分一致が形態素解析なしで成立する方式」を求めている。
設計（ADR-3）は FTS5 を `tokenize='trigram'` で使い、trigram により日本語の
部分一致を成立させる予定だった。ただし、W6 の最初のタスクとして、
**D1 の実機で trigram tokenizer が要求どおり動くかを検証してから決める**ことになっていた。

## 実測結果

W6 の最初のタスクとして、専用の検証テストで `env.DB`（テスト用 D1）に対して FTS5 の
`CREATE VIRTUAL TABLE ... USING fts5(..., tokenize='trigram')` を作成し、
日本語の文字列を投入して `MATCH` で検索した。結果は下表のとおり。
（現在は `tests/search-integration.test.ts` の「3 文字以上は FTS、1〜2 文字は LIKE」で
再現する。）

| 検索語 | 文字数 | 結果 |
| --- | --- | --- |
| `見積書` | 3 | ヒット（1 件） |
| `ご案内` | 3 | ヒット（1 件） |
| `見積` | 2 | **0 件** |
| `請求` | 2 | **0 件** |
| `書` | 1 | **0 件** |

- `CREATE VIRTUAL TABLE ... tokenize='trigram'` 自体は D1 でエラーなく通る。
  FTS5 trigram は利用**可能**。3 文字以上の日本語部分一致は成立する。
- 一方、**1〜2 文字の検索語では trigram が一切マッチしない**。これは trigram の原理
  （テキストを長さ 3 のトークン列に分解する）に起因する仕様どおりの挙動である。

## 判断

トリガンだけでは「日本語の部分一致」を満たせない。特に要件の例示である
`subject:"見積"` が 2 文字であり、業務メールで頻出の「見積」「請求」「納品」などは
2 文字の語が多い。純 FTS5 構成ではこれらが全て 0 件になり、核心機能が破綻する。

そこで、以下の**ハイブリッド方式**を採用する。

- **3 文字以上の語**: FTS5 trigram の `MATCH` を使う（索引化され高速、部分一致が効く）。
- **1〜2 文字の語**: trigram で引けないため、`LIKE '%語%'` で `messages` の
  subject / text_body / from_addr / to_addr / cc_addr を横断してフォールバックする。
- `from:` / `to:` / `subject:` / `body:` などの列指定オペランドは、常に該当カラムへの
  `LIKE` で評価する（短い日本語でも確実に部分一致する）。

これにより「全長の日本語部分一致」と「長い語の索引検索」の両方を得る。
順位付け `order=relevance` は、各検索語の一致条件を 1/0 にした和をスコアに使い、
受信日時でタイブレークする。

## 補足

- FTS テーブル `messages_fts` は `migrations/0001_search_fts.sql` で作成し、
  `messages` への INSERT / UPDATE / DELETE トリガで同期する。
- `messages_fts` は drizzle のスキーマ（`src/db/schema.ts`）には載せず、
  クエリは `sql` フラグメントで `EXISTS (SELECT 1 FROM ... WHERE rowid = "messages".rowid ...)`
  として参照する。スキーマの二重管理を避けるため。
- FTS テーブルは外部 content（`content='messages'`）を使う。FTS カラム名は
  content テーブル（`messages`）のカラム名と**名前で一致**させる必要がある。
  設計当初の「body」「addrs」という仮想カラム名は `messages` に実在しないため、
  INSERT / 同期で `no such column: T.body` になることを実測で確認した。
  そこで実在カラム `subject` / `text_body` / `from_addr` / `to_addr` / `cc_addr` を
  そのまま索引カラムに使う。アドレス検索は 3 つのアドレスカラムを横断する。
  外部 content なら `DELETE FROM messages_fts WHERE rowid=...` による再同期が動く
  （`content=''` の contentless では通常の DELETE が拒否されるため不可）。
- `messages` の UPDATE / DELETE トリガは該当 rowid の FTS 行を DELETE してから
  （UPDATE 時は）再挿入する。`messages` の外部キー連鎖削除ではトリガが働かないため、
  rowid 再利用時の再挿入衝突を避けるため UPDATE トリガに DELETE を含める。
