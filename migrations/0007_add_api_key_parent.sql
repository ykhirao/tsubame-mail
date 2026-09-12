ALTER TABLE `api_keys` ADD `parent_key_id` text;--> statement-breakpoint
CREATE INDEX `api_keys_parent_idx` ON `api_keys` (`parent_key_id`);