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

describe("FR-11 共有メールボックス", () => {
	let h: Harness;
	let owner: Client;
	let sharedId: string;
	let otherId: string;

	async function createMember(email: string, grants: { addressId: string; level: string }[]) {
		const created = await owner.post("/api/v1/admin/users", { email, name: email, role: "member" });
		expect(created.status).toBe(201);
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
		const seeded = await seedDomain(h, { addresses: ["info", "hisho"] });
		sharedId = seeded.addressIds.info!;
		otherId = seeded.addressIds.hisho!;

		await deliverEmail(h, {
			from: "toiawase@ext.example.jp",
			to: "info@mail.tsubame.test",
			raw: mime({
				from: "toiawase@ext.example.jp",
				to: "info@mail.tsubame.test",
				subject: "資料をください",
				messageId: "shared-0001",
			}),
		});
		await deliverEmail(h, {
			from: "naisho@ext.example.jp",
			to: "hisho@mail.tsubame.test",
			raw: mime({
				from: "naisho@ext.example.jp",
				to: "hisho@mail.tsubame.test",
				subject: "内密の相談",
				messageId: "secret-0001",
			}),
		});
		await drainQueues(h);
	});

	scenario("FR-11", "同じアドレスを 2 人に割り当てると両方から同じメールが見える", async () => {
		const a = await createMember("a@tsubame.test", [{ addressId: sharedId, level: "read" }]);
		const b = await createMember("b@tsubame.test", [{ addressId: sharedId, level: "write" }]);

		for (const m of [a, b]) {
			const res = await m.client.get("/api/v1/messages?limit=10");
			expect(res.status).toBe(200);
			expect(res.body.data).toHaveLength(1);
			expect(res.body.data[0].subject).toBe("資料をください");
		}
	});

	scenario("FR-11", "read だけの人は共有アドレスから送信できない", async () => {
		const a = await createMember("read-only@tsubame.test", [
			{ addressId: sharedId, level: "read" },
		]);
		const b = await createMember("can-write@tsubame.test", [
			{ addressId: sharedId, level: "write" },
		]);

		const denied = await a.client.post("/api/v1/messages", {
			from: "info@mail.tsubame.test",
			to: "someone@ext.example.jp",
			subject: "返信",
			text: "本文",
		});
		expect(denied.status).toBe(403);

		const allowed = await b.client.post("/api/v1/messages", {
			from: "info@mail.tsubame.test",
			to: "someone@ext.example.jp",
			subject: "返信",
			text: "本文",
		});
		expect(allowed.status).toBe(202);
	});

	scenario("FR-11", "割り当てられていない人には一切見えない", async () => {
		const outsider = await createMember("outsider@tsubame.test", [
			{ addressId: otherId, level: "read" },
		]);

		const list = await outsider.client.get("/api/v1/messages?limit=50");
		expect(list.body.data.every((m: { addressId: string }) => m.addressId === otherId)).toBe(true);

		const all = await owner.get("/api/v1/messages?limit=50");
		const sharedMessage = all.body.data.find(
			(m: { addressId: string }) => m.addressId === sharedId,
		);

		expect((await outsider.client.get(`/api/v1/messages/${sharedMessage.id}`)).status).toBe(404);
		expect((await outsider.client.get(`/api/v1/messages/${sharedMessage.id}/raw`)).status).toBe(404);
		expect((await outsider.client.get(`/api/v1/threads/${sharedMessage.threadId}`)).status).toBe(
			404,
		);

		const search = await outsider.client.get("/api/v1/messages?q=%E8%B3%87%E6%96%99");
		expect(search.body.data).toHaveLength(0);

		const addresses = await outsider.client.get("/api/v1/addresses");
		expect(addresses.body.data.map((a: { id: string }) => a.id)).toEqual([otherId]);
	});

	scenario("FR-11", "権限を 1 件も持たない人には何も見えない", async () => {
		const nobody = await createMember("nobody@tsubame.test", []);

		// 空の権限は「制限なし」ではなく「1 件も見えない」。
		expect((await nobody.client.get("/api/v1/messages?limit=50")).body.data).toHaveLength(0);
		expect((await nobody.client.get("/api/v1/threads?limit=50")).body.data).toHaveLength(0);
		expect((await nobody.client.get("/api/v1/addresses")).body.data).toHaveLength(0);
		expect((await nobody.client.get("/api/v1/messages?q=%E8%B3%87%E6%96%99")).body.data).toHaveLength(
			0,
		);

		const all = await owner.get("/api/v1/messages?limit=50");
		const anyMessage = all.body.data[0];
		expect((await nobody.client.get(`/api/v1/messages/${anyMessage.id}`)).status).toBe(404);
		expect((await nobody.client.get(`/api/v1/threads/${anyMessage.threadId}`)).status).toBe(404);
	});

	scenario("FR-11", "オーナーはあるアドレスを誰が見られるかを一覧できる（owner と grants）", async () => {
		const a = await createMember("viewer-a@tsubame.test", [
			{ addressId: sharedId, level: "read" },
		]);
		const b = await createMember("viewer-b@tsubame.test", [
			{ addressId: sharedId, level: "write" },
		]);

		const res = await owner.get(`/api/v1/admin/addresses/${sharedId}/viewers`);
		expect(res.status).toBe(200);
		const data = res.body.data as { userId: string; level: string }[];
		// owner は全アドレスを見られるため常に入っていて、grants は read / write で並ぶ。
		expect(data.some((v) => v.level === "owner")).toBe(true);
		expect(data.find((v) => v.userId === a.id)?.level).toBe("read");
		expect(data.find((v) => v.userId === b.id)?.level).toBe("write");

		// 割り当てていないアドレスには owner しか出ない。
		const other = await owner.get(`/api/v1/admin/addresses/${otherId}/viewers`);
		expect(other.body.data).toEqual([
			expect.objectContaining({ userId: expect.any(String), level: "owner" }),
		]);
	});

	scenario("FR-11", "オーナーは誰がそのアドレスを見られるか分かる", async () => {
		const a = await createMember("x@tsubame.test", [{ addressId: sharedId, level: "read" }]);
		const b = await createMember("y@tsubame.test", [{ addressId: sharedId, level: "write" }]);

		const holders: string[] = [];
		for (const id of [a.id, b.id]) {
			const detail = await owner.get(`/api/v1/admin/users/${id}`);
			expect(detail.status).toBe(200);
			const grants = detail.body.grants as { addressId: string }[];
			if (grants.some((g) => g.addressId === sharedId)) holders.push(id);
		}
		expect(holders.sort()).toEqual([a.id, b.id].sort());
	});
});
