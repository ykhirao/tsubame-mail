import { describe, expect, it } from "vitest";
import { parseRawMime } from "@/domain/mail/parse";
import { sampleMime } from "./helpers";

describe("parseRawMime", () => {
	it("基本フィールドを正規化する（山括弧を外す）", async () => {
		const p = await parseRawMime(sampleMime());
		expect(p.messageId).toBe("abc-123@x.example");
		expect(p.inReplyTo).toBe("prev-1@x.example");
		expect(p.references).toBe("prev-1@x.example prev-0@x.example");
		expect(p.subject).toBeTruthy();
		expect(p.text).toContain("Hello");
		expect(p.snippet.length).toBeLessThanOrEqual(200);
	});

	it("to / cc は複数アドレスを全部保持する", async () => {
		const p = await parseRawMime(sampleMime());
		expect(p.to).toContain("a@b.jp");
		expect(p.to).toContain("c@d.jp");
		expect(p.to.split(",")).toHaveLength(2);
		expect(p.cc).toBe("e@f.jp");
	});

	it("添付を inline 判定と contentId 付きで返す", async () => {
		const p = await parseRawMime(sampleMime());
		expect(p.attachments).toHaveLength(1);
		const att = p.attachments[0]!;
		expect(att.filename).toBe("report.pdf");
		expect(att.contentType).toBe("application/pdf");
		expect(att.isInline).toBe(false);
	});

	it("Date を Unix 秒に変換する", async () => {
		const p = await parseRawMime(sampleMime());
		expect(p.date).toBe(Math.floor(Date.parse("Mon, 14 Sep 2026 03:00:00 +0000") / 1000));
	});
});
