import { beforeEach, describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { scenario } from "../registry";
import {
	captureSentEmails,
	createClient,
	freshHarness,
	loginAsOwner,
	seedDomain,
	type Client,
	type Harness,
} from "../harness";

function decodeB64(s: string): string {
	const clean = s.replace(/\s+/g, "");
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

// composeMime は確認メールの本文を base64 で埋めるので、戻して 6 桁のコードを探す。
function codeFrom(raw: string): string | null {
	const parts = raw.split(/\r?\n\r?\n/);
	const body = parts.length > 1 ? parts.slice(1).join("\n") : raw;
	return /確認コード[:：\s]*(\d{6})/.exec(decodeB64(body))?.[1] ?? null;
}

describe("FR-4 外部アドレス", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
	});

	/**
	 * member を作り、write 割り当てと（この実装の）内部アドレス＝プライマリを直接設定し、
	 * プライマリでログイン済みのクライアントを返す。primaryId を与えれば seedDomain は走らない。
	 */
	async function makeMemberWithPrimary(local: string, primaryId?: string): Promise<{ id: string; client: Client }> {
		if (!primaryId) {
			const seeded = await seedDomain(h, { addresses: [local] });
			primaryId = seeded.addressIds[local];
		}

		const created = await owner.post("/api/v1/admin/users", {
			email: `${local}@tsubame.test`,
			name: "メンバー",
			role: "member",
			password: "e2e-member-password",
			primaryAddress: { addressId: primaryId },
		});
		expect(created.status).toBe(201);
		const id = created.body.id;
		await owner.put(`/api/v1/admin/users/${id}/grants`, {
			grants: [{ addressId: primaryId, level: "write" }],
		});

		const { getDb } = await import("@/db/client");
		const { users } = await import("@/db/schema");
		await getDb(h.env).update(users).set({ primaryAddressId: primaryId }).where(eq(users.id, id));

		const client = createClient(h);
		const login = await client.post("/api/v1/auth/login", {
			email: `${local}@mail.tsubame.test`,
			password: "e2e-member-password",
		});
		expect(login.status).toBe(200);
		return { id, client };
	}

	scenario("FR-4-4", "確認メールのコードで確認すると、確認済みの外部アドレスでログインできる（確認前は 401、プライマリでは常にログイン可）", async () => {
		const { client } = await makeMemberWithPrimary("ai");
		const sent = captureSentEmails(h);

		// プライマリ（内部アドレス）では、外部アドレスを未確認のままでもログインできる。
		const byPrimary = await client.post("/api/v1/auth/login", {
			email: "ai@mail.tsubame.test",
			password: "e2e-member-password",
		});
		expect(byPrimary.status).toBe(200);

		const external = "member@example.com";
		// 確認前の外部アドレスではログインできない（プライマリがあるため）。
		const beforeVerified = await client.post("/api/v1/auth/login", {
			email: external,
			password: "e2e-member-password",
		});
		expect(beforeVerified.status).toBe(401);

		const set = await client.post("/api/v1/me/external-email", { email: external });
		expect(set.status).toBe(200);
		expect(set.body.sent).toBe(true);

		const mail = sent.find((m) => m.to === external);
		expect(mail).toBeDefined();
		const code = codeFrom(mail!.raw);
		expect(code).toBeTruthy();

		const verify = await client.post("/api/v1/me/external-email/verify", { code });
		expect(verify.status).toBe(200);

		const afterVerified = await client.post("/api/v1/auth/login", {
			email: external,
			password: "e2e-member-password",
		});
		expect(afterVerified.status).toBe(200);
	});

	scenario("FR-4-4", "誤ったコードは試行回数に上限があり、超過したら送り直しを求める", async () => {
		const { client } = await makeMemberWithPrimary("hitomi");
		captureSentEmails(h);
		const set = await client.post("/api/v1/me/external-email", { email: "hitomi@example.com" });
		expect(set.status).toBe(200);

		for (let i = 0; i < 5; i++) {
			const res = await client.post("/api/v1/me/external-email/verify", { code: "111111" });
			expect(res.status).toBe(400);
		}
		// 5 回で確認コードの行が消えるので、以降は「送り直して」になる。
		const again = await client.post("/api/v1/me/external-email/verify", { code: "111111" });
		expect(again.status).toBe(400);
		expect(again.body.error.message).toContain("送り直して");
	});

	scenario("FR-4-4", "60 秒以内の送り直しは 429、期限切れのコードは 400、他人の外部アドレスとの重複は 409", async () => {
		const seeded = await seedDomain(h, { addresses: ["m1", "m2"] });
		const { client: m1 } = await makeMemberWithPrimary("m1", seeded.addressIds.m1);
		const { client: m2 } = await makeMemberWithPrimary("m2", seeded.addressIds.m2);
		const sent = captureSentEmails(h);

		const set = await m1.post("/api/v1/me/external-email", { email: "m1@example.com" });
		expect(set.status).toBe(200);
		const code = codeFrom(sent.find((m) => m.to === "m1@example.com")!.raw);
		expect(code).toBeTruthy();

		// 登録直後の送り直しは 60 秒以内なので 429。
		const resend = await m1.post("/api/v1/me/external-email/resend");
		expect(resend.status).toBe(429);

		// 他人が同じ外部アドレスを取ろうとすると 409。
		const dup = await m2.post("/api/v1/me/external-email", { email: "m1@example.com" });
		expect(dup.status).toBe(409);

		// 期限切れ：同じ人の外部アドレスのコードの有効期限を潰して確認すると 400。
		const { getDb } = await import("@/db/client");
		const { emailVerifications } = await import("@/db/schema");
		const [row] = await getDb(h.env).select().from(emailVerifications).limit(1);
		expect(row).toBeDefined();
		await getDb(h.env)
			.update(emailVerifications)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(emailVerifications.userId, row!.userId));
		const expired = await m1.post("/api/v1/me/external-email/verify", { code });
		expect(expired.status).toBe(400);
		expect(expired.body.error.message).toContain("期限");
	});
});
