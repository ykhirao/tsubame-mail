import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import notificationsRoutes, { threadNotificationRouter } from "@/api/v1/notifications";
import { ApiError } from "@/shared/errors";
import type { AppEnv } from "@/api/types";
import type { Principal } from "@/shared/contracts/common";
import { applyMigrations } from "./helpers/migrate";
import { createAddress, createDomain, createUser, db } from "./auth-helpers";

type SessionPrincipal = Omit<Principal, "via"> & { via: "session" };

function sessionPrincipal(userId: string, role: Principal["role"], addressIds: string[]): SessionPrincipal {
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
	app.route("/api/v1/me/notifications", notificationsRoutes);
	app.route("/api/v1/threads", threadNotificationRouter);
	return app;
}

function json(body: unknown) {
	return { method: "POST", body: JSON.stringify(body) };
}

async function seedOwnerWithAddresses(addressCount = 1, catchAll = false) {
	const owner = await createUser({ role: "owner" });
	const domainId = await createDomain();
	const addressId = await createAddress(domainId, "inbox");
	if (catchAll) {
		await db()
			.update(schema.addresses)
			.set({ isCatchAll: true })
			.where(eq(schema.addresses.id, addressId));
	}
	for (let i = 1; i < addressCount; i++) await createAddress(domainId, `box${i}`);
	return { owner, addressId };
}

function useCleanState() {
	afterEach(async () => {});
	beforeEach(async () => {
		await applyMigrations();
	});
}

describe("通知 API の認可（セッション限定・agent 拒否）", () => {
	useCleanState();

	it("API キー（via=api_key）は 403", async () => {
		const keyPrincipal: Principal = {
			userId: "usr_k",
			role: "owner",
			via: "api_key",
			scopes: ["read"],
			addressIds: "all",
			writableAddressIds: "all",
		};
		const app = buildApp(keyPrincipal);
		expect((await app.request("/api/v1/me/notifications")).status).toBe(403);
	});

	it("agent は 403", async () => {
		const app = buildApp(sessionPrincipal("usr_a", "agent", ["adr_1"]));
		expect((await app.request("/api/v1/me/notifications")).status).toBe(403);
	});

	it("セッションの member は通る", async () => {
		const member = await createUser({ role: "member" });
		const app = buildApp(sessionPrincipal(member.id, "member", []));
		const res = await app.request("/api/v1/me/notifications");
		expect(res.status).toBe(200);
	});
});

describe("GET /me/notifications（既定値とメールボックス一覧）", () => {
	useCleanState();

	it("設定行が無い利用者は schema の default を返す", async () => {
		const member = await createUser({ role: "member" });
		const app = buildApp(sessionPrincipal(member.id, "member", []));
		const res = await app.request("/api/v1/me/notifications");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			enabled: true,
			display: "full",
			badge: "notified",
			group_by_thread: true,
			burst_window_sec: 0,
			suppress_when_active: false,
			spam_suspicious: "drop",
			notify_send_failure: true,
			notify_catch_all: true,
		});
		expect(body.paused_until).toBeNull();
		expect(body.feed_seen_at).toBeNull();
		expect(body.quiet).toBeNull();
		expect(body.unseen_count).toBe(0);
		expect(body.mailboxes).toEqual([]);
		expect(body.rules).toEqual([]);
	});

	it("owner: 割り当てが無いメールボックスは既定 off、キャッチオールは notify_catch_all に従う", async () => {
		const owner = await createUser({ role: "owner" });
		const domainId = await createDomain();
		const catchAllId = await createAddress(domainId, "catch");
		await db().update(schema.addresses).set({ isCatchAll: true }).where(eq(schema.addresses.id, catchAllId));
		await createAddress(domainId, "plain");
		const app = buildApp({ ...sessionPrincipal(owner.id, "owner", []), addressIds: "all", writableAddressIds: "all" });
		const res = await app.request("/api/v1/me/notifications");
		const body = (await res.json()) as { mailboxes: { isCatchAll: boolean; level: string; assigned: boolean }[] };
		expect(body.mailboxes).toHaveLength(2);
		const catchAll = body.mailboxes.find((m) => m.isCatchAll)!;
		expect(catchAll.level).toBe("all");
		expect(catchAll.assigned).toBe(true);
		const plain = body.mailboxes.find((m) => !m.isCatchAll)!;
		expect(plain.level).toBe("off");
		expect(plain.assigned).toBe(false);
	});

	it("owner: notify_catch_all=false のとき catch-all は既定 off", async () => {
		const owner = await createUser({ role: "owner" });
		const domainId = await createDomain();
		const catchAllId = await createAddress(domainId, "catch");
		await db().update(schema.addresses).set({ isCatchAll: true }).where(eq(schema.addresses.id, catchAllId));
		const app = buildApp({ ...sessionPrincipal(owner.id, "owner", []), addressIds: "all", writableAddressIds: "all" });
		await app.request("/api/v1/me/notifications", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ notify_catch_all: false }),
		});
		const res = await app.request("/api/v1/me/notifications");
		const body = (await res.json()) as { mailboxes: { isCatchAll: boolean; level: string }[] };
		expect(body.mailboxes.find((m) => m.isCatchAll)!.level).toBe("off");
	});
});

