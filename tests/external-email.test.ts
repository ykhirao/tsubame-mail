import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb, schema } from "@/db/client";
import { newId } from "@/lib/id";
import { ApiError } from "@/shared/errors";
import authRoutes from "@/api/v1/auth";
import externalEmailRoutes from "@/api/v1/admin/external-email";
import {
	buildTestApp,
	createAddress,
	createApiKeyFor,
	createDomain,
	createUser,
	db,
	json,
	request,
	resetDb,
	sessionCookie,
} from "./auth-helpers";
import type { AppEnv } from "@/api/types";

const app = buildTestApp();

beforeEach(resetDb);

const PASSWORD = "correct-horse-1234";

type Sent = { from: string; to: string; raw: string };

function emailCapture() {
	const sent: Sent[] = [];
	return {
		sent,
		email: {
			async send(message: any) {
				const raw = message["EmailMessage::raw"] ?? message.raw;
				sent.push({ from: message.from, to: message.to, raw: String(raw) });
				return { messageId: `captured-${sent.length}` };
			},
		},
	};
}

async function ownerCookie() {
	const res = await request(
		app,
		"/api/v1/auth/bootstrap",
		json({
			email: "owner@x.test",
			name: "オーナー",
			password: PASSWORD,
			secret: "vitest-fixture-internal-secret-9f8e7d6c",
		}),
	);
	expect(res.status).toBe(201);
	return sessionCookie(res);
}

async function loginCookie(email: string) {
	const res = await request(app, "/api/v1/auth/login", json({ email, password: PASSWORD }));
	expect(res.status).toBe(200);
	return sessionCookie(res);
}

/** 送信が有効なドメインに 1 つメールボックスを置く。確認メールの差出人として使われる。 */
async function seedSender() {
	const id = newId("domain");
	const name = `${id.slice(0, 8)}.send.test`;
	await db()
		.insert(schema.domains)
		.values({ id, name, zoneId: "z", zoneName: name, mode: "subdomain", routingStatus: "active", sendingStatus: "active" });
	await db()
		.insert(schema.addresses)
		.values({ id: newId("address"), domainId: id, localPart: "sender", address: `sender@${name}`, kind: "mailbox" });
}

function setExternal(cookie: string, email: string, env?: { email: any; sent: Sent[] }) {
	return request(app, "/api/v1/me/external-email", {
		...json({ email }),
		cookie,
		env: env ? { EMAIL: env.email } : undefined,
	});
}

async function userExternal(userId: string) {
	const [row] = await db()
		.select({
			externalEmail: schema.users.externalEmail,
			externalVerifiedAt: schema.users.externalVerifiedAt,
			email: schema.users.email,
		})
		.from(schema.users)
		.where(eq(schema.users.id, userId))
		.limit(1);
	return row;
}

function decodeBase64(b64: string): string {
	const clean = b64.replace(/\s+/g, "");
	// atob は環境により存在しないことがある。TextDecoder と Buffer のどちらかで戻す。
	if (typeof atob === "function") {
		try {
			const bin = atob(clean);
			return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
		} catch {}
	}
	if (typeof Buffer !== "undefined") return Buffer.from(clean, "base64").toString("utf8");
	return clean;
}

function codeFrom(raw: string): string | null {
	// composeMime は本文を base64 エンコードする。headers を除いて base64 を戻してから探す。
	// 行末は環境により LF（workerd）と CRLF があり得る。
	const parts = raw.split(/\r?\n\r?\n/);
	const body = parts.length > 1 ? parts.slice(1).join("\n") : raw;
	return /確認コード[:：\s]*(\d{6})/.exec(decodeBase64(body))?.[1] ?? null;
}

