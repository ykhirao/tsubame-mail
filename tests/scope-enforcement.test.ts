import { beforeEach, describe, expect, it } from "vitest";
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
} from "../e2e/harness";

describe("共有メールボックスの read 割り当て", () => {
	let h: Harness;
	let owner: Client;
	let sharedId: string;

	async function createMember(email: string, level: "read" | "write") {
		const created = await owner.post("/api/v1/admin/users", { email, name: email, role: "member" });
		expect(created.status).toBe(201);
		const temp = created.body.temporaryPassword as string;
		await owner.put(`/api/v1/admin/users/${created.body.id}/grants`, {
			grants: [{ addressId: sharedId, level }],
		});

		const c = createClient(h);
		await c.post("/api/v1/auth/login", { email, password: temp });
		const password = `${email}-own-password`;
		await c.patch("/api/v1/me", { currentPassword: temp, newPassword: password });
		await c.post("/api/v1/auth/login", { email, password });
		return c;
	}

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		sharedId = (await seedDomain(h, { addresses: ["info"] })).addressIds.info!;
		await deliverEmail(h, {
			from: "toiawase@ext.example.jp",
			to: "info@mail.tsubame.test",
			raw: mime({
				from: "toiawase@ext.example.jp",
				to: "info@mail.tsubame.test",
				subject: "資料をください",
			}),
		});
		await drainQueues(h);
	});

	async function sharedMessageId(): Promise<string> {
		const all = await owner.get("/api/v1/messages?limit=10");
		return all.body.data[0].id as string;
	}

	it("read の人は既読・スターは付けられるが、ゴミ箱には移せない", async () => {
		const reader = await createMember("reader@tsubame.test", "read");
		const id = await sharedMessageId();

		expect((await reader.patch(`/api/v1/messages/${id}`, { isRead: true })).status).toBe(200);
		expect((await reader.patch(`/api/v1/messages/${id}`, { isStarred: true })).status).toBe(200);

		const trash = await reader.patch(`/api/v1/messages/${id}`, { status: "trash" });
		expect(trash.status).toBe(403);
		const combined = await reader.patch(`/api/v1/messages/${id}`, { isRead: false, status: "trash" });
		expect(combined.status).toBe(403);

		const after = await owner.get(`/api/v1/messages/${id}`);
		expect(after.body.status).toBe("received");
		expect(after.body.isRead).toBe(true);
	});

	it("write の人はゴミ箱に移せる", async () => {
		const writer = await createMember("writer@tsubame.test", "write");
		const id = await sharedMessageId();

		const trash = await writer.patch(`/api/v1/messages/${id}`, { status: "trash" });
		expect(trash.status).toBe(200);
		expect(trash.body.status).toBe("trash");
	});

	it("write の人でも status を sent / queued / failed / draft にはできない（#30）", async () => {
		const writer = await createMember("writer2@tsubame.test", "write");
		const id = await sharedMessageId();

		for (const status of ["sent", "queued", "failed", "draft"]) {
			const res = await writer.patch(`/api/v1/messages/${id}`, { status });
			expect(res.status).toBe(400);
		}

		const after = await owner.get(`/api/v1/messages/${id}`);
		expect(after.body.status).toBe("received");
	});

	it("write の人はゴミ箱から受信トレイへ戻せる", async () => {
		const writer = await createMember("writer3@tsubame.test", "write");
		const id = await sharedMessageId();

		expect((await writer.patch(`/api/v1/messages/${id}`, { status: "trash" })).status).toBe(200);
		const restored = await writer.patch(`/api/v1/messages/${id}`, { status: "received" });
		expect(restored.status).toBe(200);
		expect(restored.body.status).toBe("received");
	});
});
