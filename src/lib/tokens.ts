/** 平文はどれも発行時のレスポンスにしか出さない。DB に置くのは SHA-256 の 16 進文字列だけ。 */
// `__Host-` は Secure + Path=/ + Domain 無しをブラウザに強制するので、同一登録ドメインの別サブドメインから
// `Set-Cookie: tsb_session=…; Domain=.example.com` で上書きされるセッション固定（#84）を封じる。
export const SESSION_COOKIE = "__Host-tsb_session";

/** #84 で名前を変える前の旧セッション Cookie。読まないが、login / logout で消す。 */
export const LEGACY_SESSION_COOKIE = "tsb_session";

export const API_KEY_PREFIX = "tsb_";

export const API_KEY_PREFIX_LENGTH = 12;

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 壊れた入力では空配列を返す。 */
export function fromBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	try {
		const binary = atob(padded);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	} catch {
		return new Uint8Array(0);
	}
}

export function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateSessionToken(): string {
	return toBase64Url(randomBytes(32));
}

export type GeneratedApiKey = {
	token: string;
	prefix: string;
	hash: string;
};

export async function generateApiKey(): Promise<GeneratedApiKey> {
	const token = `${API_KEY_PREFIX}${toBase64Url(randomBytes(32))}`;
	return { token, prefix: apiKeyPrefix(token), hash: await hashToken(token) };
}

export function apiKeyPrefix(token: string): string {
	return token.slice(0, API_KEY_PREFIX_LENGTH);
}

export function looksLikeApiKey(value: string): boolean {
	return value.startsWith(API_KEY_PREFIX) && value.length > API_KEY_PREFIX_LENGTH;
}

export function parseBearer(header: string | undefined | null): string | null {
	if (!header) return null;
	const m = /^Bearer\s+(.+)$/i.exec(header.trim());
	return m ? m[1]!.trim() : null;
}

/** 総当たりで 1 文字ずつ確かめられないよう、長さでも内容でも早期 return しない。 */
export function secretEquals(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const x = enc.encode(a);
	const y = enc.encode(b);
	let diff = x.length ^ y.length;
	const len = Math.max(x.length, y.length);
	for (let i = 0; i < len; i++) {
		diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	}
	return diff === 0;
}
