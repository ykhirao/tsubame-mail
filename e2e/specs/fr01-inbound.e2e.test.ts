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

describe("FR-1 受信", () => {
	let h: Harness;
	let owner: Client;
	let ai: string;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		const seeded = await seedDomain(h, { addresses: ["ai", "hito"] });
		ai = seeded.addressIds.ai!;
	});

	scenario(
		"FR-1-1",
		"長さの分からない生 MIME でも R2 に保存でき、パースまで通る",
		async () => {
			// 実機（wrangler dev）で最初に落ちたのがここ。
			// ForwardableEmailMessage.raw は長さ不明のストリームなので、
			// R2 にそのまま渡すと "must have a known length" で落ちる。
			const result = await deliverEmail(h, {
				from: "torihiki@ext.example.jp",
				to: "ai@mail.tsubame.test",
				raw: mime({
					from: "取引先 <torihiki@ext.example.jp>",
					to: "ai@mail.tsubame.test, hito@mail.tsubame.test",
					subject: "見積書の件のご連絡",
					messageId: "inbound-0001",
					body: "先日の見積書をお送りします。",
				}),
			});
			expect(result.rejected).toBeNull();

			await drainQueues(h);

			const res = await owner.get("/api/v1/messages?limit=10");
			expect(res.status).toBe(200);
			expect(res.body.data).toHaveLength(1);
			const m = res.body.data[0];
			expect(m.subject).toBe("見積書の件のご連絡");
			// to は複数宛先のリスト。単一アドレスに潰してはいけない。
			expect(m.toAddr ?? m.to_addr).toContain("ai@mail.tsubame.test");
			expect(m.toAddr ?? m.to_addr).toContain("hito@mail.tsubame.test");
		},
	);

	scenario("FR-1-1", "生 MIME が R2 に実際に置かれ、取り出せる", async () => {
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", messageId: "inbound-0002" }),
		});
		await drainQueues(h);

		const listed = await h.env.BUCKET.list({ prefix: "raw/" });
		expect(listed.objects.length).toBe(1);
		const stored = await h.env.BUCKET.get(listed.objects[0]!.key);
		const text = await stored!.text();
		expect(text).toContain("Message-ID: <inbound-0002@tsubame.test>");
	});

	scenario("FR-1-2", "複数ドメインの同じローカル部のアドレスを同時に扱い、それぞれ自ドメイン宛に届く", async () => {
		// domains の一意制約は name だけなので seedDomain は複数回呼べる。
		const a = await seedDomain(h, { domain: "mail.a.test", addresses: ["ai"] });
		const b = await seedDomain(h, { domain: "mail.b.test", addresses: ["ai"] });

		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.a.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.a.test", messageId: "multi-a-0001" }),
		});
		await deliverEmail(h, {
			from: "b@ext.jp",
			to: "ai@mail.b.test",
			raw: mime({ from: "b@ext.jp", to: "ai@mail.b.test", messageId: "multi-b-0002" }),
		});
		await drainQueues(h);

		const res = await owner.get("/api/v1/messages?limit=10");
		expect(res.status).toBe(200);
		expect(res.body.data).toHaveLength(2);
		// ローカル部が同じ ai でも、各メールは自ドメインのアドレスに解決されている。
		const byAddr = new Set(res.body.data.map((m: any) => m.addressId));
		expect(byAddr.has(a.addressIds.ai!)).toBe(true);
		expect(byAddr.has(b.addressIds.ai!)).toBe(true);
	});

	scenario("FR-1-2", "複数ドメインのアドレスがアドレス一覧に並ぶ", async () => {
		await seedDomain(h, { domain: "mail.a.test", addresses: ["ai"] });
		await seedDomain(h, { domain: "mail.b.test", addresses: ["ai"] });

		const res = await owner.get("/api/v1/addresses");
		expect(res.status).toBe(200);
		const addrs = res.body.data.map((x: any) => x.address);
		expect(addrs).toContain("ai@mail.a.test");
		expect(addrs).toContain("ai@mail.b.test");
		expect(addrs).toContain("ai@mail.tsubame.test");
	});

	scenario("FR-1-3", "未登録の宛先は受信ハンドラで拒否する", async () => {
		const result = await deliverEmail(h, {
			from: "a@ext.jp",
			to: "nobody@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "nobody@mail.tsubame.test" }),
		});
		expect(result.rejected).toBeTruthy();
		expect(h.pending).toHaveLength(0);
	});

	scenario("FR-1-5", "In-Reply-To が既存メッセージを指すと同じスレッドに入る", async () => {
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({
				from: "a@ext.jp",
				to: "ai@mail.tsubame.test",
				subject: "見積書の件",
				messageId: "thread-0001",
			}),
		});
		await drainQueues(h);

		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({
				from: "a@ext.jp",
				to: "ai@mail.tsubame.test",
				subject: "Re: 見積書の件",
				messageId: "thread-0002",
				inReplyTo: "thread-0001@tsubame.test",
			}),
		});
		await drainQueues(h);

		const res = await owner.get("/api/v1/messages?limit=10");
		const threadIds = new Set(res.body.data.map((m: any) => m.threadId ?? m.thread_id));
		expect(res.body.data).toHaveLength(2);
		expect(threadIds.size).toBe(1);
	});

	scenario("FR-1-5", "他人の Message-ID を In-Reply-To に入れた第三者のメールは、その会話に混ざらない", async () => {
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", subject: "契約の件", messageId: "trust-0001" }),
		});
		await drainQueues(h);

		await deliverEmail(h, {
			from: "evil@attacker.example",
			to: "ai@mail.tsubame.test",
			raw: mime({
				from: "a@ext.jp の担当 <evil@attacker.example>",
				to: "ai@mail.tsubame.test",
				subject: "Re: 契約の件",
				messageId: "evil-0001",
				inReplyTo: "trust-0001@tsubame.test",
			}),
		});
		await drainQueues(h);

		const res = await owner.get("/api/v1/messages?limit=10");
		const threadIds = new Set(res.body.data.map((m: any) => m.threadId));
		expect(res.body.data).toHaveLength(2);
		expect(threadIds.size).toBe(2);
	});

	scenario("FR-1-6", "25MB を超えるメールは R2 に置く前に受信ハンドラで拒否する", async () => {
		const result = await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", body: "a".repeat(25 * 1024 * 1024) }),
		});
		expect(result.rejected).toContain("上限");
		expect(h.pending).toHaveLength(0);
		const listed = await h.env.BUCKET.list({ prefix: "raw/" });
		expect(listed.objects).toHaveLength(0);
	});

	scenario(["FR-1-4", "FR-1-3"], "+タグ付きのアドレスは元のメールボックスに届く", async () => {
		const result = await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai+github@mail.tsubame.test",
			raw: mime({
				from: "a@ext.jp",
				to: "ai+github@mail.tsubame.test",
				subject: "通知",
				messageId: "plus-0001",
			}),
		});
		expect(result.rejected).toBeNull();
		await drainQueues(h);

		const res = await owner.get("/api/v1/messages?limit=10");
		expect(res.body.data).toHaveLength(1);
		expect(res.body.data[0].addressId).toBe(ai);
	});

	scenario("FR-1-4", "存在しないローカル部に +タグを付けても届かない", async () => {
		const result = await deliverEmail(h, {
			from: "a@ext.jp",
			to: "nobody+tag@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "nobody+tag@mail.tsubame.test" }),
		});
		expect(result.rejected).toBeTruthy();
	});

	scenario("FR-1-1", "同じメールを二度キューから処理しても増えない", async () => {
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", messageId: "dup-0001" }),
		});
		// at-least-once なので、同じメッセージが二度届くことがある。
		const again = h.pending.map((p) => ({ ...p }));
		await drainQueues(h);
		h.pending.push(...again);
		await drainQueues(h);

		const res = await owner.get("/api/v1/messages?limit=10");
		expect(res.body.data).toHaveLength(1);
	});
});
