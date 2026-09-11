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

	it("encoded-word で CRLF を混入させた Message-ID はそのまま保存しない（#33）", async () => {
		// decodeWords が =0D=0A を実際の CRLF に戻すので、山括弧を外すだけでは改行入りの
		// 値が rfc_message_id に残り、返信生成時の assertNoLineBreak 頼みになってしまう。
		const raw = [
			"From: taro@example.com",
			"To: a@example.com",
			"Subject: test",
			"Message-ID: =?UTF-8?Q?abc=0D=0AX-Mid-Inj=3A_1?=@x.example",
			"References: =?UTF-8?Q?ref=0D=0AX-Ref-Inj?=@x.example",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"hi",
		].join("\r\n");
		const p = await parseRawMime(raw);
		expect(p.messageId).toBeNull();
		// References は空白区切りでトークン化するので、CRLF はトークンの区切りに吸収され
		// 改行を含んだトークンは残らない。
		expect(p.references).not.toContain("\r");
		expect(p.references).not.toContain("\n");
	});

	it("アドレスにタブが入った From は保存せず捨てる（返信時に宛先ゼロで黙って失敗するのを防ぐ・#39）", async () => {
		const raw = [
			'From: "a\tb"@example.org',
			"To: a@example.com",
			"Subject: test",
			"Message-ID: <safe@x.example>",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"hi",
		].join("\r\n");
		const p = await parseRawMime(raw);
		expect(p.from).toBeNull();
	});

	it("表示名に CRLF が入った To は改行を残さない（#39）", async () => {
		const raw = [
			"From: taro@example.com",
			'To: "Alice\r\nX-Mid-Inj: 1" <bob@example.com>, carol@example.com',
			"Subject: test",
			"Message-ID: <safe@x.example>",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"hi",
		].join("\r\n");
		const p = await parseRawMime(raw);
		expect(p.to).not.toContain("\r");
		expect(p.to).not.toContain("\n");
	});
});
