import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { getDb } from "@/db/client";
import { addresses, attachments, domains, messages, routingRules, threads, webhookDeliveries, webhooks } from "@/db/schema";
import { fakeCtx, resetDb, sampleMime } from "./helpers";
import { MAX_ATTACHMENTS, STORED_BYTES, processInbound } from "@/domain/mail/inbound";
import { handleIncomingEmail, MAX_RAW_BYTES } from "@/domain/routing/incoming";
import { saveRaw } from "@/services/r2";
import * as webhooksSvc from "@/services/webhooks";
import { newId } from "@/lib/id";
import { eq } from "drizzle-orm";
import { normalizeAddress, parseAddressList } from "@/domain/mail/address";
import { replyAllRecipients } from "@/api/v1/outbound";
import type { InboundQueueMessage } from "@/services/queue";

const DOM_ID = "dom_test";
const ADR = "adr_test";
const DOMAIN = "example.com";

async function seed(): Promise<void> {
	const db = getDb(env);
	await db.insert(domains).values({ id: DOM_ID, name: DOMAIN, zoneId: "z", zoneName: DOMAIN, mode: "apex" });
	await db.insert(addresses).values({
		id: ADR,
		domainId: DOM_ID,
		localPart: "a",
		address: "a@example.com",
		kind: "mailbox",
	});
}

async function storeRaw(raw: string | Uint8Array<ArrayBuffer> = sampleMime()): Promise<string> {
	const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
	return saveRaw(env, newId("message"), new Blob([bytes]).stream() as ReadableStream<Uint8Array>, new Date());
}

function fakeEmailMessage(opts: {
	from: string;
	to: string;
	raw: string;
	headers?: Headers;
}): ForwardableEmailMessage & { rejected: string | null; forwardedTo: { to: string; headers: Headers }[] } {
	const bytes = new TextEncoder().encode(opts.raw);
	const state = { rejected: null as string | null, forwardedTo: [] as { to: string; headers: Headers }[] };
	return {
		from: opts.from,
		to: opts.to,
		raw: new Blob([bytes]).stream() as ReadableStream<Uint8Array>,
		rawSize: bytes.byteLength,
		headers: opts.headers ?? new Headers(),
		get rejected() {
			return state.rejected;
		},
		get forwardedTo() {
			return state.forwardedTo;
		},
		setReject(reason: string) {
			state.rejected = reason;
		},
		async forward(to: string, headers?: Headers) {
			state.forwardedTo.push({ to, headers: headers ?? new Headers() });
		},
		async reply() {
			throw new Error("reply は使わない");
		},
	} as unknown as ForwardableEmailMessage & { rejected: string | null; forwardedTo: { to: string; headers: Headers }[] };
}

function deeplyNestedMime(depth: number): string {
	// postal-mime は maxNestingDepth（既定 256）を超えると throw する。
	let body = "leaf";
	for (let i = 0; i < depth; i++) {
		const boundary = `B${i}`;
		body = [
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			"",
			`--${boundary}`,
			body,
			`--${boundary}--`,
		].join("\r\n");
	}
	return ["From: taro@example.com", "To: a@example.com", "Subject: nested", "MIME-Version: 1.0", body].join(
		"\r\n",
	);
}

function mimeWith(opts: { text?: string; attachments?: number }): string {
	const lines = [
		"From: taro@example.com",
		"To: a@example.com",
		"Subject: test",
		"Message-ID: <big-1@x.example>",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="B"',
		"",
		"--B",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		opts.text ?? "本文",
	];
	for (let i = 0; i < (opts.attachments ?? 0); i++) {
		lines.push(
			"--B",
			`Content-Type: application/octet-stream; name="f${i}.bin"`,
			`Content-Disposition: attachment; filename="f${i}.bin"`,
			"Content-Transfer-Encoding: base64",
			"",
			"AAAA",
		);
	}
	lines.push("--B--");
	return lines.join("\r\n");
}

async function storedRow(key: string) {
	return (await getDb(env).select().from(messages).where(eq(messages.rawR2Key, key)).get())!;
}

