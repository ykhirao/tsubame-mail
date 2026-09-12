import { beforeEach, describe, expect, it } from "vitest";
import { listHref, listKey, prevNext, resetList, setList } from "@/ui/lib/listState";

describe("listState", () => {
	beforeEach(() => {
		resetList({ address: "", view: "inbox" });
	});

	it("listKey は絞り込みごとに変わる", () => {
		expect(listKey({ address: "", view: "inbox" })).toBe("|inbox");
		expect(listKey({ address: "adr_1", view: "starred" })).toBe("adr_1|starred");
	});

	it("listHref は絞り込みをクエリにする", () => {
		expect(listHref({ address: "", view: "inbox" })).toBe("/");
		expect(listHref({ address: "adr_1", view: "inbox" })).toBe("/?address=adr_1");
		expect(listHref({ address: "adr_1", view: "sent" })).toBe("/?address=adr_1&view=sent");
		expect(listHref({ address: "", view: "trash" })).toBe("/?view=trash");
	});

	it("prevNext は保存した順で前後の id を返す", () => {
		setList({ address: "", view: "inbox" }, ["thr_a", "thr_b", "thr_c"]);
		expect(prevNext("thr_a")).toEqual({ next: "thr_b" });
		expect(prevNext("thr_b")).toEqual({ prev: "thr_a", next: "thr_c" });
		expect(prevNext("thr_c")).toEqual({ prev: "thr_b" });
		expect(prevNext("thr_x")).toEqual({});
	});

	it("setList は読み進めた分まで ids を残すので、位置復元が可能になる", () => {
		setList({ address: "", view: "inbox" }, ["thr_1"]);
		setList({ address: "", view: "inbox" }, ["thr_1", "thr_2", "thr_3"]);
		expect(prevNext("thr_1")).toEqual({ next: "thr_2" });
		expect(prevNext("thr_2")).toEqual({ prev: "thr_1", next: "thr_3" });
	});

	it("resetList は位置情報を白紙に戻す", () => {
		setList({ address: "", view: "inbox" }, ["thr_1", "thr_2"]);
		resetList({ address: "adr_1", view: "inbox" });
		expect(prevNext("thr_1")).toEqual({});
		expect(listKey({ address: "adr_1", view: "inbox" })).toBe("adr_1|inbox");
	});

	it("setList の読み直しが、読み進めた ids を残す", () => {
		setList({ address: "", view: "inbox" }, ["thr_1", "thr_2"]);
		setList({ address: "", view: "inbox" }, ["thr_1", "thr_2", "thr_3"]);
		expect(prevNext("thr_1")).toEqual({ next: "thr_2" });
		expect(prevNext("thr_2")).toEqual({ prev: "thr_1", next: "thr_3" });
	});
});
