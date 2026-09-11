import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_ITERATIONS,
	DUMMY_PASSWORD_HASH,
	generateTemporaryPassword,
	hashPassword,
	needsRehash,
	verifyPassword,
} from "@/lib/password";
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

	it("DUMMY_PASSWORD_HASH は既定の反復回数の本物のハッシュとして解釈できる（#26）", async () => {
		const parts = DUMMY_PASSWORD_HASH.split("$");
		expect(parts).toHaveLength(5);
		expect(Number(parts[2])).toBe(DEFAULT_ITERATIONS);
		// どのパスワードとも一致しない（一致してしまうと想定外の分岐になる）。
		expect(await verifyPassword("password", DUMMY_PASSWORD_HASH)).toBe(false);
		// needsRehash はログイン成功時だけ走る経路なので、ダミーに対して呼んでも例外にならないことだけ確認する。
		expect(needsRehash(DUMMY_PASSWORD_HASH)).toBe(false);
	});
});

describe("generateTemporaryPassword（#53）", () => {
	const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

	it("256 を超えて捨てるべきバイト（224 以上）を引いたら、その分だけ引き直す", () => {
		// alphabet.length = 56、256 - (256 % 56) = 224 が採用する境目。
		// 1 回目のチャンクに境目以上のバイトだけを混ぜても、それを飛ばして
		// 2 回目のチャンクから文字を補うことを crypto.getRandomValues をモックして直接確認する
		// （統計的な検定はサンプル数に依存して揺れるため避ける）。
		const spy = vi.spyOn(crypto, "getRandomValues");
		const chunks: number[][] = [
			[255, 224], // どちらも 224 以上なので 2 つとも捨てられ、1 文字も採用されない
			[5, 0], // 引き直しの 2 バイトはどちらも採用される
		];
		let call = 0;
		// @ts-expect-error テスト用に Uint8Array 以外の呼び出しは考慮しない
		spy.mockImplementation((arr: Uint8Array) => {
			const bytes = chunks[call] ?? [0];
			call++;
			arr.set(bytes.slice(0, arr.length));
			return arr;
		});

		const pw = generateTemporaryPassword(2);
		expect(call).toBe(2);
		expect(pw).toBe(`${alphabet[5]}${alphabet[0]}`);
		spy.mockRestore();
	});

	it("境目ちょうど（224）も捨てる", () => {
		const spy = vi.spyOn(crypto, "getRandomValues");
		const chunks: number[][] = [[224], [2]];
		let call = 0;
		// @ts-expect-error テスト用に Uint8Array 以外の呼び出しは考慮しない
		spy.mockImplementation((arr: Uint8Array) => {
			const bytes = chunks[call] ?? [0];
			call++;
			arr.set(bytes.slice(0, arr.length));
			return arr;
		});

		const pw = generateTemporaryPassword(1);
		expect(call).toBe(2);
		expect(pw).toBe(alphabet[2]);
		spy.mockRestore();
	});

	it("既定の長さと文字種は変わらない", () => {
		const pw = generateTemporaryPassword();
		expect(pw).toHaveLength(20);
		expect(pw).toMatch(/^[abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
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
