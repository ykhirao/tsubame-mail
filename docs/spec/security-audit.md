# セキュリティ精査 — 残件と注意点

観点は [セキュリティ観点](security.html)。このファイルには、**これから直すもの**と、
**直したが残っている制約・また起きうる落とし穴・実機で未確認のこと**だけを載せる。

- 解決済みの指摘は消した。#1〜#120 の再現・対応・再検査の記録は `git show 84eb932:docs/spec/security-audit.md`、
  #121〜#126・#129 はその対応のコミット（`git log --grep '#121'` など）にある。コードのコメントにある「#n」「精査 #n」はその番号。
- 番号は通しで、**次に振る番号は #130**。
- 進め方（対応 → 再検査 → 次の精査）は `.agents/skills/security-audit/SKILL.md`。「この文書を進めて」と言われたらそれに従う。

## 1. 対応予定

### 直すもの

今は無い。

### 設計判断が要るもの

受信経路の調査（2026-09-12、別セッション）から持ち込み、コードで事実を確かめたもの。
Email Security（Cloudflare の検査製品）は、要件の非目標（「スパムは Cloudflare が付けた判定ヘッダを読むだけ」）と、受け口が Worker であることから入れない。

| # | 深刻度 | 内容 | 場所 |
| --- | --- | --- | --- |
| 127 | **中** | 受信メールの `Authentication-Results` / `ARC-*` を読むコードが無く、From を偽装したメールをスレッドに接ぎ木できる | `domain/mail/parse.ts`、`domain/mail/thread.ts` `findExistingThreadId`、`domain/mail/inbound.ts` |
| 128 | 低 | `spam_verdict` を書く側が無い。カラム・API・検索・UI のバッジ・PWA 通知の設計（`spam_suspicious: notify \| drop`）は揃っているのに常に null | `domain/mail/parse.ts`、`domain/mail/inbound.ts` |

- **#127** スレッドの接ぎ木は「Message-ID が一致し、From（または outbound の宛先）が一致する」で判定している（#10）。Message-ID と宛先を知る第三者
  （Bcc 受信者・転送先はヘッダから両方を知る）が From を偽装すると、信頼している会話の続きとして表示される。Reply-To は読まないので返信は偽装元へは行かない。
  Cloudflare Email Routing は**送信ドメインの DMARC ポリシーで不合格のメールを Worker に届く前に拒否する**
  （[Email lifecycle](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/)）ので、成立するのは送信元ドメインに DMARC が無いか `p=none` のときに限られる。
- **#128** `notes.md` では要件側の判断として保留、`security.md` の S-3 のチェックも未チェック。

**本番のメールで確かめたこと**（2026-09-12。受信メール 2 通のヘッダだけを読んだ。本文は見ていない）

| メール | Cloudflare が一番上に足したヘッダ（上から順） | `Authentication-Results` の中身 | `X-CF-SpamH-Score` |
| --- | --- | --- | --- |
| A: Cloudflare Email Sending 経由（`m.forte.llc`） | `Received` → `ARC-Seal` → `ARC-Message-Signature` → `ARC-Authentication-Results` → `Received-SPF` → `Authentication-Results` → `X-CF-SpamH-Score` | `dkim=pass header.d=m.forte.llc`、`dmarc=pass policy.dmarc=reject`、`spf=pass` | **`1`** |
| B: Gmail から `ai@test.hirao.cc` へ | `Received` → `ARC-Seal` → `ARC-Message-Signature` → `ARC-Authentication-Results` → `Received-SPF` → `Authentication-Results`（その下に Google の `Received` と ARC 一式が続く） | `dkim=pass header.d=gmail.com`、`dmarc=pass policy.dmarc=none`、`spf=pass` | **無い** |