function payload(rawKey: string): InboundQueueMessage {
	return {
		kind: "inbound",
		addressId: ADR,
		rawKey,
		envelope: { from: "taro@example.com", to: "a@example.com" },
		receivedAt: Date.now(),
	};
}

describe("processInbound", () => {
	beforeEach(resetDb);

	it("R2 の生 MIME をパースして保存し、スレッドを立てる", async () => {
		await seed();
		const key = await storeRaw();
		await processInbound(payload(key), env, fakeCtx);

		const db = getDb(env);
		const rows = await db.select().from(messages).where(eq(messages.addressId, ADR)).all();
		expect(rows).toHaveLength(1);
		const m = rows[0]!;
		expect(m.toAddr).toContain("a@b.jp");
		expect(m.toAddr).toContain("c@d.jp");
		expect(m.rfcMessageId).toBe("abc-123@x.example");
		expect(m.threadId).toBeTruthy();
		expect(m.hasAttachments).toBe(true);

		const t = await db.select().from(threads).where(eq(threads.id, m.threadId as string)).get();
		expect(t?.messageCount).toBe(1);
		expect(t?.unreadCount).toBe(1);
	});

	it("同じ rawKey は二重処理しない（at-least-once 対策）", async () => {
		await seed();
		const key = await storeRaw();
		await processInbound(payload(key), env, fakeCtx);
		await processInbound(payload(key), env, fakeCtx);

		const db = getDb(env);
		const rows = await db.select().from(messages).where(eq(messages.rawR2Key, key)).all();
		expect(rows).toHaveLength(1);
	});

	it("同じ送信者の既存スレッドの In-Reply-To に刺さる", async () => {
		await seed();
		const db = getDb(env);
		const threadId = newId("thread");
		await db.insert(threads).values({
			id: threadId,
			addressId: ADR,
			lastMessageAt: new Date(1),
			messageCount: 1,
			unreadCount: 1,
		});
		await db.insert(messages).values({
			id: newId("message"),
			threadId,
			addressId: ADR,
			direction: "inbound",
			status: "received",
			fromAddr: "taro@example.com",
			toAddr: ADR,
			rfcMessageId: "prev-1@x.example",
			receivedAt: new Date(1),
		});

		const key = await storeRaw();
		await processInbound(payload(key), env, fakeCtx);

		const rows = await db.select().from(messages).where(eq(messages.rawR2Key, key)).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.threadId).toBe(threadId);

		const t = await db.select().from(threads).where(eq(threads.id, threadId)).get();
		expect(t?.messageCount).toBe(2);
		expect(t?.unreadCount).toBe(2);
	});

	it("既知の Message-ID を In-Reply-To に入れた第三者のメールは、他人のスレッドに入らない", async () => {
		await seed();
		const db = getDb(env);
		const threadId = newId("thread");
		await db.insert(threads).values({
			id: threadId,
			addressId: ADR,
			lastMessageAt: new Date(1),
			messageCount: 1,
			unreadCount: 1,
		});
		await db.insert(messages).values({
			id: newId("message"),
			threadId,
			addressId: ADR,
			direction: "inbound",
			status: "received",
			fromAddr: "partner@b.jp",
			toAddr: ADR,
			rfcMessageId: "prev-1@x.example",
			receivedAt: new Date(1),
		});

		const key = await storeRaw();
		await processInbound(payload(key), env, fakeCtx);

		const row = await storedRow(key);
		expect(row.threadId).not.toBe(threadId);
	});

	it("アドレスのルールは To ヘッダではなくエンベロープの宛先で照合する", async () => {
		await seed();
		await getDb(env).insert(routingRules).values({
			id: newId("rule"),
			scope: "address",
			addressId: ADR,
			name: "既読にする",
			action: "mark",
			matcher: { to: "a@example.com" },
			target: "read",
		});

		// sampleMime の To ヘッダは a@b.jp, c@d.jp で、実際の宛先 a@example.com を含まない。
		const key = await storeRaw();
		await processInbound(payload(key), env, fakeCtx);

		const row = await storedRow(key);
		expect(row.toAddr).not.toContain("a@example.com");
		expect(row.isRead).toBe(true);
	});

	it("長すぎる本文は D1 の 1 行に収まるよう切り詰め、切り詰めたことを本文に残す", async () => {
		await seed();
		const key = await storeRaw(mimeWith({ text: "あ".repeat(200_000) }));
		await processInbound(payload(key), env, fakeCtx);

		const row = await storedRow(key);
		const bytes = new TextEncoder().encode(row.textBody!).byteLength;
		expect(bytes).toBeLessThan(STORED_BYTES.text + 1024);
		expect(row.textBody).not.toContain("\uFFFD");
		expect(row.textBody).toContain("途中から先は保存していません");
	});

	it("添付の件数が上限を超えた分は保存せず、件数を本文に残す", async () => {
		await seed();
		const key = await storeRaw(mimeWith({ attachments: MAX_ATTACHMENTS + 3 }));
		await processInbound(payload(key), env, fakeCtx);

		const row = await storedRow(key);
		const saved = await getDb(env).select().from(attachments).where(eq(attachments.messageId, row.id)).all();
		expect(saved).toHaveLength(MAX_ATTACHMENTS);
		expect(row.hasAttachments).toBe(true);
		expect(row.textBody).toContain("添付 3 件は");
	});

	it("上限を超える生 MIME はパースせず、届いたことだけを残して例外にしない", async () => {
		await seed();
		const key = await storeRaw(new Uint8Array(MAX_RAW_BYTES + 1));
		await processInbound(payload(key), env, fakeCtx);
		await processInbound(payload(key), env, fakeCtx);

		const rows = await getDb(env).select().from(messages).where(eq(messages.rawR2Key, key)).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.fromAddr).toBe("taro@example.com");
		expect(rows[0]!.toAddr).toBe("a@example.com");
		expect(rows[0]!.sizeBytes).toBe(MAX_RAW_BYTES + 1);
		expect(rows[0]!.textBody).toContain("上限");
	});

	it("パースが例外を投げても痕跡を残して ack する（#20）", async () => {
		await seed();
		const key = await storeRaw(deeplyNestedMime(260));
		await expect(processInbound(payload(key), env, fakeCtx)).resolves.toBeUndefined();

		const rows = await getDb(env).select().from(messages).where(eq(messages.rawR2Key, key)).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.fromAddr).toBe("taro@example.com");
		expect(rows[0]!.toAddr).toBe("a@example.com");
		expect(rows[0]!.textBody).toContain("解析できません");
	});

	it("placeholder の from / to を正規化し、カンマ入り MAIL FROM を返信宛先に漏らさない（#82 再検査失敗）", async () => {
		await seed();
		// 解析不能な MIME（入れ子で postal-mime が throw）の placeholder 経路を再現する。
		const key = await storeRaw(deeplyNestedMime(260));
		await processInbound(
			{
				...payload(key),
				envelope: { from: "box,leak@evil.jp,zz@evil.com", to: "a@example.com" },
			},
			env,
			fakeCtx,
		);

		const row = await storedRow(key);
		// fromAddr は正規化できず空になり、toAddr は正規化されたまま残る。
		expect(row.fromAddr).toBe("");
		expect(row.toAddr).toBe("a@example.com");
		// 保存した from / to から replyAll の宛先を組み立てても leak は現れず、自分だけなので 0 件になる。
		const isSelf = (a: string) => normalizeAddress(a) === "a@example.com";
		const recipients = replyAllRecipients(
			parseAddressList(row.fromAddr),
			row.toAddr,
			row.ccAddr,
			isSelf,
			true,
		);
		expect(recipients.some((r) => r.address.includes("leak@"))).toBe(false);
		expect(recipients.some((r) => r.address.includes("zz@evil"))).toBe(false);
		expect(recipients).toHaveLength(0);
	});

	it("極端に古い Date ヘッダは投入時刻に落とし、カーソルが負数にならない（#19）", async () => {
		await seed();
		const raw = [
			"From: taro@example.com",
			"To: a@example.com",
			"Subject: old",
			"Date: Mon, 1 Jan 1900 00:00:00 +0000",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"hi",
		].join("\r\n");
		const key = await storeRaw(raw);
		const queuedAt = Date.now();
		await processInbound({ ...payload(key), receivedAt: queuedAt }, env, fakeCtx);

		const row = await storedRow(key);
		expect(row.receivedAt.getTime()).toBe(Math.floor(queuedAt / 1000) * 1000);
	});

	it("極端に未来の Date ヘッダも投入時刻に落とし、スレッド一覧の先頭に固定できない（#19）", async () => {
		await seed();
		const raw = [
			"From: taro@example.com",
			"To: a@example.com",
			"Subject: future",
			"Date: Fri, 1 Jan 2100 00:00:00 +0000",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"hi",
		].join("\r\n");
		const key = await storeRaw(raw);
		const queuedAt = Date.now();
		await processInbound({ ...payload(key), receivedAt: queuedAt }, env, fakeCtx);

		const row = await storedRow(key);
		expect(row.receivedAt.getTime()).toBe(Math.floor(queuedAt / 1000) * 1000);
	});

	it("日付を偽装した古い返信でスレッドの lastMessageAt を後退させられない（#19）", async () => {
		await seed();
		const db = getDb(env);
		const threadId = newId("thread");
		const recentSec = Math.floor(Date.now() / 1000);
		await db.insert(threads).values({
			id: threadId,
			addressId: ADR,
			lastMessageAt: new Date(recentSec * 1000),
			messageCount: 1,
			unreadCount: 1,
		});
		await db.insert(messages).values({
			id: newId("message"),
			threadId,
			addressId: ADR,
			direction: "inbound",
			status: "received",
			fromAddr: "taro@example.com",
			toAddr: ADR,
			rfcMessageId: "prev-1@x.example",
			receivedAt: new Date(recentSec * 1000),
		});

		const raw = [
			"From: taro@example.com",
			"To: a@example.com",
			"Subject: old reply",
			"Date: Mon, 1 Jan 2000 00:00:00 +0000",
			"In-Reply-To: <prev-1@x.example>",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"hi",
		].join("\r\n");
		const key = await storeRaw(raw);
		// キュー投入時刻もその古い Date に近ければ外れ値クランプに掛からず、
		// updateThreadStats 自体の max() が効くかを見られる。
		const queuedAt = Date.parse("2000-01-01T00:00:00Z");
		await processInbound({ ...payload(key), receivedAt: queuedAt }, env, fakeCtx);

		const t = await db.select().from(threads).where(eq(threads.id, threadId)).get();
		expect(t!.lastMessageAt.getTime()).toBe(recentSec * 1000);
	});

	it("アドレスルールの to 一致は +タグ を落とした基本アドレスにも当てる（#28）", async () => {
		await seed();
		await getDb(env).insert(routingRules).values({
			id: newId("rule"),
			scope: "address",
			addressId: ADR,
			name: "drop",
			action: "drop",
			matcher: { to: "a@example.com" },
		});

		const raw = [
			"From: taro@example.com",
			"To: a+tag@example.com",
			"Subject: tagged",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"hi",
		].join("\r\n");
		const key = await storeRaw(raw);
		await processInbound(
			{
				...payload(key),
				envelope: { from: "taro@example.com", to: "a+tag@example.com" },
			},
			env,
			fakeCtx,
		);

		const row = await storedRow(key);
		expect(row.status).toBe("trash");
	});

	it("アドレスルールの to 一致は引用ローカル部・末尾ドットの変装も基本アドレスとして扱う（#28）", async () => {
		await seed();
		await getDb(env).insert(routingRules).values({
			id: newId("rule"),
			scope: "address",
			addressId: ADR,
			name: "drop",
			action: "drop",
			matcher: { to: "a@example.com" },
		});

		const quotedKey = await storeRaw(
			['From: taro@example.com', 'To: "a"@example.com', "Subject: quoted", "MIME-Version: 1.0", "", "hi"].join(
				"\r\n",
			),
		);
		await processInbound(
			{ ...payload(quotedKey), envelope: { from: "taro@example.com", to: '"a"@example.com' } },
			env,
			fakeCtx,
		);
		expect((await storedRow(quotedKey)).status).toBe("trash");

		const dottedKey = await storeRaw(
			["From: taro@example.com", "To: a.@example.com", "Subject: dotted", "MIME-Version: 1.0", "", "hi"].join(
				"\r\n",
			),
		);
		await processInbound(
			{ ...payload(dottedKey), envelope: { from: "taro@example.com", to: "a.@example.com" } },
			env,
			fakeCtx,
		);
		expect((await storedRow(dottedKey)).status).toBe("trash");

		const mixedKey = await storeRaw(
			['From: taro@example.com', 'To: "a+x"@EXAMPLE.COM.', "Subject: mixed", "MIME-Version: 1.0", "", "hi"].join(
				"\r\n",
			),
		);
		await processInbound(
			{ ...payload(mixedKey), envelope: { from: "taro@example.com", to: '"a+x"@EXAMPLE.COM.' } },
			env,
			fakeCtx,
		);
		expect((await storedRow(mixedKey)).status).toBe("trash");
	});

	it("drop ルールはスレッドの未読数を減らし、受信箱に未読として残さない（#92）", async () => {
		await seed();
		await getDb(env).insert(routingRules).values({
			id: newId("rule"),
			scope: "address",
			addressId: ADR,
			name: "spam drop",
			action: "drop",
			matcher: { from: "spam@evil.jp" },
		});
		const raw = [
			"From: spam@evil.jp",
			"To: a@example.com",
			"Subject: 宣伝",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"お買い得",
		].join("\r\n");
		const key = await storeRaw(raw);
		await processInbound(
			{ ...payload(key), envelope: { from: "spam@evil.jp", to: ADR } },
			env,
			fakeCtx,
		);

		const row = await storedRow(key);
		expect(row.status).toBe("trash");
		const t = await getDb(env)
			.select()
			.from(threads)
			.where(eq(threads.id, row.threadId as string))
			.get();
		expect(t?.unreadCount).toBe(0);
	});

	it("message の insert が失敗しても空スレッドを残さず、再配達で新スレッドも作らない（#91）", async () => {
		await seed();
		const key = await storeRaw();
		const db = getDb(env);

		// 新規スレッド作成と message insert は同じ batch。片方が落ちると両方残らない。
		const batchSpy = vi.spyOn(env.DB, "batch").mockRejectedValue(new Error("D1 batch 一時障害"));
		await expect(processInbound(payload(key), env, fakeCtx)).rejects.toThrow("D1 batch 一時障害");
		expect((await db.select().from(threads).all()).length).toBe(0);
		expect((await db.select().from(messages).all()).length).toBe(0);

		batchSpy.mockRestore();
		await processInbound(payload(key), env, fakeCtx);

		const rows = await db.select().from(messages).where(eq(messages.rawR2Key, key)).all();
		expect(rows).toHaveLength(1);
		expect((await db.select().from(threads).all()).length).toBe(1);
	});

	it("R2 の本文読み込みが一時的に失敗しても placeholder にせず、再配達で本文を取り込む（#56）", async () => {
		await seed();
		const key = await storeRaw();

		const flakyEnv = {
			...env,
			BUCKET: {
				get: async (k: string) => {
					const real = await env.BUCKET.get(k);
					if (!real) return null;
					return { size: real.size, arrayBuffer: () => Promise.reject(new Error("R2 read 一時障害")) };
				},
			},
		} as unknown as CloudflareEnv;

		const threadsBefore = (await getDb(env).select().from(threads).all()).length;
		await expect(processInbound(payload(key), flakyEnv, fakeCtx)).rejects.toThrow("R2 read 一時障害");

		const afterFailure = await getDb(env).select().from(messages).where(eq(messages.rawR2Key, key)).all();
		expect(afterFailure).toHaveLength(0);
		expect(await getDb(env).select().from(threads).all()).toHaveLength(threadsBefore);

		// 再配達（同じ rawKey）。placeholder の行が残っていれば dup 判定で捨てられ、ここに来ない。
		await processInbound(payload(key), env, fakeCtx);

		const row = await storedRow(key);
		expect(row.toAddr).toContain("a@b.jp");
		expect(row.textBody).not.toContain("解析できません");
	});

	it("catch-all 経由で全角ローカル部宛に届いても address ルールに当たる（#73）", async () => {
		await seed();
		await getDb(env).insert(routingRules).values({
			id: newId("rule"),
			scope: "address",
			addressId: ADR,
			name: "drop",
			action: "drop",
			matcher: { to: "a@example.com" },
		});
		const key = await storeRaw(mimeWith({}));
		await processInbound(
			{ ...payload(key), envelope: { from: "taro@example.com", to: "ａ@example.com" } },
			env,
			fakeCtx,
		);
		expect((await storedRow(key)).status).toBe("trash");
	});

	it("Unicode ドメイン宛のエンベロープでも address ルールに当たる（#73）", async () => {
		await seed();
		await getDb(env).insert(routingRules).values({
			id: newId("rule"),
			scope: "address",
			addressId: ADR,
			name: "既読にする",
			action: "mark",
			matcher: { to: "a@xn--r8jz45g.jp" },
			target: "read",
		});
		const key = await storeRaw(mimeWith({}));
		await processInbound(
			{ ...payload(key), envelope: { from: "taro@example.com", to: "a@例え.jp" } },
			env,
			fakeCtx,
		);
		expect((await storedRow(key)).isRead).toBe(true);
	});

	it("添付の R2 put が一時失敗しても、再配達で完全になり二重に増えない（#77）", async () => {
		await seed();
		const key = await storeRaw(mimeWith({ attachments: 2 }));
		const db = getDb(env);

		const realBucket = env.BUCKET;
		let failOnce = true;
		const flakyEnv = {
			...env,
			BUCKET: new Proxy(realBucket, {
				get(t, p) {
					if (p === "put") {
						return async (...args: Parameters<R2Bucket["put"]>) => {
							const [key2] = args;
							if (failOnce && typeof key2 === "string" && key2.startsWith("att/")) {
								failOnce = false;
								throw new Error("R2 put 一時障害");
							}
							return realBucket.put(...args);
						};
					}
					const v = Reflect.get(t, p);
					return typeof v === "function" ? v.bind(t) : v;
				},
			}) as R2Bucket,
		} as unknown as CloudflareEnv;

		// 添付の R2 put は batch より先に走る。失敗すると行は残らず、再配達で最初からやり直す。
		await expect(processInbound(payload(key), flakyEnv, fakeCtx)).rejects.toThrow("R2 put 一時障害");
		expect((await db.select().from(messages).where(eq(messages.rawR2Key, key)).all()).length).toBe(0);

		// 再配達（実 env）で添付が揃い、thread も正しい。
		await processInbound(payload(key), env, fakeCtx);
		const row = await storedRow(key);
		const saved = await db.select().from(attachments).where(eq(attachments.messageId, row.id)).all();
		expect(saved).toHaveLength(2);
		expect(row.hasAttachments).toBe(true);

		// もう一度処理しても何も増えない。
		await processInbound(payload(key), env, fakeCtx);
		expect((await db.select().from(messages).where(eq(messages.rawR2Key, key)).all()).length).toBe(1);
		expect((await db.select().from(attachments).where(eq(attachments.messageId, row.id)).all()).length).toBe(2);
	});

	it("batch が一度失敗しても、再配達で完全になり二重に増えない（#77）", async () => {
		await seed();
		const key = await storeRaw(mimeWith({ attachments: 2 }));
		const db = getDb(env);

		const batchSpy = vi.spyOn(env.DB, "batch").mockRejectedValueOnce(new Error("D1 batch 一時障害"));
		await expect(processInbound(payload(key), env, fakeCtx)).rejects.toThrow("D1 batch 一時障害");
		expect((await db.select().from(messages).where(eq(messages.rawR2Key, key)).all()).length).toBe(0);
		expect((await db.select().from(threads).all()).length).toBe(0);

		batchSpy.mockRestore();
		await processInbound(payload(key), env, fakeCtx);
		const row = await storedRow(key);
		expect((await db.select().from(attachments).where(eq(attachments.messageId, row.id)).all()).length).toBe(2);
		const t = await db.select().from(threads).where(eq(threads.id, row.threadId as string)).get();
		expect(t?.messageCount).toBe(1);
		expect(t?.unreadCount).toBe(1);

		// さらに処理しても何も増えない。
		await processInbound(payload(key), env, fakeCtx);
		expect((await db.select().from(messages).where(eq(messages.rawR2Key, key)).all()).length).toBe(1);
		expect((await db.select().from(attachments).where(eq(attachments.messageId, row.id)).all()).length).toBe(2);
		expect((await db.select().from(threads).all()).length).toBe(1);
	});

	it("Webhook 配信が一時失敗しても、再配達で同じ payload の配信行が二重に作られない（#77）", async () => {
		await seed();
		const key = await storeRaw(mimeWith({}));
		const db = getDb(env);
		await db.insert(webhooks).values({
			id: newId("webhook"),
			name: "hook",
			url: "https://hook.example",
			secret: "s",
			events: ["message.received"],
			enabled: true,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 200 })),
		);

		const dispatchSpy = vi.spyOn(webhooksSvc, "dispatchMessageEvent");
		dispatchSpy.mockRejectedValueOnce(new Error("webhook dispatch 一時障害"));

		// batch は確定済みなので行が残るが、dispatch だけが失敗する。
		await expect(processInbound(payload(key), env, fakeCtx)).rejects.toThrow("webhook dispatch 一時障害");

		// 再配達は dup 判定で行を再利用し、dispatch だけを re-run して配信行を 1 本作る。
		await processInbound(payload(key), env, fakeCtx);
		const row = await storedRow(key);
		const dlv = () => db.select().from(webhookDeliveries).where(eq(webhookDeliveries.messageId, row.id)).all();
		expect((await dlv()).length).toBe(1);

		// さらにもう一度処理しても配信行は増えない。
		await processInbound(payload(key), env, fakeCtx);
		expect((await dlv()).length).toBe(1);
		expect((await db.select().from(messages).where(eq(messages.rawR2Key, key)).all()).length).toBe(1);

		dispatchSpy.mockRestore();
	});
});

