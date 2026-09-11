import { describe, expect, it } from "vitest";
import { isSelfAddress, looseAddressOf } from "@/ui/lib/looseAddress";

describe("looseAddressOf", () => {
	it("表示名・山括弧を外し、引用ローカル部・末尾ドットを剥がす", () => {
		expect(looseAddressOf("Box@X.JP")).toBe("box@x.jp");
		expect(looseAddressOf("表示名 <box+news@x.jp>")).toBe("box+news@x.jp");
		expect(looseAddressOf('"victim"@example.com')).toBe("victim@example.com");
	});
});

describe("isSelfAddress", () => {
	it("own に +タグ が無ければ、タグ付き宛先も自分として扱う（#23）", () => {
		expect(isSelfAddress("box+news@x.jp", "box@x.jp")).toBe(true);
		expect(isSelfAddress("box@x.jp", "box@x.jp")).toBe(true);
	});

	it("own に +タグ があるとき、別タグやタグ無しは別人のまま（#23 再検査: 別人を自分扱いする退行）", () => {
		expect(isSelfAddress("box@x.jp", "box+a@x.jp")).toBe(false);
		expect(isSelfAddress("box+b@x.jp", "box+a@x.jp")).toBe(false);
		expect(isSelfAddress("box+a@x.jp", "box+a@x.jp")).toBe(true);
	});

	it("全員に返信の既定 Cc（box+promo@）を自分として濾せる（#78）", () => {
		expect(isSelfAddress("box+promo@x.jp", "box@x.jp")).toBe(true);
	});
});
