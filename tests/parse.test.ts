import { describe, expect, it } from "vitest";
import { parseRawMime, spamVerdictFromScore } from "@/domain/mail/parse";
import { sampleMime } from "./helpers";

// 実機のヘッダの並び（constraints.md #127/#128）を写す。A / B の署名などは伏せる。
function cfMime(opts: {
	arcAuth?: string;
	authResults?: string;
	spamScore?: string;
	senderHeaders?: string[];
}): string {
	const lines = [
		"Received: from mail.sender.example by mx.cloudflare.net with ESMTPS id X",
		"ARC-Seal: i=1; a=rsa-sha256; s=x; d=mx.cloudflare.net; t=1",
		"ARC-Message-Signature: i=1; a=rsa-sha256; d=mx.cloudflare.net",
		...(opts.arcAuth !== undefined ? [`ARC-Authentication-Results: i=1; mx.cloudflare.net; ${opts.arcAuth}`] : []),
		"Received-SPF: pass (receiver=mx.cloudflare.net) client-ip=x",
		...(opts.authResults !== undefined ? [`Authentication-Results: mx.cloudflare.net; ${opts.authResults}`] : []),
		...(opts.spamScore !== undefined ? [`X-CF-SpamH-Score: ${opts.spamScore}`] : []),
		...(opts.senderHeaders ?? []),
		"From: taro@example.com",
		"To: a@example.com",
		"Subject: test",
		"Message-ID: <abc@x.example>",
		"Date: Mon, 14 Sep 2026 03:00:00 +0000",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
	].join("\r\n");
	return lines;
}

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
		// #72 で山括弧の無い断片は捨てるようになったので、参考文献は残らない。
		expect(p.references).toBeNull();
	});

	it("encoded-word で CRLF を混入させた References は、割れた断片を残さず山括弧付き Message-ID だけ残す（#72）", async () => {
		const raw = [
			"From: taro@example.com",
			"To: a@example.com",
			"Subject: test",
			"Message-ID: <legit@x.example>",
			"In-Reply-To: <prev@x.example>",
			"References: =?UTF-8?Q?ref=0D=0AX-Inj=3A_1?=@x.example <prev@x.example>",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"hi",
		].join("\r\n");
		const p = await parseRawMime(raw);
		// CRLF で割れた X-Inj: の断片はトークンとして残らず、山括弧付き Message-ID だけが残る。
		expect(p.inReplyTo).toBe("prev@x.example");
		expect(p.references).toBe("prev@x.example");
		expect(p.references).not.toContain("Inj");
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

describe("Cloudflare 判定ブロック（#127 / #128）", () => {
	it("A 型: CF ブロックとスコアを読み、dmarc=pass と dkim ドメインを抽出する", async () => {
		const p = await parseRawMime(
			cfMime({
				arcAuth: "i=1; mx.cloudflare.net; dkim=pass header.d=m.example.com; dmarc=pass policy.dmarc=reject; spf=pass",
				authResults: "dkim=pass header.d=m.example.com; dmarc=pass policy.dmarc=reject; spf=pass",
				spamScore: "1",
			}),
		);
		expect(p.inboundAuth?.dmarc).toBe("pass");
		expect(p.inboundAuth?.dkimPassDomains).toContain("m.example.com");
		expect(p.cfSpamScore).toBe(1);
	});

	it("B 型: スコアが無く、下に別の Received が来る（Google の ARC 一式）とブロックを終える", async () => {
		const p = await parseRawMime(
			cfMime({
				arcAuth: "i=1; mx.cloudflare.net; dkim=pass header.d=gmail.com; dmarc=pass policy.dmarc=none; spf=pass",
				authResults: "dkim=pass header.d=gmail.com; dmarc=pass policy.dmarc=none; spf=pass",
				senderHeaders: [
					"Received: from mail.google.com by mail-google.example with ESMTPS",
				"ARC-Seal: i=2; a=rsa-sha256; d=google.com",
				"ARC-Message-Signature: i=2; a=rsa-sha256; d=google.com",
				"ARC-Authentication-Results: i=2; mx.google.com; dkim=pass",
			],
			}),
		);
		expect(p.cfSpamScore).toBeNull();
		expect(p.inboundAuth?.dmarc).toBe("pass");
		expect(p.inboundAuth?.dkimPassDomains).toContain("gmail.com");
	});

	it("#6740 の形: 本物の Authentication-Results が無く、送信者が偽の dmarc=pass を置いても ARC の判定で使われない", async () => {
		const p = await parseRawMime(
			cfMime({
				arcAuth: "i=1; mx.cloudflare.net; spf=pass",
				senderHeaders: ["Authentication-Results: mx.cloudflare.net; dmarc=pass", "From: attacker@evil.jp"],
			}),
		);
		expect(p.inboundAuth).toBeNull();
	});

	it("ARC にも判定が無ければ未認証（inboundAuth は null）", async () => {
		const p = await parseRawMime(
			cfMime({ arcAuth: "i=1; mx.cloudflare.net; spf=pass", authResults: "spf=pass" }),
		);
		expect(p.inboundAuth).toBeNull();
	});

	it("CF ブロックが無いメールは判定もスコアも null", async () => {
		const p = await parseRawMime(
			[
				"From: taro@example.com",
				"To: a@example.com",
				"Subject: test",
				"MIME-Version: 1.0",
				"Content-Type: text/plain; charset=utf-8",
				"",
				"hi",
			].join("\r\n"),
		);
		expect(p.inboundAuth).toBeNull();
		expect(p.cfSpamScore).toBeNull();
	});
});

describe("spamVerdictFromScore", () => {
	it("スコアが無ければ null、3 以上なら suspicious、それ未満は clean（spam は出さない。#140）", () => {
		expect(spamVerdictFromScore(null)).toBeNull();
		expect(spamVerdictFromScore(0)).toBe("clean");
		expect(spamVerdictFromScore(2)).toBe("clean");
		expect(spamVerdictFromScore(3)).toBe("suspicious");
		expect(spamVerdictFromScore(4)).toBe("suspicious");
		expect(spamVerdictFromScore(5)).toBe("suspicious");
		expect(spamVerdictFromScore(9)).toBe("suspicious");
	});
});
