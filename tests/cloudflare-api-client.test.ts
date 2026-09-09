import { describe, expect, it, vi } from "vitest";
import {
	CloudflareApi,
	cfEndpoints,
	createCloudflareApi,
	isTokenScopeError,
	literalToMatcher,
	routingRuleId,
	tokenScopeMessage,
	workerAction,
} from "@/services/cloudflare-api";
import { ApiError } from "@/shared/errors";
import { createFakeCloudflare } from "./domains-helpers";

const zone = { id: "zone1", name: "example.com" };

describe("CloudflareApi", () => {
	it("トークンが無いと分かりやすいエラーになる", async () => {
		const api = createCloudflareApi({});
		await expect(api.listAllZones()).rejects.toThrow(/CF_API_TOKEN が設定されていません/);
	});

	it("Authorization ヘッダと JSON ボディを 1 箇所で付ける", async () => {
		const fake = createFakeCloudflare();
		const spy = vi.fn(fake.fetch);
		const api = new CloudflareApi({ CF_API_TOKEN: "tok" }, { fetch: spy });

		await api.createEmailRoutingRule(zone, {
			name: "tsubame: a@example.com",
			matchers: [literalToMatcher("a@example.com")],
			actions: [workerAction("tsubame")],
		});

		const [url, init] = spy.mock.calls[0]!;
		expect(url).toContain(cfEndpoints.emailRoutingRules("zone1"));
		expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
		expect(JSON.parse(String(init?.body)).actions).toEqual([{ type: "worker", value: ["tsubame"] }]);
	});

	it("ページングを畳んでゾーンを全部返す", async () => {
		let page = 0;
		const api = new CloudflareApi(
			{ CF_API_TOKEN: "tok" },
			{
				fetch: async () => {
					page += 1;
					return new Response(
						JSON.stringify({
							success: true,
							errors: [],
							result: [{ id: `z${page}`, name: `z${page}.example` }],
							result_info: { page, total_pages: 3 },
						}),
					);
				},
			},
		);
		const zones = await api.listAllZones();
		expect(zones.map((z) => z.id)).toEqual(["z1", "z2", "z3"]);
	});

	it("Cloudflare のエラー封筒を ApiError に変換する", async () => {
		const api = new CloudflareApi(
			{ CF_API_TOKEN: "tok" },
			{
				fetch: async () =>
					new Response(
						JSON.stringify({ success: false, errors: [{ code: 1004, message: "DNS Validation Error" }] }),
						{ status: 400 },
					),
			},
		);
		await expect(api.listDnsRecords(zone)).rejects.toMatchObject({
			code: "internal",
			message: expect.stringContaining("1004: DNS Validation Error"),
		});
	});

	it("JSON でない応答も落ちずにエラーになる", async () => {
		const api = new CloudflareApi(
			{ CF_API_TOKEN: "tok" },
			{ fetch: async () => new Response("<html>502</html>", { status: 502 }) },
		);
		await expect(api.listDnsRecords(zone)).rejects.toThrow(/JSON ではない応答/);
	});
});

describe("トークンのスコープ不足", () => {
	it("403 と既知のエラーコードを権限不足と判定する", () => {
		expect(isTokenScopeError(403, [])).toBe(true);
		expect(isTokenScopeError(400, [9109])).toBe(true);
		expect(isTokenScopeError(400, [10000])).toBe(true);
		expect(isTokenScopeError(400, [1004])).toBe(false);
	});

	it("日本語で「ゾーンをトークンに追加してください」と伝える", async () => {
		const api = new CloudflareApi(
			{ CF_API_TOKEN: "tok" },
			{
				fetch: async () =>
					new Response(
						JSON.stringify({
							success: false,
							errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
						}),
						{ status: 403 },
					),
			},
		);

		const error = await api.listDnsRecords({ id: "zone1", name: "example.com" }).catch((e) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error.code).toBe("forbidden");
		expect(error.message).toContain("CF_API_TOKEN のスコープにゾーン「example.com」を追加してください");
		expect(error.message).toContain("ドメインを増やすたびに広げ直す");
		expect(error.details).toMatchObject({ kind: "token_scope" });
	});

	it("ゾーン名が分からなくても文章が壊れない", () => {
		expect(tokenScopeMessage(undefined, "HTTP 403")).toContain("対象のゾーン");
	});
});

describe("routingRuleId", () => {
	it("tag を優先して使う", () => {
		expect(routingRuleId({ tag: "t1", id: "i1", enabled: true, matchers: [], actions: [] })).toBe("t1");
		expect(routingRuleId({ enabled: true, matchers: [], actions: [] })).toBeNull();
	});
});
