import { beforeEach, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
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
	createUserViaApi,
} from "../harness";

describe("FR-11 共有メールボックス", () => {
	let h: Harness;
	let owner: Client;
	let sharedId: string;
	let otherId: string;
	let ownerId: string;

	async function createMember(email: string, grants: { addressId: string; level: string }[]) {
		const created = await createUserViaApi(h, owner, { email, name: email, role: "member" });
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
		const me = await owner.get("/api/v1/me");
		ownerId = me.body.id as string;
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

	scenario("FR-11-1", "同じアドレスを 2 人に割り当てると両方から同じメールが見える", async () => {
		const a = await createMember("a@tsubame.test", [{ addressId: sharedId, level: "read" }]);
		const b = await createMember("b@tsubame.test", [{ addressId: sharedId, level: "write" }]);

		for (const m of [a, b]) {
			const res = await m.client.get("/api/v1/messages?limit=10");
			expect(res.status).toBe(200);
			expect(res.body.data).toHaveLength(1);
			expect(res.body.data[0].subject).toBe("資料をください");
		}
	});

	scenario("FR-11-2", "read だけの人は共有アドレスから送信できない", async () => {
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

	scenario("FR-11-4", "割り当てられていない人には一切見えない", async () => {
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
		const visible = addresses.body.data.map((a: { id: string }) => a.id);
		expect(visible).toContain(otherId);
		expect(visible).not.toContain(sharedId);
	});

	scenario("FR-11-4", "プライマリのほかに何も割り当てられていない人には、他のメールは何も見えない", async () => {
		const nobody = await createMember("nobody@tsubame.test", []);

		// 割り当てが自分のプライマリだけなら、それ以外は「制限なし」ではなく「1 件も見えない」。
		expect((await nobody.client.get("/api/v1/messages?limit=50")).body.data).toHaveLength(0);
		expect((await nobody.client.get("/api/v1/threads?limit=50")).body.data).toHaveLength(0);
		expect((await nobody.client.get("/api/v1/addresses")).body.data).toHaveLength(1);
		expect((await nobody.client.get("/api/v1/messages?q=%E8%B3%87%E6%96%99")).body.data).toHaveLength(
			0,
		);

		const all = await owner.get("/api/v1/messages?limit=50");
		const anyMessage = all.body.data[0];
		expect((await nobody.client.get(`/api/v1/messages/${anyMessage.id}`)).status).toBe(404);
		expect((await nobody.client.get(`/api/v1/threads/${anyMessage.threadId}`)).status).toBe(404);
	});

	scenario("FR-11-3", "オーナーはあるアドレスを誰が見られるかを一覧できる（割り当てた人と level / isPrimary）", async () => {
		const a = await createMember("viewer-a@tsubame.test", [
			{ addressId: sharedId, level: "read" },
		]);
		const b = await createMember("viewer-b@tsubame.test", [
			{ addressId: sharedId, level: "write" },
		]);

		const res = await owner.get(`/api/v1/admin/addresses/${sharedId}/viewers`);
		expect(res.status).toBe(200);
		const data = res.body.data as { userId: string; level: string; isPrimary: boolean }[];
		// seedDomain が owner にも write を割り当てるので、owner も一覧に載る。
		expect(data.map((v) => v.userId).sort()).toEqual([ownerId, a.id, b.id].sort());
		expect(data.find((v) => v.userId === a.id)?.level).toBe("read");
		expect(data.find((v) => v.userId === b.id)?.level).toBe("write");
		// level は read / write だけで、isPrimary が付く。
		expect(data.every((v) => v.level === "read" || v.level === "write")).toBe(true);
		expect(data.every((v) => typeof v.isPrimary === "boolean")).toBe(true);

		// 他のアドレスには owner の割り当て（write）だけが載る。
		const other = await owner.get(`/api/v1/admin/addresses/${otherId}/viewers`);
		expect(
			(other.body.data as { userId: string }[]).map((v) => v.userId),
		).toEqual([ownerId]);
	});

	scenario("FR-11-3", "オーナーは誰がそのアドレスを見られるか分かる", async () => {
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

	scenario("FR-11-5", "owner も含めて自分に割り当てたアドレスだけが見え、割り当てるまで他人のアドレスは見えない", async () => {
		const db = getDb(h.env);
		// beforeEach で seedDomain が owner に otherId を割り当てているので、外して「他人のアドレス」にする。
		await db
			.delete(schema.addressGrants)
			.where(
				and(
					eq(schema.addressGrants.userId, ownerId),
					eq(schema.addressGrants.addressId, otherId),
				),
			);

		// otherId を別の member に割り当てる。
		const member = await createMember("fr11-5@tsubame.test", [
			{ addressId: otherId, level: "write" },
		]);
		const mlist = await member.client.get("/api/v1/messages?limit=50");
		const otherMsg = mlist.body.data.find(
			(m: { addressId: string }) => m.addressId === otherId,
		);
		expect(otherMsg).toBeTruthy();

		// owner は普段、他の人に割り当てた otherId のメールを一覧・検索・詳細で見えない。
		const list = await owner.get("/api/v1/messages?limit=50");
		expect(
			list.body.data.every((m: { addressId: string }) => m.addressId !== otherId),
		).toBe(true);
		const search = await owner.get("/api/v1/messages?q=%E5%86%85%E5%AF%86");
		expect(search.body.data).toHaveLength(0);
		expect((await owner.get(`/api/v1/messages/${otherMsg.id}`)).status).toBe(404);
		expect((await owner.get(`/api/v1/messages/${otherMsg.id}/raw`)).status).toBe(404);

		// owner にも明示的に割り当てると見えるようになる。
		await db.insert(schema.addressGrants).values({
			userId: ownerId,
			addressId: otherId,
			level: "write",
		});
		const now = await owner.get("/api/v1/messages?q=%E5%86%85%E5%AF%86");
		expect(now.body.data.length).toBeGreaterThanOrEqual(1);
		expect((await owner.get(`/api/v1/messages/${otherMsg.id}`)).status).toBe(200);
	});
});