describe("/me/external-email", () => {
	it("API キーでは 403（セッションだけ）", async () => {
		await ownerCookie();
		const owner = await createUser({ role: "owner", email: "o@x.test", password: PASSWORD });
		const key = await createApiKeyFor({ userId: owner.id });

		const res = await request(app, "/api/v1/me/external-email", {
			...json({ email: "new@x.test" }),
			bearer: key.token,
		});
		expect(res.status).toBe(403);
	});

	it("登録すると users に反映され、確認メールが送られ、コードを入れると確認済みになる", async () => {
		const cookie = await ownerCookie();
		const user = await createUser({ role: "member", email: "m@x.test", password: PASSWORD });
		const member = await loginCookie(user.email);
		await seedSender();
		const cap = emailCapture();

		const set = await setExternal(member, "m@example.com", cap);
		expect(set.status).toBe(200);
		expect((await set.json() as { sent: boolean }).sent).toBe(true);

		const before = await userExternal(user.id);
		expect(before!.externalEmail).toBe("m@example.com");
		expect(before!.externalVerifiedAt).toBeNull();
		expect(before!.email).toBe("m@example.com");

		const mail = cap.sent.find((s) => s.to === "m@example.com");
		expect(mail).toBeDefined();
		const code = codeFrom(mail!.raw);
		expect(code).toBeTruthy();
		expect(mail!.from.startsWith("sender@")).toBe(true);

		const ok = await request(app, "/api/v1/me/external-email/verify", {
			...json({ code }),
			cookie: member,
		});
		expect(ok.status).toBe(200);

		const after = await userExternal(user.id);
		expect(after!.externalVerifiedAt).not.toBeNull();
	});

	it("送れるドメインが無ければ sent:false と理由が返る", async () => {
		const user = await createUser({ role: "member", email: "m@x.test", password: PASSWORD });
		const member = await loginCookie(user.email);

		const set = await setExternal(member, "m@example.com");
		expect(set.status).toBe(200);
		const body = await set.json() as { sent: boolean; reason?: string };
		expect(body.sent).toBe(false);
		expect(body.reason).toContain("送信を有効");
	});

	it("確認前は、プライマリのある利用者は外部アドレスでログインできない", async () => {
		const user = await createUser({ role: "member", email: "m@x.test", password: PASSWORD });
		const domain = await createDomain();
		const primary = await createAddress(domain, "m");
		await db().update(schema.users).set({ primaryAddressId: primary }).where(eq(schema.users.id, user.id));
		await seedSender();

		const cap = emailCapture();
		const member = await loginCookie(user.email);
		const set = await setExternal(member, "m@example.com", cap);
		expect(set.status).toBe(200);
		const code = codeFrom(cap.sent[0]!.raw);
		expect(code).toBeTruthy();
		const before = await request(app, "/api/v1/auth/login", json({ email: "m@example.com", password: PASSWORD }));
		expect(before.status).toBe(401);

		const ok = await request(app, "/api/v1/me/external-email/verify", {
			...json({ code }),
			cookie: member,
		});
		expect(ok.status).toBe(200);

		const after = await request(app, "/api/v1/auth/login", json({ email: "m@example.com", password: PASSWORD }));
		expect(after.status).toBe(200);
	});

	it("誤ったコードは試行回数に上限があり、超過すると行が消えて送り直しを要求する", async () => {
		const user = await createUser({ role: "member", email: "m@x.test", password: PASSWORD });
		const member = await loginCookie(user.email);
		await seedSender();
		const cap = emailCapture();
		await setExternal(member, "m@example.com", cap);

		for (let i = 0; i < 5; i++) {
			const res = await request(app, "/api/v1/me/external-email/verify", {
				...json({ code: "111111" }),
				cookie: member,
			});
			expect(res.status).toBe(400);
		}

		// 5 回で行が消え、以降は確認コードが無い状態になる（送り直しを求める）。
		const again = await request(app, "/api/v1/me/external-email/verify", {
			...json({ code: "111111" }),
			cookie: member,
		});
		expect(again.status).toBe(400);
		expect((await again.json() as { error: { message: string } }).error.message).toContain("送り直して");
	});

	it("期限切れのコードは 400", async () => {
		const user = await createUser({ role: "member", email: "m@x.test", password: PASSWORD });
		const member = await loginCookie(user.email);
		await seedSender();
		const cap = emailCapture();
		await setExternal(member, "m@example.com", cap);

		await db()
			.update(schema.emailVerifications)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(schema.emailVerifications.userId, user.id));

		const res = await request(app, "/api/v1/me/external-email/verify", {
			...json({ code: codeFrom(cap.sent[0]!.raw)! }),
			cookie: member,
		});
		expect(res.status).toBe(400);
	});

	it("送り直しは 60 秒以内だと 429", async () => {
		const user = await createUser({ role: "member", email: "m@x.test", password: PASSWORD });
		const member = await loginCookie(user.email);
		await seedSender();
		const cap = emailCapture();
		await setExternal(member, "m@example.com", cap);

		const res = await request(app, "/api/v1/me/external-email/resend", {
			method: "POST",
			cookie: member,
		});
		expect(res.status).toBe(429);
		const body = await res.json() as { error: { code: string } };
		expect(body.error.code).toBe("rate_limited");
	});

	it("他人の外部アドレスや既存のメールボックスとは重複できない（409）", async () => {
		const user = await createUser({ role: "member", email: "m@x.test", password: PASSWORD });
		const member = await loginCookie(user.email);
		await seedSender();
		const cap = emailCapture();
		await setExternal(member, "dup@example.com", cap);

		const other = await createUser({ role: "member", email: "m2@x.test", password: PASSWORD });
		const otherCookie = await loginCookie(other.email);
		const res = await setExternal(otherCookie, "dup@example.com");
		expect(res.status).toBe(409);

		const domain = await createDomain();
		const address = await createAddress(domain, "info", "example.jp");
		const addrValue = (await db().select().from(schema.addresses).where(eq(schema.addresses.id, address)).get())!.address;
		const asMailbox = await setExternal(otherCookie, addrValue);
		expect(asMailbox.status).toBe(409);
	});
});

