import { beforeEach, describe, expect } from "vitest";
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
} from "../harness";

describe("FR-10 添付と生 MIME", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
	});

	// harness の mime() は multipart を組めないので、ここだけローカルに持つ。
	function multipartMime(opts: {
		from: string;
		to: string;
		subject?: string;
		messageId?: string;
		text?: string;
		attachment: { filename: string; contentType: string; content: string };
	}): string {
		const boundary = "e2e-boundary-0001";
		const lines = [
			`From: ${opts.from}`,
			`To: ${opts.to}`,
			`Subject: ${opts.subject ?? "添付つき"}`,
			`Message-ID: <${opts.messageId ?? "e2e-" + crypto.randomUUID()}@tsubame.test>`,
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

	scenario(
		"FR-10-1",
		"添付と生 MIME は R2 に置き、恒久 URL で毎回認可を通したときだけ取得できる（一時 URL は張らない）",
		async () => {
			const seeded = await seedDomain(h, { addresses: ["ai", "hito"] });
			const aiAddr = "ai@mail.tsubame.test";

			const attachmentContent = "添付ファイルの中身です。";
			const raw = multipartMime({
				from: "torihiki@ext.example.jp",
				to: aiAddr,
				subject: "添付つきのご連絡",
				messageId: "att-0001",
				text: "資料を添付します。",
				attachment: {
					filename: "資料.txt",
					contentType: "text/plain",
					content: attachmentContent,
				},
			});

			await deliverEmail(h, { from: "torihiki@ext.example.jp", to: aiAddr, raw });
			await drainQueues(h);

			const list = await owner.get("/api/v1/messages?limit=10");
			const msg = list.body.data[0];
			expect(msg.hasAttachments).toBe(true);

			const detail = await owner.get(`/api/v1/messages/${msg.id}`);
			expect(detail.status).toBe(200);
			expect(detail.body.attachments).toHaveLength(1);
			const att = detail.body.attachments[0];
			expect(att.filename).toBe("資料.txt");
			expect(att.contentType).toBe("text/plain");

			const attRes = await owner.get(`/api/v1/attachments/${att.id}`);
			expect(attRes.status).toBe(200);
			expect(attRes.headers.get("content-type")).toBe("text/plain");
			expect(attRes.headers.get("content-disposition")).toContain("attachment");
			expect(attRes.body).toContain(attachmentContent);

			const rawRes = await owner.get(`/api/v1/messages/${msg.id}/raw`);
			expect(rawRes.status).toBe(200);
			expect(rawRes.headers.get("content-type")).toBe("message/rfc822");
			expect(rawRes.body).toContain("Message-ID: <att-0001@tsubame.test>");
			expect(rawRes.body).toContain(attachmentContent);

			const userRes = await owner.post("/api/v1/admin/users", {
				email: "bot@tsubame.test",
				name: "見積ボット",
				role: "agent",
			});
			expect(userRes.status).toBe(201);
			const userId = userRes.body.id as string;

			const grantRes = await owner.put(`/api/v1/admin/users/${userId}/grants`, [
				{ addressId: seeded.addressIds.hito!, level: "read" },
			]);
			expect(grantRes.status).toBe(200);

			const keyRes = await owner.post("/api/v1/admin/api-keys", {
				userId,
				name: "見積ボット本番",
				scopes: ["read"],
				addressIds: [seeded.addressIds.hito!],
			});
			expect(keyRes.status).toBe(201);
			const token = keyRes.body.token as string;

			const bot = createClient(h);
			bot.useKey(token);
			const deniedAtt = await bot.get(`/api/v1/attachments/${att.id}`);
			expect([403, 404]).toContain(deniedAtt.status);
			const deniedRaw = await bot.get(`/api/v1/messages/${msg.id}/raw`);
			expect([403, 404]).toContain(deniedRaw.status);
		},
	);

	scenario("FR-10-2", "ゴミ箱のメッセージの添付と生 MIME は includeTrash 無しでは 404", async () => {
		await seedDomain(h, { addresses: ["ai"] });
		const aiAddr = "ai@mail.tsubame.test";

		const raw = multipartMime({
			from: "torihiki@ext.example.jp",
			to: aiAddr,
			subject: "ゴミ箱に入れる資料",
			attachment: { filename: "資料.txt", contentType: "text/plain", content: "中身" },
		});

		await deliverEmail(h, { from: "torihiki@ext.example.jp", to: aiAddr, raw });
		await drainQueues(h);

		const list = await owner.get("/api/v1/messages?limit=10");
		const msg = list.body.data[0];
		const patched = await owner.patch(`/api/v1/messages/${msg.id}`, { status: "trash" });
		expect(patched.status).toBe(200);

		const detail = await owner.get(`/api/v1/messages/${msg.id}?includeTrash=true`);
		const attId = detail.body.attachments[0].id;

		const deniedAtt = await owner.get(`/api/v1/attachments/${attId}`);
		expect(deniedAtt.status).toBe(404);
		const deniedRaw = await owner.get(`/api/v1/messages/${msg.id}/raw`);
		expect(deniedRaw.status).toBe(404);

		const allowedAtt = await owner.get(`/api/v1/attachments/${attId}?includeTrash=true`);
		expect(allowedAtt.status).toBe(200);
		expect(allowedAtt.body).toContain("中身");
		const allowedRaw = await owner.get(`/api/v1/messages/${msg.id}/raw?includeTrash=true`);
		expect(allowedRaw.status).toBe(200);
	});

	scenario("FR-10-1", "送信者が HTML や SVG と名乗る添付は、ブラウザが描画しない型で返す", async () => {
		await seedDomain(h, { addresses: ["ai"] });
		const aiAddr = "ai@mail.tsubame.test";

		for (const [filename, contentType] of [
			["invoice.html", "text/html"],
			["logo.svg", "image/svg+xml"],
			["photo.png", "IMAGE/PNG; name=photo.png"],
		] as const) {
			await deliverEmail(h, {
				from: "evil@ext.example.jp",
				to: aiAddr,
				raw: multipartMime({
					from: "evil@ext.example.jp",
					to: aiAddr,
					subject: filename,
					attachment: { filename, contentType, content: "<script>alert(1)</script>" },
				}),
			});
		}
		await drainQueues(h);

		const served: Record<string, string | null> = {};
		const list = await owner.get("/api/v1/messages?limit=10");
		for (const m of list.body.data) {
			const detail = await owner.get(`/api/v1/messages/${m.id}`);
			const att = detail.body.attachments[0];
			const res = await owner.get(`/api/v1/attachments/${att.id}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-disposition")).toContain("attachment");
			served[att.filename] = res.headers.get("content-type");
		}
		expect(served).toEqual({
			"invoice.html": "application/octet-stream",
			"logo.svg": "application/octet-stream",
			"photo.png": "image/png",
		});
	});
});
