const RS = 4096;
const VAPID_TTL_SECONDS = 12 * 3600;
// プッシュサービスが応答しないと Worker を拘束する。redirect は追わず 3xx を失敗として扱う。
const PUSH_FETCH_TIMEOUT_MS = 10_000;

const encoder = new TextEncoder();

// WebCrypto の BufferSource は TS 7 では ArrayBuffer 実体を要求するので、共通の型で通す。
type Bytes = Uint8Array<ArrayBuffer>;

export type PushSubscription = {
	endpoint: string;
	keys: { p256dh: string; auth: string };
};

/** 署名鍵。秘密鍵は JWK の d/x/y で持つ（raw では読めないため、VAPID_SEC_KEY は JSON で保存する）。 */
export type VapidKeyPair = {
	privateKey: JsonWebKey;
	/** base64url の非圧縮点（先頭 0x04 を含む 65 バイト）。クライアント側の照合用。 */
	publicKey: string;
};

/**
 * t=/k= の使い回し用。呼び出し側は有効期限つきで保存し、期限が切れたら get の返る値を
 * 捨てて set を呼び直す（D1 の settings に入れるのは別担当）。
 */
export type VapidTokenCache = {
	get(origin: string): string | null;
	set(origin: string, token: string): void;
};

export type SendOptions = {
	vapid: JsonWebKey;
	subject: string;
	ttl?: number;
	urgency?: "very-low" | "low" | "normal" | "high";
	topic?: string;
	fetch?: typeof fetch;
	tokenCache?: VapidTokenCache;
};

export type WebPushResponse = {
	status: number;
	outcome: "ok" | "gone" | "too_large" | "retry" | "error";
};

export type SealOptions = {
	/** RFC 8291 付録 A の検算用。運用では毎回生成して捨てる一過性の鍵を使う。 */
	senderPrivateKey?: CryptoKey;
	senderPublicKey?: Bytes;
	salt?: Bytes;
};

export function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Bytes {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function asBytes(buf: ArrayBuffer): Bytes {
	return new Uint8Array(buf);
}

function concat(...parts: Uint8Array[]): Bytes {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

// WebCrypto の HKDF は extract+expand を一気にやる。length はビット単位。
async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, lengthBytes: number): Promise<Bytes> {
	const key = await crypto.subtle.importKey("raw", ikm, { name: "HKDF", hash: "SHA-256" }, false, ["deriveBits"]);
	return asBytes(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, lengthBytes * 8));
}

export async function generateVapidKeys(): Promise<VapidKeyPair> {
	const { publicKey, privateKey } = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign"],
	);
	return {
		privateKey: await crypto.subtle.exportKey("jwk", privateKey),
		publicKey: toBase64Url(asBytes(await crypto.subtle.exportKey("raw", publicKey))),
	};
}

/** 返す値はそのまま Authorization ヘッダに入れる（`vapid t=..., k=...`）。`now` は epoch ミリ秒。 */
export async function buildVapidAuthHeader(
	endpoint: string,
	vapid: JsonWebKey,
	subject: string,
	now: number,
): Promise<string> {
	const claims = {
		aud: new URL(endpoint).origin,
		exp: Math.floor(now / 1000) + VAPID_TTL_SECONDS,
		sub: subject,
	};
	const signingInput = [
		toBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))),
		toBase64Url(encoder.encode(JSON.stringify(claims))),
	].join(".");

	const signingKey = await crypto.subtle.importKey(
		"jwk",
		vapid,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const signature = asBytes(
		await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(signingInput)),
	);

	const x = fromBase64Url(vapid.x ?? "");
	const y = fromBase64Url(vapid.y ?? "");
	const token = `${signingInput}.${toBase64Url(signature)}`;
	return `vapid t=${token}, k=${toBase64Url(concat(new Uint8Array([4]), x, y))}`;
}

export async function encryptPayload(
	sub: PushSubscription,
	payload: Bytes,
	opts: SealOptions = {},
): Promise<Bytes> {
	const uaPublic = fromBase64Url(sub.keys.p256dh);
	const authSecret = fromBase64Url(sub.keys.auth);

	let senderPublic: Bytes;
	let senderPrivate: CryptoKey;
	if (opts.senderPrivateKey && opts.senderPublicKey) {
		senderPrivate = opts.senderPrivateKey;
		senderPublic = opts.senderPublicKey;
	} else {
		const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
		senderPrivate = pair.privateKey;
		senderPublic = asBytes(await crypto.subtle.exportKey("raw", pair.publicKey));
	}

	const uaKey = await crypto.subtle.importKey(
		"raw",
		uaPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const ecdhSecret = asBytes(
		await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, senderPrivate, 256),
	);

	const keyInfo = concat(encoder.encode("WebPush: info"), new Uint8Array([0]), uaPublic, senderPublic);
	const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

	const salt: Bytes = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
	// RFC 8188 は PRK の展開を HKDF の extract に含めて 1 回にでき、salt をそのまま salt に渡す。
	const cek = await hkdf(
		ikm,
		salt,
		concat(encoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])),
		16,
	);
	const nonce = await hkdf(
		ikm,
		salt,
		concat(encoder.encode("Content-Encoding: nonce"), new Uint8Array([0])),
		12,
	);

	const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
	// 単一レコード。末尾の 0x02 がパディング区切りの区切りオクテット。
	const ciphertext = asBytes(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(payload, new Uint8Array([2]))),
	);

	const rsBytes = new Uint8Array(4);
	new DataView(rsBytes.buffer).setUint32(0, RS);
	const header = concat(salt, rsBytes, new Uint8Array([65]), senderPublic);
	return concat(header, ciphertext);
}

export async function sendWebPush(
	sub: PushSubscription,
	payload: Bytes,
	opts: SendOptions,
): Promise<WebPushResponse> {
	const origin = new URL(sub.endpoint).origin;
	let authorization = opts.tokenCache?.get(origin) ?? null;
	if (authorization === null) {
		authorization = await buildVapidAuthHeader(sub.endpoint, opts.vapid, opts.subject, Date.now());
		opts.tokenCache?.set(origin, authorization);
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/octet-stream",
		"Content-Encoding": "aes128gcm",
		Authorization: authorization,
		TTL: String(opts.ttl ?? 86400),
		Urgency: opts.urgency ?? "normal",
	};
	if (opts.topic !== undefined) headers.Topic = opts.topic;

	const body = await encryptPayload(sub, payload);

	let res: Response;
	try {
		res = await (opts.fetch ?? fetch)(sub.endpoint, {
			method: "POST",
			headers,
			body,
			signal: AbortSignal.timeout(PUSH_FETCH_TIMEOUT_MS),
			redirect: "manual",
		});
	} catch {
		// ネットワーク断・タイムアウトは一過性として再試行へ回す（恒久 4xx と分ける）。
		return { status: 0, outcome: "retry" };
	}

	const status = res.status;
	const outcome: WebPushResponse["outcome"] =
		status === 201
			? "ok"
			: status === 404 || status === 410
				? "gone"
				: status === 413
					? "too_large"
					: status === 429 || (status >= 500 && status < 600)
						? "retry"
						: "error";
	return { status, outcome };
}
