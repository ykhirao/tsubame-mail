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

describe("FR-5 API キー", () => {
	let h: Harness;
	let owner: Client;
	let ownerId: string;
	let ai: string;
	let hito: string;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		const me = await owner.get("/api/v1/me");
		ownerId = me.body.id;
		const seeded = await seedDomain(h, { addresses: ["ai", "hito"] });
		ai = seeded.addressIds.ai!;
		hito = seeded.addressIds.hito!;
	});

	async function issueKey(opts: {
		scopes: string[];
		addressIds?: string[] | null;
		userId?: string;
	}): Promise<{ id: string; token: string }> {
		const res = await owner.post("/api/v1/admin/api-keys", {
			userId: opts.userId ?? ownerId,
			name: "テストキー",
			scopes: opts.scopes,
			addressIds: opts.addressIds ?? null,
		});
		expect(res.status).toBe(201);
		return { id: res.body.id, token: res.body.token };
	}

	scenario(
		"FR-5",
		"オーナー自身のキーでも addressIds で絞れば他のアドレスは見えない",
		async () => {
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

			const all = await owner.get("/api/v1/messages?limit=10");
			const hitoId = all.body.data.find((m: any) => m.addressId === hito)!.id;

			const { token } = await issueKey({ scopes: ["read"], addressIds: [ai] });
			owner.useKey(token);

			const list = await owner.get("/api/v1/messages?limit=10");
			expect(list.status).toBe(200);
			expect(list.body.data).toHaveLength(1);
			expect(list.body.data[0].addressId).toBe(ai);
			expect(list.body.data[0].subject).toBe("AI 宛て");

			const detail = await owner.get(`/api/v1/messages/${hitoId}`);
			expect(detail.status).toBe(404);
		},
	);

	scenario("FR-5", "read だけのキーで送信すると 403、管理 API も 403", async () => {
		const { token } = await issueKey({ scopes: ["read"] });
		owner.useKey(token);

		const send = await owner.post("/api/v1/messages", {
			from: "ai@mail.tsubame.test",
			to: "saki@ext.example.jp",
			subject: "送れない",
			text: "本文",
		});
		expect(send.status).toBe(403);

		const admin = await owner.get("/api/v1/admin/users");
		expect(admin.status).toBe(403);
	});

	scenario("FR-5", "失効したキーは 401 になる", async () => {
		const { id, token } = await issueKey({ scopes: ["read"] });

		owner.useKey(token);
		const before = await owner.get("/api/v1/me");
		expect(before.status).toBe(200);

		// 失効する（セッションに戻してから。キー自身では admin スコープが無い）。
		owner.useKey(null);
		const revoke = await owner.del(`/api/v1/admin/api-keys/${id}`);
		expect(revoke.status).toBe(200);

		owner.useKey(token);
		const after = await owner.get("/api/v1/me");
		expect(after.status).toBe(401);
	});

	scenario("FR-5", "発行時だけ平文が返り、一覧・詳細には出ない", async () => {
		const { token } = await issueKey({ scopes: ["read", "send"] });

		expect(token).toBeTruthy();

		const adminList = await owner.get("/api/v1/admin/api-keys");
		expect(adminList.status).toBe(200);
		for (const k of adminList.body.data) {
			expect(k.token).toBeUndefined();
		}

		const meList = await owner.get("/api/v1/me/api-keys");
		expect(meList.status).toBe(200);
		for (const k of meList.body.data) {
			expect(k.token).toBeUndefined();
		}

		owner.useKey(token);
		const me = await owner.get("/api/v1/me");
		expect(me.status).toBe(200);
		expect(me.body.apiKeyId).toBeTruthy();
	});
});
