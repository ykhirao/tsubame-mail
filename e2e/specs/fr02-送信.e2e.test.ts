import { beforeEach, describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "@/worker";
import type { AnyQueueMessage } from "@/services/queue";
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

describe("FR-2 送信", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
	});

	function captureEmail() {
		const sent: { from: string; to: string; raw: string }[] = [];
		(h.env as any).EMAIL = {
			send: async (m: any) => {
				// miniflare の EmailMessage は raw を `EmailMessage::raw` キーに持つ。
				const raw = m["EmailMessage::raw"];
				sent.push({ from: m.from, to: m.to, raw });
				return { messageId: "mock-message-id" };
			},
		};
		return sent;
	}

	function headerValue(raw: string, name: string): string {
		const m = raw.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
		return m ? m[1]!.trim() : "";
	}

	function decodeHeaderValue(value: string): string {
		return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_m, _cs, enc, data) => {
			if (enc.toUpperCase() === "B") {
				const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
				return new TextDecoder().decode(bytes);
			}
			return data.replace(/_/g, " ");
		});
	}

	function failEmail() {
		(h.env as any).EMAIL = {
			send: async () => {
				throw new Error("SMTP 接続失敗");
			},
		};
	}

	async function drainOne(): Promise<void> {
		const item = h.pending.shift();
		if (!item) return;
		const batch = {
			queue: item.queue === "inbound" ? "tsubame-inbound" : "tsubame-outbound",
			messages: [
				{
					id: crypto.randomUUID(),
					timestamp: new Date(),
					body: item.body,
					attempts: 1,
					ack() {},
					retry(opts?: { delaySeconds?: number }) {
						h.retried.push({ body: item.body, delaySeconds: opts?.delaySeconds });
					},
				},
			],
			ackAll() {},
			retryAll() {},
		} as unknown as MessageBatch<AnyQueueMessage>;
		const ctx = createExecutionContext();
		await worker.queue!(batch, h.env, ctx);
		await waitOnExecutionContext(ctx);
	}

	scenario(
		"FR-2",
		"自分に割り当てられたアドレスから送信できる。差出人詐称は不可（サーバ側で検証）。",
		async () => {
			const seeded = await seedDomain(h, { addresses: ["ai", "hito"] });
			const aiAddr = "ai@mail.tsubame.test";
			const hitoAddr = "hito@mail.tsubame.test";

			const sent = captureEmail();

			const res = await owner.post("/api/v1/messages", {
				from: aiAddr,
				to: "torihiki@ext.example.jp",
				subject: "日本語の件名です",
				text: "本文です。",
			});
			expect(res.status).toBe(202);
			expect(res.body.status).toBe("queued");
			const messageId = res.body.id as string;
			expect(messageId).toBeTruthy();

			const { getDb } = await import("@/db/client");
			const { outboundJobs, messages } = await import("@/db/schema");
			const db = getDb(h.env);
			const job = await db
				.select()
				.from(outboundJobs)
				.where(eq(outboundJobs.messageId, messageId))
				.get();
			expect(job).toBeTruthy();
			expect(job!.status).toBe("queued");
			expect(h.pending.some((p) => p.queue === "outbound")).toBe(true);

			await drainQueues(h);
			const m = await db.select().from(messages).where(eq(messages.id, messageId)).get();
			expect(m!.status).toBe("sent");

			expect(sent).toHaveLength(1);
			const raw = sent[0]!.raw;
			expect(raw).toContain(`From: <${aiAddr}>`);
			expect(raw).toContain("To: <torihiki@ext.example.jp>");
			expect(decodeHeaderValue(headerValue(raw, "Subject"))).toBe("日本語の件名です");
			expect(raw).toMatch(/Message-ID: <[^>]+@mail\.tsubame\.test>/);

			const userRes = await owner.post("/api/v1/admin/users", {
				email: "bot@tsubame.test",
				name: "見積ボット",
				role: "agent",
			});
			expect(userRes.status).toBe(201);
			const userId = userRes.body.id as string;

			const grantRes = await owner.put(`/api/v1/admin/users/${userId}/grants`, [
				{ addressId: seeded.addressIds.ai!, level: "write" },
			]);
			expect(grantRes.status).toBe(200);

			const keyRes = await owner.post("/api/v1/admin/api-keys", {
				userId,
				name: "見積ボット本番",
				scopes: ["send"],
				addressIds: [seeded.addressIds.ai!],
			});
			expect(keyRes.status).toBe(201);
			const token = keyRes.body.token as string;

			const bot = createClient(h);
			bot.useKey(token);
			const spoof = await bot.post("/api/v1/messages", {
				from: hitoAddr,
				to: "torihiki@ext.example.jp",
				subject: "詐称",
				text: "本文",
			});
			expect(spoof.status).toBe(403);
		},
	);

	scenario("FR-2", "返信はスレッドを維持する（In-Reply-To / References を引き継ぐ）。", async () => {
		await seedDomain(h, { addresses: ["ai"] });
		const aiAddr = "ai@mail.tsubame.test";

		await deliverEmail(h, {
			from: "torihiki@ext.example.jp",
			to: aiAddr,
			raw: mime({
				from: "取引先 <torihiki@ext.example.jp>",
				to: aiAddr,
				subject: "見積書の件",
				messageId: "thread-0001",
				body: "先日の見積書をお送りします。",
			}),
		});
		await drainQueues(h);

		const list = await owner.get("/api/v1/messages?limit=10");
		const original = list.body.data[0];
		expect(original.subject).toBe("見積書の件");

		const sent = captureEmail();

		const reply = await owner.post(`/api/v1/messages/${original.id}/reply`, {
			text: "承知しました。",
		});
		expect(reply.status).toBe(202);
		await drainQueues(h);

		expect(sent).toHaveLength(1);
		const raw = sent[0]!.raw;
		expect(decodeHeaderValue(headerValue(raw, "Subject"))).toBe("Re: 見積書の件");
		expect(raw).not.toContain("Re: Re:");

		expect(raw).toContain("In-Reply-To: <thread-0001@tsubame.test>");
		expect(raw).toContain("References: <thread-0001@tsubame.test>");

		const after = await owner.get("/api/v1/messages?limit=10");
		const threadIds = new Set(after.body.data.map((m: any) => m.threadId));
		expect(after.body.data).toHaveLength(2);
		expect(threadIds.size).toBe(1);
	});

	scenario("FR-2", "添付ファイルを送れる。", async () => {
		await seedDomain(h, { addresses: ["ai"] });
		const aiAddr = "ai@mail.tsubame.test";

		const sent = captureEmail();

		const content = "hello attachment";
		const base64 = btoa(content);
		const res = await owner.post("/api/v1/messages", {
			from: aiAddr,
			to: "torihiki@ext.example.jp",
			subject: "添付つき",
			text: "資料を添付します。",
			attachments: [{ filename: "資料.txt", contentType: "text/plain", base64 }],
		});
		expect(res.status).toBe(202);
		await drainQueues(h);

		const { getDb } = await import("@/db/client");
		const { attachments } = await import("@/db/schema");
		const db = getDb(h.env);
		const att = await db
			.select()
			.from(attachments)
			.where(eq(attachments.messageId, res.body.id))
			.get();
		expect(att).toBeTruthy();
		expect(att!.filename).toBe("資料.txt");
		expect(att!.contentType).toBe("text/plain");
		expect(att!.sizeBytes).toBe(content.length);

		const obj = await h.env.BUCKET.get(att!.r2Key);
		expect(obj).toBeTruthy();
		expect(await obj!.text()).toBe(content);

		expect(sent).toHaveLength(1);
		const raw = sent[0]!.raw;
		// #119: 非 ASCII のファイル名はヘッダで RFC 2231 符号化される（DB の filename は素のまま）。
		expect(raw).not.toContain("資料.txt");
		expect(raw).toContain("filename*=UTF-8''%E8%B3%87%E6%96%99.txt");
		expect(raw).toContain(base64);
	});

	scenario("FR-2", "送信は outbound_jobs で状態を持ち、失敗は再試行する。", async () => {
		await seedDomain(h, { addresses: ["ai"] });
		const aiAddr = "ai@mail.tsubame.test";

		const { getDb } = await import("@/db/client");
		const { outboundJobs, messages } = await import("@/db/schema");
		const db = getDb(h.env);

		failEmail();

		const res = await owner.post("/api/v1/messages", {
			from: aiAddr,
			to: "torihiki@ext.example.jp",
			subject: "再試行のテスト",
			text: "本文",
		});
		expect(res.status).toBe(202);
		const messageId = res.body.id as string;

		await drainOne();
		let job = await db
			.select()
			.from(outboundJobs)
			.where(eq(outboundJobs.messageId, messageId))
			.get();
		expect(job!.status).toBe("queued");
		expect(job!.attempts).toBe(1);
		expect(job!.lastError).toBe("SMTP 接続失敗");
		expect(job!.nextAttemptAt).toBeTruthy();
		expect(h.pending.some((p) => p.queue === "outbound")).toBe(true);
		const firstNext = job!.nextAttemptAt!.getTime();

		await drainOne();
		job = await db
			.select()
			.from(outboundJobs)
			.where(eq(outboundJobs.messageId, messageId))
			.get();
		expect(job!.attempts).toBe(2);
		expect(job!.nextAttemptAt!.getTime()).toBeGreaterThan(firstNext);

		await drainOne();
		job = await db
			.select()
			.from(outboundJobs)
			.where(eq(outboundJobs.messageId, messageId))
			.get();
		expect(job!.attempts).toBe(3);
		expect(job!.nextAttemptAt!.getTime()).toBeGreaterThan(firstNext);

		await drainOne();
		job = await db
			.select()
			.from(outboundJobs)
			.where(eq(outboundJobs.messageId, messageId))
			.get();
		expect(job!.status).toBe("failed");
		expect(job!.attempts).toBe(4);
		const m = await db.select().from(messages).where(eq(messages.id, messageId)).get();
		expect(m!.status).toBe("failed");
		expect(
			h.pending.filter((p) => p.queue === "outbound" && (p.body as { kind: string }).kind !== "notify"),
		).toHaveLength(0);
	});
});