describe("handleIncomingEmail", () => {
	beforeEach(resetDb);

	it("キュー投入の失敗を例外にし、waitUntil で握りつぶさない（#24）", async () => {
		await seed();
		const message = fakeEmailMessage({
			from: "taro@example.com",
			to: "a@example.com",
			raw: sampleMime(),
		});
		const failingSend = async () => {
			throw new Error("queue 一時障害");
		};
		const brokenEnv = { ...env, INBOUND_QUEUE: { send: failingSend } } as unknown as CloudflareEnv;

		await expect(handleIncomingEmail(message, brokenEnv, fakeCtx)).rejects.toThrow("queue 一時障害");
		expect(message.rejected).toBeNull();
	});

	it("転送ヘッダにエンベロープ宛先を載せない（#40）", async () => {
		const db = getDb(env);
		await db.insert(domains).values({ id: DOM_ID, name: DOMAIN, zoneId: "z", zoneName: DOMAIN, mode: "apex" });
		await db.insert(routingRules).values({
			id: newId("rule"),
			scope: "domain",
			domainId: DOM_ID,
			name: "forward",
			action: "forward",
			matcher: {},
			target: "elsewhere@out.example",
		});

		const message = fakeEmailMessage({
			from: "taro@example.com",
			to: "nobody@example.com",
			raw: sampleMime(),
		});
		await handleIncomingEmail(message, env, fakeCtx);

		expect(message.forwardedTo).toHaveLength(1);
		const sentHeaders = message.forwardedTo[0]!.headers;
		expect(sentHeaders.get("X-Tsubame-Forwarded")).toBe("1");
		expect(sentHeaders.get("X-Tsubame-Forwarded")).not.toContain("nobody@example.com");
	});
});
