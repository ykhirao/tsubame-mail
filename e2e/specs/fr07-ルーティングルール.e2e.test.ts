import { beforeEach, describe, expect } from "vitest";
import { scenario } from "../registry";
import {
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

	scenario("FR-7", "domain スコープの reject が実在メールボックス宛でも効く", async () => {
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

	scenario("FR-7", "宛先の reject は +タグ を足しても効く", async () => {
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

	scenario("FR-7", "domain スコープの forward が転送され、ループ防止ヘッダ付きは転送しない", async () => {
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

	scenario("FR-7", "catch-all が実在アドレスを覆い隠さない", async () => {
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

	scenario("FR-7", "address スコープのルールが配信後に効く（既読化）", async () => {
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
});
