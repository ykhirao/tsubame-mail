import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstile, turnstileEnabled } from "@/domain/access/turnstile";
import { ApiError } from "@/shared/errors";

const CONFIGURED = {
	TURNSTILE_SECRET: "test-secret",
	TURNSTILE_HOSTNAMES: "mail.example.com",
};

function mockSiteverify(body: unknown, init?: { ok?: boolean; status?: number }) {
	return vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify(body), {
			status: init?.status ?? 200,
			headers: { "content-type": "application/json" },
		}),
	);
}

async function expectForbidden(p: Promise<void>) {
	await expect(p).rejects.toBeInstanceOf(ApiError);
	await p.catch((e: ApiError) => expect(e.status).toBe(403));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Turnstile の検査", () => {
	// ローカルと vitest にはウィジェットが無い。必須にすると開発でログインできなくなる。
	it("TURNSTILE_SECRET が無ければ素通りする（ローカル開発）", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		expect(turnstileEnabled({})).toBe(false);
		await expect(verifyTurnstile({}, undefined, "login")).resolves.toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("siteverify が通れば例外にならない", async () => {
		mockSiteverify({ success: true, action: "login", hostname: "mail.example.com" });
		await expect(verifyTurnstile(CONFIGURED, "tok", "login")).resolves.toBeUndefined();
	});

	it("トークンが無ければ 403（設定済みの環境）", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expectForbidden(verifyTurnstile(CONFIGURED, undefined, "login"));
		// 問い合わせるまでもなく落とす。
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("success が false なら 403", async () => {
		mockSiteverify({ success: false, "error-codes": ["invalid-input-response"] });
		await expectForbidden(verifyTurnstile(CONFIGURED, "tok", "login"));
	});

	// 別の画面で取ったトークンを使い回せないようにする。
	it("action が違えば 403", async () => {
		mockSiteverify({ success: true, action: "bootstrap", hostname: "mail.example.com" });
		await expectForbidden(verifyTurnstile(CONFIGURED, "tok", "login"));
	});

	// 同じウィジェットを別サイトに置いて取ったトークンを弾く。
	it("hostname が許可の外なら 403", async () => {
		mockSiteverify({ success: true, action: "login", hostname: "evil.example.net" });
		await expectForbidden(verifyTurnstile(CONFIGURED, "tok", "login"));
	});

	// 通信の失敗を「通す」に倒すと、siteverify を落とすだけで門を抜けられる。
	it("siteverify に届かなければ 403（落ちる側に倒す）", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
		await expectForbidden(verifyTurnstile(CONFIGURED, "tok", "login"));
	});

	it("siteverify が 5xx でも 403", async () => {
		mockSiteverify({}, { status: 502 });
		await expectForbidden(verifyTurnstile(CONFIGURED, "tok", "login"));
	});

	it("siteverify が JSON を返さなくても 403", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
		await expectForbidden(verifyTurnstile(CONFIGURED, "tok", "login"));
	});

	it("2048 バイトを超えるトークンは問い合わせずに 403", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expectForbidden(verifyTurnstile(CONFIGURED, "x".repeat(2049), "login"));
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// secret だけ入れて hostname を忘れた設定は、全部通すか全部落とすかにしかならない。
	// 落とす側に倒して、設定の誤りに運用で気付けるようにする。
	it("TURNSTILE_HOSTNAMES が空なら 500 で止める", async () => {
		const p = verifyTurnstile({ TURNSTILE_SECRET: "s" }, "tok", "login");
		await expect(p).rejects.toBeInstanceOf(ApiError);
		await p.catch((e: ApiError) => expect(e.status).toBe(500));
	});
});
