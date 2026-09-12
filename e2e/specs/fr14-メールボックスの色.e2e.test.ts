import { beforeEach, describe, expect, vi } from "vitest";
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
import { MAILBOX_COLORS } from "@/shared/colors";
import { createFakeCloudflare } from "../../tests/domains-helpers";

describe("FR-14 メールボックスの色", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		// admin/addresses の作成は Cloudflare API を叩くので、fetch ごと差し替える。
		(h.env as unknown as Record<string, unknown>).CF_API_TOKEN = "test-token";
		(h.env as unknown as Record<string, unknown>).CF_ACCOUNT_ID = "test-account";
		vi.stubGlobal("fetch", createFakeCloudflare().fetch);
	});

	scenario("FR-14", "一覧で見分けるための色をメールボックスごとに持つ", async () => {
		const seeded = await seedDomain(h, { addresses: ["ai", "hito"] });
		void seeded;
		const list = await owner.get("/api/v1/addresses");
		expect(list.status).toBe(200);
		expect(list.body.data.length).toBeGreaterThanOrEqual(2);
		for (const a of list.body.data) {
			expect(a).toHaveProperty("color");
			expect(a.color).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	scenario("FR-14", "既定は 20 色を作成順に割り当てる。任意の色（#rrggbb）も指定できる", async () => {
		const { domainId } = await seedDomain(h, { addresses: [] });
		const created = await owner.get("/api/v1/admin/addresses");
		// まだ何も無いこと（プレースホルダを作っていないので count が 0 から始まる）。
		const before = created.body.data.filter((a: any) => a.domainId === domainId);
		expect(before).toHaveLength(0);

		const colors: string[] = [];
		for (let i = 0; i < 21; i++) {
			const local = `box${String(i).padStart(2, "0")}`;
			const res = await owner.post("/api/v1/admin/addresses", { domainId, localPart: local });
			expect(res.status).toBe(201);
			colors.push(res.body.data.color);
		}

		for (let i = 0; i < 21; i++) {
			expect(colors[i]).toBe(MAILBOX_COLORS[i % MAILBOX_COLORS.length].hex);
		}
		expect(colors[0]).toBe(colors[20]);
		expect(colors[0]).toBe("#1a73e8");
		expect(colors[1]).toBe("#d93025");
		expect(colors[2]).toBe("#188038");

		const firstId = (await owner.get("/api/v1/admin/addresses")).body.data.find(
			(a: any) => a.localPart === "box00",
		).id;
		const patched = await owner.patch(`/api/v1/admin/addresses/${firstId}`, {
			color: "#ff00aa",
		});
		expect(patched.status).toBe(200);
		expect(patched.body.data.color).toBe("#ff00aa");
	});

	scenario("FR-14", "不正な色（red や #12345）は 400 で弾かれる", async () => {
		const { domainId } = await seedDomain(h, { addresses: [] });
		const created = await owner.post("/api/v1/admin/addresses", {
			domainId,
			localPart: "ai",
		});
		const id = created.body.data.id;

		for (const bad of ["red", "#12345", "#gggggg", "rgb(10,20,30)"]) {
			const res = await owner.patch(`/api/v1/admin/addresses/${id}`, { color: bad });
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe("invalid_request");
		}
	});

	scenario("FR-14", "削除後に作ったアドレスは残っている色と重複しない", async () => {
		const { domainId } = await seedDomain(h, { addresses: [] });
		const ids: string[] = [];
		const colors: string[] = [];
		for (let i = 0; i < 4; i++) {
			const res = await owner.post("/api/v1/admin/addresses", {
				domainId,
				localPart: `delbox${i}`,
			});
			expect(res.status).toBe(201);
			ids.push(res.body.data.id);
			colors.push(res.body.data.color);
		}
		expect(new Set(colors).size).toBe(4);

		const removed = await owner.del(`/api/v1/admin/addresses/${ids[1]}`);
		expect(removed.status).toBe(200);

		const re = await owner.post("/api/v1/admin/addresses", {
			domainId,
			localPart: "delbox-new",
		});
		expect(re.status).toBe(201);
		const newColor = re.body.data.color;

		// count % 20 だと削除で減った分だけ、残っている色とかぶる。
		// 使われていない色を回すので、残りの 3 色とは重複せず、空いた 2 つ目の色が再割り当てされる。
		const remaining = [0, 2, 3].map((i) => colors[i]!);
		expect(remaining).not.toContain(newColor);
		expect(newColor).toBe(colors[1]);
	});

	scenario("FR-14", "横断表示のときは、どのメールボックス宛かが色と文字で分かる", async () => {
		const { domainId } = await seedDomain(h, { addresses: [] });
		const created = await owner.post("/api/v1/admin/addresses", {
			domainId,
			localPart: "ai",
		});
		const color = created.body.data.color;

		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", subject: "スレッドの件名" }),
		});
		await drainQueues(h);

		const threads = await owner.get("/api/v1/threads");
		expect(threads.status).toBe(200);
		expect(threads.body.data).toHaveLength(1);
		expect(threads.body.data[0].address).toBe("ai@mail.tsubame.test");
		expect(threads.body.data[0].addressColor).toBe(color);
	});
});
