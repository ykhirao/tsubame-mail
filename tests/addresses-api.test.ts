import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import addressRoutes from "@/api/v1/addresses";
import { addresses, auditLogs, domains, messages } from "@/db/schema";
import { newId } from "@/lib/id";
import type { Principal } from "@/shared/contracts/common";
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

	describe("PATCH /:id/signature", () => {
		async function seedMailbox(): Promise<string> {
			const db = getTestDb();
			const domainId = newId("domain");
			const name = `sig-${domainId.slice(-6)}.test`;
			await db.insert(domains).values({
				id: domainId,
				name,
				zoneId: `zone-${domainId}`,
				zoneName: name,
				mode: "subdomain",
			});
			const addressId = newId("address");
			await db.insert(addresses).values({
				id: addressId,
				domainId,
				localPart: "info",
				address: `info@${name}`,
			});
			return addressId;
		}

		function writer(ids: string[]): Principal {
			return {
				userId: "usr_member",
				role: "member",
				via: "session",
				scopes: ["read", "send", "admin"],
				addressIds: ids,
				writableAddressIds: ids,
			};
		}

		async function countAudits(action: string): Promise<number> {
			const db = getTestDb();
			const rows = await db
				.select({ id: auditLogs.id })
				.from(auditLogs)
				.where(eq(auditLogs.action, action));
			return rows.length;
		}

		it("write 権限の member が変えられ、監査ログに 1 行残る", async () => {
			const id = await seedMailbox();
			const app = mountRouter("/", addressRoutes, writer([id]));

			const res = await callJson(app, `/${id}/signature`, {
				method: "PATCH",
				body: JSON.stringify({ signature: "よろしくお願いします" }),
			});

			expect(res.status).toBe(200);
			expect(res.json.data.signature).toBe("よろしくお願いします");
			const row = await getTestDb().query.addresses.findFirst({ where: eq(addresses.id, id) });
			expect(row?.signature).toBe("よろしくお願いします");
			expect(await countAudits("address.signature")).toBe(1);
		});

		it("空文字は null として保存され、署名本文は監査ログに入らない", async () => {
			const id = await seedMailbox();
			const app = mountRouter("/", addressRoutes, writer([id]));

			const res = await callJson(app, `/${id}/signature`, {
				method: "PATCH",
				body: JSON.stringify({ signature: "" }),
			});

			expect(res.status).toBe(200);
			expect(res.json.data.signature).toBeNull();
			const row = await getTestDb().query.addresses.findFirst({ where: eq(addresses.id, id) });
			expect(row?.signature).toBeNull();

			const audit = await getTestDb().query.auditLogs.findFirst({
				where: and(
					eq(auditLogs.action, "address.signature"),
					eq(auditLogs.targetId, id),
				),
			});
			expect(audit?.meta).toMatchObject({
				before: 0,
				after: 0,
			});
			expect((audit?.meta as { address?: string }).address).toMatch(/^info@/);
			expect(JSON.stringify(audit?.meta)).not.toContain("よろしく");
		});

		it("read だけの member は 403", async () => {
			const id = await seedMailbox();
			const principal: Principal = {
				userId: "usr_member",
				role: "member",
				via: "session",
				scopes: ["read", "send", "admin"],
				addressIds: [id],
				writableAddressIds: [],
			};
			const app = mountRouter("/", addressRoutes, principal);

			const res = await callJson(app, `/${id}/signature`, {
				method: "PATCH",
				body: JSON.stringify({ signature: "x" }),
			});

			expect(res.status).toBe(403);
			expect(res.json.error.message).toBe("このメールボックスの署名を変える権限がありません");
		});

		it("見えないアドレスは 404", async () => {
			const id = await seedMailbox();
			const principal: Principal = {
				userId: "usr_member",
				role: "member",
				via: "session",
				scopes: ["read", "send", "admin"],
				addressIds: ["adr_other"],
				writableAddressIds: ["adr_other"],
			};
			const app = mountRouter("/", addressRoutes, principal);

			const res = await callJson(app, `/${id}/signature`, {
				method: "PATCH",
				body: JSON.stringify({ signature: "x" }),
			});
			expect(res.status).toBe(404);
		});

		it("owner は変えられる", async () => {
			const id = await seedMailbox();
			const app = mountRouter("/", addressRoutes, ownerPrincipal);

			const res = await callJson(app, `/${id}/signature`, {
				method: "PATCH",
				body: JSON.stringify({ signature: "オーナーの署名" }),
			});

			expect(res.status).toBe(200);
			const row = await getTestDb().query.addresses.findFirst({ where: eq(addresses.id, id) });
			expect(row?.signature).toBe("オーナーの署名");
		});

		it("2001 文字は 400", async () => {
			const id = await seedMailbox();
			const app = mountRouter("/", addressRoutes, ownerPrincipal);

			const res = await callJson(app, `/${id}/signature`, {
				method: "PATCH",
				body: JSON.stringify({ signature: "あ".repeat(2001) }),
			});
			expect(res.status).toBe(400);
		});

		it("send スコープのキー（write 権限の agent など）でも 403（#143）", async () => {
			const id = await seedMailbox();
			const agentKey: Principal = {
				userId: "usr_agent",
				role: "agent",
				via: "api_key",
				scopes: ["read", "send"],
				addressIds: [id],
				writableAddressIds: [id],
			};
			const app = mountRouter("/", addressRoutes, agentKey);
			const before = await countAudits("address.signature");
			const res = await callJson(app, `/${id}/signature`, {
				method: "PATCH",
				body: JSON.stringify({ signature: "https://evil.example/login" }),
			});
			expect(res.status).toBe(403);
			expect(await countAudits("address.signature")).toBe(before);
		});

		it("read スコープだけのキーと未認証は 403 / 401", async () => {
			const ownerId = await seedMailbox();
			const reader: Principal = {
				userId: "usr_member",
				role: "member",
				via: "api_key",
				scopes: ["read"],
				addressIds: [ownerId],
				writableAddressIds: [ownerId],
			};
			const app = mountRouter("/", addressRoutes, reader);
			const res = await callJson(app, `/${ownerId}/signature`, {
				method: "PATCH",
				body: JSON.stringify({ signature: "x" }),
			});
			expect(res.status).toBe(403);

			const anon = mountRouter("/", addressRoutes, null);
			const res2 = await callJson(anon, `/${ownerId}/signature`, {
				method: "PATCH",
				body: JSON.stringify({ signature: "x" }),
			});
			expect(res2.status).toBe(401);
		});

		it("アーカイブ済みは 409", async () => {
			const db = getTestDb();
			const domainId = newId("domain");
			const name = `sig-arch-${domainId.slice(-6)}.test`;
			await db.insert(domains).values({
				id: domainId,
				name,
				zoneId: `zone-arch-${domainId}`,
				zoneName: name,
				mode: "subdomain",
			});
			const addressId = newId("address");
			await db.insert(addresses).values({
				id: addressId,
				domainId,
				localPart: "gone",
				address: "gone@sig-arch.test",
				archivedAt: new Date(),
			});
			const app = mountRouter("/", addressRoutes, ownerPrincipal);
			const res = await callJson(app, `/${addressId}/signature`, {
				method: "PATCH",
				body: JSON.stringify({ signature: "x" }),
			});
			expect(res.status).toBe(409);
		});
	});
});
