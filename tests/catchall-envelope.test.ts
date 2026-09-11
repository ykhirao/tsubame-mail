import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import threadRoutes from "@/api/v1/threads";
import messageRoutes from "@/api/v1/messages";
import { ApiError } from "@/shared/errors";
import type { AppEnv } from "@/api/types";
import type { Principal } from "@/shared/contracts/common";
import { applyMigrations } from "./helpers/migrate";
import { createAddress, createDomain, createUser, db } from "./auth-helpers";

function sessionPrincipal(
	userId: string,
	role: Principal["role"],
	addressIds: string[] | "all",
): Principal {
	return {
		userId,
		role,
		via: "session",
		scopes: ["read", "send", "admin"],
		addressIds,
		writableAddressIds: addressIds,
		sessionId: "ses_test",
	};
}

function buildApp(principal: Principal) {
	const app = new Hono<AppEnv>();
	app.onError((err, c) =>
		err instanceof ApiError ? c.json(err.toJSON(), err.status as 400) : c.text("boom", 500),
	);
	app.use("*", async (c, next) => {
		c.set("db", getDb(env as unknown as CloudflareEnv));
		c.set("principal", principal);
		c.set("requestId", "test");
		await next();
	});
	app.route("/api/v1/threads", threadRoutes);
	app.route("/api/v1/messages", messageRoutes);
	return app;
}

async function seed() {
	const user = await createUser({ role: "owner" });
	const domainId = await createDomain();
	const catchAllId = await createAddress(domainId, "catch");
	await db()
		.update(schema.addresses)
		.set({ isCatchAll: true })
		.where(eq(schema.addresses.id, catchAllId));
	const plainId = await createAddress(domainId, "info");
	await db()
		.insert(schema.threads)
		.values({
			id: "thr_catch",
			addressId: catchAllId,
			subject: "応募について",
			lastMessageAt: new Date(1_770_000_200_000),
			messageCount: 2,
			unreadCount: 2,
		});
	await db()
		.insert(schema.threads)
		.values({
			id: "thr_plain",
			addressId: plainId,
			subject: "お知らせ",
			lastMessageAt: new Date(1_770_000_300_000),
			messageCount: 1,
			unreadCount: 0,
		});
	return { user, catchAllId, plainId };
}

async function insertMessage(over: {
	id: string;
	threadId: string;
	addressId: string;
	direction: "inbound" | "outbound";
	envelopeTo?: string | null;
	receivedAt?: number;
}) {
	await db()
		.insert(schema.messages)
		.values({
			id: over.id,
			threadId: over.threadId,
			addressId: over.addressId,
			direction: over.direction,
			status: over.direction === "inbound" ? "received" : "sent",
			fromAddr: over.direction === "inbound" ? "応募者 <apply@example.net>" : "catch@example.test",
			toAddr: "catch@example.test",
			subject: "志望動機を添えます",
			envelopeTo: over.envelopeTo ?? null,
			receivedAt: new Date(over.receivedAt ?? 1_770_000_000_000),
			isRead: false,
			isStarred: false,
			hasAttachments: false,
		});
}

beforeEach(async () => {
	await applyMigrations();
});

describe("キャッチオールの本来の宛先（envelopeTo）", () => {
	it("スレッド一覧は最新の受信メッセージの envelopeTo を載せる", async () => {
		const { user, catchAllId } = await seed();
		await insertMessage({
			id: "msg_old",
			threadId: "thr_catch",
			addressId: catchAllId,
			direction: "inbound",
			envelopeTo: "old@example.com",
			receivedAt: 1_770_000_000_000,
		});
		await insertMessage({
			id: "msg_new",
			threadId: "thr_catch",
			addressId: catchAllId,
			direction: "inbound",
			envelopeTo: "recruit@example.com",
			receivedAt: 1_770_000_100_000,
		});
		const app = buildApp(sessionPrincipal(user.id, "owner", "all"));
		const res = await app.request("/api/v1/threads");
		const body = (await res.json()) as {
			data: { id: string; envelopeTo: string | null }[];
		};
		const item = body.data.find((t) => t.id === "thr_catch")!;
		expect(item.envelopeTo).toBe("recruit@example.com");
	});

	it("スレッド詳細の各受信メッセージに envelopeTo を載せ、送信メッセージは null のまま", async () => {
		const { user, catchAllId } = await seed();
		await insertMessage({
			id: "msg_in",
			threadId: "thr_catch",
			addressId: catchAllId,
			direction: "inbound",
			envelopeTo: "recruit@example.com",
		});
		await insertMessage({
			id: "msg_out",
			threadId: "thr_catch",
			addressId: catchAllId,
			direction: "outbound",
		});
		const app = buildApp(sessionPrincipal(user.id, "owner", "all"));
		const res = await app.request("/api/v1/threads/thr_catch");
		const body = (await res.json()) as {
			messages: { id: string; envelopeTo: string | null }[];
		};
		expect(body.messages.find((m) => m.id === "msg_in")!.envelopeTo).toBe("recruit@example.com");
		expect(body.messages.find((m) => m.id === "msg_out")!.envelopeTo).toBeNull();
	});

	it("メッセージ詳細に envelopeTo を載せる", async () => {
		const { user, catchAllId } = await seed();
		await insertMessage({
			id: "msg_d",
			threadId: "thr_catch",
			addressId: catchAllId,
			direction: "inbound",
			envelopeTo: "recruit@example.com",
		});
		const app = buildApp(sessionPrincipal(user.id, "owner", "all"));
		const res = await app.request("/api/v1/messages/msg_d");
		const body = (await res.json()) as { envelopeTo: string | null };
		expect(body.envelopeTo).toBe("recruit@example.com");
	});

	it("見られないアドレスのメッセージは従来どおり見えない（404）", async () => {
		const { user, catchAllId, plainId } = await seed();
		await insertMessage({
			id: "msg_a",
			threadId: "thr_catch",
			addressId: catchAllId,
			direction: "inbound",
			envelopeTo: "recruit@example.com",
		});
		await insertMessage({
			id: "msg_plain",
			threadId: "thr_plain",
			addressId: plainId,
			direction: "inbound",
		});
		// catchAllId しか見られない利用者が、plain のメッセージを引いても null→404。
		const app = buildApp(sessionPrincipal(user.id, "owner", [catchAllId]));
		expect((await app.request("/api/v1/messages/msg_plain")).status).toBe(404);
		expect((await app.request("/api/v1/threads/thr_plain")).status).toBe(404);
		const list = (await (await app.request("/api/v1/threads")).json()) as {
			data: { id: string }[];
		};
		expect(list.data.map((t) => t.id)).not.toContain("thr_plain");
	});
});
