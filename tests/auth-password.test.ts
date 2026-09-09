import { describe, expect, it } from "vitest";
import { DEFAULT_ITERATIONS, hashPassword, needsRehash, verifyPassword } from "@/lib/password";
import {
	API_KEY_PREFIX,
	apiKeyPrefix,
	generateApiKey,
	generateSessionToken,
	hashToken,
	looksLikeApiKey,
	parseBearer,
} from "@/lib/tokens";

describe("hashPassword / verifyPassword", () => {
	it("往復する", async () => {
		const stored = await hashPassword("正しいパスワード123");
		expect(await verifyPassword("正しいパスワード123", stored)).toBe(true);
	});

	it("間違ったパスワードを弾く", async () => {
		const stored = await hashPassword("正しいパスワード123");
		expect(await verifyPassword("正しいパスワード124", stored)).toBe(false);
		expect(await verifyPassword("", stored)).toBe(false);
	});

	it("同じパスワードでも毎回違うハッシュになる（ソルトが効いている）", async () => {
		const a = await hashPassword("same-password-value");
		const b = await hashPassword("same-password-value");
		expect(a).not.toBe(b);
		expect(await verifyPassword("same-password-value", b)).toBe(true);
	});

	it("保存形式が自己記述的で、反復回数を持っている", async () => {
		const stored = await hashPassword("some-password-value");
		const parts = stored.split("$");
		expect(parts[0]).toBe("pbkdf2");
		expect(parts[1]).toBe("sha256");
		expect(Number(parts[2])).toBe(DEFAULT_ITERATIONS);
		expect(parts).toHaveLength(5);
	});

	it("パスワードを持たないユーザー（agent）は常に false", async () => {
		expect(await verifyPassword("なんでも", null)).toBe(false);
		expect(await verifyPassword("なんでも", "")).toBe(false);
	});

	it("壊れた保存値で例外を投げない", async () => {
		expect(await verifyPassword("x", "not-a-hash")).toBe(false);
		expect(await verifyPassword("x", "pbkdf2$sha256$abc$zz$zz")).toBe(false);
	});

	it("反復回数が既定より少なければ貼り替えたいと判定する", async () => {
		const weak = await hashPassword("some-password-value", 1000);
		expect(needsRehash(weak)).toBe(true);
		expect(needsRehash(await hashPassword("some-password-value"))).toBe(false);
	});
});

describe("トークン", () => {
	it("セッショントークンは十分な長さの base64url", () => {
		const token = generateSessionToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(token.length).toBeGreaterThanOrEqual(43);
		expect(generateSessionToken()).not.toBe(token);
	});

	it("API キーは rid_ で始まり、prefix は先頭 12 文字", async () => {
		const key = await generateApiKey();
		expect(key.token.startsWith(API_KEY_PREFIX)).toBe(true);
		expect(key.prefix).toBe(key.token.slice(0, 12));
		expect(key.prefix).toHaveLength(12);
		expect(apiKeyPrefix(key.token)).toBe(key.prefix);
		expect(looksLikeApiKey(key.token)).toBe(true);
		expect(looksLikeApiKey("nope")).toBe(false);
	});

	it("ハッシュは平文を含まず、同じ入力で同じ値になる", async () => {
		const key = await generateApiKey();
		expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(key.hash).not.toContain(key.token);
		expect(await hashToken(key.token)).toBe(key.hash);
	});

	it("Bearer ヘッダを読む", () => {
		expect(parseBearer("Bearer rid_abc")).toBe("rid_abc");
		expect(parseBearer("bearer rid_abc")).toBe("rid_abc");
		expect(parseBearer("Basic xyz")).toBeNull();
		expect(parseBearer(undefined)).toBeNull();
	});
});
