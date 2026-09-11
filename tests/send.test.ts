import { describe, expect, it } from "vitest";
import { sendMessageInput, replyInput } from "@/shared/contracts/send";
import { addressListToCsv, composeMime, generateMessageId } from "@/domain/mail/compose";
import { canSendFrom, collectRecipients, stripHeader } from "@/services/sender";

const baseInput = { from: "me@example.com", to: "a@b.jp" };

describe("sendMessageInput スキーマ", () => {
	it("to は文字列でも配列でも通る", () => {
		expect(sendMessageInput.safeParse({ ...baseInput, to: "a@b.jp" }).success).toBe(true);
		expect(sendMessageInput.safeParse({ ...baseInput, to: ["a@b.jp", "c@d.jp"] }).success).toBe(true);
	});

	it("from が無いと失敗する", () => {
		expect(sendMessageInput.safeParse({ to: "a@b.jp" }).success).toBe(false);
	});

	it("threadId は受け付けない（#51。使い始めると他人のスレッドに刺せてしまう）", () => {
		const parsed = sendMessageInput.safeParse({ ...baseInput, threadId: "thr_other" });
		expect(parsed.success).toBe(true);
		// zod 4 の z.object は未知キーを落とす。結果に threadId は残らない。
		expect(parsed.success && "threadId" in parsed.data).toBe(false);
	});

	it("宛先の合計が 100 件を超えると失敗する（#22）", () => {
		const many = Array.from({ length: 101 }, (_, i) => `a${i}@b.jp`);
		expect(sendMessageInput.safeParse({ ...baseInput, to: many }).success).toBe(false);
		const ok = Array.from({ length: 100 }, (_, i) => `a${i}@b.jp`);
		expect(sendMessageInput.safeParse({ ...baseInput, to: ok }).success).toBe(true);
	});

	it("to / cc / bcc の配列要素数に上限がある（#79）", () => {
		const many = Array.from({ length: 101 }, (_, i) => `a${i}@b.jp`);
		expect(sendMessageInput.safeParse({ ...baseInput, to: many }).success).toBe(false);
		expect(sendMessageInput.safeParse({ ...baseInput, to: many.slice(0, 100) }).success).toBe(true);
		expect(replyInput.safeParse({ cc: many }).success).toBe(false);
		const ok = Array.from({ length: 100 }, (_, i) => `a${i}@b.jp`);
		expect(replyInput.safeParse({ cc: ok }).success).toBe(true);
	});

	it("閉じない引用で parseAddressList 後の宛先が 0 件だと失敗する（#80）", () => {
		const unclosed = '"open <a@x.jp>, b@c.jp';
		expect(sendMessageInput.safeParse({ ...baseInput, to: unclosed }).success).toBe(false);
		expect(sendMessageInput.safeParse({ ...baseInput, to: "a@b.jp" }).success).toBe(true);
	});

	it("配列の 1 要素にカンマ区切りで詰めても、要素数でなく実際の宛先数で数える（#22 再検査失敗）", () => {
		const packedOver = [Array.from({ length: 101 }, (_, i) => `a${i}@b.jp`).join(", ")];
		expect(sendMessageInput.safeParse({ ...baseInput, to: packedOver }).success).toBe(false);
		const packedOk = [Array.from({ length: 100 }, (_, i) => `a${i}@b.jp`).join(", ")];
		expect(sendMessageInput.safeParse({ ...baseInput, to: packedOk }).success).toBe(true);
	});

	it("reply の to / cc も配列 1 要素へのカンマ詰めを見逃さない（#22 再検査失敗）", () => {
		const packedOver = [Array.from({ length: 101 }, (_, i) => `a${i}@b.jp`).join(", ")];
		expect(replyInput.safeParse({ to: packedOver }).success).toBe(false);
		expect(replyInput.safeParse({ to: "a@b.jp", cc: packedOver }).success).toBe(false);
	});

	it("件数が上限内でも、1 項目が極端に長いと文字数の上限で弾く（#22 再検査失敗）", () => {
		const huge = `${"a".repeat(20_000)}@b.jp`;
		expect(sendMessageInput.safeParse({ ...baseInput, to: huge }).success).toBe(false);
	});

	it("subject が 998 文字を超えると失敗する（#22）", () => {
		expect(sendMessageInput.safeParse({ ...baseInput, subject: "a".repeat(999) }).success).toBe(false);
		expect(sendMessageInput.safeParse({ ...baseInput, subject: "a".repeat(998) }).success).toBe(true);
	});

	it("text / html が 1MB を超えると失敗する（#22）", () => {
		expect(sendMessageInput.safeParse({ ...baseInput, text: "a".repeat(1024 * 1024 + 1) }).success).toBe(
			false,
		);
	});

	it("多バイト本文はバイト数で検査され、1MB 超を弾く（#89）", () => {
		// "あ" は 1 コード単位 3 バイト。700k 文字はコード単位では 1M 未満だが実バイトは 2.1MB。
		expect(sendMessageInput.safeParse({ ...baseInput, text: "あ".repeat(700 * 1024) }).success).toBe(false);
		const ok = "あ".repeat(300 * 1024); // 約 900KB。単体では 1MB 未満。
		expect(sendMessageInput.safeParse({ ...baseInput, text: ok }).success).toBe(true);
	});

	it("text + html + 件名 の合計が D1 行上限に届く前に弾く（#89）", () => {
		const chunk = "あ".repeat(300 * 1024); // 約 900KB × 2 = 1.8MB > 1.5MB
		expect(sendMessageInput.safeParse({ ...baseInput, text: chunk, html: chunk }).success).toBe(false);
		const single = "あ".repeat(300 * 1024); // 約 900KB。単体は 1MB 未満、合計も 1.5MB に収まる。
		expect(sendMessageInput.safeParse({ ...baseInput, text: single }).success).toBe(true);
		// 件名も合計に数えるが、900KB 程度なら 1.5MB に収まる。
		expect(
			sendMessageInput.safeParse({ ...baseInput, subject: "あ".repeat(998), text: single }).success,
		).toBe(true);
	});

	it("添付は 50 件・1 件 20MB・合計 25MB を超えると失敗する（#22）", () => {
		const small = { filename: "a.txt", contentType: "text/plain", base64: "aGk=" };
		const many = Array.from({ length: 51 }, () => small);
		expect(sendMessageInput.safeParse({ ...baseInput, attachments: many }).success).toBe(false);

		const tooBig = { filename: "a.txt", contentType: "text/plain", base64: "A".repeat(30 * 1024 * 1024) };
		expect(sendMessageInput.safeParse({ ...baseInput, attachments: [tooBig] }).success).toBe(false);

		// 1 件ずつは 20MB 未満（base64 で 12MB≒生 9MB）でも、3 件で合計 27MB（生換算）になり 25MB を超える。
		const chunk = "A".repeat(12 * 1024 * 1024);
		const three = [1, 2, 3].map(() => ({ filename: "a.txt", contentType: "text/plain", base64: chunk }));
		expect(sendMessageInput.safeParse({ ...baseInput, attachments: three }).success).toBe(false);
	});
});

