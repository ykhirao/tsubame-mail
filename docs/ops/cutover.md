# 切り替え手順（cutover）— `mail.example.com` を `旧 Worker` から `tsubame` へ

既に別の Worker が同じホスト名でメールを送受信している場合の差し替え手順。
これを **tsubame（Worker 名 `tsubame`）** に切り替える手順。**本番を壊さないこと**が最優先。

## 事前条件

- `docs/ops/deployment.md` の初回デプロイが完了し、`tsubame` Worker の送受信の
  動作確認チェックリストが全て通っていること。
- 新旧のリソース・Worker 名は以下:

| 役割 | 旧（現行） | 新（tsubame） |
| --- | --- | --- |
| Worker | `旧 Worker` | `tsubame` |
| D1 | `旧 Worker` | `tsubame` |
| R2 | `mailflare-raw` | `tsubame-mail` |
| Queues | `mailflare-inbound` / `mailflare-outbound` | `tsubame-inbound` / `tsubame-outbound` |

## 0. 全体の考え方

切り替えは「**同一ホスト名（`mail.example.com`）が片方の Worker にしか付けられない**」という
Cloudflare の制約（カスタムドメインと Email Routing の宛先 Worker の両方）があるため、
2 段階で行う:

1. **検証段階**: 新 Worker を別ホスト名（一時的に `tsubame.example.com`）で公開して、
   受信・送信・API を実地で確認する。
2. **本切替段階**: `mail.example.com` の Email Routing ルール宛先とカスタムドメインを
   `旧 Worker` → `tsubame` に貼り替える。

切り替えの瞬間の失敗に備えて、**手順のどの位置で何を戻せばよいか**を
各節の「ロールバック」に書いてある。いずれも DNS とルーティングの設定で戻せる。

---

## 1.（検証）新 Worker を別ホスト名で動かす

切り替え前に、`mail.example.com` とは別のホスト名で `tsubame` を本番公開して安全に検証する。

### 1.1 DNS `CNAME` を追加

`tsubame.example.com` → Worker `tsubame` に向ける。Cloudflare ダッシュボード →
*dns.tsubame... のゾーン → DNS → Records* に追加:

```
名前:  tsubame
種別:  CNAME
内容:  tsubame.<ACCOUNT_ID>.workers.dev   ← リクエストのターゲット（workers は無効だが CNAME 解決はできる）
代理:  Proxied
```

> `workers_dev: false` のため `tsubame.<ACCOUNT_ID>.workers.dev` 自体は 404 を返す。
> これで問題ない。CNAME は DNS 解決と Worker へのルーティングのためにだけ使う。

### 1.2 カスタムドメインとして Worker に割り当て

Workers ダッシュボード → *tsubame → Settings → Domains & Routes* から
`tsubame.example.com` を追加（*Add custom domain*）。同じホスト名は他 Worker に
付けられないが、`tsubame.example.com` は新規なので衝突しない。

### 1.3 接続確認

```bash
curl -s https://tsubame.example.com/api/health
# → {"ok":true,"app":"tsubame"} を期待
```

### 1.4（検証のみ）受信確認

この段階では Email Routing ルールはまだ `mail.example.com` を `旧 Worker` 宛のままなので、
普通の受信は旧 Worker に流れる。検証目的で一時ルールを作る場合は、**必ず後で消す**。

- 一時ルール: `mail.test.example.com` 宛を `tsubame` に送る、など（本物の
  `mail.example.com` は触らない）。

ロールバック（検証段階）:
- `tsubame.example.com` のカスタムドメインを外し、CNAME を消す。`mail.example.com` は
  一切変更されていないので旧運用に何の影響もない。

---

## 2.（本切替）Email Routing の宛先 Worker を貼り替える

### 2.1 新旧のルーティングルールを確認

Cloudflare ダッシュボード → *Email → Email Routing → Routing rules*。

現在は `mail.example.com`（と `cf-bounce.mail.example.com`）宛が **`旧 Worker`** に
転送されるルールがあるはず。宛先 Workers ドロップダウンに `旧 Worker` と `tsubame` の
選択肢が出ることを確認する。

### 2.2 ルールの宛先を書き換える

`mail.example.com` についてのルール（catch-all や個別アドレスのもの）の
**宛先 Worker を `旧 Worker` から `tsubame` に変更する**。

- 個別ルール（`ai@mail.example.com` など）が定義されている場合は**全部**書き換える。
- 宛先を Worker にしているルールをすべて `tsubame` にする。転送先（外部アドレスへの
  転送）ルールは Worker 宛ではないので対象外。

### 2.3 直後に受信が新 Worker に流れる

ルール保存後、次に届くメールから `mail.example.com` 宛の処理が `tsubame` に切り替わる。
`wrangler tail`（`docs/ops/operations.md` 参照）で、受信ハンドラが走って
R2 → Queues → D1 に処理されることを確認する。

