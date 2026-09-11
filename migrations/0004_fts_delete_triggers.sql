-- #27: messages_fts_au / messages_fts_ad が外部コンテンツテーブルの削除手順（FTS5 §4.4.3 の
-- 'delete' コマンド）を使っていなかった。AFTER DELETE では対象行が既に消えているため
-- 何も索引から消せず、AFTER UPDATE では new の値で「消そう」として old のトークンが残る。
-- 生きているトリガを一度 DROP してから 'delete' コマンド形式で作り直し、既存データの索引を
-- 'rebuild' で作り直す。
--> statement-breakpoint
DROP TRIGGER `messages_fts_au`;
--> statement-breakpoint
DROP TRIGGER `messages_fts_ad`;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_au` AFTER UPDATE ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, rowid, subject, text_body, from_addr, to_addr, cc_addr)
	VALUES ('delete', old.rowid, old.subject, old.text_body, old.from_addr, old.to_addr, old.cc_addr);
	INSERT INTO `messages_fts`(rowid, subject, text_body, from_addr, to_addr, cc_addr)
	VALUES (new.rowid, new.subject, new.text_body, new.from_addr, new.to_addr, new.cc_addr);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_ad` AFTER DELETE ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, rowid, subject, text_body, from_addr, to_addr, cc_addr)
	VALUES ('delete', old.rowid, old.subject, old.text_body, old.from_addr, old.to_addr, old.cc_addr);
END;
--> statement-breakpoint
INSERT INTO `messages_fts`(`messages_fts`) VALUES ('rebuild');
