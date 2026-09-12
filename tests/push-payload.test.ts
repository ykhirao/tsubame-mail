import { describe, expect, it } from "vitest";
import { isSafePath, sameOriginHref, validMessageId } from "@/ui/lib/pushPayload";

describe("isSafePath", () => {
	it("相対パスのみ許可する", () => {
		expect(isSafePath("/")).toBe(true);
		// http(s) は `\` を `/` と読むので、別オリジンへ抜ける（#138）。
		expect(isSafePath("/\\evil.example/x")).toBe(false);
		expect(isSafePath("/threads/thr_1")).toBe(true);
	});
	it("プロトコル相対・外部 URL・javascript: などは弾く", () => {
		expect(isSafePath("//evil.example/x")).toBe(false);
		expect(isSafePath("https://evil.example/x")).toBe(false);
		expect(isSafePath("javascript:alert(1)")).toBe(false);
		expect(isSafePath("threads/x")).toBe(false);
		expect(isSafePath(undefined)).toBe(false);
	});
});

describe("sameOriginHref", () => {
	const base = "https://mail.example.com/";
	it("同一オリジンなら絶対 href を返す", () => {
		expect(sameOriginHref("/icon.png", base)).toBe("https://mail.example.com/icon.png");
		expect(sameOriginHref("https://mail.example.com/x.png", base)).toBe("https://mail.example.com/x.png");
	});
	it("別オリジン・非 http(s) は undefined", () => {
		expect(sameOriginHref("https://evil.example/x.png", base)).toBeUndefined();
		expect(sameOriginHref("//evil.example/x.png", base)).toBeUndefined();
		expect(sameOriginHref("javascript:alert(1)", base)).toBeUndefined();
		expect(sameOriginHref("data:text/plain,x", base)).toBeUndefined();
	});
});

describe("validMessageId", () => {
	it("msg_ 形式だけ通す", () => {
		expect(validMessageId("msg_abcdef")).toBe("msg_abcdef");
		expect(validMessageId("adr_123")).toBeUndefined();
		expect(validMessageId("../../../etc/passwd")).toBeUndefined();
	});
});
