import { describe, expect, it } from "vitest";
import { rotatedExpiry } from "@/ui/lib/rotateExpiry";

const NOW = 1_800_000_000;
const DAY = 86_400;

describe("rotatedExpiry", () => {
	it("無期限のキーは無期限のまま（expiresAt を送らない）", () => {
		expect(rotatedExpiry({ expiresAt: null, createdAt: NOW - DAY }, NOW)).toBeUndefined();
	});

	it("元の有効期間の長さを保って先送りする", () => {
		const key = { createdAt: NOW - 10 * DAY, expiresAt: NOW + 20 * DAY };
		expect(rotatedExpiry(key, NOW)).toBe(NOW + 30 * DAY);
	});

	// 元の expiresAt をそのまま渡すと、最初から切れている鍵ができてしまう。
	it("期限切れのキーを再発行しても、切れた日時は引き継がない", () => {
		const key = { createdAt: NOW - 40 * DAY, expiresAt: NOW - 10 * DAY };
		const out = rotatedExpiry(key, NOW)!;
		expect(out).toBeGreaterThan(NOW);
		expect(out).toBe(NOW + 30 * DAY);
	});

	it("createdAt より前に切れている壊れた行でも、過去の日時は返さない", () => {
		const key = { createdAt: NOW, expiresAt: NOW - DAY };
		expect(rotatedExpiry(key, NOW)).toBe(NOW);
	});
});
