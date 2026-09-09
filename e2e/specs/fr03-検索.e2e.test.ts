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

describe("FR-3 検索（重点機能）", () => {
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

	async function receive(opts: {
		to: string;
		subject?: string;
		body?: string;
		from?: string;
	}): Promise<void> {
		await deliverEmail(h, {
			from: opts.from ?? "torihiki@ext.example.jp",
			to: opts.to,
			raw: mime({
				from: opts.from ?? "torihiki@ext.example.jp",
				to: opts.to,
				subject: opts.subject ?? "件名なし",
				body: opts.body ?? "本文です。",
			}),
		});
		await drainQueues(h);
	}

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

	scenario(
		"FR-3",
		"日本語の部分一致: 3 文字以上は FTS5 trigram、1〜2 文字は LIKE の両方で引ける",
		async () => {
			// ADR: 3 文字以上は FTS5 trigram、1〜2 文字は LIKE に振り分ける。
			// 両方の経路を通す（「見積書」=3 文字、「見積」=2 文字）。
			await receive({
				to: "ai@mail.tsubame.test",
				subject: "見積書の件のご連絡",
				body: "先日の見積書をお送りします。",
			});

			const three = await owner.get("/api/v1/messages?q=見積書");
			expect(three.status).toBe(200);
			expect(three.body.data).toHaveLength(1);
			expect(three.body.data[0].subject).toBe("見積書の件のご連絡");

			const two = await owner.get("/api/v1/messages?q=見積");
			expect(two.status).toBe(200);
			expect(two.body.data).toHaveLength(1);
			expect(two.body.data[0].subject).toBe("見積書の件のご連絡");

			const one = await owner.get("/api/v1/messages?q=送り");
			expect(one.status).toBe(200);
			expect(one.body.data).toHaveLength(1);
		},
	);

	scenario("FR-3", "from: / subject: / since: / until: / is:unread の演算子が効く", async () => {
		await receive({
			to: "ai@mail.tsubame.test",
			from: "torihiki@ext.example.jp",
			subject: "見積書の件",
		});
		await receive({
			to: "ai@mail.tsubame.test",
			from: "hanbai@ext.example.jp",
			subject: "請求書の件",
		});

		const byFrom = await owner.get("/api/v1/messages?q=from:torihiki@ext.example.jp");
		expect(byFrom.status).toBe(200);
		expect(byFrom.body.data).toHaveLength(1);
		expect(byFrom.body.data[0].fromAddr).toBe("torihiki@ext.example.jp");

		const bySubject = await owner.get("/api/v1/messages?q=subject:見積");
		expect(bySubject.status).toBe(200);
		expect(bySubject.body.data).toHaveLength(1);
		expect(bySubject.body.data[0].subject).toBe("見積書の件");

		const since = await owner.get("/api/v1/messages?q=since:2000-01-01");
		expect(since.status).toBe(200);
		expect(since.body.data).toHaveLength(2);

		const until = await owner.get("/api/v1/messages?q=until:2000-01-01");
		expect(until.status).toBe(200);
		expect(until.body.data).toHaveLength(0);

		const all = await owner.get("/api/v1/messages?limit=10");
		const first = all.body.data[0];
		const patch = await owner.patch(`/api/v1/messages/${first.id}`, { isRead: true });
		expect(patch.status).toBe(200);

		const unread = await owner.get("/api/v1/messages?q=is:unread");
		expect(unread.status).toBe(200);
		expect(unread.body.data).toHaveLength(1);
		expect(unread.body.data[0].id).not.toBe(first.id);
	});

	scenario("FR-3", "権限外のアドレスのメッセージが絶対に出ない（member の検索）", async () => {
		await receive({ to: "ai@mail.tsubame.test", subject: "AI 宛ての秘密" });
		await receive({ to: "hito@mail.tsubame.test", subject: "人宛ての秘密" });

		const member = await createMember("member@tsubame.test", [{ addressId: ai, level: "read" }]);

		const list = await member.get("/api/v1/messages?limit=10");
		expect(list.status).toBe(200);
		expect(list.body.data).toHaveLength(1);
		expect(list.body.data[0].addressId).toBe(ai);
		expect(list.body.data[0].subject).toBe("AI 宛ての秘密");

		const byAddr = await member.get(`/api/v1/messages?address=${hito}`);
		expect(byAddr.status).toBe(200);
		expect(byAddr.body.data).toHaveLength(0);

		const hitoMsg = await owner.get("/api/v1/messages?limit=10");
		const hitoId = hitoMsg.body.data.find((m: any) => m.addressId === hito)!.id;
		const detail = await member.get(`/api/v1/messages/${hitoId}`);
		expect(detail.status).toBe(404);
	});

	scenario("FR-3", "カーソルページングで重複も取りこぼしも出ない（limit=1 で全部辿る）", async () => {
		for (let i = 0; i < 5; i++) {
			await receive({ to: "ai@mail.tsubame.test", subject: `ページング ${i}` });
		}

		const seen: string[] = [];
		let cursor: string | null = null;
		let guard = 0;
		do {
			const q = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
			const res = await owner.get(`/api/v1/messages?limit=1${q}`);
			expect(res.status).toBe(200);
			expect(res.body.data.length).toBeLessThanOrEqual(1);
			for (const m of res.body.data) seen.push(m.id);
			cursor = res.body.next_cursor;
			guard++;
			expect(guard).toBeLessThan(20);
		} while (cursor);

		expect(seen).toHaveLength(5);
		expect(new Set(seen).size).toBe(5);
	});

	scenario("FR-3", "不正なパラメータは黙って無視されず 400 になる", async () => {
		const badIs = await owner.get("/api/v1/messages?q=is:bogus");
		expect(badIs.status).toBe(400);
		expect(badIs.body.error.code).toBe("invalid_request");

		const badDate = await owner.get("/api/v1/messages?q=since:2026-13-99");
		expect(badDate.status).toBe(400);

		const badLimit = await owner.get("/api/v1/messages?limit=0");
		expect(badLimit.status).toBe(400);
		const tooBig = await owner.get("/api/v1/messages?limit=101");
		expect(tooBig.status).toBe(400);
	});
});
