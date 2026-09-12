import { describe, expect, it, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { getDb, schema } from "@/db/client";
import { newId } from "@/lib/id";
import { createApp } from "@/api/app";
import { buildSrcDoc, hasRemoteImages } from "@/ui/components/MessageHtml";
import headersFile from "../public/_headers?raw";
import { applyMigrations } from "./helpers/migrate";
import { createUser, createDomain, createAddress, createApiKeyFor, grant } from "./auth-helpers";

async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
	return createApp().fetch(new Request(`https://tsubame.test${path}`, init), env, createExecutionContext());
}

function expectLockedDown(res: Response) {
	const csp = res.headers.get("content-security-policy") ?? "";
	expect(csp).toContain("default-src 'none'");
	expect(csp).toContain("frame-ancestors 'none'");
	expect(csp).toContain("form-action 'none'");
	expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	expect(res.headers.get("x-frame-options")).toBe("DENY");
	expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("API 応答のセキュリティヘッダ", () => {
	it("正常応答に付く", async () => {
		const res = await fetchApi("/api/health");
		expect(res.status).toBe(200);
		expectLockedDown(res);
	});

	it("onError で整形されたエラー応答にも付く", async () => {
		const res = await fetchApi("/api/v1/messages");
		expect(res.status).toBe(401);
		expectLockedDown(res);
	});

	it("存在しないエンドポイントの 404 にも付く", async () => {
		const res = await fetchApi("/api/v1/no-such-endpoint");
		expect(res.status).toBe(404);
		expectLockedDown(res);
	});
});

describe("SPA 資産の _headers", () => {
	const text = headersFile;

	it("全パスにクリックジャッキング対策と nosniff を付ける", () => {
		expect(text).toMatch(/^\/\*$/m);
		expect(text).toContain("frame-ancestors 'none'");
		expect(text).toContain("X-Frame-Options: DENY");
		expect(text).toContain("X-Content-Type-Options: nosniff");
		expect(text).toContain("script-src 'self';");
	});

	it("「画像を表示」が効くよう、親の img-src は https: を許す", () => {
		expect(text).toMatch(/img-src [^;]*https:/);
	});
});

describe("メール本文の srcdoc", () => {
	const metaCsp = (doc: string) =>
		doc.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1] ?? "";

	it("既定ではリモートの画像も CSS も読ませない", () => {
		const csp = metaCsp(buildSrcDoc('<img src="https://attacker.example/p.png">', false));
		expect(csp).toContain("default-src 'none'");
		expect(csp).toMatch(/img-src data:;/);
		expect(csp).not.toContain("https:");
	});

	it("許可したときだけ img-src に https: が入る", () => {
		const csp = metaCsp(buildSrcDoc('<img src="https://example.com/p.png">', true));
		expect(csp).toMatch(/img-src data: https:;/);
		expect(csp).toContain("default-src 'none'");
	});

	it("CSP の meta を本文より前に置く", () => {
		const doc = buildSrcDoc("<html><head><title>x</title></head><body>本文</body></html>", false);
		expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<html>"));
	});

	it("doctype があれば、互換モードに落ちないようその後ろに差し込む", () => {
		const doc = buildSrcDoc("<!DOCTYPE html><html><body>本文</body></html>", false);
		expect(doc.startsWith("<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
	});

	it("外部の画像を含むかを見分ける", () => {
		expect(hasRemoteImages('<img src="https://a.example/x.png">')).toBe(true);
		expect(hasRemoteImages("<img src='http://a.example/x.png'>")).toBe(true);
		expect(hasRemoteImages("<img src=//a.example/x.png>")).toBe(true);
		expect(hasRemoteImages('<td background="https://a.example/bg.png">')).toBe(true);
		expect(hasRemoteImages('<div style="background:url( https://a.example/bg.png )">')).toBe(true);
		expect(hasRemoteImages('<img src="data:image/png;base64,AAAA">')).toBe(false);
		expect(hasRemoteImages('<a href="https://a.example/">リンク</a>')).toBe(false);
	});

	// #17: <link rel=preconnect> は CSP を素通りして接続だけを張る。DOMParser の無い
	// この実行環境（workerd）では正規表現によるフォールバック経路を検査する。
	it("<link rel=preconnect> を取り除く（#17）", () => {
		const doc = buildSrcDoc('<link rel="preconnect" href="http://attacker.example/"><p>本文</p>', false);
		expect(doc).not.toContain("<link");
		expect(doc).toContain("<p>本文</p>");
	});

	it("<link> は rel の種類を問わず取り除く", () => {
		const doc = buildSrcDoc(
			'<link rel="stylesheet" href="https://a.example/x.css">' +
				'<link rel="dns-prefetch" href="//a.example">' +
				'<link rel="prefetch" href="https://a.example/y">' +
				"<p>本文</p>",
			false,
		);
		expect(doc).not.toContain("<link");
	});

	it("meta http-equiv=refresh を取り除く（開いた瞬間の自動遷移を防ぐ）", () => {
		const doc = buildSrcDoc('<meta http-equiv="refresh" content="0;url=http://attacker.example/"><p>本文</p>', false);
		expect(doc.toLowerCase()).not.toContain("refresh");
		expect(doc).toContain("<p>本文</p>");
	});

	it("http-equiv の大小文字・空白ゆれがあっても取り除く", () => {
		const doc = buildSrcDoc('<meta HTTP-EQUIV = "Refresh" content="0;url=http://attacker.example/">', false);
		expect(doc.toLowerCase()).not.toContain("refresh");
	});
});

describe("生 MIME の配信は attachment（#49）", () => {
	beforeEach(async () => {
		await applyMigrations();
	});

	it("Content-Disposition が attachment になり、inline では返らない", async () => {
		const owner = await createUser({ role: "owner" });
		const domainId = await createDomain();
		const addressId = await createAddress(domainId, "a");
		// 生 MIME は割り当てたアドレスだけ読める（owner も割り当てが要る）。
		await grant(owner.id, addressId, "write");
		const { token } = await createApiKeyFor({ userId: owner.id, scopes: ["read"], addressIds: null });

		const db = getDb(env);
		const messageId = newId("message");
		const rawKey = `raw/2026/09/${messageId}.eml`;
		await env.BUCKET.put(rawKey, "Subject: x\r\n\r\nhi");
		await db.insert(schema.messages).values({
			id: messageId,
			addressId,
			direction: "inbound",
			status: "received",
			fromAddr: "sender@example.com",
			toAddr: "a@example.com",
			subject: "x",
			receivedAt: new Date(),
			rawR2Key: rawKey,
		});

		const res = await fetchApi(`/api/v1/messages/${messageId}/raw`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const disposition = res.headers.get("content-disposition") ?? "";
		expect(disposition).toContain("attachment");
		expect(disposition).not.toContain("inline");
	});
});
