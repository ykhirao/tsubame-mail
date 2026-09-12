import { beforeEach, describe, expect } from "vitest";
import { scenario } from "../registry";
import { getDb, schema } from "@/db/client";
import { newId } from "@/lib/id";
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

describe("FR-19 メールボックスの非表示", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
	});

	scenario(
		"FR-19-2",
		"非表示にすると一覧・スレッド・検索から外れ、address 指定と includeHidden で出る",
		async () => {
			const seeded = await seedDomain(h, { addresses: ["vis", "hid"] });
			const hidId = seeded.addressIds["hid"]!;
			await deliverEmail(h, {
				from: "a@ext.jp",
				to: "vis@mail.tsubame.test",
				raw: mime({ from: "a@ext.jp", to: "vis@mail.tsubame.test", subject: "見える連絡" }),
			});
			await deliverEmail(h, {
				from: "a@ext.jp",
				to: "hid@mail.tsubame.test",
				raw: mime({ from: "a@ext.jp", to: "hid@mail.tsubame.test", subject: "秘密の知らせ" }),
			});
			await drainQueues(h);

			const before = await owner.get("/api/v1/messages");
			expect(JSON.stringify(before.body)).toContain("秘密の知らせ");

			const patched = await owner.patch(`/api/v1/addresses/${hidId}/hidden`, { hidden: true });
			expect(patched.status).toBe(200);

			// まとめた受信箱・検索・スレッド一覧から外れる
			const list = await owner.get("/api/v1/messages");
			expect(list.body.data.map((m: { subject: string }) => m.subject)).not.toContain("秘密の知らせ");
			const search = await owner.get("/api/v1/messages?q=秘密");
			expect(search.body.data.map((m: { subject: string }) => m.subject)).not.toContain("秘密の知らせ");
			const threads = await owner.get("/api/v1/threads");
			expect(threads.body.data.map((t: { subject: string }) => t.subject)).not.toContain("秘密の知らせ");

			// address で名指しすると出る
			const scoped = await owner.get(`/api/v1/messages?address=${hidId}`);
			expect(scoped.status).toBe(200);
			expect(scoped.body.data.map((m: { subject: string }) => m.subject)).toContain("秘密の知らせ");

			// includeHidden=true でまとめ一覧・検索に出す
			const include = await owner.get("/api/v1/messages?includeHidden=true");
			expect(include.body.data.map((m: { subject: string }) => m.subject)).toContain("秘密の知らせ");
			const searchInclude = await owner.get("/api/v1/messages?q=秘密&includeHidden=true");
			expect(searchInclude.body.data.map((m: { subject: string }) => m.subject)).toContain("秘密の知らせ");
		},
	);

	scenario("FR-19-2", "割り当てのないアドレスは非表示にできず 404", async () => {
		const seeded = await seedDomain(h, { addresses: ["mine"] });
		const db = getDb(h.env);
		const extraId = newId("address");
		await db.insert(schema.addresses).values({
			id: extraId,
			domainId: seeded.domainId,
			localPart: "other",
			address: "other@mail.tsubame.test",
			kind: "mailbox",
			isCatchAll: false,
		});

		const res = await owner.patch(`/api/v1/addresses/${extraId}/hidden`, { hidden: true });
		expect(res.status).toBe(404);
	});

	scenario("FR-19-2", "非表示にしても通知は届き続ける", async () => {
		const seeded = await seedDomain(h, { addresses: ["notice"] });
		const noticeId = seeded.addressIds["notice"]!;

		// 相手に通知が届くかを見るので member + 端末を使う。
		const created = await createUserViaApi(h, owner, {
			email: "notice@tsubame.test",
			name: "通知受け取り",
			role: "member",
		});
		expect(created.status).toBe(201);
		const memberId = created.body.id as string;
		await owner.put(`/api/v1/admin/users/${memberId}/grants`, { grants: [{ addressId: noticeId, level: "write" }] });
		const constC = createClient(h);
		await constC.post("/api/v1/auth/login", {
			email: "notice@tsubame.test",
			password: created.body.temporaryPassword as string,
		});
		await constC.patch("/api/v1/me", {
			currentPassword: created.body.temporaryPassword as string,
			newPassword: "notice-own-password",
		});
		await constC.post("/api/v1/auth/login", { email: "notice@tsubame.test", password: "notice-own-password" });

		const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
		const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
		const { toBase64Url } = await import("@/services/webpush");
		await constC.post("/api/v1/me/devices", {
			endpoint: `https://fcm.googleapis.com/fcm/send/p/${crypto.randomUUID()}`,
			keys: { p256dh: toBase64Url(pub), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) },
			name: "受信用",
			platform: "ios",
		});

		await constC.patch(`/api/v1/addresses/${noticeId}/hidden`, { hidden: true });

		const { enableVapid } = await import("../harness");
		const sends = await enableVapid(h);
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "notice@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "notice@mail.tsubame.test", subject: "非表示でも通知" }),
		});
		await drainQueues(h);

		expect(sends).toHaveLength(1);
		expect(sends[0]!.method).toBe("POST");
	});

	scenario("FR-19-2", "非表示でも直接スレッドを開ける", async () => {
		const seeded = await seedDomain(h, { addresses: ["hid"] });
		const hidId = seeded.addressIds["hid"]!;
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "hid@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "hid@mail.tsubame.test", subject: "詳細を開く" }),
		});
		await drainQueues(h);
		await owner.patch(`/api/v1/addresses/${hidId}/hidden`, { hidden: true });

		// まとめ一覧には出ないが、スレッドそのものは直接開ける。
		const threads = await owner.get("/api/v1/threads");
		expect(threads.body.data.map((t: { subject: string }) => t.subject)).not.toContain("詳細を開く");

		const scoped = await owner.get(`/api/v1/threads?address=${hidId}`);
		const threadId = scoped.body.data[0]?.id as string | undefined;
		expect(threadId).toBeDefined();
		const detail = await owner.get(`/api/v1/threads/${threadId}`);
		expect(detail.status).toBe(200);
		expect(detail.body.subject).toBe("詳細を開く");
	});

	scenario("FR-19-2", "非表示 150 件でも一覧が 500 にならず除外できる", async () => {
		const seeded = await seedDomain(h, { addresses: ["seed"] });
		const me = await owner.get("/api/v1/me");
		const ownerId = me.body.id as string;
		const db = getDb(h.env);

		const hiddenSubjects: string[] = [];
		for (let i = 0; i < 150; i++) {
			const id = newId("address");
			await db.insert(schema.addresses).values({
				id,
				domainId: seeded.domainId,
				localPart: `h${i}`,
				address: `h${i}@mail.tsubame.test`,
				kind: "mailbox",
				isCatchAll: false,
			});
			await db.insert(schema.addressGrants).values({
				userId: ownerId,
				addressId: id,
				level: "read",
				hidden: true,
			});
			const subject = `大量非表示-${i}`;
			hiddenSubjects.push(subject);
			await db.insert(schema.messages).values({
				id: newId("message"),
				threadId: null,
				addressId: id,
				direction: "inbound",
				status: "received",
				fromAddr: "a@ext.jp",
				toAddr: `h${i}@mail.tsubame.test`,
				subject,
				receivedAt: new Date(),
			});
		}

		const res = await owner.get("/api/v1/messages?limit=100");
		expect(res.status).toBe(200);
		const returned = res.body.data.map((m: { subject: string }) => m.subject);
		for (const s of hiddenSubjects) expect(returned).not.toContain(s);

		const include = await owner.get("/api/v1/messages?limit=100&includeHidden=true");
		expect(include.status).toBe(200);
	});
});
