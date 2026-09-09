import { describe, expect, it } from "vitest";
import {
	backoffDelaySeconds,
	isRetryExhausted,
	OUTBOUND_BACKOFF_SECONDS,
	OUTBOUND_MAX_ATTEMPTS,
} from "@/domain/mail/outbound";
import { replyAllRecipients } from "@/api/v1/outbound";
import { canSendFrom } from "@/services/sender";

describe("送信バックオフ", () => {
	it("失敗 n 回目は 10s, 60s, 300s と延びる", () => {
		expect(backoffDelaySeconds(1)).toBe(10);
		expect(backoffDelaySeconds(2)).toBe(60);
		expect(backoffDelaySeconds(3)).toBe(300);
		// 上限を超えても最後の値を返す（使い分けは isRetryExhausted が担当）
		expect(backoffDelaySeconds(99)).toBe(300);
	});
	it("OUTBOUND_BACKOFF_SECONDS は仕様どおり 10 / 60 / 300", () => {
		expect(OUTBOUND_BACKOFF_SECONDS).toEqual([10, 60, 300]);
	});
	it("上限を超えたら永久失敗", () => {
		expect(OUTBOUND_MAX_ATTEMPTS).toBe(3);
		expect(isRetryExhausted(1)).toBe(false);
		expect(isRetryExhausted(3)).toBe(false);
		expect(isRetryExhausted(4)).toBe(true);
	});
});

describe("replyAllRecipients", () => {
	const isSelf = (a: string) => /^me@/.test(a);

	it("replyAll なら To/Cc から自分を除いて元の From を集める", () => {
		const r = replyAllRecipients(
			[{ address: "x@z.jp" }],
			"a@b.jp, me@example.com",
			"c@d.jp",
			isSelf,
			true,
		);
		expect(r.map((m) => m.address)).toEqual(["x@z.jp", "a@b.jp", "c@d.jp"]);
	});

	it("replyAll でなければ元の From だけ", () => {
		const r = replyAllRecipients([{ address: "x@z.jp" }], "a@b.jp", "c@d.jp", isSelf, false);
		expect(r.map((m) => m.address)).toEqual(["x@z.jp"]);
	});

	it("自分は除外する", () => {
		const r = replyAllRecipients([], "me@example.com, a@b.jp", null, isSelf, true);
		expect(r.map((m) => m.address)).toEqual(["a@b.jp"]);
	});
});

describe("canSendFrom で 403 相当を判定", () => {
	it("他人のアドレスを from にすると拒否（false）", () => {
		expect(canSendFrom(["adr_own"], "adr_other")).toBe(false);
	});
});
