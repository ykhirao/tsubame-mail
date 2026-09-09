---
name: workstream
description: 並列で1つの担当範囲を実装するときの進め方
---

このリポジトリは複数のエージェントが別々の git worktree で同時に実装する。
衝突を避けるための規則。

- 担当は `docs/spec/architecture.md` の「2. ディレクトリと所有権」で決まる。**担当外を編集しない。**
- 全員が編集してはいけないファイル: `src/db/schema.ts`, `src/api/app.ts`, `src/worker.ts`,
  `src/api/types.ts`, `src/shared/errors.ts`, `src/shared/contracts/common.ts`,
  `src/domain/mail/address.ts`, `src/services/queue.ts`, `wrangler.jsonc`, `package.json`,
  `migrations/0000_init.sql`
- スキーマ変更・依存追加が要るときは、勝手にやらず報告に「要依頼」として書く。
- ルータは `export default` するだけ。`src/api/app.ts` への登録は統合担当がやる。
- 認証は `c.get("principal")` に `Principal` が入っている前提で書く。自分で認証を書かない。
- 他のワークストリームの関数を呼ぶときは、シグネチャだけを契約とする。中身の完成を待たない。

終わる前に必ず全部通す:

```bash
npx tsc --noEmit    # エラー 0
npx vitest run      # 全部通る（他人のテストも壊さない）
git add -A && git commit -m "<日本語のメッセージ>"
```

コミットメッセージに AI の署名（Co-Authored-By など）を入れない。フックに弾かれる。

報告は 20 行以内。作ったファイル / 他から使う export の名前 / 未解決の依頼事項。