describe("addressListToCsv（文字列でも配列でも同じ結果）", () => {
	it("単一文字列の入力と配列の入力が同じ正規化結果になる", () => {
		const fromString = addressListToCsv("山田 <a@b.jp>, c@d.jp");
		const fromArray = addressListToCsv(["a@b.jp", "c@d.jp"]);
		expect(fromArray).toBe("a@b.jp, c@d.jp");
		// 配列で渡した場合、名前が無ければ address のみ。文字列側は名前付き。
		expect(fromString).toMatch(/山田 <a@b\.jp>, c@d\.jp/);
	});
});

describe("canSendFrom（from 詐称の防止）", () => {
	it("writable に含まれないアドレスは送れない", () => {
		expect(canSendFrom(["adr_1"], "adr_2")).toBe(false);
	});
	it("writable に含まれるアドレスは送れる", () => {
		expect(canSendFrom(["adr_1"], "adr_1")).toBe(true);
	});
	it('owner（"all"）は存在すれば送れる', () => {
		expect(canSendFrom("all", "adr_1")).toBe(true);
	});
});

describe("composeMime", () => {
	it("Message-ID / In-Reply-To / References が埋まる", () => {
		const raw = composeMime({
			messageId: "msg_1",
			fromAddr: "me@example.com",
			toAddr: "a@b.jp",
			subject: "こんにちは",
			textBody: "本文です",
			inReplyTo: "<parent@b.jp>",
			referencesHeader: "<grand@b.jp> <parent@b.jp>",
		});
		expect(raw).toContain(`Message-ID: ${generateMessageId("msg_1", "me@example.com")}`);
		expect(raw).toContain("In-Reply-To: <parent@b.jp>");
		expect(raw).toContain("References: <grand@b.jp> <parent@b.jp>");
	});

	it("日本語の件名が正しくエンコードされる", () => {
		const raw = composeMime({
			messageId: "msg_1",
			fromAddr: "me@example.com",
			toAddr: "a@b.jp",
			subject: "見積もりの件",
			textBody: "どうぞよろしくお願いします",
		});
		expect(raw).toContain("Subject: =?utf-8?B?");
		expect(raw).toContain(Buffer.from("見積もりの件", "utf-8").toString("base64"));
	});

	it("添付（base64）が multipart に埋まる", () => {
		const raw = composeMime(
			{
				messageId: "msg_1",
				fromAddr: "me@example.com",
				toAddr: "a@b.jp",
				subject: "添付あり",
				textBody: "見てください",
			},
			[{ filename: "a.txt", contentType: "text/plain", base64: "aGVsbG8=" }],
		);
		expect(raw).toContain("Content-Disposition: attachment");
		expect(raw).toContain("aGVsbG8=");
	});

	it("生 MIME は全行 CRLF で区切られる（#87）", () => {
		const raw = composeMime({
			messageId: "msg_1",
			fromAddr: "me@example.com",
			toAddr: "a@b.jp",
			subject: "件名",
			textBody: "本文\n二行目",
		});
		expect(raw.replace(/\r\n/g, "")).not.toContain("\n");
	});

	it("日本語本文は base64 で入り、Content-Transfer-Encoding は base64（#103）", () => {
		const body = "日本語の本文です";
		const raw = composeMime({
			messageId: "msg_1",
			fromAddr: "me@example.com",
			toAddr: "a@b.jp",
			subject: "件名",
			textBody: body,
		});
		expect(raw).toContain("Content-Transfer-Encoding: base64");
		expect(raw).toContain(Buffer.from(body, "utf-8").toString("base64"));
		expect(raw).not.toContain(body);
	});

	it("本文に --<boundary> 風の行を書いてもパート境界にならない（#104）", () => {
		const raw = composeMime({
			messageId: "msg_1",
			fromAddr: "me@example.com",
			toAddr: "a@b.jp",
			subject: "件名",
			textBody: "--abc123\r\nContent-Type: text/html\r\n\r\n<p>inject</p>",
		});
		// 本文は base64 なので、注入に使う生の行は MIME に出ない。
		expect(raw).not.toContain("<p>inject</p>");
		expect(raw).not.toMatch(/^Content-Type: text\/html$/m);
	});
});

