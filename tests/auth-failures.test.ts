import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getDb } from "@/db/client";
import {
	clearFailures,
	isBlocked,
	MAX_FAILURES,
	pruneAuthFailures,
	recordFailure,
	WINDOW_MS,
	BLOCK_MS,
} from "@/domain/access/auth-failures";
import { applyMigrations } from "./helpers/migrate";

function db() {
	return getDb(env as unknown as CloudflareEnv);
}

const IP = "203.0.113.9";
const OTHER_IP = "198.51.100.7";

async function failTimes(n: number, now: number, ip = IP) {
	for (let i = 0; i < n; i++) await recordFailure(db(), ip, now);
}

beforeEach(async () => {
	await applyMigrations();
});

// キーは 32 バイトの乱数なので当てられる心配は無い。ここで止めたいのは
// 無効なキーで D1 を引き続ける負荷（精査 #147 の穴埋め）。
describe("API キーの失敗カウンタ", () => {
	it("上限までは通す", async () => {
		const now = Date.now();
		await failTimes(MAX_FAILURES, now);
		expect(await isBlocked(db(), IP, now)).toBe(false);
	});

	it("上限を超えたら門前で返す", async () => {
		const now = Date.now();
		await failTimes(MAX_FAILURES + 1, now);
		expect(await isBlocked(db(), IP, now)).toBe(true);
	});

	it("止めるのはその IP だけ（他の利用者を巻き込まない）", async () => {
		const now = Date.now();
		await failTimes(MAX_FAILURES + 1, now);
		expect(await isBlocked(db(), OTHER_IP, now)).toBe(false);
	});

	it("期限が切れれば通る", async () => {
		const now = Date.now();
		await failTimes(MAX_FAILURES + 1, now);
		expect(await isBlocked(db(), IP, now + BLOCK_MS + 1)).toBe(false);
	});

	// 窓の中で積み上がらなければ、ぽつぽつ失敗する正規の利用者は止まらない。
	it("窓が切れると数え直す", async () => {
		const now = Date.now();
		await failTimes(MAX_FAILURES, now);
		// 窓を越えてから 1 回失敗しても、合計ではなく 1 から数える。
		const later = now + WINDOW_MS + 1;
		await recordFailure(db(), IP, later);
		expect(await isBlocked(db(), IP, later)).toBe(false);
	});

	it("認証が通れば記録を消す", async () => {
		const now = Date.now();
		await failTimes(MAX_FAILURES + 1, now);
		expect(await isBlocked(db(), IP, now)).toBe(true);
		await clearFailures(db(), IP);
		expect(await isBlocked(db(), IP, now)).toBe(false);
	});

	// IP が取れない経路（テスト・非ブラウザ）で誰も止めない。
	it("IP が無ければ数えないし止めない", async () => {
		const now = Date.now();
		await recordFailure(db(), null, now);
		expect(await isBlocked(db(), null, now)).toBe(false);
	});

	// 生の IP を残すと、失敗しただけの相手の所在が手元に残る。
	it("生の IP を保存しない", async () => {
		const now = Date.now();
		await recordFailure(db(), IP, now);
		const rows = await db().run("SELECT ip_hash FROM auth_failures" as never);
		const stored = JSON.stringify(rows);
		expect(stored).not.toContain(IP);
	});

	it("窓も期限も切れた行を掃除する", async () => {
		const now = Date.now();
		await failTimes(1, now);
		expect(await pruneAuthFailures(db(), now + WINDOW_MS + 1)).toBe(1);
	});

	it("まだ止めている行は掃除しない", async () => {
		const now = Date.now();
		await failTimes(MAX_FAILURES + 1, now);
		// 窓は切れたが期限は残っている時点。
		expect(await pruneAuthFailures(db(), now + WINDOW_MS + 1)).toBe(0);
		expect(await isBlocked(db(), IP, now + WINDOW_MS + 1)).toBe(true);
	});

	// IP は NAT・社内網・CI で共有される。同居している誰かの失敗で、正しいキーを
	// 持つ利用者を締め出してはいけない。認証が通れば記録ごと消えて止めるのをやめる。
	it("止めている最中でも、正しいキーが通れば解除される", async () => {
		const now = Date.now();
		await failTimes(MAX_FAILURES + 1, now);
		expect(await isBlocked(db(), IP, now)).toBe(true);

		// principalFromApiKey は認証が通ると clearFailures を呼ぶ。
		await clearFailures(db(), IP);
		expect(await isBlocked(db(), IP, now)).toBe(false);
	});
});
