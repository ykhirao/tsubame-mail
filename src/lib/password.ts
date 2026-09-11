/**
 * 保存形式 `pbkdf2$sha256$<iterations>$<saltB64url>$<hashB64url>` は自己記述的にしてある。
 * 反復回数を上げるときは DEFAULT_ITERATIONS を増やすだけでよく、既存のハッシュは
 * 自分の反復回数で検証でき、`needsRehash()` が true になるのでログイン時に貼り替えられる。
 */
import { fromBase64Url, randomBytes, toBase64Url } from "./tokens";

const ALGORITHM = "pbkdf2";
const HASH = "sha256";

// Workers の WebCrypto は PBKDF2 の反復回数を 100,000 までしか受け付けない（超えると
// NotSupportedError で落ちる）。OWASP 推奨の 210,000 は本番で使えないので上限に合わせる。
// ローカルの workerd はこの上限を強制しないため、単体テストでは気付けない。
export const DEFAULT_ITERATIONS = 100_000;

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

/**
 * ユーザーが存在しない／agent でパスワード無しのときにログインが素通りする応答時間を、
 * ユーザーが存在する場合と揃えるためのダミーハッシュ。固定 salt で問題ない
 * （このハッシュ自体をどのユーザーの検証にも使わないので、照合結果に意味を持たせない）。
 */
export const DUMMY_PASSWORD_HASH =
	"pbkdf2$sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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
	// 256 % alphabet.length !== 0 なので単純な mod だと先頭の文字ほど出やすくなる（剰余バイアス）。
	// 256 を超えない最大の alphabet.length の倍数を境目に、それ以上のバイトは捨てて引き直す。
	const limit = 256 - (256 % alphabet.length);
	let out = "";
	while (out.length < length) {
		const chunk = crypto.getRandomValues(new Uint8Array(length - out.length));
		for (const b of chunk) {
			if (b >= limit) continue;
			out += alphabet[b % alphabet.length];
			if (out.length === length) break;
		}
	}
	return out;
}
