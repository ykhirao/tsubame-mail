import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { addresses, attachments, messages } from "@/db/schema";
import { freshHarness, loginAsOwner, seedDomain } from "../e2e/harness";

// アドレスを消すと D1 は messages と attachments を cascade で消す。その瞬間に
// R2 のキーを知る手段が無くなるので、消す前に集めて R2 からも消さないと、
// 生 MIME と添付が誰からも参照されないまま課金対象として残り続ける。
describe("アドレスの削除と R2", () => {
	it("そのアドレスの生 MIME と添付を R2 からも消す", async () => {
		const h = await freshHarness();
		// 削除は Cloudflare のルーティング規則にも触る。ここで見たいのは R2 の後片付けなので、
		// ゾーン側は「規則なし」を返すだけにする。
		(h.env as { CF_API_TOKEN: string }).CF_API_TOKEN = "test-token";
		(h.env as { CF_ACCOUNT_ID: string }).CF_ACCOUNT_ID = "test-account";
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ success: true, result: [], result_info: { page: 1, total_pages: 1 } }), {
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		const owner = await loginAsOwner(h);
		const { addressIds } = await seedDomain(h, { addresses: ["gone", "stays"] });
		const doomedId = addressIds.gone!;
		const keptId = addressIds.stays!;
		const db = getDb(h.env);

		const rawKey = "raw/2026/09/msg_doomed.eml";
		const attKey = "att/msg_doomed/att_doomed";
		const keptRawKey = "raw/2026/09/msg_kept.eml";
		await h.env.BUCKET.put(rawKey, "生 MIME");
		await h.env.BUCKET.put(attKey, "添付の中身");
		await h.env.BUCKET.put(keptRawKey, "消えないほう");

		const insertMessage = async (id: string, addressId: string, rawR2Key: string) => {
			await db.insert(messages).values({
				id,
				addressId,
				direction: "inbound",
				status: "received",
				fromAddr: "them@example.net",
				toAddr: "me@example.test",
				subject: "件名",
				rawR2Key,
				receivedAt: new Date(),
			});
		};
		await insertMessage("msg_doomed", doomedId, rawKey);
		await insertMessage("msg_kept", keptId, keptRawKey);
		await db.insert(attachments).values({
			id: "att_doomed",
			messageId: "msg_doomed",
			filename: "a.pdf",
			contentType: "application/pdf",
			sizeBytes: 10,
			isInline: false,
			r2Key: attKey,
		});

		const res = await owner.del(`/api/v1/admin/addresses/${doomedId}`);
		expect(res.status).toBe(200);

		expect(await h.env.BUCKET.head(rawKey)).toBeNull();
		expect(await h.env.BUCKET.head(attKey)).toBeNull();
		// 別のアドレスのものは巻き添えにしない。
		expect(await h.env.BUCKET.head(keptRawKey)).not.toBeNull();
		expect(await db.select().from(addresses).where(eq(addresses.id, doomedId)).get()).toBeUndefined();
	});
});
