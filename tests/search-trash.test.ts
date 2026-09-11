import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import messagesRoutes from "@/api/v1/messages";
import threadsRoutes from "@/api/v1/threads";
import { createAddress, createDomain, db } from "./auth-helpers";
import { callJson, memberPrincipal, mountRouter } from "./domains-helpers";
import type { Principal } from "@/shared/contracts/common";
import { queryMessages } from "@/domain/search/sql";

async function wipe() {
	const d = db();
	await d.delete(schema.auditLogs);
	await d.delete(schema.sessions);
	await d.delete(schema.apiKeys);
	await d.delete(schema.addressGrants);
	await d.delete(schema.messages);
	await d.delete(schema.attachments);
	await d.delete(schema.threads);
	await d.delete(schema.addresses);
	await d.delete(schema.domains);
	await d.delete(schema.users);
}

beforeEach(wipe);

// drop ルールでゴミ箱入りしたメッセージと、普通のスレッドを用意する共通の土台。
async function seed(aid: string) {
	await db().insert(schema.threads).values([
		{
			id: "thr_good",
			addressId: aid,
			subject: "普通のメール",
			lastMessageAt: new Date(1_770_000_100_000),
			messageCount: 1,
			unreadCount: 0,
		},
		{
			id: "thr_trash",
			addressId: aid,
			subject: "宣伝",
			lastMessageAt: new Date(1_770_000_200_000),
			messageCount: 1,
			unreadCount: 0,
		},
	]);
	await db().insert(schema.messages).values([
		{
			id: "msg_good",
			threadId: "thr_good",
			addressId: aid,
			direction: "inbound",
			status: "received",
			fromAddr: "friend@example.test",
			toAddr: "a@trash.test",
			subject: "普通のメール",
			textBody: "普通のメール",
			receivedAt: new Date(1_770_000_100_000),
			isRead: false,
			isStarred: false,
			hasAttachments: false,
		},
		{
			id: "msg_trash",
			threadId: "thr_trash",
			addressId: aid,
			direction: "inbound",
			status: "trash",
			fromAddr: "spam@evil.jp",
			toAddr: "a@trash.test",
			subject: "宣伝",
			textBody: "宣伝 本文",
			receivedAt: new Date(1_770_000_200_000),
			isRead: false,
			isStarred: false,
			hasAttachments: false,
		},
	]);
}

async function seedOnce(): Promise<{ aid: string; msgApp: ReturnType<typeof mountRouter>; thrApp: ReturnType<typeof mountRouter>; p: Principal }> {
	const d = await createDomain("trash.test");
	const aid = await createAddress(d, "a", "trash.test");
	await seed(aid);
	const p: Principal = { ...memberPrincipal([aid], [aid]), scopes: ["read", "send"] };
	return {
		aid,
		msgApp: mountRouter("/", messagesRoutes, p),
		thrApp: mountRouter("/", threadsRoutes, p),
		p,
	};
}

describe("#116 drop で trash になった行を API は既定で出さない", () => {
	it("GET /messages は既定で trash を除き、status=trash で trash だけ返す", async () => {
		const { msgApp } = await seedOnce();
		const list = await callJson(msgApp, "/");
		expect(list.status).toBe(200);
		expect(list.json.data.map((m: { id: string }) => m.id)).toContain("msg_good");
		expect(list.json.data.map((m: { id: string }) => m.id)).not.toContain("msg_trash");

		const trashOnly = await callJson(msgApp, "/?status=trash");
		expect(trashOnly.status).toBe(200);
		expect(trashOnly.json.data.map((m: { id: string }) => m.id)).toEqual(["msg_trash"]);
	});

	it("GET /messages?q= も既定で trash を除き、本文は読めない", async () => {
		const { msgApp } = await seedOnce();
		const search = await callJson(msgApp, `/?q=${encodeURIComponent("宣伝")}`);
		expect(search.status).toBe(200);
		expect(search.json.data).toEqual([]);

		const withTrash = await callJson(msgApp, `/?q=${encodeURIComponent("宣伝")}&status=trash`);
		expect(withTrash.status).toBe(200);
		expect(withTrash.json.data.map((m: { id: string }) => m.id)).toEqual(["msg_trash"]);
	});

	it("GET /messages/:id は既定で 404、includeTrash=true で読める", async () => {
		const { msgApp } = await seedOnce();
		const hidden = await callJson(msgApp, "/msg_trash");
		expect(hidden.status).toBe(404);

		const shown = await callJson(msgApp, "/msg_trash?includeTrash=true");
		expect(shown.status).toBe(200);
		expect(shown.json.id).toBe("msg_trash");
	});

	it("GET /threads/:id は全件 trash のスレッドを既定で 404、includeTrash=true で中身が見える", async () => {
		const { thrApp } = await seedOnce();
		const hidden = await callJson(thrApp, "/thr_trash");
		expect(hidden.status).toBe(404);

		const shown = await callJson(thrApp, "/thr_trash?includeTrash=true");
		expect(shown.status).toBe(200);
		expect(shown.json.messages.map((m: { id: string }) => m.id)).toEqual(["msg_trash"]);

		const good = await callJson(thrApp, "/thr_good");
		expect(good.status).toBe(200);
		expect(good.json.messages.map((m: { id: string }) => m.id)).toEqual(["msg_good"]);
	});

	it("trash のメッセージの既読 PATCH とゴミ箱からの復元 PATCH が 200", async () => {
		const { msgApp } = await seedOnce();
		const markRead = await callJson(msgApp, "/msg_trash", {
			method: "PATCH",
			body: JSON.stringify({ isRead: true }),
		});
		expect(markRead.status).toBe(200);

		const restore = await callJson(msgApp, "/msg_trash", {
			method: "PATCH",
			body: JSON.stringify({ status: "received" }),
		});
		expect(restore.status).toBe(200);
		expect(restore.json.status).toBe("received");
	});
});

describe("#116 queryMessages も既定で trash を除く", () => {
	it("status 未指定では trash が出ず、status=trash で trash だけ出る", async () => {
		const { aid, p } = await seedOnce();
		const all = await queryMessages(db(), { principal: p, filters: { search: { freeWords: [] } }, order: "received_at", limit: 25 });
		expect(all.rows.map((m) => m.id)).toContain("msg_good");
		expect(all.rows.map((m) => m.id)).not.toContain("msg_trash");

		const only = await queryMessages(db(), { principal: p, filters: { search: { freeWords: [] }, status: "trash" }, order: "received_at", limit: 25 });
		expect(only.rows.map((m) => m.id)).toEqual(["msg_trash"]);
	});
});
