/**
 * 保存形式 `pbkdf2$sha256$<iterations>$<saltB64url>$<hashB64url>` は自己記述的にしてある。
 * 反復回数を上げるときは DEFAULT_ITERATIONS を増やすだけでよく、既存のハッシュは
 * 自分の反復回数で検証でき、`needsRehash()` が true になるのでログイン時に貼り替えられる。
 */
import { fromBase64Url, randomBytes, toBase64Url } from "./tokens";

const ALGORITHM = "pbkdf2";
const HASH = "sha256";

export const DEFAULT_ITERATIONS = 210_000;

const SALT_BYTES = 16;
const KEY_BITS = 256;

const encoder = new TextEncoder();

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
		key,
		KEY_BITS,
	);
	return new Uint8Array(bits);
}

export async function hashPassword(
	password: string,
	iterations: number = DEFAULT_ITERATIONS,
): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const derived = await deriveBits(password, salt, iterations);
	return [ALGORITHM, HASH, String(iterations), toBase64Url(salt), toBase64Url(derived)].join("$");
}

type ParsedHash = { iterations: number; salt: Uint8Array; hash: Uint8Array };

function parseStored(stored: string): ParsedHash | null {
	const parts = stored.split("$");
	if (parts.length !== 5) return null;
	const [algorithm, hashName, iterationsRaw, saltRaw, hashRaw] = parts as [
		string,
		string,
		string,
		string,
		string,
	];
	if (algorithm !== ALGORITHM || hashName !== HASH) return null;
	const iterations = Number.parseInt(iterationsRaw, 10);
	if (!Number.isFinite(iterations) || iterations < 1) return null;
	const salt = fromBase64Url(saltRaw);
	const hash = fromBase64Url(hashRaw);
	if (salt.length === 0 || hash.length === 0) return null;
	return { iterations, salt, hash };
}

/** 総当たりで 1 バイトずつ確かめられないよう、長さでも内容でも早期 return しない。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	let diff = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return diff === 0;
}

/** `stored` が null（パスワードを持たない agent ユーザーなど）なら常に false。 */
export async function verifyPassword(
	password: string,
	stored: string | null | undefined,
): Promise<boolean> {
	if (!stored) return false;
	const parsed = parseStored(stored);
	if (!parsed) return false;
	const derived = await deriveBits(password, parsed.salt, parsed.iterations);
	return timingSafeEqual(derived, parsed.hash);
}

export function needsRehash(stored: string | null | undefined): boolean {
	if (!stored) return false;
	const parsed = parseStored(stored);
	if (!parsed) return true;
	return parsed.iterations < DEFAULT_ITERATIONS;
}

/** 口頭やチャットで渡すので、紛らわしい文字（0/O、1/l/I）を外している。 */
export function generateTemporaryPassword(length = 20): string {
	const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (const b of bytes) out += alphabet[b % alphabet.length];
	return out;
}
