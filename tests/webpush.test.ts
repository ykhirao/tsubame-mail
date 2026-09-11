import { describe, expect, it } from "vitest";
import {
	buildVapidAuthHeader,
	encryptPayload,
	fromBase64Url,
	generateVapidKeys,
	sendWebPush,
	toBase64Url,
} from "@/services/webpush";
import type { PushSubscription, SendOptions, WebPushResponse } from "@/services/webpush";

// RFC 8291 付録 A の検算用に、送信者鍵と salt を注入して暗号化の一致を確かめる。
const SENDER_PRIV = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const SENDER_PUB =
	"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const UA_PUB =
	"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
// RFC 8291 Section 5 の例の本文（ヘッダ 86 バイト + 暗号文 58 バイト）を base64url でそのまま。
const EXPECTED_BODY =
	"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg" +
	"Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
	"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

async function senderPrivateKey(): Promise<CryptoKey> {
	const pub = fromBase64Url(SENDER_PUB);
	const jwk = {
		kty: "EC",
		crv: "P-256",
		x: toBase64Url(pub.slice(1, 33)),
		y: toBase64Url(pub.slice(33, 65)),
		d: SENDER_PRIV,
	};
	return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

async function rfcSubscription(): Promise<PushSubscription> {
	return {
		endpoint: "https://push.example.net/p/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV",
		keys: { p256dh: UA_PUB, auth: AUTH },
	};
}

async function testSubscription(): Promise<PushSubscription> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	return {
		endpoint: "https://push.example.net/p/x",
		keys: { p256dh: toBase64Url(pub), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) },
	};
}

describe("encryptPayload（RFC 8291 付録 A の検算）", () => {
	it("送信者鍵と salt を注入すると付録 A の本文と完全に一致する", async () => {
		const encrypted = await encryptPayload(
			await rfcSubscription(),
			new TextEncoder().encode("When I grow up, I want to be a watermelon"),
			{ senderPrivateKey: await senderPrivateKey(), senderPublicKey: fromBase64Url(SENDER_PUB), salt: fromBase64Url(SALT) },
		);
		expect(toBase64Url(encrypted)).toBe(EXPECTED_BODY);
	});

	it("salt を注入しなければ毎回違う本文になる", async () => {
		const sub = await rfcSubscription();
		const senderPrivate = await senderPrivateKey();
		const pub = fromBase64Url(SENDER_PUB);
		const payload = new TextEncoder().encode("x");
		const opts = { senderPrivateKey: senderPrivate, senderPublicKey: pub };
		const a = toBase64Url(await encryptPayload(sub, payload, opts));
		const b = toBase64Url(await encryptPayload(sub, payload, opts));
		expect(a).not.toBe(b);
	});
});

describe("generateVapidKeys と buildVapidAuthHeader", () => {
	it("k パラメータで署名を公開鍵検証でき、aud/sub/exp が正しい", async () => {
		const keys = await generateVapidKeys();
		const now = Date.now();
		const header = await buildVapidAuthHeader(
			"https://push.example.net/p/abc",
			keys.privateKey,
			"mailto:push@tsubame.example",
			now,
		);
		const m = /^vapid t=([^,]+), k=([^,]+)$/.exec(header);
		expect(m).not.toBeNull();
		const token = m![1]!;
		const k = m![2]!;
		const h = token.split(".")[0]!;
		const c = token.split(".")[1]!;
		const s = token.split(".")[2]!;
		const pubPoint = fromBase64Url(k);
		expect(pubPoint[0]).toBe(4);
		// 生成した公開鍵と一致する。
		expect(k).toBe(keys.publicKey);

		const pub = await crypto.subtle.importKey(
			"jwk",
			{
				kty: "EC",
				crv: "P-256",
				x: toBase64Url(pubPoint.slice(1, 33)),
				y: toBase64Url(pubPoint.slice(33, 65)),
			},
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const ok = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			pub,
			fromBase64Url(s),
			new TextEncoder().encode(`${h}.${c}`),
		);
		expect(ok).toBe(true);

		const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(c)));
		expect(claims.aud).toBe("https://push.example.net");
		expect(claims.sub).toBe("mailto:push@tsubame.example");
		expect(claims.exp).toBeGreaterThan(Math.floor(now / 1000));
		// RFC 8292 は exp をリクエスト時刻から 24 時間以内にすることを求める。
		expect(claims.exp).toBeLessThanOrEqual(Math.floor(now / 1000) + 24 * 3600);
	});
});

describe("sendWebPush", () => {
	async function opts(status: number): Promise<SendOptions> {
		const keys = await generateVapidKeys();
		return {
			vapid: keys.privateKey,
			subject: "mailto:push@tsubame.example",
			fetch: async () => new Response(null, { status }),
		};
	}

	it("201 は ok、その他のステータスを outcomes に割り当てる", async () => {
		const sub = await testSubscription();
		const cases: Array<[number, WebPushResponse["outcome"]]> = [
			[201, "ok"],
			[404, "gone"],
			[410, "gone"],
			[413, "too_large"],
			[429, "retry"],
			[500, "retry"],
			[502, "retry"],
			[200, "error"],
			[400, "error"],
		];
		for (const [status, outcome] of cases) {
			const base = await opts(status);
			const res = await sendWebPush(sub, new TextEncoder().encode("hi"), base);
			expect(res.status).toBe(status);
			expect(res.outcome).toBe(outcome);
		}
	});

	it("トピックと urgency と TTL をヘッダに載せる", async () => {
		const keys = await generateVapidKeys();
		const sub = await testSubscription();
		let captured: Headers | undefined;
		const res = await sendWebPush(sub, new TextEncoder().encode("hi"), {
			vapid: keys.privateKey,
			subject: "mailto:push@tsubame.example",
			ttl: 600,
			urgency: "high",
			topic: "thread-12345",
			fetch: async (_url, req) => {
				captured = new Headers(req!.headers);
				return new Response(null, { status: 201 });
			},
		});
		expect(res.outcome).toBe("ok");
		expect(captured!.get("Content-Encoding")).toBe("aes128gcm");
		expect(captured!.get("TTL")).toBe("600");
		expect(captured!.get("Urgency")).toBe("high");
		expect(captured!.get("Topic")).toBe("thread-12345");
		expect(captured!.get("Authorization")).toMatch(/^vapid t=/);
	});

	it("tokenCache は origin ごとに Authorization を使い回す", async () => {
		const keys = await generateVapidKeys();
		const sub = await testSubscription();
		const cache = new Map<string, string>();
		const headers: string[] = [];
		const common: SendOptions = {
			vapid: keys.privateKey,
			subject: "mailto:push@tsubame.example",
			tokenCache: {
				get: (o) => cache.get(o) ?? null,
				set: (o, v) => void cache.set(o, v),
			},
			fetch: async (_url, req) => {
				headers.push(new Headers(req!.headers).get("Authorization")!);
				return new Response(null, { status: 201 });
			},
		};
		await sendWebPush(sub, new TextEncoder().encode("a"), common);
		await sendWebPush(sub, new TextEncoder().encode("b"), common);
		expect(headers).toHaveLength(2);
		expect(headers[0]).toBe(headers[1]);
	});

	it("fetch が失敗すると error を返す", async () => {
		const keys = await generateVapidKeys();
		const res = await sendWebPush(await testSubscription(), new TextEncoder().encode("hi"), {
			vapid: keys.privateKey,
			subject: "mailto:push@tsubame.example",
			fetch: async () => {
				throw new Error("network down");
			},
		});
		expect(res.outcome).toBe("error");
		expect(res.status).toBe(0);
	});
});
