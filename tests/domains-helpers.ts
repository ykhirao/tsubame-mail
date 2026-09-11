import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { ApiError } from "@/shared/errors";
import type { Hono as HonoType } from "hono";
import type { AppEnv } from "@/api/types";
import * as schema from "@/db/schema";
import type { Principal } from "@/shared/contracts/common";

export const testEnv = {
	...(env as unknown as Record<string, unknown>),
	CF_API_TOKEN: "test-token",
	CF_ACCOUNT_ID: "test-account",
	EMAIL_WORKER_NAME: "tsubame",
} as unknown as CloudflareEnv;

export function getTestDb() {
	return drizzle(env.DB, { schema });
}

export { applyMigrations } from "./helpers/migrate";

export type RecordedRequest = {
	method: string;
	url: string;
	path: string;
	body: Record<string, unknown> | null;
};

export type FakeZone = { id: string; name: string; status?: string; account?: { id: string; name?: string } };
export type FakeDnsRecord = {
	id: string;
	type: string;
	name: string;
	content: string;
	priority?: number;
};
export type FakeRoutingRule = {
	tag: string;
	name?: string;
	enabled?: boolean;
	matchers: { type: string; field?: string; value?: string }[];
	actions: { type: string; value: string[] }[];
};

export type FakeCloudflareOptions = {
	zones?: FakeZone[];
	dnsRecords?: FakeDnsRecord[];
	routingRules?: FakeRoutingRule[];
	failWith?: (req: RecordedRequest) => { status: number; errors: { code?: number; message: string }[] } | undefined;
};

export type FakeCloudflare = {
	requests: RecordedRequest[];
	dnsRecords: FakeDnsRecord[];
	routingRules: FakeRoutingRule[];
	catchAll: FakeRoutingRule & { enabled: boolean };
	fetch: (input: string, init?: RequestInit) => Promise<Response>;
	find(predicate: (req: RecordedRequest) => boolean): RecordedRequest[];
};

