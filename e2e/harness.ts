import { vi } from "vitest";
import { env as testEnv, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "@/worker";
import type { AnyQueueMessage } from "@/services/queue";
import { applyMigrations } from "../tests/helpers/migrate";

type Captured = { queue: "inbound" | "outbound"; body: AnyQueueMessage; delaySeconds?: number };

export type Harness = {
	env: CloudflareEnv;
	pending: Captured[];
	retried: { body: AnyQueueMessage; delaySeconds?: number }[];
};

export async function freshHarness(): Promise<Harness> {
	await applyMigrations();
	await emptyBucket();

	const pending: Captured[] = [];
	const retried: Harness["retried"] = [];

	const capture = (queue: "inbound" | "outbound") => ({
		send: async (body: AnyQueueMessage, opts?: { delaySeconds?: number }) => {
			pending.push({ queue, body, delaySeconds: opts?.delaySeconds });
		},
		sendBatch: async (batch: Iterable<{ body: AnyQueueMessage; delaySeconds?: number }>) => {
			for (const m of batch) pending.push({ queue, body: m.body, delaySeconds: m.delaySeconds });
		},
	});

	const env = {
		...testEnv,
		INBOUND_QUEUE: capture("inbound"),
		OUTBOUND_QUEUE: capture("outbound"),
	} as unknown as CloudflareEnv;

	return { env, pending, retried };
}

// 残骸があると「保存されたか」の検証が前のテストに引きずられる。
async function emptyBucket(): Promise<void> {
	let cursor: string | undefined;
	do {
		const listed = await testEnv.BUCKET.list({ cursor, limit: 1000 });
		if (listed.objects.length > 0) {
			await testEnv.BUCKET.delete(listed.objects.map((o) => o.key));
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
}

export type ApiResponse<T = any> = { status: number; body: T; headers: Headers };

// Set-Cookie を自前で持ち回る。リクエストをまたいでセッションが続く前提のテストが多い。
export function createClient(h: Harness) {
	let cookie: string | null = null;
	let bearer: string | null = null;
	// LOGIN_RATE_LIMIT は #52 で ip 単独の鍵も見る。クライアントを分けているテストが
	// 同じ "unknown" IP に化けて互いのレート制限を消費しないよう、クライアントごとに固定する。
	const clientIp = crypto.randomUUID();

	async function request<T = any>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<ApiResponse<T>> {
		const headers = new Headers();
		if (body !== undefined) headers.set("content-type", "application/json");
		if (cookie) headers.set("cookie", cookie);
		if (bearer) headers.set("authorization", `Bearer ${bearer}`);
		headers.set("cf-connecting-ip", clientIp);

		const req = new Request(`https://tsubame.test${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req as Parameters<typeof worker.fetch>[0], h.env, ctx);
		await waitOnExecutionContext(ctx);

		const setCookie = res.headers.get("set-cookie");
		if (setCookie) cookie = setCookie.split(";")[0]!;

		const text = await res.text();
		let parsed: unknown = text;
		try {
			parsed = JSON.parse(text);
		} catch {
			// HTML やプレーンテキストのレスポンスもそのまま返す。
		}
		return { status: res.status, body: parsed as T, headers: res.headers };
	}

	return {
		get: <T = any>(p: string) => request<T>("GET", p),
		post: <T = any>(p: string, b?: unknown) => request<T>("POST", p, b),
		patch: <T = any>(p: string, b?: unknown) => request<T>("PATCH", p, b),
		put: <T = any>(p: string, b?: unknown) => request<T>("PUT", p, b),
		del: <T = any>(p: string) => request<T>("DELETE", p),
		/** null を渡すと Cookie セッションに戻る。 */
		useKey(token: string | null) {
			bearer = token;
		},
		clearCookie() {
			cookie = null;
		},
	};
}

export type Client = ReturnType<typeof createClient>;

export type PushSend = { url: string; method: string; headers: Headers; status: number };

/**
 * Web Push の送信先 fetch を捕まえる。VAPID 鍵を差し込み、globalThis.fetch を
 * status を返すスタブに差し替えて、送られた POST をログに残す。
 */
/**
 * Web Push の送信を捕まえる。VAPID 鍵を差し込み、globalThis.fetch を status を返す
 * スタブに差し替えて、送られた POST の一覧をログに残す。テストの afterEach で vi
 * のモックを消すこと（別テストに fetch の差し替えが漏れない）。
 */
export async function enableVapid(h: Harness, status = 201): Promise<PushSend[]> {
	if (!(h.env as { VAPID_PRIVATE_KEY?: string }).VAPID_PRIVATE_KEY) {
		const { generateVapidKeys } = await import("@/services/webpush");
		const keys = await generateVapidKeys();
		(h.env as { VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }).VAPID_PRIVATE_KEY = JSON.stringify(keys.privateKey);
		(h.env as { VAPID_SUBJECT?: string }).VAPID_SUBJECT = "mailto:push@tsubame.example";
	}
	const sends: PushSend[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
		sends.push({
			url: String(url),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			status,
		});
		return new Response(null, { status });
	});
	return sends;
}

export type DeliverResult = {
	rejected: string | null;
	forwarded: { to: string; headers: Headers }[];
};

/**
 * `raw` は実機の ForwardableEmailMessage と同じく長さの分からない ReadableStream で渡す。
 * 長さ既知のストリームで代用すると「R2 に長さ不明のストリームを渡して落ちる」類のバグを取り逃がす。
 */
export async function deliverEmail(
	h: Harness,
	opts: { from: string; to: string; raw: string },
): Promise<DeliverResult> {
	const bytes = new TextEncoder().encode(opts.raw);
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(bytes);
			c.close();
		},
	});

	const result: DeliverResult = { rejected: null, forwarded: [] };

	const message = {
		from: opts.from,
		to: opts.to,
		raw: stream,
		rawSize: bytes.byteLength,
		headers: parseHeaders(opts.raw),
		setReject(reason: string) {
			result.rejected = reason;
		},
		async forward(to: string, headers?: Headers) {
			result.forwarded.push({ to, headers: headers ?? new Headers() });
		},
		async reply() {
			throw new Error("reply は使わない");
		},
	} as unknown as ForwardableEmailMessage;

	const ctx = createExecutionContext();
	await worker.email!(message, h.env, ctx);
	await waitOnExecutionContext(ctx);
	return result;
}

function parseHeaders(raw: string): Headers {
	const headers = new Headers();
	const headBlock = raw.split(/\r?\n\r?\n/)[0] ?? "";
	for (const line of headBlock.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx <= 0 || /^\s/.test(line)) continue;
		try {
			headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
		} catch {
			// 実メールには Headers が受け付けない名前が来る。落とさずに捨てる。
		}
	}
	return headers;
}

export async function drainQueues(h: Harness, maxRounds = 5): Promise<void> {
	for (let round = 0; round < maxRounds; round++) {
		const batchItems = h.pending.splice(0, h.pending.length);
		if (batchItems.length === 0) return;

		for (const item of batchItems) {
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
	}
	throw new Error(`キューが ${maxRounds} 巡しても空にならない。無限ループの疑い。`);
}

/** 再試行の途中経過を見たいとき用。残りは pending に置いたままになる。 */
export async function drainOne(h: Harness): Promise<boolean> {
	const item = h.pending.shift();
	if (!item) return false;
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
	return true;
}

export type SentEmail = { from: string; to: string; raw: string };

// 送信は「何を組み立てたか」を見たいので、ここだけは本物のバインディングを使えない。
export function captureSentEmails(h: Harness): SentEmail[] {
	const sent: SentEmail[] = [];
	(h.env as { EMAIL: unknown }).EMAIL = {
		async send(message: { from: string; to: string; raw?: unknown; "EmailMessage::raw"?: unknown }) {
			// miniflare の EmailMessage は raw を `EmailMessage::raw` キーに持つ。
			const raw = message["EmailMessage::raw"] ?? message.raw;
			const text =
				typeof raw === "string"
					? raw
					: raw instanceof ReadableStream
						? await new Response(raw).text()
						: String(raw);
			sent.push({ from: message.from, to: message.to, raw: text });
			return { messageId: `captured-${sent.length}` };
		},
	};
	return sent;
}

export const OWNER = {
	email: "owner@tsubame.test",
	name: "オーナー",
	password: "e2e-owner-password",
	/** vitest.config.ts の INTERNAL_SECRET と揃える。 */
	secret: "vitest-fixture-internal-secret-9f8e7d6c",
};

export async function loginAsOwner(h: Harness): Promise<Client> {
	const client = createClient(h);
	const res = await client.post("/api/v1/auth/bootstrap", OWNER);
	if (res.status >= 400) throw new Error(`bootstrap 失敗: ${JSON.stringify(res.body)}`);
	return client;
}

/** D1 に直接入れる。API 経由にすると Cloudflare のゾーン操作まで走ってしまう。 */
export async function seedDomain(
	h: Harness,
	opts: { domain?: string; addresses: string[] },
): Promise<{ domainId: string; addressIds: Record<string, string> }> {
	const { getDb } = await import("@/db/client");
	const { domains, addresses } = await import("@/db/schema");
	const { newId } = await import("@/lib/id");
	const db = getDb(h.env);

	const name = opts.domain ?? "mail.tsubame.test";
	const domainId = newId("domain");
	await db.insert(domains).values({
		id: domainId,
		name,
		zoneId: "zone_test",
		zoneName: name.split(".").slice(-2).join("."),
		mode: "subdomain",
		routingStatus: "active",
		sendingStatus: "active",
		catchAllEnabled: false,
	});

	const addressIds: Record<string, string> = {};
	for (const local of opts.addresses) {
		const id = newId("address");
		addressIds[local] = id;
		await db.insert(addresses).values({
			id,
			domainId,
			localPart: local,
			address: `${local}@${name}`,
			kind: "mailbox",
			isCatchAll: false,
		});
	}
	return { domainId, addressIds };
}

export function mime(opts: {
	from: string;
	to: string;
	subject?: string;
	messageId?: string;
	inReplyTo?: string;
	body?: string;
	extraHeaders?: Record<string, string>;
}): string {
	const lines = [
		`From: ${opts.from}`,
		`To: ${opts.to}`,
		`Subject: ${opts.subject ?? "件名なし"}`,
		`Message-ID: <${opts.messageId ?? "e2e-" + crypto.randomUUID()}@tsubame.test>`,
		`Date: ${new Date().toUTCString()}`,
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="UTF-8"',
	];
	if (opts.inReplyTo) {
		lines.push(`In-Reply-To: <${opts.inReplyTo}>`);
		lines.push(`References: <${opts.inReplyTo}>`);
	}
	for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) lines.push(`${k}: ${v}`);
	return `${lines.join("\r\n")}\r\n\r\n${opts.body ?? "本文です。"}\r\n`;
}
