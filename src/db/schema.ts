/** D1 スキーマ。変更したら必ず `npm run db:generate` でマイグレーションを作ること。 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const createdAt = () =>
	integer("created_at", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`);

export const users = sqliteTable(
	"users",
	{
		id: text("id").primaryKey(),
		email: text("email").notNull(),
		name: text("name").notNull(),
		passwordHash: text("password_hash"),
		role: text("role", { enum: ["owner", "member", "agent"] }).notNull(),
		status: text("status", { enum: ["active", "disabled"] })
			.notNull()
			.default("active"),
		mustChangePassword: integer("must_change_password", { mode: "boolean" })
			.notNull()
			.default(false),
		lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		userAgent: text("user_agent"),
		ip: text("ip"),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex("sessions_token_idx").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const apiKeys = sqliteTable(
	"api_keys",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		prefix: text("prefix").notNull(),
		keyHash: text("key_hash").notNull(),
		/** JSON 配列: ("read" | "send" | "admin")[] */
		scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
		/** JSON 配列。null なら「所有ユーザーの権限そのまま」。値があるとユーザーの権限との積集合になる。 */
		addressIds: text("address_ids", { mode: "json" }).$type<string[] | null>(),
		expiresAt: integer("expires_at", { mode: "timestamp" }),
		revokedAt: integer("revoked_at", { mode: "timestamp" }),
		lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex("api_keys_hash_idx").on(t.keyHash), index("api_keys_user_idx").on(t.userId)],
);

export const domains = sqliteTable(
	"domains",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		zoneId: text("zone_id").notNull(),
		zoneName: text("zone_name").notNull(),
		mode: text("mode", { enum: ["apex", "subdomain"] }).notNull(),
		routingStatus: text("routing_status", { enum: ["pending", "active", "error"] })
			.notNull()
			.default("pending"),
		sendingStatus: text("sending_status", { enum: ["disabled", "pending", "active", "error"] })
			.notNull()
			.default("disabled"),
		/** ゾーン全体を飲み込む catch-all。有効化は明示のオプトインに限る。 */
		catchAllEnabled: integer("catch_all_enabled", { mode: "boolean" }).notNull().default(false),
		lastError: text("last_error"),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex("domains_name_idx").on(t.name)],
);

export const addresses = sqliteTable(
	"addresses",
	{
		id: text("id").primaryKey(),
		domainId: text("domain_id")
			.notNull()
			.references(() => domains.id, { onDelete: "cascade" }),
		localPart: text("local_part").notNull(),
		address: text("address").notNull(),
		displayName: text("display_name"),
		kind: text("kind", { enum: ["mailbox", "alias"] })
			.notNull()
			.default("mailbox"),
		aliasTargetId: text("alias_target_id"),
		isCatchAll: integer("is_catch_all", { mode: "boolean" }).notNull().default(false),
		signature: text("signature"),
		color: text("color"),
		archivedAt: integer("archived_at", { mode: "timestamp" }),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("addresses_address_idx").on(t.address),
		index("addresses_domain_idx").on(t.domainId),
	],
);

/** owner はこの表に依らず全アドレスを見られる。 */
export const addressGrants = sqliteTable(
	"address_grants",
	{
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		addressId: text("address_id")
			.notNull()
			.references(() => addresses.id, { onDelete: "cascade" }),
		level: text("level", { enum: ["read", "write"] }).notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.addressId] }),
		index("address_grants_address_idx").on(t.addressId),
	],
);

export const threads = sqliteTable(
	"threads",
	{
		id: text("id").primaryKey(),
		addressId: text("address_id")
			.notNull()
			.references(() => addresses.id, { onDelete: "cascade" }),
		subject: text("subject"),
		lastMessageAt: integer("last_message_at", { mode: "timestamp" }).notNull(),
		messageCount: integer("message_count").notNull().default(0),
		unreadCount: integer("unread_count").notNull().default(0),
		createdAt: createdAt(),
	},
	(t) => [index("threads_address_last_idx").on(t.addressId, t.lastMessageAt)],
);

