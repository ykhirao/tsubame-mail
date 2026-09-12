CREATE TABLE `email_verifications` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `address_grants` ADD `hidden` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `admin_mode_until` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `external_email` text;--> statement-breakpoint
ALTER TABLE `users` ADD `external_verified_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `primary_address_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_external_email_idx` ON `users` (`external_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_primary_address_idx` ON `users` (`primary_address_id`);--> statement-breakpoint
-- 今のログイン用アドレスは外部アドレスとして引き継ぐ。今までそれでログインしてきたので確認済みとして扱う。
UPDATE `users` SET `external_email` = `email`, `external_verified_at` = unixepoch() WHERE `external_email` IS NULL;
--> statement-breakpoint
-- owner は今まで割り当て無しで全アドレスを見ていた。誰にも割り当てていないアドレスだけを owner に割り当て、他の人に割り当て済みのものは見えなくする。
INSERT INTO `address_grants` (`user_id`, `address_id`, `level`)
SELECT u.`id`, a.`id`, 'write' FROM `users` u CROSS JOIN `addresses` a
WHERE u.`role` = 'owner' AND NOT EXISTS (SELECT 1 FROM `address_grants` g WHERE g.`address_id` = a.`id`);
--> statement-breakpoint
-- owner の有効な API キーが対象にしているアドレスは、キーが動き続けるように owner に割り当てる。見え方は非表示にして、受信箱には出さない。
INSERT INTO `address_grants` (`user_id`, `address_id`, `level`, `hidden`)
SELECT DISTINCT u.`id`, j.`value`, 'write', 1
FROM `api_keys` k
JOIN `users` u ON u.`id` = k.`user_id`
JOIN json_each(k.`address_ids`) j
JOIN `addresses` a ON a.`id` = j.`value`
WHERE u.`role` = 'owner' AND k.`revoked_at` IS NULL AND k.`address_ids` IS NOT NULL
  AND (k.`expires_at` IS NULL OR k.`expires_at` > unixepoch())
  AND NOT EXISTS (SELECT 1 FROM `address_grants` g WHERE g.`user_id` = u.`id` AND g.`address_id` = j.`value`);
--> statement-breakpoint
-- プライマリは、write で割り当てたメールボックス（エイリアス・アーカイブ済みを除く）のうち最初に割り当てたもの。
UPDATE `users` SET `primary_address_id` = (
	SELECT g.`address_id` FROM `address_grants` g JOIN `addresses` a ON a.`id` = g.`address_id`
	WHERE g.`user_id` = `users`.`id` AND g.`level` = 'write' AND g.`hidden` = 0 AND a.`kind` = 'mailbox' AND a.`archived_at` IS NULL
	  AND NOT EXISTS (SELECT 1 FROM `users` o WHERE o.`primary_address_id` = a.`id`)
	ORDER BY g.`created_at`, a.`created_at`, a.`id` LIMIT 1
) WHERE `primary_address_id` IS NULL;
