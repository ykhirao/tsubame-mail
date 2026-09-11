# セキュリティ精査 — 残件と注意点

観点は [セキュリティ観点](security.html)。このファイルには、**これから直すもの**と、
**直したが残っている制約・また起きうる落とし穴・実機で未確認のこと**だけを載せる。

- 解決済みの指摘（#1〜#120 の再現・対応・再検査の記録）は消した。経緯は git 履歴にある
  （`git show 84eb932:docs/spec/security-audit.md`）。コードのコメントにある「#n」「精査 #n」はその番号。
- 番号は通しで、**次に振る番号は #129**。
- 進め方（対応 → 再検査 → 次の精査）は `.agents/skills/security-audit/SKILL.md`。「この文書を進めて」と言われたらそれに従う。

## 1. 対応予定

### 直すもの

2026-09-12 の再検査で見つかったもの。どれも「実証済み」（実際に走らせて成立を確かめた）。

| # | 深刻度 | 内容 | 場所 |
| --- | --- | --- | --- |
| 121 | **中** | 絞った admin キーから、ユーザー管理で全権を得られる（#58 の clamp の迂回） | `api/v1/admin/users.ts` |
| 122 | 低 | 受信の再配達で、後から作った webhook にも古いメールを配信する | `domain/mail/inbound.ts`、`services/webhooks.ts` |
| 123 | 低 | drop ルールで捨てたメールにも `message.received` を配信する | `domain/mail/inbound.ts` |
| 124 | 低 | address ルールの matcher 側が NFKC / punycode で揃っていない | `domain/mail/inbound.ts` `matchAddressRules` |
| 125 | 低 | 検索の LIKE が `_` `%` と区切りの制御文字をエスケープしない | `domain/search/sql.ts` |
| 126 | 低 | 返信で To が空・Cc だけのメールを送れる | `api/v1/outbound.ts` reply |

- **#121** addressIds 1 件・期限 1 時間の admin キーで `POST /admin/users {role:"owner", password}` → 201。そのユーザーでログインすると
  addressIds `"all"`・無期限の完全なセッションになる。同じキーで自分の password の PATCH と自分への grants PUT も通る。
  **直し方**: ユーザーの作成・更新・削除・grants の PUT は Cookie セッションの owner だけに許し、API キーは admin スコープでも 403。
  パスワードやロールはキーの期限・範囲で縛れない資格情報なので、「キーから、キーより強い資格情報を作れない」原則（#25 / #58）をここにも当てる。GET はキーでよい。
- **#122** 再配達が `rawR2Key` の重複に当たると `dispatchMessageEvent` だけを呼び直す（#77）。これは「今有効で、配信行がまだ無い webhook」全部に配るので、
  最初の配送より後に作った webhook にも古いメールが届く。遅延再配達・DLQ の再投入で表に出る。
  **直し方**: dup 経路の再配信は、webhook の `createdAt` がメッセージの作成時刻以前のものだけに限る。
- **#123** drop（trash）にしたメールにも `message.received` を出す（従来から）。**直し方**: trash なら出さない。dup 経路も同じ。
- **#124** 候補（envelope の宛先）は `canonicalAddress` と NFKC で揃えたが、ルールの matcher はそのまま比べる。`{to:"b@例え.jp"}` のルールが punycode の envelope に当たらない。
  **直し方**: `resolve.ts` の `canonicalMatcher` を export して matcher も揃える。
- **#125** 1〜2 文字の語の LIKE と、`from:` `to:` `subject:` `body:` の個別条件が値を `%${w}%` のまま渡す。`q=_`、`q=%1F` で全件に一致する。
  **直し方**: `\` `%` `_` をエスケープして `escape '\'` を付け、制御文字を含む語は一致させない。
- **#126** 明示した `to` が全部自分で `cc` に他人がいると 202 になり、To が空のメールを送る。新規送信は `to` 必須（#80）なので食い違う。
  **直し方**: 自分を除いた最終の To が 0 件なら 400。

### 設計判断が要るもの

受信経路の調査（2026-09-12、別セッション）から持ち込み、コードで事実を確かめたもの。
Email Security（Cloudflare の検査製品）は、要件の非目標（「スパムは Cloudflare が付けた判定ヘッダを読むだけ」）と、受け口が Worker であることから入れない。

