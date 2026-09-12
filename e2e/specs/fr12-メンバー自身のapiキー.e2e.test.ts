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

describe("FR-12 メンバー自身の API キー", () => {
	let h: Harness;
	let owner: Client;
	let mineId: string;
	let othersId: string;
	let member: Client;
	let memberId: string;

	async function createMember(email: string, grants: { addressId: string; level: string }[]) {
		const created = await owner.post("/api/v1/admin/users", { email, name: email, role: "member" });
		const temp = created.body.temporaryPassword as string;
		await owner.put(`/api/v1/admin/users/${created.body.id}/grants`, { grants });

		const c = createClient(h);
		await c.post("/api/v1/auth/login", { email, password: temp });
		const password = `${email}-own-password`;
		await c.patch("/api/v1/me", { currentPassword: temp, newPassword: password });
		await c.post("/api/v1/auth/login", { email, password });
		return { client: c, id: created.body.id as string };
	}

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		const seeded = await seedDomain(h, { addresses: ["mine", "others"] });
		mineId = seeded.addressIds.mine!;
		othersId = seeded.addressIds.others!;

		for (const [local, id] of [
			["mine", "key-mine-0001"],
			["others", "key-others-0001"],
		]) {
			await deliverEmail(h, {
				from: "sender@ext.example.jp",
				to: `${local}@mail.tsubame.test`,
				raw: mime({
					from: "sender@ext.example.jp",
					to: `${local}@mail.tsubame.test`,
					subject: `${local} 宛の連絡`,
					messageId: id,
				}),
			});
		}
		await drainQueues(h);

		const m = await createMember("member@tsubame.test", [
			{ addressId: mineId, level: "write" },
		]);
		member = m.client;
		memberId = m.id;
	});

	scenario("FR-12-1", "オーナーでなくても自分のキーを発行できる", async () => {
		const res = await member.post("/api/v1/me/api-keys", { name: "自分用", scopes: ["read"] });
		expect(res.status).toBe(201);
		expect(res.body.token).toMatch(/^tsb_/);

		const list = await member.get("/api/v1/me/api-keys");
		expect(list.body.data).toHaveLength(1);
		expect(JSON.stringify(list.body)).not.toContain(res.body.token);
	});

	scenario("FR-12-2", "自分のキーでも本人が触れないアドレスには届かない", async () => {
		const created = await member.post("/api/v1/me/api-keys", { name: "自分用", scopes: ["read"] });
		const token = created.body.token as string;

		const keyClient = createClient(h);
		keyClient.useKey(token);

		const list = await keyClient.get("/api/v1/messages?limit=50");
		expect(list.body.data.every((m: { addressId: string }) => m.addressId === mineId)).toBe(true);

		const all = await owner.get("/api/v1/messages?limit=50");
		const othersMessage = all.body.data.find(
			(m: { addressId: string }) => m.addressId === othersId,
		);
		expect((await keyClient.get(`/api/v1/messages/${othersMessage.id}`)).status).toBe(404);
		expect((await keyClient.get(`/api/v1/messages/${othersMessage.id}/raw`)).status).toBe(404);
	});

	scenario("FR-12-3", "キーの対象アドレスで自分の権限をさらに狭められる", async () => {
		const both = await owner.put(`/api/v1/admin/users/${memberId}/grants`, {
			grants: [
				{ addressId: mineId, level: "write" },
				{ addressId: othersId, level: "read" },
			],
		});
		expect(both.status).toBe(200);

		const created = await member.post("/api/v1/me/api-keys", {
			name: "片方だけ",
			scopes: ["read"],
			addressIds: [mineId],
		});
		const keyClient = createClient(h);
		keyClient.useKey(created.body.token as string);

		const list = await keyClient.get("/api/v1/messages?limit=50");
		expect(list.body.data.every((m: { addressId: string }) => m.addressId === mineId)).toBe(true);
	});

	scenario(["FR-12-2", "FR-12-3"], "read だけのキーで送信も管理 API も通らない", async () => {
		const created = await member.post("/api/v1/me/api-keys", { name: "読むだけ", scopes: ["read"] });
		const keyClient = createClient(h);
		keyClient.useKey(created.body.token as string);

		const send = await keyClient.post("/api/v1/messages", {
			from: "mine@mail.tsubame.test",
			to: "someone@ext.example.jp",
			subject: "件名",
			text: "本文",
		});
		expect(send.status).toBe(403);
		expect((await keyClient.get("/api/v1/admin/users")).status).toBe(403);
		expect((await keyClient.get("/api/v1/admin/domains")).status).toBe(403);
	});

	scenario("FR-12-4", "他人のキーは一覧にも出ず、失効もできない", async () => {
		const stranger = await createMember("stranger@tsubame.test", [
			{ addressId: othersId, level: "read" },
		]);
		const strangerKey = await stranger.client.post("/api/v1/me/api-keys", {
			name: "他人のキー",
			scopes: ["read"],
		});

		const list = await member.get("/api/v1/me/api-keys");
		expect(
			list.body.data.some((k: { id: string }) => k.id === strangerKey.body.id),
		).toBe(false);

		const del = await member.del(`/api/v1/me/api-keys/${strangerKey.body.id}`);
		expect([403, 404]).toContain(del.status);

		const keyClient = createClient(h);
		keyClient.useKey(strangerKey.body.token as string);
		expect((await keyClient.get("/api/v1/me")).status).toBe(200);
	});

	scenario("FR-12-1", "失効したキーは使えない", async () => {
		const created = await member.post("/api/v1/me/api-keys", { name: "捨てる", scopes: ["read"] });
		const keyClient = createClient(h);
		keyClient.useKey(created.body.token as string);
		expect((await keyClient.get("/api/v1/me")).status).toBe(200);

		const del = await member.del(`/api/v1/me/api-keys/${created.body.id}`);
		expect([200, 204]).toContain(del.status);
		expect((await keyClient.get("/api/v1/me")).status).toBe(401);
	});

	scenario("FR-12-5", "失効したキーと同じ設定で再発行でき、新しいキーは同じ範囲で動く", async () => {
		const body = { name: "再発行", scopes: ["read"], addressIds: [mineId] };

		const first = await member.post("/api/v1/me/api-keys", body);
		expect(first.status).toBe(201);
		const oldClient = createClient(h);
		oldClient.useKey(first.body.token as string);
		expect((await oldClient.get("/api/v1/messages?limit=10")).status).toBe(200);

		const del = await member.del(`/api/v1/me/api-keys/${first.body.id}`);
		expect([200, 204]).toContain(del.status);
		expect((await oldClient.get("/api/v1/messages?limit=10")).status).toBe(401);

		const second = await member.post("/api/v1/me/api-keys", body);
		expect(second.status).toBe(201);

		const newClient = createClient(h);
		newClient.useKey(second.body.token as string);
		expect((await newClient.get("/api/v1/messages?limit=10")).status).toBe(200);

		const all = await owner.get("/api/v1/messages?limit=50");
		const othersMessage = all.body.data.find((m: { addressId: string }) => m.addressId === othersId);
		// 新しいキーも同じ範囲（mineId だけ）で届かない相手は読めない。
		expect((await newClient.get(`/api/v1/messages/${othersMessage.id}`)).status).toBe(404);
	});
});
