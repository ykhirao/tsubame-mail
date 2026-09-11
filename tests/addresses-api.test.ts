import { beforeAll, describe, expect, it } from "vitest";
import addressRoutes from "@/api/v1/addresses";
import { addresses, domains, messages } from "@/db/schema";
import { newId } from "@/lib/id";
import { applyMigrations, callJson, getTestDb, mountRouter, ownerPrincipal } from "./domains-helpers";

beforeAll(async () => {
	await applyMigrations();
});

async function seedManyAddresses(n: number): Promise<void> {
	const db = getTestDb();
	const domainId = newId("domain");
	await db.insert(domains).values({
		id: domainId,
		name: "many.test",
		zoneId: "zone",
		zoneName: "many.test",
		mode: "subdomain",
	});
	for (let i = 0; i < n; i++) {
		await db.insert(addresses).values({
			id: newId("address"),
			domainId,
			localPart: `user${i}`,
			address: `user${i}@many.test`,
		});
	}
}

describe("GET /addresses の一覧（#32: 未読集計の inArray がアドレス数に比例する）", () => {
	it("見えるアドレスが 120 件（限度の 99 件超）でも 500 にならない", async () => {
		await seedManyAddresses(120);
		const app = mountRouter("/", addressRoutes, ownerPrincipal);

		const res = await callJson(app, "/?limit=120");

		expect(res.status).toBe(200);
		expect(res.json.data.length).toBe(120);
		for (const row of res.json.data) expect(row.unreadCount).toBe(0);
	});

	it("既定の limit（100）でも 500 にならない", async () => {
		const app = mountRouter("/", addressRoutes, ownerPrincipal);

		const res = await callJson(app, "/");

		expect(res.status).toBe(200);
		expect(res.json.data.length).toBe(100);
	});

	it("相関サブクエリに変えても未読件数は正しい（既読・trash を数えない）", async () => {
		const db = getTestDb();
		const domainId = newId("domain");
		await db.insert(domains).values({
			id: domainId,
			name: "unread.test",
			zoneId: "zone2",
			zoneName: "unread.test",
			mode: "subdomain",
		});
		const addressId = newId("address");
		await db.insert(addresses).values({
			id: addressId,
			domainId,
			localPart: "inbox",
			address: "inbox@unread.test",
		});
		const insertMessage = (isRead: boolean, status: "received" | "trash") =>
			db.insert(messages).values({
				id: newId("message"),
				addressId,
				direction: "inbound",
				status,
				isRead,
				fromAddr: "a@b.test",
				toAddr: "inbox@unread.test",
				subject: "s",
				receivedAt: new Date(),
			});
		await insertMessage(false, "received");
		await insertMessage(false, "received");
		await insertMessage(true, "received");
		await insertMessage(false, "trash");

		const app = mountRouter("/", addressRoutes, ownerPrincipal);
		const res = await callJson(app, "/?limit=200");

		expect(res.status).toBe(200);
		const row = res.json.data.find((a: { id: string }) => a.id === addressId);
		expect(row.unreadCount).toBe(2);
	});
});
