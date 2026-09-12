import { describe, expect, it } from "vitest";
import { isQuiet, nextQuietEnd, type QuietSchedule } from "@/domain/notify/schedule";

// 2026-06-01 は月曜。
const weekday = { tz: "Asia/Tokyo", mode: "drop", ranges: [{ days: [1, 2, 3, 4, 5], start: 22 * 60, end: 7 * 60 }] } satisfies QuietSchedule;

/** 東京の現地時刻から epoch ms を作る。 */
function jst(y = 2026, month = 6, d = 1, h = 0, mi = 0): number {
	return Date.UTC(y, month - 1, d, h - 9, mi);
}

describe("isQuiet", () => {
	it("平日深夜の 23 時は静音", () => {
		expect(isQuiet(weekday, jst(2026, 6, 1, 23))).toBe(true);
	});
	it("日をまたいで翌朝 3 時も静音", () => {
		// 月曜 22:00 に始まり火曜 7:00 に終わる区間。火曜 3:00 はその中。
		expect(isQuiet(weekday, jst(2026, 6, 2, 3))).toBe(true);
	});
	it("昼間は静音でない", () => {
		expect(isQuiet(weekday, jst(2026, 6, 2, 12))).toBe(false);
	});
	it("土曜昼は静音でない（金曜の区間は朝に終わる）", () => {
		expect(isQuiet(weekday, jst(2026, 6, 6, 12))).toBe(false);
	});
	it("曜日配列が空なら全日", () => {
		const allDay: QuietSchedule = { tz: "Asia/Tokyo", mode: "drop", ranges: [{ days: [], start: 0, end: 1440 }] };
		expect(isQuiet(allDay, jst(2026, 6, 3, 5))).toBe(true);
	});
	it("区間が無ければ静音でない", () => {
		const s: QuietSchedule = { tz: "Asia/Tokyo", mode: "drop", ranges: [] };
		expect(isQuiet(s, jst())).toBe(false);
	});
	it("DST の日の深夜も正しく判定する", () => {
		// LA は 2026-03-08 深夜 2:00 にサマータイムへ。0:30(PST) は静音、3:30(PDT) は外。
		const la: QuietSchedule = { tz: "America/Los_Angeles", mode: "drop", ranges: [{ days: [0], start: 0, end: 120 }] };
		expect(isQuiet(la, Date.UTC(2026, 2, 8, 8, 30))).toBe(true); // 0:30 PST
		expect(isQuiet(la, Date.UTC(2026, 2, 8, 10, 30))).toBe(false); // 3:30 PDT
	});
});

describe("nextQuietEnd", () => {
	it("平日正午の次は翌朝 7:00", () => {
		// 火曜 12:00 → 火曜夜 22:00 に始まり水曜朝 7:00 に終わる。
		expect(nextQuietEnd(weekday, jst(2026, 6, 2, 12))).toBe(jst(2026, 6, 3, 7));
	});
	it("金曜深夜の次は土曜朝（週末をまたいだ長い区間でも 24h を超えない）", () => {
		// 金曜 23:00 は金曜夜の区間の最中。終わりは土曜朝 7:00。
		expect(nextQuietEnd(weekday, jst(2026, 6, 5, 23))).toBe(jst(2026, 6, 6, 7));
	});
	it("複数区間があるときは最も近い終わりを返す", () => {
		const s: QuietSchedule = {
			tz: "Asia/Tokyo",
			mode: "drop",
			ranges: [
				{ days: [1], start: 0, end: 60 }, // 月曜 0:00-1:00
				{ days: [2], start: 9 * 60, end: 11 * 60 }, // 火曜 9:00-11:00
			],
		};
		// 月曜 0:30 → 月曜 1:00（先に終わる方）
		expect(nextQuietEnd(s, jst(2026, 6, 1, 0, 30))).toBe(jst(2026, 6, 1, 1));
	});
	it("常に未来の時刻を返す", () => {
		expect(nextQuietEnd(weekday, jst(2026, 6, 2, 12))).toBeGreaterThan(jst(2026, 6, 2, 12));
	});
});

describe("壊れた tz の耐性（#132）", () => {
	const bad: QuietSchedule = { tz: "Not/AZone", mode: "drop", ranges: [{ days: [], start: 0, end: 1440 }] };

	it("isQuiet は RangeError を投げず「静音でない」とみなす", () => {
		expect(() => isQuiet(bad, jst())).not.toThrow();
		expect(isQuiet(bad, jst())).toBe(false);
	});

	it("nextQuietEnd は RangeError を投げず nowMs を返す", () => {
		expect(() => nextQuietEnd(bad, jst())).not.toThrow();
		expect(nextQuietEnd(bad, jst())).toBe(jst());
	});
});
