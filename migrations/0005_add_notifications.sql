CREATE TABLE `notification_digests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`message_ids` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_digests_due_idx` ON `notification_digests` (`due_at`);--> statement-breakpoint
CREATE INDEX `notification_digests_user_idx` ON `notification_digests` (`user_id`);--> statement-breakpoint
CREATE TABLE `notification_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`message_id` text,
	`kind` text DEFAULT 'received' NOT NULL,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`hold_group` text,
	`device_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_log_user_idx` ON `notification_log` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification_mailbox_prefs` (
	`user_id` text NOT NULL,
	`address_id` text NOT NULL,
	`level` text NOT NULL,
	PRIMARY KEY(`user_id`, `address_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notification_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`paused_until` integer,
	`display` text DEFAULT 'full' NOT NULL,
	`badge` text DEFAULT 'notified' NOT NULL,
	`group_by_thread` integer DEFAULT true NOT NULL,
	`burst_window_sec` integer DEFAULT 0 NOT NULL,
	`suppress_when_active` integer DEFAULT false NOT NULL,
	`spam_suspicious` text DEFAULT 'drop' NOT NULL,
	`quiet` text,
	`notify_send_failure` integer DEFAULT true NOT NULL,
	`notify_catch_all` integer DEFAULT true NOT NULL,
	`feed_seen_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notification_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`matcher` text NOT NULL,
	`action` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_rules_user_idx` ON `notification_rules` (`user_id`,`priority`);--> statement-breakpoint
CREATE TABLE `push_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`address_ids` text,
	`last_seen_at` integer,
	`last_success_at` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_endpoint_idx` ON `push_devices` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_devices_user_idx` ON `push_devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `thread_notification_prefs` (
	`user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`mode` text NOT NULL,
	PRIMARY KEY(`user_id`, `thread_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `sent_by_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `messages` ADD `envelope_to` text;