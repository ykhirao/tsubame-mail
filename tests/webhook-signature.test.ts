import { describe, expect, it } from "vitest";
import { buildSignatureHeader, hmacHex } from "@/services/webhooks";

describe("webhook 署名（HMAC-SHA256）", () => {
	it("既知の鍵と本文で固定値になる", async () => {
		// openssl dgst -sha256 -hmac secret で検証済みの期待値。
		expect(await hmacHex("secret", "hello")).toBe(
			"88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
		);
	});

	it("本文次第で値が変わる（同一鍵でも別の署名）", async () => {
		const a = await hmacHex("k", "body-a");
		const b = await hmacHex("k", "body-b");
		expect(a).not.toBe(b);
	});

	it("ヘッダは t=<unix秒>,v1=<hex> の形になる", async () => {
		const t = 1_700_000_000;
		const header = await buildSignatureHeader("whksecret", t, "payload");
		expect(header).toBe(`t=${t},v1=${await hmacHex("whksecret", `${t}.payload`)}`);
		expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
	});

	it("署名対象は <t>.<body> である（ドットで結合）", async () => {
		const t = 1_700_000_000;
		const header = await buildSignatureHeader("whksecret", t, "payload");
		const expectedHex = await hmacHex("whksecret", `${t}.payload`);
		expect(header.split(",")[1]).toBe(`v1=${expectedHex}`);
	});
});
