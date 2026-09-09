import { describe, expect, it } from "vitest";
import { ApiError } from "@/shared/errors";
import {
	parseSearchQuery,
	parseDayStart,
	parseDayEnd,
	type SearchQuery,
} from "@/domain/search/query";

describe("parseSearchQuery", () => {
	it("演算子と全文検索語を組み合わせて解釈する", () => {
		const q = parseSearchQuery("from:foo@bar subject:見積 since:2026-01-01 添付");
		expect(q.from).toBe("foo@bar");
		expect(q.subject).toBe("見積");
		expect(q.since).toBe(parseDayStart("2026-01-01"));
		expect(q.freeWords).toEqual(["添付"]);
	});

	it("引用符で囲んだ語をひとまとまりにする", () => {
		const q = parseSearchQuery('subject:"見積書" body:"お世話になっております"');
		expect(q.subject).toBe("見積書");
		expect(q.body).toBe("お世話になっております");
	});

	it("列のない語は全文検索語として積む", () => {
		const q = parseSearchQuery("あいう 会議 資料");
		expect(q.freeWords).toEqual(["あいう", "会議", "資料"]);
	});

	it("is / has / in 演算子を解釈する", () => {
		const q = parseSearchQuery("is:unread is:starred has:attachment in:info@ex.com");
		expect(q.isUnread).toBe(true);
		expect(q.isStarred).toBe(true);
		expect(q.hasAttachment).toBe(true);
		expect(q.inAddress).toBe("info@ex.com");
	});

	it("空入力は空の条件を返す", () => {
		expect(parseSearchQuery("")).toEqual({ freeWords: [] });
		expect(parseSearchQuery(null)).toEqual({ freeWords: [] });
		expect(parseSearchQuery("   ")).toEqual({ freeWords: [] });
	});

	it("複数語の演算子は最後を取る", () => {
		const q = parseSearchQuery("from:a@x.jp from:b@y.jp");
		expect(q.from).toBe("b@y.jp");
	});

	it("不正な is: の値は invalidRequest を投げる", () => {
		expect(() => parseSearchQuery("is:bogus")).toThrowError(ApiError);
	});

	it("不正な has: の値は invalidRequest を投げる", () => {
		expect(() => parseSearchQuery("has:file")).toThrowError(ApiError);
	});

	it("不正な日付は invalidRequest を投げる", () => {
		expect(() => parseSearchQuery("since:2026/01/01")).toThrowError(ApiError);
		expect(() => parseSearchQuery("since:2026-13-99")).toThrowError(ApiError);
	});
});

describe("parseDayStart / parseDayEnd", () => {
	it("since は当日 00:00:00 UTC、until は 23:59:59 UTC を返す", () => {
		const day = parseDayStart("2026-01-02");
		expect(day).toBe(Math.floor(Date.UTC(2026, 0, 2) / 1000));
		expect(parseDayEnd("2026-01-02")).toBe(day + 86400 - 1);
	});
});

describe("SearchQuery 型の利用", () => {
	it("型として参照できる", () => {
		const q: SearchQuery = { freeWords: [] };
		expect(q.freeWords).toEqual([]);
	});
});