| # | 深刻度 | 内容 | 場所 |
| --- | --- | --- | --- |
| 127 | **中** | 受信メールの `Authentication-Results` / `ARC-*` を読むコードが無く、From を偽装したメールをスレッドに接ぎ木できる | `domain/routing/incoming.ts`、`services/queue.ts` `InboundQueueMessage`、`domain/mail/thread.ts` `findExistingThreadId` |
| 128 | 低 | `spam_verdict` を書く側が無い。カラム・API・検索・UI のバッジ・PWA 通知の設計（`spam_suspicious: notify \| drop`）は揃っているのに常に null | `domain/mail/inbound.ts`、`domain/routing/incoming.ts` |

- **#127** スレッドの接ぎ木は「Message-ID が一致し、From（または outbound の宛先）が一致する」で判定している（#10）。Message-ID と宛先を知る第三者
  （Bcc 受信者・転送先はヘッダから両方を知る）が From を偽装すると、信頼している会話の続きとして表示される。Reply-To は読まないので返信は偽装元へは行かない。
  Cloudflare Email Routing は**送信ドメインの DMARC ポリシーで不合格のメールを Worker に届く前に拒否する**
  （[Email lifecycle](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/)）ので、成立するのは送信元ドメインに DMARC が無いか `p=none` のときに限られる。
- **#128** `notes.md` では要件側の判断として保留、`security.md` の S-3 のチェックも未チェック。

**進め方**:
1. まず実物を見る。Worker が受け取るメールに Cloudflare がどのヘッダを付けるか（`Authentication-Results` の authserv-id、スパム判定のヘッダ名）は公式文書に無い。
   受信した生 MIME は R2（`raw/…`）に残っているので、実運用の 1 通を読んで確かめる。
2. #127: email ハンドラ（`incoming.ts`。ヘッダを読めて `setReject()` も使える唯一の場所）で、Cloudflare の authserv-id を持つ `Authentication-Results` **だけ**を読む
   （送信者も同名ヘッダを自由に書けるので、それ以外は信用しない）。結果を `InboundQueueMessage` に載せて運び、inbound をアンカーにする接ぎ木を
   「DMARC pass、または From のドメインに揃った DKIM pass」のときに限る。保存するなら列の追加（スキーマ変更）が要る。
   接ぎ木しないだけにするか、画面に「未認証」を出すかは要件の判断。
3. #128: 1 で見つけた判定ヘッダを `incoming.ts` で読んで運び、`inbound.ts` の insert に `spamVerdict` を書く。`security.md` S-3 のチェックを付ける。

## 2. デプロイ時に要る作業（未実施）

- **`npx wrangler queues create tsubame-outbound-dlq`**（#86 で `wrangler.jsonc` に DLQ を足した。作らないとデプロイが失敗する）。
- **セッション Cookie の名前が `__Host-tsb_session` に変わった**（#84）。デプロイすると既存のセッションはすべて切れ、全員が再ログインになる。
- 既存の大きな D1 に `0004_fts_delete_triggers` を初めて流すときは、`deployment.md` §5.1 の手順（行数の確認、失敗時の `'rebuild'` の流し直し）に従う（#112）。

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
- **キーから、キーより強い資格情報を作れる**。子キーの発行（#25 / #58）、期限のオーバーフロー（#83）、ユーザー管理（#121）。
- **Cloudflare のゾーン単位の資源をドメイン単位で扱う**。catch-all（#85 / #117）、DNS レコード（#18 / #60）。消す操作は「迷ったら消さず 409」。
- **API に上限・カーソルを付けたのに、呼ぶ UI が 1 ページしか読まない**（#32 / #65 / #81）。
- **テストが本番と違う経路を通る**。vitest の `new Request` は workerd の実 HTTP とボディの扱いが違う（#55）。実装者が書いたテストが誤った挙動を期待値にしていた（#117 の第 2 波）。
- **ブラウザ実機でしか分からない**。parse → serialize → reparse が冪等でない mXSS、iframe の投機接続（#17）。

## 5. 未確認（実機でしか確かめられないもの）

- Worker に届くメールに Cloudflare が付けるヘッダ（#127 / #128 の前提）。
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
