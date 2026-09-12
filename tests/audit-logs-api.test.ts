import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApp } from "@/api/app";
import { createAddress, createApiKeyFor, createDomain, createUser, resetDb } from "./auth-helpers";

const app = createApp();
const testEnv = env as unknown as CloudflareEnv;

function call(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
	const headers = new Headers({ authorization: `Bearer ${token}` });
	if (init.body !== undefined) headers.set("content-type", "application/json");
	return app.request(
		path,
		{
			method: init.method ?? "GET",
			headers,
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		},
		testEnv,
	);
}

type Entry = { action: string; targetType: string | null; targetId: string | null; createdAt: number };
type ListBody = { data: Entry[]; next_cursor: string | null };

describe("GET /api/v1/admin/audit-logs", () => {
	let ownerId: string;
	let ownerToken: string;

	beforeEach(async () => {
		await resetDb();
		ownerId = (await createUser({ role: "owner" })).id;
		ownerToken = (await createApiKeyFor({ userId: ownerId })).token;
	});

	async function issueKey(name: string): Promise<string> {
		const res = await call("/api/v1/admin/api-keys", ownerToken, {
			method: "POST",
			body: { userId: ownerId, name, scopes: ["read"] },
		});
		expect(res.status).toBe(201);
		return ((await res.json()) as { id: string }).id;
	}

	it("対象で絞った監査ログを返す", async () => {
		const id = await issueKey("ai");
		await issueKey("other");

		const res = await call(`/api/v1/admin/audit-logs?targetType=api_key&targetId=${id}`, ownerToken);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListBody;
		expect(body.data.map((e) => e.action)).toEqual(["api_key.create"]);
		expect(body.data[0]!.targetId).toBe(id);
	});

	it("limit と cursor でページを辿れる", async () => {
		await issueKey("a");
		await issueKey("b");

		const first = (await (await call("/api/v1/admin/audit-logs?action=api_key.create&limit=1", ownerToken)).json()) as ListBody;
		expect(first.data).toHaveLength(1);
		expect(first.next_cursor).not.toBeNull();
		const second = (await (
			await call(`/api/v1/admin/audit-logs?action=api_key.create&limit=1&cursor=${first.next_cursor}`, ownerToken)
		).json()) as ListBody;
		expect(second.data).toHaveLength(1);
		expect(second.data[0]!.targetId).not.toBe(first.data[0]!.targetId);
	});

	it("member のキーは 403", async () => {
		const member = await createUser({ role: "member" });
		const { token } = await createApiKeyFor({ userId: member.id });
		expect((await call("/api/v1/admin/audit-logs", token)).status).toBe(403);
	});

	it("admin スコープの無いキーと、アドレスを絞ったキーは 403", async () => {
		const owner = await createUser({ role: "owner" });
		const readOnly = await createApiKeyFor({ userId: owner.id, scopes: ["read"] });
		expect((await call("/api/v1/admin/audit-logs", readOnly.token)).status).toBe(403);

		const domainId = await createDomain("example.com");
		const addressId = await createAddress(domainId, "scoped", "example.com");
		const scoped = await createApiKeyFor({ userId: owner.id, addressIds: [addressId] });
		expect((await call("/api/v1/admin/audit-logs", scoped.token)).status).toBe(403);
	});
});