- authserv-id は `mx.cloudflare.net`。`Received-SPF` には `receiver=mx.cloudflare.net`、`ARC-Authentication-Results` は `i=<n>; mx.cloudflare.net; …`。
- **`X-CF-SpamH-Score` は毎回は付かない**（B には無い）。尺度も公式文書に無い（A の値は `1`）。
- Worker に届くメールで `Authentication-Results` が欠け、`ARC-Authentication-Results` に判定が入っていないことがあるという報告がある（[workerd #6740](https://github.com/cloudflare/workerd/issues/6740)）。
- B の元の eml（Gmail から送った実機テスト、`msg_ppi15infhkiqcwjsqkx78`）は `GET /api/v1/messages/{id}/raw` で取れる。テストのひな形を作るときの材料にする。

**どこまで信用できるか（設計）**

送信者は生 MIME のヘッダを自由に書けるので、`Authentication-Results: mx.cloudflare.net; dmarc=pass` や `X-CF-SpamH-Score: 0` を自分で入れられる。
送信者のヘッダは必ず Cloudflare が足したまとまり（以下「CF ブロック」）の**下**に来る、という位置だけを頼りにする。

- CF ブロック = ヘッダを上から読み、1 本目が `by mx.cloudflare.net` を含む `Received`、続けて `ARC-Seal` / `ARC-Message-Signature` /
  `ARC-Authentication-Results`（`mx.cloudflare.net`）/ `Received-SPF`（`receiver=mx.cloudflare.net`）/ `Authentication-Results`（`mx.cloudflare.net`）/
  `X-CF-SpamH-Score` だけが並ぶ間。これ以外の名前のヘッダ（B なら 2 本目の `Received`）が来たら終わり。1 本目が Cloudflare の `Received` でなければ CF ブロックは無い。
- **弱点**: Cloudflare がブロックの末尾のヘッダを付けなかったとき（B の `X-CF-SpamH-Score`、#6740 の `Authentication-Results`）、
  送信者が同じ名前のヘッダを自分のヘッダの 1 本目に置くと、CF ブロックの続きに見えてしまう。そこで:
  - **認証結果（#127）**は CF ブロックの `Authentication-Results` を使い、無ければ CF ブロックの `ARC-Authentication-Results` を使う。
    `ARC-Authentication-Results` はブロックの 4 本目で、その下に Cloudflare の `Received-SPF` が必ず来るので、送信者は位置を偽れない。
    **両方が CF ブロック内にあって判定が食い違うときは「未認証」**。どちらも無ければ「未認証」。
  - **スパム判定（#128）**は偽っても得をしない。低いスコアを偽っても「判定なし」と同じ扱いにしかならず、高いスコアを偽ると自分のメールが不利になるだけ。
    なので CF ブロック内の `X-CF-SpamH-Score` をそのまま使ってよい。無ければ「判定なし」（`spam_verdict` は null）。

**実装の手順**

1. `src/domain/mail/parse.ts`: postal-mime の `email.headers`（上から順の配列）から CF ブロックを切り出す関数を作り、`ParsedMessage` に次を足す。
   `inboundAuth: { dmarc: "pass" | "fail" | "none" | null; dkimPassDomains: string[] } | null`（CF ブロックが無い・判定が無いときは null）と
   `cfSpamScore: number | null`。`dmarc=` / `dkim=pass header.d=` を読むだけで、他の項目は捨てる。
2. `src/domain/mail/thread.ts` `findExistingThreadId`: 接ぎ木の判定（inbound をアンカーにする「From が同じ」、outbound をアンカーにする「宛先に含まれる」の両方）の前に、
   `dmarc === "pass"`、または `dkimPassDomains` に From のドメイン（またはその親ドメイン）がある、を要求する。満たさなければ接ぎ木せず新しいスレッドにする。
3. `src/domain/mail/inbound.ts`: placeholder（解析不能・サイズ超過）は `inboundAuth: null` として扱う（接ぎ木しない。今も placeholder は Message-ID を持たない）。
   #128 は `cfSpamScore` を `spam_verdict` に写して insert に入れる。しきい値は、決まるまでは「スコアがあれば数値だけ見て、`clean` / `suspicious` / `spam` に写す関数」を
   1 か所に置き、値は仮置き（下の「決めること」）。
4. テスト（`tests/parse.test.ts`・`tests/thread.test.ts`・`tests/inbound.test.ts`）。ひな形は A / B のヘッダの並びを写し、アドレス・署名は伏せる:
   - A 型（CF ブロック + スコアあり）と B 型（スコア無し、下に Google の ARC 一式）を正しく読む。
   - 送信者が偽の `Authentication-Results: mx.cloudflare.net; dmarc=pass` を**自分のヘッダの 1 本目**に置いたメール（CF ブロックの `Authentication-Results` が無い #6740 の形）で、
     CF ブロックの `ARC-Authentication-Results` の判定が使われ、偽の方は使われない。ARC 側も判定が無ければ「未認証」。
   - `dmarc=none`（送信元に DMARC が無い）で From を偽装し、既知の Message-ID を `In-Reply-To` に入れたメールが**接ぎ木されない**（#10 の残りを塞いだことの証明）。
     `dmarc=pass` の正規の返信は今までどおり接ぎ木される。
   - 偽の `X-CF-SpamH-Score: 0` を置いたメールは `spam_verdict` が null か `clean`（`suspicious` 以上にならない）。
5. 完了条件: 上のテストが通り、`npm run verify` が通る。`security.md` の S-3（`spam_verdict` を書いているか）のチェックを付け、`notes.md` の「却下」を更新する。
   スキーマ変更は無し（判定は処理中にだけ使い、保存しない）。

**決めること（実装の前に）**

- `X-CF-SpamH-Score` のしきい値。尺度が分からないので、実運用で数週間分のスコアを集めてから決める。それまでは `spam_verdict` を書かない（null のまま）か、
  仮のしきい値で `suspicious` だけを出すか。
- 未認証のメールを画面に「未認証」と出すか（出すなら列の追加＝スキーマ変更が要る）。今の案は「接ぎ木しないだけ」。
- DMARC も DKIM も無い小さなドメインの正規の返信は、スレッドにつながらなくなる（新しいスレッドになる）。この副作用を受け入れるか。

## 2. デプロイ時に要る作業

今は無い（#84 の Cookie の名前の変更、outbound の DLQ、`0004` は 2026-09-12 に本番へ反映済み）。新しい環境を作る手順は `docs/ops/deployment.md`。
直した指摘がキュー・シークレット・マイグレーションを増やしたら、ここに書く。

## 3. 残っている制約

直していない、または直しきれないもの。**太字**は影響が大きいか、仕組みではなく運用で守っているもの。

### 受信

- **スレッド詳細は古い順に 200 件まで**で、201 件目以降（最新）は出ない。#127 の From 偽装と組み合わせると、正規のスレッドに 200 件積んで以後の正規メールを
  スレッド詳細から隠せる（受信箱の一覧には出る）（#35。`search/sql.ts` `MAX_THREAD_MESSAGES`）。
- 受信 `Date` は投入時刻の 1 年前〜10 分後の外なら投入時刻に落とすが、1 年以内の過去日は通る。新規スレッドならその日付で沈む（#19）。
- 同形異字（キリル文字の `а` など）は正規化しても同じにならず、拒否ルールをすり抜けうる（#9）。
- 表示用の `to_addr` は受信ヘッダの値のまま（ルールの照合はエンベロープで行う）（#14）。
- 山括弧の無い In-Reply-To / References（RFC 違反）はスレッドにつながらない（#72）。
- 受信の再配達の冪等化は「確認してから insert」なので、同じキューメッセージの同時再配達では Webhook の配信行が 2 本できうる。前回の添付 put の R2 孤児は残る（#77）。
- 解析できない・大きすぎるメール（placeholder）は、envelope の from が正規化できなければ差出人が空になる（#82）。
- アーカイブ済みのアドレス宛は、catch-all があればそこへ落ちる（#37）。
- **修正前に保存された行**は直っていない: ローカル部に裸のカンマがある `to_addr` / `cc_addr`（返信で宛先が割れる。#82）、
  `\` で終わる引用表示名（読めない。#39）、別ドメインを向いたエイリアス（`alias_target_id` に FK が無い。#61）。

### 送信

- **宛先ごとの送信済み記録が無い**。N 件目の宛先で失敗すると、成功した宛先にも再送する（最大 3 回。#21 / #59）。直すには `outbound_jobs` に列が要る。
- 件名は API が 998 文字まで受けるが、送信では 600 バイト（日本語で約 200 文字）で黙って切る（#22。`compose.ts` `MAX_SUBJECT_BYTES`）。
- 送信のレート制限（100 回 / 60 秒）は Rate Limiting binding の概算で、厳密な上限ではない（#106）。
- 返信の引用は切り詰めないので、長いメールへの長い返信は 400 になる（#115）。
- 非 ASCII の添付ファイル名は RFC 2231 で送るので、それを読まない古い MUA では化ける（#119）。
- 送信の直前に差出人の行が消えていれば送る（アドレスの削除はメッセージごと消える前提）（#67）。To が無く Cc / Bcc だけの送信は受けない（#80）。
- 送信に失敗した行は `failed` として残る（#90）。

### 表示

- **受信 HTML の DOMParser を使う経路に自動テストが無い**（workerd に `DOMParser` が無く、vitest は正規表現の代用経路だけを見る）。mXSS 対策の収束ループ（#17）は
  Chrome の実機で確かめただけ。インライン SVG は表示されず、`<plaintext>` を含む本文は常に空。
- 添付と生 MIME は id を知っていればゴミ箱のメッセージのものも読める（#116）。
- CSP に `sandbox` は付けていない（添付のダウンロードを止めるブラウザがあるため）（#6）。

### 認証・キー

- 子キーのカスケード失効は無い（親子関係の列が無い。発行の門で塞いでいる）（#25）。
- ログインのレート制限: `email` 単独の鍵は、他人のアドレスを 1 分に 20 回叩けばその人のログインを止められる。`ip` 単独の鍵は NAT 配下の全員で分け合う。
  成功したログインもバケットを消費する（#52）。
- Fetch Metadata の検査は、`Sec-Fetch-Site` も `Origin` も無い要求（非ブラウザ・古いブラウザ）を通す（#76）。
- owner が管理 API で自分のパスワードを変えると、自分にも強制変更が付く（`PATCH /me` で解除できる）（#98）。
- vitest 用の固定の `INTERNAL_SECRET` はリポジトリにあり、本番の拒否リストには入っていない（#48）。
- ユーザー管理の変更系（作成・更新・削除・grants）は API キーでは 403。自動化するなら画面ログインのセッションが要る（#121）。
- 管理 API の変更系（webhook・ルール・ドメイン・アドレス）は、addressIds を絞ったキーでは 403。addressIds が全部のキーは期限付きでも通るので、
  そのキーで作ったルールや webhook はキーの期限が切れた後も残る（#129）。

### Webhook

- 手動再送の claim の後に webhook を無効化すると、配信が `pending` のまま残る（#69）。キューのメッセージを失って `pending` のまま止まった配信は手動で再送できない（#42）。
- DNS リバインディングは Workers から防げない（#12）。

### ドメイン・Cloudflare

- subdomain モードの切断は、名前の完全一致と DKIM のホスト名だけを消す。従来消していた `*.<name>` のメール用レコードは残る（消さない側に倒した）（#60）。
- `verifyDomain` / `previewDomain` のページ上限（最大 41 往復）はそのまま（#93）。
- `CF_ACCOUNT_ID` が未設定だとドメイン接続が動かない（必須として文書化）（#94）。
- 監査ログの保持期間は未決で、消す仕組みも無い（#95。`docs/ops/audit-log.md`）。

### 運用・CI

- `npm ci` は install script を持つ依存（`workerd`・`esbuild`・`core-js-pure`・`fsevents`）を全部実行する。絞っていない（#96）。
- Worker 名の一致テスト（`tests/worker-name.test.ts`）は `env.*` 別の `name` / `vars` を見ない（#47）。
- `0004` の `'rebuild'` はバッチ無しの全件再構築で、手順で扱っている（#112）。

## 4. 再発しやすい型

これまでの輪で繰り返し出た形。修正・審査・次の精査で必ず見る。

- **保存形式の往復が冪等でない**。カンマ区切りで保存するアドレス列は、表示名（#39）でもローカル部（#82）でも同じ穴が開いた。区切り文字・引用・エスケープを持つ形式を増やしたら、format → parse → format の往復をテストで固定する。
- **門が 1 経路にしか入っていない**。新規送信だけに入れた上限が返信に無い（#89 → #115）、通常の受信だけ正規化して placeholder を忘れた（#82）、
  自分のルータだけ検査して同じ経路の他ルータが素通り（#13 / #31 / #75）。直したら `grep` で同じ入力を受ける経路を全部洗う。
- **キューの at-least-once**。再配達で副作用が二重になる（#21 / #86 / #118）か、重複判定で捨てられて続きが永久に走らない（#56 / #77）。再配達は即時に来る前提で、期限付きの回収が動くかも見る。
- **D1 の上限**。バインド変数 100 個（#32 / #57 / #88。id の列は `policy.ts` の `jsonIdsIn` で JSON 1 本にする）、1 行 2MB（#89 / #115）。どちらも vitest では再現しにくい。
- **キーから、キーより強い資格情報・広い範囲を得られる**。子キーの発行（#25 / #58）、期限のオーバーフロー（#83）、ユーザー管理（#121）、
  管理 API の Webhook・ルール（#129）。キーの addressIds と期限は、そのキーで作れるもの・届くもの全部を縛るか確かめる。
- **Cloudflare のゾーン単位の資源をドメイン単位で扱う**。catch-all（#85 / #117）、DNS レコード（#18 / #60）。消す操作は「迷ったら消さず 409」。
- **API に上限・カーソルを付けたのに、呼ぶ UI が 1 ページしか読まない**（#32 / #65 / #81）。
- **テストが本番と違う経路を通る**。vitest の `new Request` は workerd の実 HTTP とボディの扱いが違う（#55）。実装者が書いたテストが誤った挙動を期待値にしていた（#117 の第 2 波）。
- **ブラウザ実機でしか分からない**。parse → serialize → reparse が冪等でない mXSS、iframe の投機接続（#17）。

## 5. 未確認（実機でしか確かめられないもの）

- `X-CF-SpamH-Score` の尺度（#128。2 通のうち 1 通にだけ付き、値は `1`）。Cloudflare の `Authentication-Results` が欠けるのがどんなメールか（#127。#6740）。CF ブロックの並びがいつも同じか（2 通では同じ）。
- Email Routing が `INBOUND_QUEUE.send` の失敗を送信側の再送に変えるか（#24）。
- 998 文字を超えるヘッダ行を Cloudflare Email Sending が拒否するか、中継 MTA がどう扱うか（#34 / #66。送信側は 998 以内に収めている）。
- Cloudflare の `catch_all` が実機でもゾーンに 1 本であること（#85 / #117 の前提。fake CF と仕様の記述に基づく）。Cloudflare API の実レート制限と 429 の挙動（#93）。
- `_headers` が SPA のフォールバック応答に実機で付くか。本番の応答ヘッダ全般（#6）。
- 25MB のメールのパースが Workers の 128MB メモリに収まるか。
- ログインの応答時間から、遠隔でアドレスの存在を判別できるか（#26。ローカルでは差が出ない）。
- 最後のオーナー保護（#54）の D1 上での同時実行。
- `Zone Settings – Edit` 権限が実際に要るか（対応する呼び出しが `cfEndpoints` に無い。過剰権限の可能性）。
- `__Host-` の Cookie がローカル開発（`http://localhost`）で Chrome 以外のブラウザでも受け付けられるか（#84）。
- `<a>` を押した瞬間の Chrome の投機的 preconnect（クリック時点の漏えいなので、画像を許可するのと同程度）。
- 空の matcher（全件一致）のルールに UI が警告を出しているか。