const ok = (result: unknown) =>
	new Response(
		JSON.stringify({
			success: true,
			errors: [],
			messages: [],
			result,
			result_info: { page: 1, per_page: 100, total_pages: 1, count: Array.isArray(result) ? result.length : 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

const ng = (status: number, errors: { code?: number; message: string }[]) =>
	new Response(JSON.stringify({ success: false, errors, messages: [], result: null }), {
		status,
		headers: { "content-type": "application/json" },
	});

export function createFakeCloudflare(options: FakeCloudflareOptions = {}): FakeCloudflare {
	const requests: RecordedRequest[] = [];
	const zones = (options.zones ?? [
		{ id: "zone1", name: "example.com", status: "active" },
	]).map((z) => ({ account: { id: "test-account", name: "test" }, ...z }));
	const dnsRecords = [...(options.dnsRecords ?? [])];
	const routingRules = [...(options.routingRules ?? [])];
	const catchAll: FakeRoutingRule & { enabled: boolean } = {
		tag: "catch_all",
		name: "catch-all",
		enabled: false,
		matchers: [{ type: "all" }],
		actions: [{ type: "drop", value: [] }],
	};

	const sendingSubdomains: { id: string; name: string; enabled: boolean }[] = [];
	let seq = 0;
	const nextId = () => `rec${++seq}`;

	const fake: FakeCloudflare = {
		requests,
		dnsRecords,
		routingRules,
		catchAll,
		find: (predicate) => requests.filter(predicate),
		async fetch(input, init) {
			const url = new URL(input);
			const method = (init?.method ?? "GET").toUpperCase();
			const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
			const req: RecordedRequest = { method, url: input, path: url.pathname, body };
			requests.push(req);

			const failure = options.failWith?.(req);
			if (failure) return ng(failure.status, failure.errors);

			const p = url.pathname.replace(/^\/client\/v4/, "");

			if (method === "GET" && p === "/zones") {
				const name = url.searchParams.get("name");
				const accountId = url.searchParams.get("account.id");
				return ok(
					zones.filter(
						(z) =>
							(name ? z.name === name : true) && (accountId ? z.account?.id === accountId : true),
					),
				);
			}

			const dnsList = p.match(/^\/zones\/([^/]+)\/dns_records$/);
			if (dnsList && method === "GET") {
				const type = url.searchParams.get("type");
				const name = url.searchParams.get("name");
				return ok(
					dnsRecords.filter(
						(r) => (type ? r.type === type : true) && (name ? r.name === name : true),
					),
				);
			}
			if (dnsList && method === "POST") {
				const created = { ...(body as unknown as FakeDnsRecord), id: nextId() };
				dnsRecords.push(created);
				return ok(created);
			}

			const dnsOne = p.match(/^\/zones\/([^/]+)\/dns_records\/([^/]+)$/);
			if (dnsOne && method === "DELETE") {
				const index = dnsRecords.findIndex((r) => r.id === dnsOne[2]);
				if (index >= 0) dnsRecords.splice(index, 1);
				return ok({ id: dnsOne[2] });
			}

			if (method === "POST" && /\/email\/routing\/enable$/.test(p)) {
				return ok({ enabled: true, name: String(body?.name ?? ""), status: "ready" });
			}
			if (method === "POST" && /\/email\/routing\/disable$/.test(p)) {
				return ok({ enabled: false });
			}
			if (/\/email\/routing\/dns$/.test(p)) {
				const name = String(body?.name ?? url.searchParams.get("name") ?? "");
				const suggested = [
					{ type: "MX", name, content: "route1.mx.cloudflare.net", priority: 1 },
					{ type: "TXT", name, content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
				];
				if (method === "POST") {
					for (const r of suggested) dnsRecords.push({ id: nextId(), ...r });
				}
				return ok(suggested);
			}

			if (/\/email\/routing\/rules\/catch_all$/.test(p)) {
				if (method === "PUT") {
					catchAll.enabled = Boolean(body?.enabled);
					catchAll.actions = (body?.actions as FakeRoutingRule["actions"]) ?? catchAll.actions;
					return ok(catchAll);
				}
				return ok(catchAll);
			}

			const ruleOne = p.match(/^\/zones\/([^/]+)\/email\/routing\/rules\/([^/]+)$/);
			if (ruleOne && method === "DELETE") {
				const index = routingRules.findIndex((r) => r.tag === ruleOne[2]);
				if (index >= 0) routingRules.splice(index, 1);
				return ok({ tag: ruleOne[2] });
			}

			if (/\/email\/routing\/rules$/.test(p)) {
				if (method === "POST") {
					const created: FakeRoutingRule = {
						tag: `rule${++seq}`,
						name: String(body?.name ?? ""),
						enabled: true,
						matchers: (body?.matchers as FakeRoutingRule["matchers"]) ?? [],
						actions: (body?.actions as FakeRoutingRule["actions"]) ?? [],
					};
					routingRules.push(created);
					return ok(created);
				}
				return ok(routingRules);
			}

			const sendingOne = p.match(/^\/zones\/([^/]+)\/email\/sending\/subdomains\/([^/]+?)(\/dns)?$/);
			if (sendingOne) {
				if (sendingOne[3]) return ok([]);
				if (method === "DELETE") {
					const index = sendingSubdomains.findIndex((s) => s.id === sendingOne[2]);
					if (index >= 0) sendingSubdomains.splice(index, 1);
					return ok({ id: sendingOne[2] });
				}
				return ok(sendingSubdomains.find((s) => s.id === sendingOne[2]) ?? null);
			}

			if (/\/email\/sending\/subdomains$/.test(p)) {
				if (method === "POST") {
					const created = { id: `sub${++seq}`, name: String(body?.name ?? ""), enabled: true };
					sendingSubdomains.push(created);
					return ok(created);
				}
				return ok(sendingSubdomains);
			}

			return ng(404, [{ code: 7003, message: `未対応のパス: ${p}` }]);
		},
	};

	return fake;
}

export const ownerPrincipal: Principal = {
	userId: "usr_owner",
	role: "owner",
	via: "session",
	scopes: ["read", "send", "admin"],
	addressIds: "all",
	writableAddressIds: "all",
};

export function memberPrincipal(addressIds: string[], writable: string[] = addressIds): Principal {
	return {
		userId: "usr_member",
		role: "member",
		via: "api_key",
		scopes: ["read"],
		addressIds,
		writableAddressIds: writable,
	};
}

export function mountRouter(
	basePath: string,
	router: HonoType<AppEnv>,
	principal: Principal | null,
): HonoType<AppEnv> {
	const app = new Hono<AppEnv>();
	app.onError((err, c) => {
		if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
		console.error("unhandled error", err);
		return c.json({ error: { code: "internal", message: "内部エラーが発生しました" } }, 500);
	});
	app.use("*", async (c, next) => {
		c.set("db", getTestDb());
		c.set("requestId", "test");
		if (principal) c.set("principal", principal);
		await next();
	});
	app.route(basePath, router);
	return app;
}

export async function callJson(
	app: HonoType<AppEnv>,
	path: string,
	init?: RequestInit,
): Promise<{ status: number; json: any }> {
	const response = await app.fetch(
		new Request(`https://test.local${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
		}),
		testEnv,
	);
	const text = await response.text();
	return { status: response.status, json: text ? JSON.parse(text) : null };
}
