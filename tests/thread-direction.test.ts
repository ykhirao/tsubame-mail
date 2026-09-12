import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { getDb, schema } from "@/db/client";
import threadRoutes from "@/api/v1/threads";
import { ApiError } from "@/shared/errors";
import type { AppEnv } from "@/api/types";
import type { Principal } from "@/shared/contracts/common";
import { applyMigrations } from "./helpers/migrate";
import { createAddress, createDomain, createUser, db } from "./auth-helpers";

function sessionPrincipal(userId: string): Principal {
	return {
		userId,
		role: "owner",
		via: "session",
		scopes: ["read", "send", "admin"],
		addressIds: "all",
		writableAddressIds: "all",
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
	return app;
}

async function insertMessage(over: {
	id: string;
	threadId: string;
	addressId: string;
	direction: "inbound" | "outbound";
	receivedAt: number;
}) {
	await db()
		.insert(schema.messages)
		.values({
			id: over.id,
			threadId: over.threadId,
			addressId: over.addressId,
			direction: over.direction,
			status: over.direction === "inbound" ? "received" : "sent",
			fromAddr: over.direction === "inbound" ? "相手 <them@example.net>" : "me@example.test",
			toAddr: over.direction === "inbound" ? "me@example.test" : "them@example.net",
			subject: "見積もりの件",
			receivedAt: new Date(over.receivedAt),
			isRead: true,
			isStarred: false,
			hasAttachments: false,
		});
}

beforeEach(async () => {
	await applyMigrations();
});

// 自分宛に送ると同じ件名の行が受信と送信控えで 2 本並ぶ。一覧が direction を持って
// いないと、どちらがどちらか判別できなかった（B-34）。
describe("スレッド一覧の向き（lastDirection）", () => {
	it("最新が送信控えのスレッドは outbound を返す", async () => {
		const user = await createUser({ role: "owner" });
		const domainId = await createDomain();
		const addressId = await createAddress(domainId, "me");
		await db()
			.insert(schema.threads)
			.values({
				id: "thr_sent",
				addressId,
				subject: "見積もりの件",
				lastMessageAt: new Date(1_770_000_100_000),
				messageCount: 2,
				unreadCount: 0,
			});
		// 受信のあとに返信した形。一覧に出るのは最新＝送信控え。
		await insertMessage({
			id: "msg_in",
			threadId: "thr_sent",
			addressId,
			direction: "inbound",
			receivedAt: 1_770_000_000_000,
		});
		await insertMessage({
			id: "msg_out",
			threadId: "thr_sent",
			addressId,
			direction: "outbound",
			receivedAt: 1_770_000_100_000,
		});

		const app = buildApp(sessionPrincipal(user.id));
		const res = await app.request("/api/v1/threads");
		const body = (await res.json()) as { data: { id: string; lastDirection: string | null }[] };
		expect(body.data.find((t) => t.id === "thr_sent")!.lastDirection).toBe("outbound");
	});

	it("最新が受信のスレッドは inbound を返す", async () => {
		const user = await createUser({ role: "owner" });
		const domainId = await createDomain();
		const addressId = await createAddress(domainId, "me");
		await db()
			.insert(schema.threads)
			.values({
				id: "thr_recv",
				addressId,
				subject: "見積もりの件",
				lastMessageAt: new Date(1_770_000_100_000),
				messageCount: 2,
				unreadCount: 0,
			});
		await insertMessage({
			id: "msg_out2",
			threadId: "thr_recv",
			addressId,
			direction: "outbound",
			receivedAt: 1_770_000_000_000,
		});
		await insertMessage({
			id: "msg_in2",
			threadId: "thr_recv",
			addressId,
			direction: "inbound",
			receivedAt: 1_770_000_100_000,
		});

		const app = buildApp(sessionPrincipal(user.id));
		const res = await app.request("/api/v1/threads");
		const body = (await res.json()) as { data: { id: string; lastDirection: string | null }[] };
		expect(body.data.find((t) => t.id === "thr_recv")!.lastDirection).toBe("inbound");
	});
});
