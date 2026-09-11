import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import {
	buildReplyQuote,
	quoteHeader,
	quoteText,
	quoteHtml,
	replySubject,
	referencesFor,
	stripHtml,
} from "@/domain/mail/quote";
import { composeMime } from "@/domain/mail/compose";
import { formatAddress } from "@/domain/mail/address";

const src = {
	fromName: "山田太郎",
	fromAddr: "a@b.jp",
	receivedAt: new Date(2026, 8, 9, 12, 34),
	textBody: "こんにちは\nよろしく",
	htmlBody: null,
};

describe("quoteHeader", () => {
	it("日本語の引用ヘッダを作る", () => {
		expect(quoteHeader(src)).toBe("2026年9月9日 12:34 山田太郎 <a@b.jp>:");
	});
});

describe("quoteText", () => {
	it("各行に > を付け、先頭にヘッダを置く", () => {
		const q = quoteText("2026年9月9日 12:34 山田太郎 <a@b.jp>:", "こんにちは\nよろしく");
		expect(q).toBe("2026年9月9日 12:34 山田太郎 <a@b.jp>:\n> こんにちは\n> よろしく");
	});
});

describe("buildReplyQuote", () => {
	it("text と html の両方を作る", () => {
		const { text, html } = buildReplyQuote(src);
		expect(text).toContain("> こんにちは");
		expect(html).toContain("<blockquote>");
		expect(html).toContain("2026年9月9日 12:34");
	});

	it("元が HTML しか無い場合、テキスト版はタグを除いて引用する", () => {
		const { text } = buildReplyQuote({
			fromAddr: "a@b.jp",
			receivedAt: src.receivedAt,
			htmlBody: "<p>こんにちは</p><p>よろしく</p>",
		});
		expect(text).toContain("> こんにちは");
		expect(text).toContain("> よろしく");
	});

	it("両方無ければプレースホルダを入れる", () => {
		const { text } = buildReplyQuote({ fromAddr: "a@b.jp", receivedAt: src.receivedAt });
		expect(text).toContain("（本文なし）");
	});

	it("受信 HTML の script / img / blockquote 脱出をサニタイズする（#16）", () => {
		const { html } = buildReplyQuote({
			fromAddr: "attacker@evil.example",
			receivedAt: src.receivedAt,
			htmlBody: '<p>hi</p><img src="https://attacker.example/t.png"></blockquote><script>1</script>',
		});
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("</blockquote><script>");
		// blockquote は 1 個だけ（開閉とも quoteHtml 由来）
		expect(html.match(/<blockquote>/g)).toHaveLength(1);
		expect(html.match(/<\/blockquote>/g)).toHaveLength(1);
		expect(html).toContain("hi");
	});
});

describe("replySubject", () => {
	it("Re: を重複させない", () => {
		expect(replySubject("Re: 見積もり")).toBe("Re: 見積もり");
		expect(replySubject("RE: 見積もり")).toBe("Re: 見積もり");
	});
	it("Re: が無ければ付ける", () => {
		expect(replySubject("見積もり")).toBe("Re: 見積もり");
	});
	it("空なら Re: のまま", () => {
		expect(replySubject("")).toBe("Re: ");
	});
});

describe("referencesFor", () => {
	it("親の Message-ID を References に追記する", () => {
		expect(referencesFor("<a@x> <b@x>", "<c@x>")).toBe("<a@x> <b@x> <c@x>");
	});
	it("既にあれば重複させない", () => {
		expect(referencesFor("<c@x>", "<c@x>")).toBe("<c@x>");
	});

	it("大量の References は直近だけ残す（#34）", () => {
		const long = Array.from({ length: 200 }, (_, i) => `<${i}@x.jp>`).join(" ");
		const result = referencesFor(long, "<200@x.jp>");
		const ids = result.split(" ");
		expect(ids.length).toBeLessThanOrEqual(50);
		expect(ids.at(-1)).toBe("<200@x.jp>");
		expect(result.length).toBeLessThan(998);
	});
});

describe("stripHtml", () => {
	it("タグを除き段落を改行にする", () => {
		expect(stripHtml("<p>こんにちは</p><p>よろしく</p>")).toBe("こんにちは\nよろしく");
	});
});

describe("composeMime の To 行（長い表示名 #66）", () => {
	function toLine(raw: string): string {
		const block = raw.split(/\r?\n\r?\n/)[0]!;
		return block.split(/\r?\n(?=[A-Za-z-]+:)/).find((l) => l.startsWith("To:"))!;
	}

	it("受信由来の 1000 バイト超の表示名でも To 行が 998 文字に収まる", () => {
		const longName = "あ".repeat(1000); // 3000 バイト
		const raw = composeMime({
			messageId: "msg_1",
			fromAddr: "me@example.com",
			toAddr: `${formatAddress({ address: "a@b.jp", name: longName })}, b@c.jp`,
			subject: "件名",
			textBody: "本文",
		});
		const line = toLine(raw);
		expect(line.length).toBeLessThanOrEqual(998);
		// 表示名は落ち、アドレスは残る。
		expect(line).toContain("<a@b.jp>");
	});

	it("通常の長さの表示名は保持される", () => {
		const raw = composeMime({
			messageId: "msg_1",
			fromAddr: "me@example.com",
			toAddr: `${formatAddress({ address: "a@b.jp", name: "山田 太郎" })}, b@c.jp`,
			subject: "件名",
			textBody: "本文",
		});
		const line = toLine(raw);
		expect(line.length).toBeLessThanOrEqual(998);
		// 名前は mimetext が base64 の encoded-word で入る（落ちていない）。
		expect(line).toContain("=?utf-8?B?");
	});
});

describe("quoteHtml", () => {
	it("blockquote で包み、ヘッダは改行タグにする", () => {
		const h = quoteHtml("2026年9月9日 12:34 <a@b.jp>:", "<p>こんにちは</p>");
		expect(h).toContain("<blockquote>");
		expect(h).toContain("2026年9月9日 12:34");
		expect(h).toContain("<p>こんにちは</p>");
	});
});

describe("composeMime の添付ファイル名（#119）", () => {
	it("非 ASCII のファイル名は生 UTF-8 ヘッダにならず、読み戻すと復元される", async () => {
		const raw = composeMime(
			{
				messageId: "msg_1",
				fromAddr: "me@example.com",
				toAddr: "a@b.jp",
				subject: "件名",
				textBody: "本文",
			},
			[{ filename: "レポ\"ート;x.pdf", contentType: "application/pdf", base64: "aGk=" }],
		);
		// ヘッダ部に 0x80 以上のバイトが無い。
		const header = raw.split(/\r?\n\r?\n/)[0]!;
		for (const ch of header) {
			expect(ch.charCodeAt(0)).toBeLessThan(0x80);
		}
		expect(raw).not.toContain("name=\"レポ");
		// RFC 2231（filename*=UTF-8''…）を読み戻すと元のファイル名になる。
		const parsed = await new PostalMime().parse(raw);
		expect(parsed.attachments[0]?.filename).toBe("レポ\"ート;x.pdf");
	});

	it("ASCII のファイル名は従来どおり name=/filename= に入り、壊れない", () => {
		const raw = composeMime(
			{
				messageId: "msg_1",
				fromAddr: "me@example.com",
				toAddr: "a@b.jp",
				subject: "件名",
				textBody: "本文",
			},
			[{ filename: "report(1).pdf", contentType: "application/pdf", base64: "aGk=" }],
		);
		expect(raw).toContain('name="report(1).pdf"');
		expect(raw).toContain('filename="report(1).pdf"');
	});
});

