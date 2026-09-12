import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getDb, schema } from "@/db/client";
import { countUnread, loadPrefs } from "@/services/notify/prefs";
import { applyMigrations } from "./helpers/migrate";
import { createAddress, createDomain, createUser, db } from "./auth-helpers";

function testDb() {
	return getDb(env as unknown as CloudflareEnv);
}

async function grant(userId: string, addressId: string) {
	await db().insert(schema.addressGrants).values({ userId, addressId, level: "write" });
}

async function seedThread(over: {
	threadId: string;
	addressId: string;
	unreadCount: number;
	messageStatus: "received" | "trash";
}) {
	await db()
		.insert(schema.threads)
		.values({
			id: over.threadId,
			addressId: over.addressId,
			subject: "件名",
			lastMessageAt: new Date(1_770_000_000_000),
			messageCount: 1,
			unreadCount: over.unreadCount,
		});
	await db()
		.insert(schema.messages)
		.values({
			id: `msg_${over.threadId}`,
			threadId: over.threadId,
			addressId: over.addressId,
			direction: "inbound",
			status: over.messageStatus,
			fromAddr: "them@example.net",
			toAddr: "me@example.test",
			subject: "件名",
			receivedAt: new Date(1_770_000_000_000),
			isRead: false,
			isStarred: false,
			hasAttachments: false,
		});
}

beforeEach(async () => {
	await applyMigrations();
});

// 端末のアプリバッジは「開けば消える数」でなければならない。ゴミ箱の会話は受信箱に
// 出ないので、数えるとホーム画面に消せない数字が残る（サイドバーのバッジは
// `addresses.ts` が同じ条件で既に除いている）。
describe("アプリバッジの未読数", () => {
	it("ゴミ箱だけの会話は数えない", async () => {
		const user = await createUser({ role: "owner" });
		const domainId = await createDomain();
		const addressId = await createAddress(domainId, "me");
		await grant(user.id, addressId);
		await seedThread({
			threadId: "thr_trash",
			addressId,
			unreadCount: 1,
			messageStatus: "trash",
		});

		const prefs = await loadPrefs(testDb(), user.id);
		expect(await countUnread(testDb(), user.id, "owner", prefs)).toBe(0);
	});

	it("受信箱に残る未読は数える", async () => {
		const user = await createUser({ role: "owner" });
		const domainId = await createDomain();
		const addressId = await createAddress(domainId, "me");
		await grant(user.id, addressId);
		await seedThread({
			threadId: "thr_live",
			addressId,
			unreadCount: 2,
			messageStatus: "received",
		});

		const prefs = await loadPrefs(testDb(), user.id);
		expect(await countUnread(testDb(), user.id, "owner", prefs)).toBe(2);
	});
});
