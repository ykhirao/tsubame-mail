import { describe, expect, it } from "vitest";
import {
	baseAddressOf,
	formatAddress,
	formatAddressList,
	normalizeAddress,
	parseAddressList,
} from "@/domain/mail/address";
import { createAddressInput, updateAddressInput } from "@/shared/contracts/addresses";

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

	it("表示名の \\\" エスケープを解釈し、保存済みの行の宛先を落とさない（#39 再検査失敗）", () => {
		const list = parseAddressList('"x\\"y" <bob@x.com>, carol@x.com');
		expect(list).toEqual([{ address: "bob@x.com", name: 'x"y' }, { address: "carol@x.com" }]);
	});

	it("formatAddress が保存した表示名の \" を読み戻せる（往復）", () => {
		const s = formatAddressList([{ address: "bob@x.com", name: 'x"y' }, { address: "carol@x.com" }]);
		expect(parseAddressList(s)).toEqual([{ address: "bob@x.com", name: 'x"y' }, { address: "carol@x.com" }]);
	});

	it("引用ローカル部のカンマで宛先が別のアドレスに分かれない（#82）", () => {
		const list = parseAddressList('"box,leak@evil.jp,zz"@example.com, box@example.com');
		expect(list.map((a) => a.address)).toEqual(["box@example.com"]);
	});

	it("正当な表示名のカンマは往復で壊れない（#82 の対照）", () => {
		const s = '"Doe, John" <bob@x.com>, carol@x.com';
		expect(parseAddressList(s)).toEqual([{ address: "bob@x.com", name: "Doe, John" }, { address: "carol@x.com" }]);
		expect(parseAddressList(formatAddressList(parseAddressList(s)))).toEqual([
			{ address: "bob@x.com", name: "Doe, John" },
			{ address: "carol@x.com" },
		]);
	});
});

describe("normalizeAddress", () => {
	it("小文字化して山括弧を外す", () => {
		expect(normalizeAddress(" <A@B.JP> ")).toBe("a@b.jp");
	});

	it("改行や制御文字を含むものはアドレスとして扱わない", () => {
		expect(normalizeAddress("a@b.jp\r\nBcc: x@evil.jp")).toBeNull();
		expect(normalizeAddress("a\t@b.jp")).toBeNull();
		expect(normalizeAddress("a@b.jp\u0000")).toBeNull();
	});

	it("引用ローカル部・末尾ドットを剥がして reject ルールをすり抜けさせない（#29）", () => {
		expect(normalizeAddress('"victim"@example.com')).toBe("victim@example.com");
		expect(normalizeAddress("victim.@example.com")).toBe("victim@example.com");
		expect(normalizeAddress("victim@example.com.")).toBe("victim@example.com");
	});

	it("ローカル部にカンマがあるアドレスは捨てる（#82）", () => {
		expect(normalizeAddress('"box,leak@evil.jp,zz"@example.com')).toBeNull();
		expect(normalizeAddress("box,leak@evil.jp,zz@example.com")).toBeNull();
	});
});

describe("formatAddress", () => {
	it("表示名の改行を落として、保存文字列が別のアドレスに分裂しないようにする（#39）", () => {
		const formatted = formatAddress({ address: "bob@example.com", name: "Alice\r\nX-Mid-Inj: 1" });
		expect(formatted).not.toContain("\r");
		expect(formatted).not.toContain("\n");
		expect(parseAddressList(`${formatted}, carol@example.com`)).toHaveLength(2);
	});

	// formatAddress → parseAddressList が往復すること（後ろのアドレスも含めて全件・表示名とも）。
	// \ 自身を escape していないと、名前が \ で終わったときに閉じ引用符が「エスケープされた文字」
	// と読み違えられ、引用が閉じないまま後続のカンマも飲み込んで宛先ごと消える（#39 再検査での退行）。
	function roundTrip(name: string) {
		const s = formatAddressList([{ address: "bob@x.com", name }, { address: "carol@x.com" }]);
		return parseAddressList(s);
	}

	it("表示名が \\ で終わっても往復できる", () => {
		expect(roundTrip("a,\\")).toEqual([
			{ address: "bob@x.com", name: "a,\\" },
			{ address: "carol@x.com" },
		]);
	});

	it('表示名が \\" を含んでも往復できる', () => {
		expect(roundTrip('x\\"y')).toEqual([
			{ address: "bob@x.com", name: 'x\\"y' },
			{ address: "carol@x.com" },
		]);
	});

	it("表示名が \\\\ を含んでも往復できる", () => {
		expect(roundTrip("a\\\\b")).toEqual([
			{ address: "bob@x.com", name: "a\\\\b" },
			{ address: "carol@x.com" },
		]);
	});

	it('表示名が " を含んでも往復できる', () => {
		expect(roundTrip('x"y')).toEqual([
			{ address: "bob@x.com", name: 'x"y' },
			{ address: "carol@x.com" },
		]);
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

describe("displayName スキーマ（#105）", () => {
	it("改行を含む displayName は create では落とす", () => {
		const parsed = createAddressInput.safeParse({
			domainId: "dom_1",
			localPart: "alice",
			displayName: "Alice\r\nBcc: evil@evil.jp",
			kind: "mailbox",
		});
		expect(parsed.success).toBe(false);
	});

	it("改行を含む displayName は PATCH（update）では落とす", () => {
		const parsed = updateAddressInput.safeParse({ displayName: "Bob\nCc: x@evil.jp" });
		expect(parsed.success).toBe(false);
	});

	it("通常の displayName は通る", () => {
		expect(updateAddressInput.safeParse({ displayName: "山田 太郎" }).success).toBe(true);
	});
});
