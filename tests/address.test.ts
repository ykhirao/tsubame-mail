import { describe, expect, it } from "vitest";
import {
	baseAddressOf,
	formatAddressList,
	normalizeAddress,
	parseAddressList,
} from "@/domain/mail/address";

describe("parseAddressList", () => {
	it("引用符の中のカンマで分割しない", () => {
		const list = parseAddressList('"山田, 太郎" <a@b.jp>, c@d.jp');
		expect(list).toEqual([{ address: "a@b.jp", name: "山田, 太郎" }, { address: "c@d.jp" }]);
	});

	it("空や不正な入力を落とす", () => {
		expect(parseAddressList("")).toEqual([]);
		expect(parseAddressList("not-an-address")).toEqual([]);
	});

	it("往復できる", () => {
		const s = 'foo <a@b.jp>, c@d.jp';
		expect(formatAddressList(parseAddressList(s))).toBe(s);
	});
});

describe("normalizeAddress", () => {
	it("小文字化して山括弧を外す", () => {
		expect(normalizeAddress(" <A@B.JP> ")).toBe("a@b.jp");
	});
});

describe("baseAddressOf", () => {
	it("+タグを落とした基本アドレスを返す", () => {
		expect(baseAddressOf("tanaka+github@example.com")).toBe("tanaka@example.com");
		expect(baseAddressOf("Tanaka+A+B@Example.com")).toBe("tanaka@example.com");
	});

	it("タグが無ければ null", () => {
		expect(baseAddressOf("tanaka@example.com")).toBeNull();
		expect(baseAddressOf("not-an-address")).toBeNull();
	});

	it("ローカル部が + で始まるものは基本アドレスを持たない", () => {
		// 空のローカル部にしてしまうと、別のアドレスに化けかねない。
		expect(baseAddressOf("+tag@example.com")).toBeNull();
	});

	it("ドメイン側の + には触れない", () => {
		expect(baseAddressOf("a@ex+ample.com")).toBeNull();
	});
});