describe("PATCH /me/notifications（プリセット）", () => {
	useCleanState();

	it("preset=important は全メールボックスを direct にし、返信ルールを 1 つ作る", async () => {
		const { owner, addressId } = await seedOwnerWithAddresses(1);
		const app = buildApp({ ...sessionPrincipal(owner.id, "owner", []), addressIds: "all", writableAddressIds: "all" });
		const res = await app.request("/api/v1/me/notifications", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ preset: "important" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			mailboxes: { id: string; level: string }[];
			rules: { name: string; action: string; matcher: Record<string, unknown> }[];
			enabled: boolean;
		};
		expect(body.mailboxes).toHaveLength(1);
		expect(body.mailboxes[0]!.id).toBe(addressId);
		expect(body.mailboxes[0]!.level).toBe("direct");
		expect(body.rules).toHaveLength(1);
		expect(body.rules[0]!.matcher).toEqual({ replyToOwn: true });
		expect(body.enabled).toBe(true);
	});

	it("preset=all は全メールボックスを all にする", async () => {
		const { owner } = await seedOwnerWithAddresses(1);
		const app = buildApp({ ...sessionPrincipal(owner.id, "owner", []), addressIds: "all", writableAddressIds: "all" });
		const res = await app.request("/api/v1/me/notifications", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ preset: "all" }),
		});
		const body = (await res.json()) as { mailboxes: { level: string }[] };
		expect(body.mailboxes[0]!.level).toBe("all");
	});
});

