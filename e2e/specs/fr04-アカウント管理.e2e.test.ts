import { beforeEach, describe, expect } from "vitest";
import { scenario } from "../registry";
import {
	createClient,
	deliverEmail,
	drainQueues,
	freshHarness,
	loginAsOwner,
	mime,
	seedDomain,
	OWNER,
	type Client,
	type Harness,
} from "../harness";

describe("FR-4 アカウント管理", () => {
	let h: Harness;
	let owner: Client;
	let ai: string;
	let hito: string;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		const seeded = await seedDomain(h, { addresses: ["ai", "hito"] });
		ai = seeded.addressIds.ai!;
		hito = seeded.addressIds.hito!;
	});

	async function createMember(
		email: string,
		grants: { addressId: string; level: "read" | "write" }[],
	): Promise<Client> {
		const created = await owner.post("/api/v1/admin/users", {
			email,
			name: "メンバー",
			role: "member",
			password: "e2e-member-password",
		});
		expect(created.status).toBe(201);
		const userId = created.body.id;
		const g = await owner.put(`/api/v1/admin/users/${userId}/grants`, grants);
		expect(g.status).toBe(200);

		const member = createClient(h);
		const login = await member.post("/api/v1/auth/login", {
			email,
			password: "e2e-member-password",
		});
		expect(login.status).toBe(200);
		return member;
	}

	scenario("FR-4-3", "bootstrap は owner が居ないときだけ通り、2 回目は 409", async () => {
		const h2 = await freshHarness();
		const c = createClient(h2);

		const first = await c.post("/api/v1/auth/bootstrap", OWNER);
		expect(first.status).toBe(201);
		expect(first.body.role).toBe("owner");

		const second = await c.post("/api/v1/auth/bootstrap", OWNER);
		expect(second.status).toBe(409);
		expect(second.body.error.code).toBe("conflict");
	});

	scenario(["FR-4-1", "FR-4-4", "FR-11-2"], "オーナーがユーザーを作り、read / write を割り当て、read だけのユーザーは送信できない", async () => {
		const member = await createMember("member@tsubame.test", [
			{ addressId: ai, level: "read" },
			{ addressId: hito, level: "write" },
		]);

		const me = await member.get("/api/v1/me");
		expect(me.status).toBe(200);
		const byId = new Map<string, { canWrite: boolean }>(me.body.addresses.map((a: any) => [a.id, a]));
		expect(byId.get(ai)!.canWrite).toBe(false);
		expect(byId.get(hito)!.canWrite).toBe(true);

		const sendReadOnly = await member.post("/api/v1/messages", {
			from: "ai@mail.tsubame.test",
			to: "saki@ext.example.jp",
			subject: "送れないはず",
			text: "本文",
		});
		expect(sendReadOnly.status).toBe(403);

		const sendWrite = await member.post("/api/v1/messages", {
			from: "hito@mail.tsubame.test",
			to: "saki@ext.example.jp",
			subject: "送れるはず",
			text: "本文",
		});
		expect(sendWrite.status).toBe(202);
	});

	scenario(["FR-4-1", "FR-11-4"], "member は他人のアドレスのメッセージを一切見られない", async () => {
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", subject: "AI 宛て" }),
		});
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "hito@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "hito@mail.tsubame.test", subject: "人宛て" }),
		});
		await drainQueues(h);

		const member = await createMember("member@tsubame.test", [{ addressId: ai, level: "read" }]);

		const list = await member.get("/api/v1/messages?limit=10");
		expect(list.status).toBe(200);
		expect(list.body.data).toHaveLength(1);
		expect(list.body.data[0].addressId).toBe(ai);

		const all = await owner.get("/api/v1/messages?limit=10");
		const hitoId = all.body.data.find((m: any) => m.addressId === hito)!.id;
		const detail = await member.get(`/api/v1/messages/${hitoId}`);
		expect(detail.status).toBe(404);
	});

	scenario("FR-4-1", "最後の owner は削除も降格も無効化もできない", async () => {
		const me = await owner.get("/api/v1/me");
		const ownerId = me.body.id;

		const del = await owner.del(`/api/v1/admin/users/${ownerId}`);
		expect(del.status).toBe(409);

		const demote = await owner.patch(`/api/v1/admin/users/${ownerId}`, { role: "member" });
		expect(demote.status).toBe(409);

		const disable = await owner.patch(`/api/v1/admin/users/${ownerId}`, { status: "disabled" });
		expect(disable.status).toBe(409);
	});

	scenario("FR-4-1", "12 文字未満のパスワードではユーザーを作れない", async () => {
		const short = await owner.post("/api/v1/admin/users", {
			email: "short@tsubame.test",
			name: "短いパスワード",
			role: "member",
			password: "短い11文字!!",
		});
		expect(short.status).toBe(400);

		// 境界の 12 文字は作れる。
		const twelve = await owner.post("/api/v1/admin/users", {
			email: "twelve@tsubame.test",
			name: "12文字ちょうど",
			role: "member",
			password: "1234567890ab",
		});
		expect(twelve.status).toBe(201);
	});

	scenario("FR-4-2", "ログイン失敗はメールアドレスの存在を漏らさない", async () => {
		const noUser = await owner.post("/api/v1/auth/login", {
			email: "nobody@tsubame.test",
			password: "wrong-password-123",
		});
		expect(noUser.status).toBe(401);

		const wrongPass = await owner.post("/api/v1/auth/login", {
			email: OWNER.email,
			password: "wrong-password-123",
		});
		expect(wrongPass.status).toBe(401);

		expect(noUser.body.error.code).toBe("unauthorized");
		expect(wrongPass.body.error.code).toBe("unauthorized");
		expect(noUser.body.error.message).toBe(wrongPass.body.error.message);
	});

	scenario("FR-4-3", "合言葉が違うと最初のオーナーを作れない", async () => {
		// オーナーは DNS とルーティングまで触れるので、
		// デプロイ直後に URL を見つけただけの相手には作らせない。
		const h2 = await freshHarness();
		const c = createClient(h2);

		const wrong = await c.post("/api/v1/auth/bootstrap", { ...OWNER, secret: "wrong-secret-value" });
		expect(wrong.status).toBe(403);

		const ok = await c.post("/api/v1/auth/bootstrap", OWNER);
		expect(ok.status).toBe(201);
	});
});
