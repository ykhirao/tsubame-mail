---
name: code-review
description: このリポジトリ固有のレビュー観点
---

一般論ではなく、このプロジェクトで実際に壊れる箇所だけを見る。
指摘には必ずファイルパスと行番号を付ける。

**認可**
- メッセージを引くクエリが `principal.addressIds` で絞られているか。
  `userId` で絞っているものは**必ず間違い**（共有アドレスと API キーのスコープが壊れる）。
- API キーの `addressIds` が、所有ユーザーの権限を**広げて**いないか（積集合になっているか）。
- 管理系が `role === "owner"` で守られているか。スコープだけで通していないか。

**メール**
- `to` / `cc` を単一アドレスとして扱っていないか。`parseAddressList` を通しているか。
- `message.setReject()` / `message.forward()` を email ハンドラの外で呼んでいないか。
- 受信ハンドラで MIME をパースしていないか（R2 に置いてキューに逃がす）。
- catch-all が実在アドレスより先に評価されていないか。
- 送信の `from` が `writableAddressIds` で検証されているか。

**Cloudflare**
- `wrangler.jsonc` にアカウント固有の ID を書いていないか。
- Worker 名（`name` / `vars.EMAIL_WORKER_NAME` / Email Routing の宛先）がずれていないか。
- apex の DNS を触る経路が増えていないか。

**その他**
- ハンドラで `c.json({ error: ... })` を直接返していないか（`ApiError` を throw する）。
- キューの処理が at-least-once に耐えるか（二重処理で行が増えないか）。
- 設定項目を安易に増やしていないか。要件は「設定は最小限」。