describe("composeMime のヘッダ行 998 文字上限（#34）", () => {
	function headerLine(raw: string, name: string): string {
		const block = raw.split(/\r?\n\r?\n/)[0]!;
		// mimetext は折り返さないので 1 行のまま。ヘッダ間の改行は LF のみ。
		const line = block.split(/\r?\n(?=[A-Za-z-]+:)/).find((l) => l.startsWith(`${name}:`));
		if (!line) throw new Error(`header ${name} not found`);
		return line;
	}

	it("References が 200 個でも 1 行 998 文字に収まる", () => {
		const references = Array.from({ length: 200 }, (_, i) => `<${i}@x.jp>`).join(" ");
		const raw = composeMime({
			messageId: "msg_1",
			fromAddr: "me@example.com",
			toAddr: "a@b.jp",
			subject: "件名",
			textBody: "本文",
			referencesHeader: references,
		});
		const line = headerLine(raw, "References");
		expect(line.length).toBeLessThanOrEqual(998);
		// 直近（末尾）の ID は残る。
		expect(line).toContain("<199@x.jp>");
	});

	it("長い件名でも Subject 行が 998 文字を超えない", () => {
		const raw = composeMime({
			messageId: "msg_1",
			fromAddr: "me@example.com",
			toAddr: "a@b.jp",
			subject: "あ".repeat(2000),
			textBody: "本文",
		});
		const line = headerLine(raw, "Subject");
		expect(line.length).toBeLessThanOrEqual(998);
	});
});

describe("collectRecipients / stripHeader", () => {
	it("宛先を重複なく集める", () => {
		const r = collectRecipients({
			to: [{ address: "a@b.jp" }],
			cc: [{ address: "a@b.jp" }, { address: "c@d.jp" }],
			bcc: [{ address: "e@f.jp" }],
		});
		expect(r.map((x) => x.address)).toEqual(["a@b.jp", "c@d.jp", "e@f.jp"]);
	});

	it("Bcc ヘッダを継続行ごと取り除く", () => {
		const raw = "From: x@y.jp\r\nTo: a@b.jp\r\nBcc: c@d.jp,\r\n d@e.jp\r\nSubject: hi\r\n\r\nbody";
		const out = stripHeader(raw, "Bcc");
		expect(out).not.toContain("Bcc:");
		expect(out).not.toContain("d@e.jp");
	});
});
