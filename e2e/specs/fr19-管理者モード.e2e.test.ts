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
	seedDomain,
	type Client,
	type Harness,
	createUserViaApi,
} from "../harness";

describe("FR-19 見るメールの範囲（管理者モード）", () => {
	let h: Harness;
	let owner: Client;
	let msgId: string;
	let threadId: string;
	let attId: string;

	// harness の mime() は multipart を組めないので、添付つきだけローカルに持つ（fr10 と同じ）。
	function multipartMime(opts: {
		from: string;
		to: string;
		subject?: string;
		messageId?: string;
		text?: string;
		attachment: { filename: string; contentType: string; content: string };
	}): string {
		const boundary = "fr19-boundary-0001";
		const lines = [
			`From: ${opts.from}`,
			`To: ${opts.to}`,
			`Subject: ${opts.subject ?? "添付つき"}`,
			`Message-ID: <${opts.messageId ?? "fr19-" + crypto.randomUUID()}@tsubame.test>`,
			`Date: ${new Date().toUTCString()}`,
			"MIME-Version: 1.0",
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			"",
			`--${boundary}`,
			'Content-Type: text/plain; charset="UTF-8"',
			"",
			opts.text ?? "本文です。",
			`--${boundary}`,
			`Content-Type: ${opts.attachment.contentType}`,
			`Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
			"",
			opts.attachment.content,
			`--${boundary}--`,
			"",
		];
		return lines.join("\r\n");
	}

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		const me = await owner.get("/api/v1/me");
		const ownerId = me.body.id as string;
		const seeded = await seedDomain(h, { addresses: ["annai", "naisho"] });
		const naisho = seeded.addressIds.naisho!;

		// seedDomain が owner にも naisho を割り当てるので、外して「他人のアドレス」にする。
		const db = getDb(h.env);
		await db
			.delete(schema.addressGrants)
			.where(
				and(
					eq(schema.addressGrants.userId, ownerId),
					eq(schema.addressGrants.addressId, naisho),
				),
			);
		// 別の member に naisho を割り当てる。
		const user = await createUserViaApi(h, owner, {
			email: "naisho-bangai@tsubame.test",
			name: "内所担当",
			role: "member",
		});
		await owner.put(`/api/v1/admin/users/${user.body.id}/grants`, {
			grants: [{ addressId: naisho, level: "write" }],
		});

		// 添付つきのメールを naisho に届ける。
		await deliverEmail(h, {
			from: "hisho@ext.example.jp",
			to: "naisho@mail.tsubame.test",
			raw: multipartMime({
				from: "hisho@ext.example.jp",
				to: "naisho@mail.tsubame.test",
				subject: "内密の相談",
				messageId: "fr19-secret-0001",
				text: "内部の資料です。",
				attachment: {
					filename: "秘密.txt",
					contentType: "text/plain",
					content: "秘密の中身",
				},
			}),
		});
		await drainQueues(h);

		const [msg] = await db
			.select()
			.from(schema.messages)
			.where(eq(schema.messages.addressId, naisho))
			.limit(1);
		expect(msg).toBeTruthy();
		msgId = msg!.id;
		threadId = msg!.threadId ?? "";
		const [att] = await db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.messageId, msgId))
			.limit(1);
		expect(att).toBeTruthy();
		attId = att!.id;
	});

	scenario("FR-19-1", "owner は普段、他の人に割り当てたアドレスのメールを一覧・検索・スレッド・添付で見えない", async () => {
		expect((await owner.get(`/api/v1/messages/${msgId}`)).status).toBe(404);
		expect((await owner.get(`/api/v1/messages/${msgId}/raw`)).status).toBe(404);
		expect((await owner.get(`/api/v1/threads/${threadId}`)).status).toBe(404);
		expect((await owner.get(`/api/v1/attachments/${attId}`)).status).toBe(404);

		const list = await owner.get("/api/v1/messages?limit=50");
		expect(list.body.data.some((m: { id: string }) => m.id === msgId)).toBe(false);
		const search = await owner.get(`/api/v1/messages?q=${encodeURIComponent("内密")}`);
		expect(search.body.data.some((m: { id: string }) => m.id === msgId)).toBe(false);
	});

	scenario("FR-19-1", "管理者モードに入ると読め、変更は 403、出るとまた見えなくなる", async () => {
		expect((await owner.post("/api/v1/me/admin-mode", { enabled: true })).status).toBe(200);
		expect((await owner.get("/api/v1/me")).body.adminMode).toBe(true);

		expect((await owner.get(`/api/v1/messages/${msgId}`)).status).toBe(200);
		expect((await owner.get(`/api/v1/messages/${msgId}/raw`)).status).toBe(200);
		expect((await owner.get(`/api/v1/threads/${threadId}`)).status).toBe(200);
		expect((await owner.get(`/api/v1/attachments/${attId}`)).status).toBe(200);
		const search = await owner.get(`/api/v1/messages?q=${encodeURIComponent("内密")}`);
		expect(search.body.data.some((m: { id: string }) => m.id === msgId)).toBe(true);

		// 管理者モードでも他人のメールの変更（既読）は 403 で、既読にならない。
		expect((await owner.patch(`/api/v1/messages/${msgId}`, { isRead: true })).status).toBe(403);
		const after = await owner.get(`/api/v1/messages/${msgId}`);
		expect(after.body.isRead).toBe(false);

		expect((await owner.post("/api/v1/me/admin-mode", { enabled: false })).status).toBe(200);
		expect((await owner.get(`/api/v1/messages/${msgId}`)).status).toBe(404);
		expect((await owner.get(`/api/v1/messages/${msgId}/raw`)).status).toBe(404);
	});

	scenario("FR-19-1", "owner の API キーでは管理者モードに入れない", async () => {
		const keyRes = await owner.post("/api/v1/me/api-keys", {
			name: "管理用",
			scopes: ["read", "admin"],
			addressIds: null,
		});
		expect(keyRes.status).toBe(201);
		const c = createClient(h);
		c.useKey(keyRes.body.token);
		expect((await c.post("/api/v1/me/admin-mode", { enabled: true })).status).toBe(403);
	});
});
