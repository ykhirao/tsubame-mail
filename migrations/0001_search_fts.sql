-- W6: 全文検索インデックス。
-- D1 の実機検証（tests/search-integration.test.ts で再現）の結果、FTS5 trigram は有効で
-- 3 文字以上の日本語部分一致は成立するが、1〜2 文字の語（「見積」「請求」など）
-- は trigram ではマッチしないことが判明した。要件 FR-3 の例（subject:"見積"）は
-- 2 文字なので、本マイグレーションは FTS5 trigram を「3 文字以上の語」に限定して使い、
-- 1〜2 文字の語は LIKE でフォールバックする方針（詳細は docs/adr-search.md）。
--
-- FTS カラム名は content テーブル（messages）のカラム名と**名前で一致**させ、
-- 外部 content（content='messages'）を使う。設計当初の「body」「addrs」という仮想
-- カラム名は messages に実在しないため、INSERT/同期時に「no such column: T.body」で
-- 失敗する（実測確認済み）。そこで実在カラム subject / text_body / from_addr /
-- to_addr / cc_addr をそのまま索引カラムにする。アドレス検索は 3 つのアドレスカラムを
-- 横断して行う。外部 content なら DELETE / UPDATE 後の再同期もトリガで問題なく動く。
--> statement-breakpoint
CREATE VIRTUAL TABLE `messages_fts` USING fts5(
	`subject`,
	`text_body`,
	`from_addr`,
	`to_addr`,
	`cc_addr`,
	content='messages',
	content_rowid='rowid',
	tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER `messages_fts_ai` AFTER INSERT ON `messages` BEGIN
	INSERT INTO `messages_fts`(rowid, subject, text_body, from_addr, to_addr, cc_addr)
	VALUES (new.rowid, new.subject, new.text_body, new.from_addr, new.to_addr, new.cc_addr);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_au` AFTER UPDATE ON `messages` BEGIN
	DELETE FROM `messages_fts` WHERE rowid = old.rowid;
	INSERT INTO `messages_fts`(rowid, subject, text_body, from_addr, to_addr, cc_addr)
	VALUES (new.rowid, new.subject, new.text_body, new.from_addr, new.to_addr, new.cc_addr);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_ad` AFTER DELETE ON `messages` BEGIN
	DELETE FROM `messages_fts` WHERE rowid = old.rowid;
END;
