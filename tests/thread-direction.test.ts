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

	// 一覧のスターと「まとめて操作」は、この id があるから会話の全文を取らずに済む。
	it("最新のメールの id を返す", async () => {
		const user = await createUser({ role: "owner" });
		const domainId = await createDomain();
		const addressId = await createAddress(domainId, "me");
		await db()
			.insert(schema.threads)
			.values({
				id: "thr_last",
				addressId,
				subject: "見積もりの件",
				lastMessageAt: new Date(1_770_000_100_000),
				messageCount: 2,
				unreadCount: 0,
			});
		await insertMessage({
			id: "msg_older",
			threadId: "thr_last",
			addressId,
			direction: "inbound",
			receivedAt: 1_770_000_000_000,
		});
		await insertMessage({
			id: "msg_newest",
			threadId: "thr_last",
			addressId,
			direction: "inbound",
			receivedAt: 1_770_000_100_000,
		});

		const app = buildApp(sessionPrincipal(user.id));
		const res = await app.request("/api/v1/threads");
		const body = (await res.json()) as { data: { id: string; lastMessageId: string | null }[] };
		expect(body.data.find((t) => t.id === "thr_last")!.lastMessageId).toBe("msg_newest");
	});

	// 添付は 1 件ずつ引くと 200 往復になるのでまとめて 1 本にした（jsonIdsIn）。
	// まとめる以上、どの添付がどのメッセージのものかを取り違えないことを押さえる。
	it("会話の詳細で、添付が正しいメッセージに割り振られる", async () => {
		const user = await createUser({ role: "owner" });
		const domainId = await createDomain();
		const addressId = await createAddress(domainId, "me");
		await db()
			.insert(schema.threads)
			.values({
				id: "thr_att",
				addressId,
				subject: "資料です",
				lastMessageAt: new Date(1_770_000_100_000),
				messageCount: 2,
				unreadCount: 0,
			});
		await insertMessage({
			id: "msg_a",
			threadId: "thr_att",
			addressId,
			direction: "inbound",
			receivedAt: 1_770_000_000_000,
		});
		await insertMessage({
			id: "msg_b",
			threadId: "thr_att",
			addressId,
			direction: "inbound",
			receivedAt: 1_770_000_100_000,
		});
		// msg_a に 2 件、msg_b に 1 件。添付ゼロのメッセージも混ぜる意味で msg_b は 1 件だけ。
		for (const [id, messageId, filename] of [
			["att_1", "msg_a", "a1.pdf"],
			["att_2", "msg_a", "a2.pdf"],
			["att_3", "msg_b", "b1.pdf"],
		] as const) {
			await db().insert(schema.attachments).values({
				id,
				messageId,
				filename,
				contentType: "application/pdf",
				sizeBytes: 10,
				isInline: false,
				r2Key: `att/${id}`,
			});
		}

		const app = buildApp(sessionPrincipal(user.id));
		const res = await app.request("/api/v1/threads/thr_att");
		const body = (await res.json()) as {
			messages: { id: string; attachments: { filename: string }[] }[];
		};
		const a = body.messages.find((m) => m.id === "msg_a")!;
		const b = body.messages.find((m) => m.id === "msg_b")!;
		expect(a.attachments.map((x) => x.filename)).toEqual(["a1.pdf", "a2.pdf"]);
		expect(b.attachments.map((x) => x.filename)).toEqual(["b1.pdf"]);
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
