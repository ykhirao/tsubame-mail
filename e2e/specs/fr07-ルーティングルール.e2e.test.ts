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
	type Client,
	type Harness,
} from "../harness";

describe("FR-7 ルーティングルール", () => {
	let h: Harness;
	let owner: Client;
	let domainId: string;
	let aiId: string;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		const seeded = await seedDomain(h, { addresses: ["ai"] });
		domainId = seeded.domainId;
		aiId = seeded.addressIds.ai!;
	});

	async function createDomainRule(body: Record<string, unknown>) {
		const res = await owner.post("/api/v1/admin/rules", {
			scope: "domain",
			domainId,
			priority: 10,
			enabled: true,
			...body,
		});
		expect(res.status).toBe(201);
		return res.body;
	}

	scenario(["FR-7-1", "FR-1-3"], "domain スコープの reject が実在メールボックス宛でも効く", async () => {
		await createDomainRule({
			name: "スパム送信者を拒否",
			action: "reject",
			matcher: { from: "spam@ext.jp" },
			target: "この送信者は拒否されています",
		});

		const result = await deliverEmail(h, {
			from: "spam@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "spam@ext.jp", to: "ai@mail.tsubame.test" }),
		});
		expect(result.rejected).toBeTruthy();
		expect(h.pending).toHaveLength(0);
	});

	scenario(["FR-7-1", "FR-1-4"], "宛先の reject は +タグ を足しても効く", async () => {
		await createDomainRule({
			name: "ai 宛てを拒否",
			action: "reject",
			matcher: { to: "ai@mail.tsubame.test" },
			target: "この宛先は受け付けていません",
		});

		const result = await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai+x@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai+x@mail.tsubame.test" }),
		});
		expect(result.rejected).toBe("この宛先は受け付けていません");
		expect(h.pending).toHaveLength(0);
	});

	scenario("FR-7-1", "domain スコープの forward が転送され、ループ防止ヘッダ付きは転送しない", async () => {
		await createDomainRule({
			name: "外部へ転送",
			action: "forward",
			matcher: { from: "fwd@ext.jp" },
			target: "external@example.com",
		});

		const result = await deliverEmail(h, {
			from: "fwd@ext.jp",
			to: "nobody@mail.tsubame.test",
			raw: mime({ from: "fwd@ext.jp", to: "nobody@mail.tsubame.test" }),
		});
		expect(result.rejected).toBeNull();
		expect(result.forwarded.map((f) => f.to)).toContain("external@example.com");

		const loop = await deliverEmail(h, {
			from: "fwd@ext.jp",
			to: "nobody@mail.tsubame.test",
			raw: mime({
				from: "fwd@ext.jp",
				to: "nobody@mail.tsubame.test",
				extraHeaders: { "X-Tsubame-Forwarded": "ai@mail.tsubame.test" },
			}),
		});
		expect(loop.forwarded).toHaveLength(0);
		expect(loop.rejected).toContain("転送ループ");
	});

	scenario(["FR-7-1", "FR-1-3"], "実在しない宛先に当たる domain スコープの drop は、拒否せず黙って捨てる（保存もキュー投入もしない）", async () => {
		await createDomainRule({ name: "黙って捨てる", action: "drop", matcher: { to: "old-news@" } });

		const result = await deliverEmail(h, {
			from: "noise@ext.jp",
			to: "old-news@mail.tsubame.test",
			raw: mime({ from: "noise@ext.jp", to: "old-news@mail.tsubame.test" }),
		});
		expect(result.rejected).toBeFalsy();
		expect(h.pending).toHaveLength(0);
		const list = await owner.get("/api/v1/messages?limit=10&includeTrash=true");
		expect(list.body.data).toHaveLength(0);
	});

	scenario("FR-1-3", "エイリアス宛のメールは、エイリアス先のメールボックスに届く", async () => {
		const { getDb } = await import("@/db/client");
		const { addresses } = await import("@/db/schema");
		const { newId } = await import("@/lib/id");
		await getDb(h.env).insert(addresses).values({
			id: newId("address"),
			domainId,
			localPart: "sales",
			address: "sales@mail.tsubame.test",
			kind: "alias",
			aliasTargetId: aiId,
		});

		await deliverEmail(h, {
			from: "customer@ext.jp",
			to: "sales@mail.tsubame.test",
			raw: mime({ from: "customer@ext.jp", to: "sales@mail.tsubame.test", subject: "見積もりの依頼" }),
		});
		await drainQueues(h);

		const list = await owner.get("/api/v1/messages?limit=10");
		expect(list.body.data).toHaveLength(1);
		expect(list.body.data[0].addressId).toBe(aiId);
		expect(list.body.data[0].subject).toBe("見積もりの依頼");
	});

	scenario("FR-1-3", "catch-all が実在アドレスを覆い隠さない", async () => {
		// seedDomain は isCatchAll: false でしか作らないので、受け皿は D1 に直接入れる。
		const { getDb } = await import("@/db/client");
		const { addresses } = await import("@/db/schema");
		const { newId } = await import("@/lib/id");
		await getDb(h.env).insert(addresses).values({
			id: newId("address"),
			domainId,
			localPart: "any",
			address: "any@mail.tsubame.test",
			kind: "mailbox",
			isCatchAll: true,
		});

		const real = await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test" }),
		});
		expect(real.rejected).toBeNull();
		expect(h.pending).toHaveLength(1);

		h.pending.length = 0;
		const fallback = await deliverEmail(h, {
			from: "a@ext.jp",
			to: "nobody@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "nobody@mail.tsubame.test" }),
		});
		expect(fallback.rejected).toBeNull();
		expect(h.pending).toHaveLength(1);
	});

	scenario("FR-7-2", "address スコープのルールが配信後に効く（既読化）", async () => {
		const res = await owner.post("/api/v1/admin/rules", {
			scope: "address",
			addressId: aiId,
			name: "自動既読",
			action: "mark",
			target: "read",
			matcher: { from: "auto@ext.jp" },
			priority: 10,
			enabled: true,
		});
		expect(res.status).toBe(201);

		await deliverEmail(h, {
			from: "auto@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "auto@ext.jp", to: "ai@mail.tsubame.test" }),
		});
		await drainQueues(h);

		const list = await owner.get("/api/v1/messages?limit=10");
		expect(list.status).toBe(200);
		expect(list.body.data).toHaveLength(1);
		expect(list.body.data[0].isRead).toBe(true);
	});

	async function memberAndKeyedOwner(): Promise<[Client, Client]> {
		const memberCreate = await owner.post("/api/v1/admin/users", {
			email: "member@tsubame.test",
			name: "メンバー",
			role: "member",
			password: "member-pass-12345",
		});
		expect(memberCreate.status).toBe(201);
		const member = createClient(h);
		expect((await member.post("/api/v1/auth/login", {
			email: "member@tsubame.test",
			password: "member-pass-12345",
		})).status).toBe(200);

		const me = await owner.get("/api/v1/me");
		const key = await owner.post("/api/v1/admin/api-keys", {
			userId: me.body.id,
			name: "read-send-owner",
			scopes: ["read", "send"],
			addressIds: null,
		});
		expect(key.status).toBe(201);
		const keyed = createClient(h);
		keyed.useKey(key.body.token);
		return [member, keyed];
	}

	scenario("FR-5-1", "member セッションと admin 無しの owner キーではルールを作成・更新・削除できない", async () => {
		const [member, keyed] = await memberAndKeyedOwner();

		const createdRule = await owner.post("/api/v1/admin/rules", {
			scope: "domain",
			domainId,
			priority: 10,
			enabled: true,
			name: "既存ルール",
			action: "reject",
			matcher: { from: "spam@ext.jp" },
		});
		expect(createdRule.status).toBe(201);
		const ruleId = createdRule.body.id;

		const createBody = {
			scope: "domain",
			domainId,
			priority: 20,
			enabled: true,
			name: "権限の無い人が作るルール",
			action: "reject",
			matcher: { from: "x@ext.jp" },
		};

		for (const [label, client] of [
			["member", member],
			["owner read+send キー", keyed],
		] as const) {
			expect((await client.post("/api/v1/admin/rules", createBody)).status, `${label} 作成`).toBe(403);
			expect((await client.patch(`/api/v1/admin/rules/${ruleId}`, { enabled: false })).status, `${label} 更新`).toBe(403);
			expect((await client.del(`/api/v1/admin/rules/${ruleId}`)).status, `${label} 削除`).toBe(403);
		}

		const still = await owner.get(`/api/v1/admin/rules/${ruleId}`);
		expect(still.status).toBe(200);
		expect(still.body.enabled).toBe(true);
	});

	scenario("FR-7-2", "mark の target は既読化の実在種別だけを許可する", async () => {
		// read / unread / star / unstar 以外（ここでは存在しない種別）は 400 で弾く。
		const bad = await owner.post("/api/v1/admin/rules", {
			scope: "address",
			addressId: aiId,
			name: "存在しない既読化",
			action: "mark",
			target: "unread_star_delete",
			matcher: { from: "a@ext.jp" },
			priority: 10,
			enabled: true,
		});
		expect(bad.status).toBe(400);

		const ok = await owner.post("/api/v1/admin/rules", {
			scope: "address",
			addressId: aiId,
			name: "スター",
			action: "mark",
			target: "star",
			matcher: { from: "a@ext.jp" },
			priority: 10,
			enabled: true,
		});
		expect(ok.status).toBe(201);
	});

	scenario("FR-7-1", "不正なルール入力は 400", async () => {
		const res = await owner.post("/api/v1/admin/rules", {
			scope: "domain",
			domainId,
			priority: 10,
			name: "action が無い",
		});
		expect(res.status).toBe(400);
	});
});