```bash
npx wrangler tail tsubame
```

実メールを `mail.example.com` の実在アドレスへ送って、D1 にメッセージが入ることを
API（`GET /api/v1/messages`）で確認する。

ロールバック（本切替・ルールだけの時点）:
- 同じルールの宛先 Worker を `tsubame` → `旧 Worker` に戻すだけで、受信が旧 Worker に
  戻る。カスタムドメイン（`mail.example.com` → Worker）はまだ `旧 Worker` のままなので、
  送信・UI は旧のまま。この時点で切り戻すと受信のみ旧に戻る。

---

## 3.（本切替）カスタムドメインの付け替え

### 3.1 旧 Worker から外す

Workers ダッシュボード → *mailflare → Settings → Domains & Routes* で
`mail.example.com` のカスタムドメインを**削除**する。
（同じホスト名は片方の Worker にしか付けられないため、先に外す必要がある）

### 3.2 旧 Worker の Email Routing ルールで残るルートを片付ける（任意・推奨）

`旧 Worker` 側の Email Routing ルールは手順 2.2 で宛先が `tsubame` に変わっているので
`旧 Worker` への転送ルールは無くなっている。念のため残っていないことを確認する。

### 3.3 新 Worker に付け替える

Workers ダッシュボード → *tsubame → Settings → Domains & Routes* から
`mail.example.com` を *Add custom domain* で追加。

### 3.4 接続確認

```bash
curl -s https://mail.example.com/api/health
# → {"ok":true,"app":"tsubame"} を期待
```

`curl -s https://mail.example.com/` で UI がログインページを返すこと。

ロールバック（カスタムドメイン付け替えの時点）:
- カスタムドメイン `mail.example.com` を `tsubame` から外し、`旧 Worker` に付け直す。
  Email Routing ルールの宛先も手順 2.2 で `tsubame` に変えているが、受信を戻すには
  ルール宛先も `旧 Worker` へ戻す。これで受信・送信・UI すべて旧運用に戻る。

---

## 4. 切り替え中に届いたメールはどうなるか

- **Email Routing のルール設定とカスタムドメインは連動していない**（別の設定項目）。
  切り替えタイミングにより「ルールは `tsubame` 宛 / ドメインは `旧 Worker`」の
  一瞬のズレがあり得る。
- ルールが `tsubame` 宛になっていれば、その時点のメールは `tsubame` に届く。
  逆にまだ `旧 Worker` 宛なら旧 Worker に届く。
- ルールとドメインの両方の付け替えを**短時間（数分以内）で**済ませれば、実害は
  ほとんど無い。切り替え作業はメールボックスでなくルーティングと HTTP の設定のみで、
  **メールの喪失**は起きにくい。万一 `tsubame` に届いた時点で受信処理に失敗しても、
  Cloudflare Email Routing 側で再配送はされないため、その 1 通は届かないことがある。
  重要なメールを使者が再送して確認できるよう、**切り替えは業務の谷間（夜間・週末）に行う**。
- **過去メールは移行しない**方針なので、旧 D1（`旧 Worker`）に残っている過去分は
  `mail.example.com` の新 UI には出ない。旧 Worker を消す前に必要なら取得・退避しておく
  （第 6 節）。

---

## 5. 検証（本切替後）

- [ ] `https://mail.example.com/api/health` が `app":"tsubame"` を返す
- [ ] 実メール受信が新 Worker で処理され D1 に入る
- [ ] 送信が `tsubame` の Email バインディングで届く
- [ ] UI ログイン・API キー取得が動く（`docs/ops/deployment.md` 第 9 節のチェックリスト）

---

## 6. 旧 Worker と旧リソースを消すタイミング

**すぐには消さない。一定期間（目安 2〜4 週間）残す。**

- 理由: 切り替え直後に問題が出たとき、第 2・3 節のロールバックで旧運用に戻すため。
- 残すもの: `旧 Worker` Worker、D1 `旧 Worker`、R2 `mailflare-raw`、
  Queues `mailflare-inbound` / `mailflare-outbound`、旧 Cloudflare トークン。
- 一定期間を過ぎて問題が無いことを確認したら、**統合担当に依頼して**削除する
  （削除手順は別途相談。誤って `mail.example.com` の DNS や apex を触らないこと）。

---

## 7. 切り替えの最終チェックリスト

- [ ] `tsubame.example.com` 検証が全部通った
- [ ] Email Routing ルールの宛先がすべて `旧 Worker` → `tsubame`
- [ ] カスタムドメイン `mail.example.com` が `tsubame` に付いた（`旧 Worker` からは外れた）
- [ ] 受信・送信・API の実地確認が通った
- [ ] 旧 Worker / 旧リソースを残したまま（削除はしていない）
- [ ] 切り替え日時と作業内容を記録した