describe("PUT /api/v1/admin/users/:id/external-email", () => {
	function buildAdminApp() {
		const a = new Hono<AppEnv>();
		a.onError((err, c) => {
			if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
			return c.json({ error: { code: "internal", message: "内部エラー" } }, 500);
		});
		a.use("*", async (c, next) => {
			c.set("db", getDb(c.env));
			c.set("requestId", "test");
			await next();
		});
		a.route("/api/v1/auth", authRoutes);
		a.route("/api/v1/admin/users", externalEmailRoutes);
		return a;
	}
	const adminApp = buildAdminApp();

	function putExternal(adminApp: ReturnType<typeof buildAdminApp>, id: string, email: string, init?: { cookie?: string; env?: { email: any } }) {
		return request(adminApp, `/api/v1/admin/users/${id}/external-email`, {
			method: "PUT",
			body: JSON.stringify({ email }),
			cookie: init?.cookie,
			env: init?.env ? { EMAIL: init.env.email } : undefined,
		});
	}

	it("owner のセッションが対象の利用者の外部アドレスを登録できる", async () => {
		await ownerCookie();
		const cookie = await loginCookie("owner@x.test");
		const target = await createUser({ role: "member", email: "t@x.test", password: PASSWORD });
		await seedSender();
		const cap = emailCapture();

		const res = await putExternal(adminApp, target.id, "t@example.com", { cookie, env: { email: cap.email } });
		expect(res.status).toBe(200);
		expect((await res.json() as { sent: boolean }).sent).toBe(true);

		const row = await userExternal(target.id);
		expect(row!.externalEmail).toBe("t@example.com");
		expect(row!.externalVerifiedAt).toBeNull();
	});

	it("owner でないセッションは 403", async () => {
		const member = await createUser({ role: "member", email: "m@x.test", password: PASSWORD });
		const cookie = await loginCookie(member.email);
		const target = await createUser({ role: "member", email: "t2@x.test", password: PASSWORD });

		const res = await putExternal(adminApp, target.id, "x@example.com", { cookie });
		expect(res.status).toBe(403);
	});

	it("存在しない利用者には 404", async () => {
		const cookie = await ownerCookie();
		const res = await putExternal(adminApp, "nope", "x@example.com", { cookie });
		expect(res.status).toBe(404);
	});
});

describe("確認メールを送る回数の制限（登録のやり直しで試行回数を回させない）", () => {
	it("登録も 60 秒以内は 429、1 時間に 5 通を超えると 429", async () => {
		await ownerCookie();
		await seedSender();
		const member = await createUser({ role: "member", email: "rl@x.test", password: PASSWORD });
		const cookie = await loginCookie("rl@x.test");
		const cap = emailCapture();

		expect((await setExternal(cookie, "a1@example.net", cap)).status).toBe(200);
		expect((await setExternal(cookie, "a2@example.net", cap)).status).toBe(429);

		for (let i = 2; i <= 5; i++) {
			await db()
				.update(schema.emailVerifications)
				.set({ createdAt: new Date(Date.now() - 61_000) })
				.where(eq(schema.emailVerifications.userId, member.id));
			expect((await setExternal(cookie, `a${i}@example.net`, cap)).status).toBe(200);
		}
		await db()
			.update(schema.emailVerifications)
			.set({ createdAt: new Date(Date.now() - 61_000) })
			.where(eq(schema.emailVerifications.userId, member.id));
		expect((await setExternal(cookie, "a6@example.net", cap)).status).toBe(429);
		expect(cap.sent).toHaveLength(5);
	});
});

describe("未確認の外部アドレスでのログイン", () => {
	it("プライマリの無い member でも、未確認の外部アドレスでは入れない（例外は最初の owner だけ）", async () => {
		await ownerCookie();
		const member = await createUser({ role: "member", email: "noprimary@x.test", password: PASSWORD });
		await db()
			.update(schema.users)
			.set({ externalVerifiedAt: null, primaryAddressId: null })
			.where(eq(schema.users.id, member.id));
		const res = await request(app, "/api/v1/auth/login", json({ email: "noprimary@x.test", password: PASSWORD }));
		expect(res.status).toBe(401);
	});
});
