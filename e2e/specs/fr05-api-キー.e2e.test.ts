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

	scenario("FR-5", "send だけのキーでは受信メールを一切読めないが、送信はできる", async () => {
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", subject: "秘密の件名" }),
		});
		await drainQueues(h);
		const all = await owner.get("/api/v1/messages?limit=10");
		const msg = all.body.data[0];

		const { token } = await issueKey({ scopes: ["send"] });
		owner.useKey(token);

		for (const path of [
			"/api/v1/messages?limit=10",
			"/api/v1/messages?q=%E7%A7%98%E5%AF%86",
			`/api/v1/messages/${msg.id}`,
			`/api/v1/messages/${msg.id}/raw`,
			"/api/v1/threads?limit=10",
			`/api/v1/threads/${msg.threadId}`,
		]) {
			const res = await owner.get(path);
			expect(res.status, path).toBe(403);
			expect(JSON.stringify(res.body)).not.toContain("秘密の件名");
		}

		const star = await owner.patch(`/api/v1/messages/${msg.id}`, { isStarred: true });
		expect(star.status).toBe(403);

		// outbound のルータも同じ /api/v1/messages に載っている。受信系の検査が送信まで塞がないこと。
		const send = await owner.post("/api/v1/messages", {
			from: "ai@mail.tsubame.test",
			to: "saki@ext.example.jp",
			subject: "送れる",
			text: "本文",
		});
		expect(send.status).toBe(202);
	});

	scenario("FR-5", "read だけのキーでは既読は付けられるが、ゴミ箱には移せない", async () => {
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", subject: "残すべきメール" }),
		});
		await drainQueues(h);
		const all = await owner.get("/api/v1/messages?limit=10");
		const msgId = all.body.data[0].id as string;

		const { token } = await issueKey({ scopes: ["read"] });
		owner.useKey(token);

		const trash = await owner.patch(`/api/v1/messages/${msgId}`, { status: "trash" });
		expect(trash.status).toBe(403);

		const read = await owner.patch(`/api/v1/messages/${msgId}`, { isRead: true });
		expect(read.status).toBe(200);
		expect(read.body.isRead).toBe(true);

		owner.useKey(null);
		const after = await owner.get(`/api/v1/messages/${msgId}`);
		expect(after.body.status).toBe("received");
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
