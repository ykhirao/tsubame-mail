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
