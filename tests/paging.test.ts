import { describe, expect, it } from "vitest";
import { afterCursor } from "@/lib/paging";
import { ApiError } from "@/shared/errors";

function encodeCursor(seconds: number, id: string): string {
	const raw = `${seconds}:${id}`;
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("#83 lib/paging の decode は範囲外の cursor で 400 を投げる", () => {
	it("Date の上限を超える秒数の cursor は 400 になる（従来は空ページ）", () => {
		const cursor = encodeCursor(8_640_000_000_001, "abc");
		expect(() => afterCursor({ createdAt: null as never, id: null as never }, cursor, "desc")).toThrow(ApiError);
	});

	it("Date の上限ぎりぎりの秒数は通る", () => {
		const cursor = encodeCursor(8_640_000_000_000, "abc");
		// 上限ぎりぎり（8.64e15 ms）は valid なので Invalid Date にならない。
		expect(() => afterCursor({ createdAt: null as never, id: null as never }, cursor, "desc")).not.toThrow();
	});
});