export const messages = sqliteTable(
	"messages",
	{
		id: text("id").primaryKey(),
		threadId: text("thread_id").references(() => threads.id, { onDelete: "set null" }),
		addressId: text("address_id")
			.notNull()
			.references(() => addresses.id, { onDelete: "cascade" }),
		direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
		status: text("status", {
			enum: ["received", "sent", "draft", "queued", "failed", "trash"],
		}).notNull(),

		rfcMessageId: text("rfc_message_id"),
		inReplyTo: text("in_reply_to"),
		referencesHeader: text("references_header"),

		fromAddr: text("from_addr").notNull(),
		fromName: text("from_name"),
		/** to / cc / bcc はカンマ結合の完全なリスト。単一アドレスとして扱わないこと。 */
		toAddr: text("to_addr").notNull().default(""),
		ccAddr: text("cc_addr"),
		bccAddr: text("bcc_addr"),

		subject: text("subject"),
		snippet: text("snippet"),
		textBody: text("text_body"),
		htmlBody: text("html_body"),

		rawR2Key: text("raw_r2_key"),
		sizeBytes: integer("size_bytes"),
		hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull().default(false),

		isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
		isStarred: integer("is_starred", { mode: "boolean" }).notNull().default(false),
		spamVerdict: text("spam_verdict", { enum: ["clean", "suspicious", "spam"] }),

		receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		index("messages_address_received_idx").on(t.addressId, t.receivedAt),
		index("messages_thread_idx").on(t.threadId),
		index("messages_rfc_id_idx").on(t.addressId, t.rfcMessageId),
		index("messages_status_idx").on(t.status),
	],
);

export const attachments = sqliteTable(
	"attachments",
	{
		id: text("id").primaryKey(),
		messageId: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		filename: text("filename").notNull(),
		contentType: text("content_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		contentId: text("content_id"),
		isInline: integer("is_inline", { mode: "boolean" }).notNull().default(false),
		r2Key: text("r2_key").notNull(),
		createdAt: createdAt(),
	},
	(t) => [index("attachments_message_idx").on(t.messageId)],
);

export const routingRules = sqliteTable(
	"routing_rules",
	{
		id: text("id").primaryKey(),
		/**
		 * domain は受信ハンドラで配送前に、address は配送後に評価する別物。
		 * クエリでは必ず scope を絞ること。
		 */
		scope: text("scope", { enum: ["domain", "address"] }).notNull(),
		domainId: text("domain_id").references(() => domains.id, { onDelete: "cascade" }),
		addressId: text("address_id").references(() => addresses.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		action: text("action", { enum: ["deliver", "forward", "reject", "drop", "mark"] }).notNull(),
		matcher: text("matcher", { mode: "json" }).$type<Record<string, string>>().notNull(),
		target: text("target"),
		priority: integer("priority").notNull().default(0),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdAt: createdAt(),
	},
	(t) => [index("routing_rules_scope_idx").on(t.scope, t.priority)],
);

export const outboundJobs = sqliteTable(
	"outbound_jobs",
	{
		id: text("id").primaryKey(),
		messageId: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		status: text("status", { enum: ["queued", "sending", "sent", "failed"] })
			.notNull()
			.default("queued"),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }),
		sentAt: integer("sent_at", { mode: "timestamp" }),
		createdAt: createdAt(),
	},
	(t) => [index("outbound_jobs_status_idx").on(t.status)],
);

export const webhooks = sqliteTable(
	"webhooks",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		url: text("url").notNull(),
		secret: text("secret").notNull(),
		/** JSON 配列: ("message.received" | "message.sent" | "message.failed")[] */
		events: text("events", { mode: "json" }).$type<string[]>().notNull(),
		addressIds: text("address_ids", { mode: "json" }).$type<string[] | null>(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdAt: createdAt(),
	},
);

export const webhookDeliveries = sqliteTable(
	"webhook_deliveries",
	{
		id: text("id").primaryKey(),
		webhookId: text("webhook_id")
			.notNull()
			.references(() => webhooks.id, { onDelete: "cascade" }),
		event: text("event").notNull(),
		messageId: text("message_id"),
		status: text("status", { enum: ["pending", "success", "failed"] }).notNull(),
		httpStatus: integer("http_status"),
		error: text("error"),
		durationMs: integer("duration_ms"),
		attempt: integer("attempt").notNull().default(1),
		nextRetryAt: integer("next_retry_at", { mode: "timestamp" }),
		createdAt: createdAt(),
	},
	(t) => [index("webhook_deliveries_webhook_idx").on(t.webhookId, t.createdAt)],
);

export const auditLogs = sqliteTable(
	"audit_logs",
	{
		id: text("id").primaryKey(),
		actorId: text("actor_id"),
		action: text("action").notNull(),
		targetType: text("target_type"),
		targetId: text("target_id"),
		meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
		ip: text("ip"),
		createdAt: createdAt(),
	},
	(t) => [index("audit_logs_created_idx").on(t.createdAt)],
);

export const settings = sqliteTable("settings", {
	key: text("key").primaryKey(),
	value: text("value", { mode: "json" }).$type<unknown>(),
	updatedAt: integer("updated_at", { mode: "timestamp" }),
});
