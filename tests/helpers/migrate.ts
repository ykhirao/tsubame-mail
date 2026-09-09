/**
 * vitest-pool-workers のストレージ分離が効かないので、テストは自分で片付ける必要がある。
 * スキーマ自体は tests/setup.ts が beforeAll で一度だけ流す。ここは空にするだけ。
 */
import { env } from "cloudflare:test";
import { getDb, schema } from "@/db/client";

export async function applyMigrations() {
	const db = getDb(env as unknown as CloudflareEnv);
	await db.delete(schema.webhookDeliveries);
	await db.delete(schema.webhooks);
	await db.delete(schema.auditLogs);
	await db.delete(schema.sessions);
	await db.delete(schema.apiKeys);
	await db.delete(schema.addressGrants);
	await db.delete(schema.attachments);
	await db.delete(schema.messages);
	await db.delete(schema.threads);
	await db.delete(schema.addresses);
	await db.delete(schema.domains);
	await db.delete(schema.users);
}
