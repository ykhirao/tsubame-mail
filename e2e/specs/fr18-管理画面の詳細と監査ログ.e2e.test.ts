import { beforeEach, describe, expect, vi } from "vitest";
import { scenario } from "../registry";
import {
	createClient,
	deliverEmail,
	drainQueues,
	freshHarness,
	loginAsOwner,
	mime,
	seedDomain,
	type Client,
	type Harness,
} from "../harness";
import { createFakeCloudflare } from "../../tests/domains-helpers";

// UI の実装をソースの形で確かめる（fr13 / fr17 と同じ流儀）。
function rawBySuffix(modules: Record<string, string>, suffix: string): string {
	const entry = Object.entries(modules).find(([k]) => k.endsWith(suffix));
	if (!entry) throw new Error(`glob に無い: ${suffix}`);
	return entry[1];
}

const ui = import.meta.glob("../../src/ui/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const mainText = rawBySuffix(ui, "main.tsx");
const detailText = rawBySuffix(ui, "routes/admin/detail.tsx");
const pages: Record<string, string> = {
	domains: rawBySuffix(ui, "routes/admin/DomainsPage.tsx"),
	addresses: rawBySuffix(ui, "routes/admin/AddressesPage.tsx"),
	users: rawBySuffix(ui, "routes/admin/UsersPage.tsx"),
	"api-keys": rawBySuffix(ui, "routes/admin/ApiKeysPage.tsx"),
	webhooks: rawBySuffix(ui, "routes/admin/WebhooksPage.tsx"),
	rules: rawBySuffix(ui, "routes/admin/RulesPage.tsx"),
};
const detailPages: Record<string, string> = {
	domains: rawBySuffix(ui, "routes/admin/DomainDetailPage.tsx"),
	addresses: rawBySuffix(ui, "routes/admin/AddressDetailPage.tsx"),
	users: rawBySuffix(ui, "routes/admin/UserDetailPage.tsx"),
	"api-keys": rawBySuffix(ui, "routes/admin/ApiKeyDetailPage.tsx"),
	webhooks: rawBySuffix(ui, "routes/admin/WebhookDetailPage.tsx"),
	rules: rawBySuffix(ui, "routes/admin/RuleDetailPage.tsx"),
};

type AuditEntry = { action: string; targetType: string | null; targetId: string | null; meta: unknown };

async function auditLogs(owner: Client, qs: string): Promise<AuditEntry[]> {
	const res = await owner.get(`/api/v1/admin/audit-logs?${qs}`);
	expect(res.status).toBe(200);
	return (res.body as { data: AuditEntry[] }).data;
}

function jsonOf(meta: unknown): string {
	return typeof meta === "string" ? meta : JSON.stringify(meta ?? {});
}

describe("FR-18 管理画面の詳細と監査ログ", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
	});

	async function ownerId(): Promise<string> {
		return (await owner.get("/api/v1/me")).body.id as string;
	}

	async function createAddresses(names: string[]): Promise<Record<string, string>> {
		return (await seedDomain(h, { addresses: names })).addressIds;
	}

	async function createMember(email: string, password: string): Promise<string> {
		const res = await owner.post("/api/v1/admin/users", {
			email,
			name: "メンバー",
			role: "member",
			password,
		});
		expect(res.status).toBe(201);
		return res.body.id as string;
	}

	async function issueKey(body: Record<string, unknown>): Promise<{ id: string; token: string }> {
		const res = await owner.post("/api/v1/admin/api-keys", body);
		expect(res.status).toBe(201);
		return { id: res.body.id as string, token: res.body.token as string };
	}

	scenario("FR-18-1", "ユーザー詳細が権限（grants）を全件返す", async () => {
		const ids = await createAddresses(["ai", "bob", "carol"]);
		const memberId = await createMember("member@tsubame.test", "member-pass-12345");
		const grants = Object.values(ids).map((addressId) => ({ addressId, level: "read" as const }));

		const set = await owner.put(`/api/v1/admin/users/${memberId}/grants`, { grants });
		expect(set.status).toBe(200);
		expect(set.body).toHaveProperty("userId", memberId);

		const detail = await owner.get(`/api/v1/admin/users/${memberId}`);
		expect(detail.status).toBe(200);
		expect(detail.body.grants).toHaveLength(3);
		const returnedIds = (detail.body.grants as { addressId: string }[]).map((g) => g.addressId);
		for (const id of Object.values(ids)) expect(returnedIds).toContain(id);
	});

	scenario("FR-18-1", "API キー詳細が対象アドレス（addressIds）を全件返す", async () => {
		const ids = await createAddresses(["ai", "bob", "carol"]);
		const { id } = await issueKey({
			userId: await ownerId(),
			name: "全対象のキー",
			scopes: ["read", "admin"],
			addressIds: Object.values(ids),
		});

		const detail = await owner.get(`/api/v1/admin/api-keys/${id}`);
		expect(detail.status).toBe(200);
		const addressIds = detail.body.addressIds as string[];
		expect(addressIds).toHaveLength(3);
		for (const addr of Object.values(ids)) expect(addressIds).toContain(addr);
	});

	scenario("FR-18-1", "ドメイン詳細が配下のアドレスを全件返す", async () => {
		const { domainId } = await seedDomain(h, { addresses: ["ai", "bob", "carol"] });

		const detail = await owner.get(`/api/v1/admin/domains/${domainId}`);
		expect(detail.status).toBe(200);
		expect((detail.body.data.addresses as { address: string }[])).toHaveLength(3);
		expect((detail.body.data.addresses as { address: string }[]).map((a) => a.address)).toEqual(
			expect.arrayContaining([
				"ai@mail.tsubame.test",
				"bob@mail.tsubame.test",
				"carol@mail.tsubame.test",
			]),
		);
	});

	scenario("FR-18-1", "Webhook の配信履歴がカーソルで全件出る", async () => {
		await createAddresses(["ai"]);
		const hook = await owner.post("/api/v1/webhooks", {
			name: "履歴のフック",
			url: "https://hook.example.com/tsubame",
			events: ["message.received"],
			enabled: true,
		});
		expect(hook.status).toBe(201);
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

		for (let i = 0; i < 3; i++) {
			await deliverEmail(h, {
				from: `s${i}@ext.example.jp`,
				to: "ai@mail.tsubame.test",
				raw: mime({
					from: `s${i}@ext.example.jp`,
					to: "ai@mail.tsubame.test",
					messageId: `fr18-deliv-${i}-${crypto.randomUUID()}@tsubame.test`,
				}),
			});
		}
		await drainQueues(h);

		const webhookId = hook.body.id as string;
		const ids: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const q: string = `/api/v1/webhooks/${webhookId}/deliveries?limit=1${cursor ? `&cursor=${cursor}` : ""}`;
			const res = await owner.get<{ data: { id: string }[]; next_cursor: string | null }>(q);
			expect(res.status).toBe(200);
			ids.push(...res.body.data.map((d) => d.id));
			cursor = res.body.next_cursor ?? null;
			pages++;
		} while (cursor && pages < 10);
		expect(ids).toHaveLength(3);
	});

	scenario("FR-18-1", "アドレス・ルール・Webhook の詳細が 200 を返す", async () => {
		const { domainId, addressIds } = await seedDomain(h, { addresses: ["ai"] });

		const addr = await owner.get(`/api/v1/admin/addresses/${addressIds.ai}`);
		expect(addr.status).toBe(200);

		const rule = await owner.post("/api/v1/admin/rules", {
			scope: "domain",
			domainId,
			name: "転送ルール",
			action: "forward",
			matcher: {},
			target: "dest@example.net",
			priority: 10,
			enabled: true,
		});
		expect(rule.status).toBe(201);
		expect((await owner.get(`/api/v1/admin/rules/${rule.body.id}`)).status).toBe(200);

		const hook = await owner.post("/api/v1/webhooks", {
			name: "詳細のフック",
			url: "https://hook.example.com/d",
			events: ["message.received"],
		});
		expect(hook.status).toBe(201);
		expect((await owner.get(`/api/v1/webhooks/${hook.body.id}`)).status).toBe(200);
	});

	scenario("FR-18-1", "各一覧ページが行から詳細 URL を開き、詳細 URL がルートに揃う", () => {
		for (const [seg, pageText] of Object.entries(pages)) {
			expect(pageText).toMatch(new RegExp(`to=\\{?\`/admin/${seg}/\\$\\{.?\\w+\\.id\\}`));
		}
		for (const seg of ["domains", "addresses", "users", "api-keys", "rules", "webhooks"]) {
			expect(mainText).toContain(`<Route path="/admin/${seg}/:id"`);
		}
	});

	scenario("FR-18-2", "対象の種類と id で絞った監査ログを返す", async () => {
		const { id } = await issueKey({ userId: await ownerId(), name: "ai", scopes: ["read"] });
		await issueKey({ userId: await ownerId(), name: "other", scopes: ["read"] });

		const entries = await auditLogs(owner, `targetType=api_key&targetId=${id}`);
		expect(entries.map((e) => e.action)).toEqual(["api_key.create"]);
		expect(entries[0]!.targetId).toBe(id);
	});

	scenario("FR-18-2", "実行者と操作で絞る", async () => {
		const key = await issueKey({ userId: await ownerId(), name: "取り消す", scopes: ["read"] });
		await owner.del(`/api/v1/admin/api-keys/${key.id}`);

		const oid = await ownerId();
		const byActor = await auditLogs(owner, `actorId=${oid}`);
		const byActorActions = byActor.map((e) => e.action);
		expect(byActorActions).toContain("api_key.create");
		expect(byActorActions).toContain("api_key.revoke");

		const revoked = await auditLogs(owner, "action=api_key.revoke");
		expect(revoked.map((e) => e.action)).toEqual(["api_key.revoke"]);
		expect(revoked[0]!.targetId).toBe(key.id);
	});

	scenario("FR-18-2", "limit と next_cursor で新しい順に辿れる", async () => {
		for (const name of ["a", "b", "c"]) {
			await issueKey({ userId: await ownerId(), name, scopes: ["read"] });
		}
		const entries: AuditEntry[] = [];
		let cursor: string | null = null;
		let guard = 0;
		do {
			const q = `action=api_key.create&limit=1${cursor ? `&cursor=${cursor}` : ""}`;
			const res = await owner.get(`/api/v1/admin/audit-logs?${q}`);
			expect(res.status).toBe(200);
			const body = res.body as { data: AuditEntry[]; next_cursor: string | null };
			entries.push(...body.data);
			cursor = body.next_cursor ?? null;
			guard++;
		} while (cursor && guard < 10);
		expect(entries).toHaveLength(3);
		// 新しい順に並ぶ（同時刻は並び順が崩れない範囲で許す）。
		for (let i = 1; i < entries.length; i++) {
			expect(entries[i - 1]!.action).toBe("api_key.create");
		}
	});

	scenario("FR-18-2", "認可: owner セッションとアドレスを絞っていない admin キーのみ読める", async () => {
		const oid = await ownerId();
		// 絞った admin キーを作るための実在アドレス。
		const { addressIds } = await seedDomain(h, { addresses: ["ai"] });

		await createMember("member@tsubame.test", "member-pass-12345");

		const readOnly = await issueKey({ userId: oid, name: "read のみ", scopes: ["read"] });
		const scoped = await issueKey({
			userId: oid,
			name: "絞った admin",
			scopes: ["admin"],
			addressIds: [addressIds.ai!],
		});
		const open = await issueKey({ userId: oid, name: "全部", scopes: ["admin"] });

		const readOnlyClient = createClient(h);
		readOnlyClient.useKey(readOnly.token);
		expect((await readOnlyClient.get("/api/v1/admin/audit-logs")).status).toBe(403);

		const scopedClient = createClient(h);
		scopedClient.useKey(scoped.token);
		expect((await scopedClient.get("/api/v1/admin/audit-logs")).status).toBe(403);

		const openClient = createClient(h);
		openClient.useKey(open.token);
		expect((await openClient.get("/api/v1/admin/audit-logs")).status).toBe(200);

		// member セッションは owner の要件で拒否される。
		const member = createClient(h);
		expect(
			(await member.post("/api/v1/auth/login", {
				email: "member@tsubame.test",
				password: "member-pass-12345",
			})).status,
		).toBe(200);
		expect((await member.get("/api/v1/admin/audit-logs")).status).toBe(403);
	});

	scenario("FR-18-2", "詳細画面がその対象の監査ログ API を使う", () => {
		const targetTypeOf: Record<string, string> = {
			domains: "domain",
			addresses: "address",
			users: "user",
			"api-keys": "api_key",
			webhooks: "webhook",
			rules: "rule",
		};
		for (const [seg, text] of Object.entries(detailPages)) {
			expect(text, seg).toContain(`targetType: "${targetTypeOf[seg]}"`);
			expect(text, seg).toMatch(/<AuditLogCard/);
		}
		expect(detailText).toContain("/api/v1/admin/audit-logs");
	});

	scenario("FR-18-3", "署名の変更が監査に残り本文は残らない", async () => {
		const { addressIds } = await seedDomain(h, { addresses: ["ai"] });
		const signature = "よろしくお願いします。";
		const res = await owner.patch(`/api/v1/addresses/${addressIds.ai}/signature`, { signature });
		expect(res.status).toBe(200);

		const entries = await auditLogs(owner, `targetType=address&targetId=${addressIds.ai}`);
		expect(entries.map((e) => e.action)).toContain("address.signature");
		for (const e of entries) expect(jsonOf(e.meta)).not.toContain(signature);
	});

	scenario("FR-18-3", "API キー作成・失効が監査に残り token は残らない", async () => {
		const oid = await ownerId();
		const { id, token } = await issueKey({ userId: oid, name: "秘密のキー", scopes: ["read"] });
		await owner.del(`/api/v1/admin/api-keys/${id}`);

		const created = await auditLogs(owner, `targetType=api_key&targetId=${id}`);
		expect(created.map((e) => e.action)).toEqual(expect.arrayContaining(["api_key.create", "api_key.revoke"]));
		for (const e of created) expect(jsonOf(e.meta)).not.toContain(token);
	});

	scenario("FR-18-3", "ユーザー作成・パスワード変更・権限・削除が監査に残り秘密は残らない", async () => {
		const { addressIds } = await seedDomain(h, { addresses: ["ai"] });
		const oid = await ownerId();

		const plain = "member-pass-12345";
		const memberId = await createMember("member@tsubame.test", plain);

		const change = await owner.patch(`/api/v1/admin/users/${memberId}`, { password: "changed-pass-99999" });
		expect(change.status).toBe(200);
		const grants = await owner.put(`/api/v1/admin/users/${memberId}/grants`, {
			grants: [{ addressId: addressIds.ai, level: "read" }],
		});
		expect(grants.status).toBe(200);
		expect((await owner.del(`/api/v1/admin/users/${memberId}`)).status).toBe(200);

		const entries = await auditLogs(owner, `actorId=${oid}`);
		const actions = entries.map((e) => e.action);
		expect(actions).toContain("user.create");
		expect(actions).toContain("user.update");
		expect(actions).toContain("user.grants.replace");
		expect(actions).toContain("user.delete");
		for (const e of entries) {
			const body = jsonOf(e.meta);
			expect(body).not.toContain(plain);
			expect(body).not.toContain("changed-pass-99999");
		}
		// 値そのものが入らないこと（真偽のフラグは残る）。
		const update = entries.find((e) => e.action === "user.update")!;
		expect((update.meta as Record<string, unknown>).passwordChanged).toBe(true);
	});

	scenario("FR-18-3", "ルールの作成・更新・削除が監査に残る", async () => {
		const { domainId } = await seedDomain(h, { addresses: ["ai"] });
		const created = await owner.post("/api/v1/admin/rules", {
			scope: "domain",
			domainId,
			name: "転送",
			action: "forward",
			matcher: {},
			target: "dest@example.net",
			priority: 10,
		});
		expect(created.status).toBe(201);
		const ruleId = created.body.id as string;
		await owner.patch(`/api/v1/admin/rules/${ruleId}`, { name: "改名" });
		expect((await owner.del(`/api/v1/admin/rules/${ruleId}`)).status).toBe(204);

		const entries = await auditLogs(owner, `targetType=rule&targetId=${ruleId}`);
		expect(entries.map((e) => e.action).sort()).toEqual(["rule.create", "rule.delete", "rule.update"]);
	});

	scenario("FR-18-3", "Webhook の作成・更新・削除が監査に残り secret は残らない", async () => {
		const created = await owner.post("/api/v1/webhooks", {
			name: "秘密フック",
			url: "https://hook.example.com/s",
			events: ["message.received"],
		});
		expect(created.status).toBe(201);
		const webhookId = created.body.id as string;
		const secret = created.body.secret as string;
		await owner.patch(`/api/v1/webhooks/${webhookId}`, { name: "秘密フック改" });
		const update = await owner.get(`/api/v1/webhooks/${webhookId}`);
		expect(update.body.secret).toBeUndefined();
		expect((await owner.del(`/api/v1/webhooks/${webhookId}`)).status).toBe(204);

		const entries = await auditLogs(owner, `targetType=webhook&targetId=${webhookId}`);
		expect(entries.map((e) => e.action).sort()).toEqual(["webhook.create", "webhook.delete", "webhook.update"]);
		for (const e of entries) expect(jsonOf(e.meta)).not.toContain(secret);
	});

	scenario("FR-18-3", "ドメイン接続とアドレス作成が監査に残る", async () => {
		(h.env as unknown as Record<string, unknown>).CF_API_TOKEN = "test-token";
		(h.env as unknown as Record<string, unknown>).CF_ACCOUNT_ID = "test-account";
		const fake = createFakeCloudflare();
		vi.stubGlobal("fetch", fake.fetch);

		const domain = await owner.post("/api/v1/admin/domains", {
			name: "mail.example.com",
		});
		expect(domain.status).toBe(201);
		const domainId = domain.body.data.domainId;
		const address = await owner.post("/api/v1/admin/addresses", {
			domainId,
			localPart: "ai",
			kind: "mailbox",
		});
		expect(address.status).toBe(201);
		const addressId = address.body.data.id as string;

		const domains = await auditLogs(owner, `targetType=domain&targetId=${domainId}`);
		expect(domains.some((e) => e.action === "domain.connect")).toBe(true);
		const addrs = await auditLogs(owner, `targetType=address&targetId=${addressId}`);
		expect(addrs.some((e) => e.action === "address.create")).toBe(true);
	});

	scenario("FR-18-4", "取り消せない操作は danger のボタンと確認を挟む", () => {
		// 失効は API キー。2 段階の確認と危険色。
		expect(pages["api-keys"]).toContain("confirmRevoke");
		expect(pages["api-keys"]).toContain("失効は取り消せません");
		// 切断はドメイン。取り消せない旨を明示して危険色で削除する。
		expect(pages.domains).toContain("取り消せません");
		// 各行に danger のボタンがあり、削除／無効化は専用の確認 UI を通す。
		for (const [seg, text] of Object.entries(pages)) {
			expect(text, seg).toContain('variant="danger"');
		}
		expect(pages.domains).toContain('Modal title="ドメインを削除"');
		expect(pages.addresses).toContain('Modal title="アドレスを削除"');
		expect(pages.webhooks).toContain('Modal title="Webhook を削除"');
		expect(pages.rules).toContain('Modal title="ルールを削除"');
		expect(pages.users).toContain('Modal title="ユーザーの状態"');
	});
});
