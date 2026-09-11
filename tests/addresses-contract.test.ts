import { describe, expect, it } from "vitest";
import { createAddressInput, updateAddressInput } from "@/shared/contracts/addresses";

describe("displayName", () => {
	it("update の displayName に改行が入ると保存されない（#105）", () => {
		expect(
			updateAddressInput.safeParse({ displayName: "Alice\r\nBcc: evil@evil.jp" }).success
		).toBe(false);
		expect(updateAddressInput.safeParse({ displayName: "Alice" }).success).toBe(true);
		expect(updateAddressInput.safeParse({ displayName: null }).success).toBe(true);
	});

	it("create の displayName にも改行が入ると弾かれる", () => {
		const base = { domainId: "d", localPart: "a" };
		expect(createAddressInput.safeParse({ ...base, displayName: "Alice\nB" }).success).toBe(false);
		expect(createAddressInput.safeParse({ ...base, displayName: "Alice" }).success).toBe(true);
	});
});
