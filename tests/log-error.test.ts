import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { redactError } from "@/lib/logError";

describe("redactError（#146）", () => {
	it("drizzle のクエリ失敗からクエリとバインド値を落とし、原因のメッセージだけ残す", () => {
		const err = new DrizzleQueryError("select * from messages where body like ?", ["%秘密の検索語%"], new Error("D1_ERROR: LIKE or GLOB pattern too complex"));
		const out = redactError(err);
		expect(JSON.stringify(out)).not.toContain("秘密の検索語");
		expect(JSON.stringify(out)).not.toContain("select");
		expect(out).toEqual({ name: "DrizzleQueryError", cause: "D1_ERROR: LIKE or GLOB pattern too complex" });
	});

	it("それ以外の例外はそのまま返す", () => {
		const err = new Error("ふつうの失敗");
		expect(redactError(err)).toBe(err);
	});
});