describe("メールボックスのレベル PUT", () => {
	useCleanState();

	it("見られるアドレスのみ変更でき、権限外は 403", async () => {
		const member = await createUser({ role: "member" });
		const domainId = await createDomain();
		const mine = await createAddress(domainId, "mine");
		const app = buildApp(sessionPrincipal(member.id, "member", [mine]));

		const ok = await app.request(`/api/v1/me/notifications/mailboxes/${mine}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ level: "off" }),
		});
		expect(ok.status).toBe(200);

		const res = await app.request("/api/v1/me/notifications/mailboxes/adr_notyours", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ level: "all" }),
		});
		expect(res.status).toBe(403);

		const settings = (await (await app.request("/api/v1/me/notifications")).json()) as {
			mailboxes: { id: string; level: string }[];
		};
		expect(settings.mailboxes.find((m) => m.id === mine)!.level).toBe("off");
	});
});

describe("通知ルール CRUD と並べ替え", () => {
	useCleanState();

	it("作成 → 一覧 → 更新 → 削除 / reorder", async () => {
		const member = await createUser({ role: "member" });
		const app = buildApp(sessionPrincipal(member.id, "member", []));

		const created = (await (
			await app.request("/api/v1/me/notifications/rules", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "ニュースレター", matcher: { from: "news@x.example" }, action: "never" }),
			})
		).json()) as { id: string; priority: number };
		expect(created.id).toMatch(/^nrl_/);
		expect(created.priority).toBe(0);

		const second = (await (
			await app.request("/api/v1/me/notifications/rules", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "大事", matcher: { subject: "至急" }, action: "always" }),
			})
		).json()) as { id: string; priority: number };
		expect(second.priority).toBe(1);

		// 並べ替え: second を先頭に
		await app.request("/api/v1/me/notifications/rules/reorder", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ids: [second.id, created.id] }),
		});
		const list = (await (await app.request("/api/v1/me/notifications/rules")).json()) as {
			data: { id: string; priority: number }[];
		};
		expect(list.data.map((r) => r.id)).toEqual([second.id, created.id]);

		await app.request(`/api/v1/me/notifications/rules/${created.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		const after = (await (await app.request("/api/v1/me/notifications/rules")).json()) as {
			data: { id: string; enabled: boolean }[];
		};
		expect(after.data.find((r) => r.id === created.id)!.enabled).toBe(false);

		expect(
			(await app.request(`/api/v1/me/notifications/rules/${created.id}`, { method: "DELETE" })).status,
		).toBe(204);
		const afterDel = (await (await app.request("/api/v1/me/notifications/rules")).json()) as {
			data: { id: string }[];
		};
		expect(afterDel.data.map((r) => r.id)).toEqual([second.id]);
	});
});

describe("dry-run と通知欄 feed", () => {
	useCleanState();

	async function seedLog(owner: { id: string }, n: number) {
		const d = db();
		const rows: typeof schema.notificationLog.$inferInsert[] = [];
		for (let i = 0; i < n; i++) {
			rows.push({
				id: `ntf_${i}`,
				userId: owner.id,
				decision: i === 0 ? "sent" : "held",
				reason: i === 0 ? "mailbox_level" : "paused",
				holdGroup: i === 0 ? null : "h1",
				createdAt: new Date(1_700_000_000_000 + i * 1000),
			});
		}
		await d.insert(schema.notificationLog).values(rows);
	}

	it("dry-run は body が空でも今の設定で判定する", async () => {
		const { owner } = await seedOwnerWithAddresses(1);
		const app = buildApp({ ...sessionPrincipal(owner.id, "owner", []), addressIds: "all", writableAddressIds: "all" });
		const res = await app.request("/api/v1/me/notifications/dry-run", { method: "POST", headers: { "content-type": "application/json" }, body: "" });
		// body 空でも 200
		expect(res.status).toBe(200);
	});

	it("feed は束にまとめる（held 同 hold_group）+ include_dropped", async () => {
		const member = await createUser({ role: "member" });
		await seedLog(member, 5);
		await db()
			.insert(schema.notificationLog)
			.values({
				id: "ntf_dropped",
				userId: member.id,
				decision: "dropped",
				reason: "thread_muted",
				createdAt: new Date(1_800_000_000_000),
			});
		const app = buildApp(sessionPrincipal(member.id, "member", []));

		const defaultFeed = (await (await app.request("/api/v1/me/notifications/feed")).json()) as {
			data: ({ type: string; decision: string; count?: number })[];
		};
		expect(defaultFeed.data.some((d) => d.type === "bundle")).toBe(true);
		const bundle = defaultFeed.data.find((d) => d.type === "bundle")!;
		expect(bundle.count).toBe(4);
		// dropped は既定では含まれない
		expect(defaultFeed.data.some((d) => (d as { reason?: string }).reason === "thread_muted")).toBe(false);

		const withDropped = (await (
			await app.request("/api/v1/me/notifications/feed?include_dropped=1")
		).json()) as { data: ({ reason?: string }[]) };
		expect(withDropped.data.some((d) => d.reason === "thread_muted")).toBe(true);
	});

	it("feed/seen は feed_seen_at を更新し、GET の unseen_count を 0 にする", async () => {
		const member = await createUser({ role: "member" });
		await seedLog(member, 3);
		const app = buildApp(sessionPrincipal(member.id, "member", []));

		const before = (await (await app.request("/api/v1/me/notifications")).json()) as { unseen_count: number };
		expect(before.unseen_count).toBe(3);

		await app.request("/api/v1/me/notifications/feed/seen", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		const after = (await (await app.request("/api/v1/me/notifications")).json()) as { unseen_count: number; feed_seen_at: number | null };
		expect(after.unseen_count).toBe(0);
		expect(after.feed_seen_at).not.toBeNull();
	});
});

describe("会話のフォロー / ミュート", () => {
	useCleanState();

	it("PUT で follow / mute を設定し、DELETE で解除する", async () => {
		const { owner, addressId } = await seedOwnerWithAddresses(1);
		const threadId = "thr_t1";
		await db().insert(schema.threads).values({
			id: threadId,
			addressId,
			subject: "打ち合わせ",
			lastMessageAt: new Date(),
		});
		const app = buildApp({ ...sessionPrincipal(owner.id, "owner", []), addressIds: "all", writableAddressIds: "all" });

		const put = await app.request(`/api/v1/threads/${threadId}/notification`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "follow" }),
		});
		expect(put.status).toBe(200);
		const row = await db()
			.select()
			.from(schema.threadNotificationPrefs)
			.where(eq(schema.threadNotificationPrefs.threadId, threadId))
			.get();
		expect(row!.mode).toBe("follow");

		expect((await app.request(`/api/v1/threads/${threadId}/notification`, { method: "DELETE" })).status).toBe(204);
		const after = await db()
			.select()
			.from(schema.threadNotificationPrefs)
			.where(eq(schema.threadNotificationPrefs.threadId, threadId))
			.get();
		expect(after).toBeUndefined();
	});

	it("見えないスレッドは 404", async () => {
		const member = await createUser({ role: "member" });
		const app = buildApp(sessionPrincipal(member.id, "member", []));
		const res = await app.request("/api/v1/threads/thr_ghost/notification", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "mute" }),
		});
		expect(res.status).toBe(404);
	});
});
