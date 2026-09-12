import { beforeEach, describe, expect } from "vitest";
import { scenario } from "../registry";
import {
	OWNER,
	createClient,
	deliverEmail,
	drainQueues,
	freshHarness,
	loginAsOwner,
	mime,
	seedDomain,
	type Client,
	type Harness,
	createUserViaApi,
} from "../harness";

describe("FR-5 API キー", () => {
	let h: Harness;
	let owner: Client;
	let ownerId: string;
	let ai: string;
	let hito: string;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		const me = await owner.get("/api/v1/me");
		ownerId = me.body.id;
		const seeded = await seedDomain(h, { addresses: ["ai", "hito"] });
		ai = seeded.addressIds.ai!;
		hito = seeded.addressIds.hito!;
	});

	async function issueKey(opts: {
		scopes: string[];
		addressIds?: string[] | null;
		userId?: string;
		expiresAt?: number;
	}): Promise<{ id: string; token: string; parentKeyId: string | null }> {
		const res = await owner.post("/api/v1/admin/api-keys", {
			userId: opts.userId ?? ownerId,
			name: "テストキー",
			scopes: opts.scopes,
			addressIds: opts.addressIds ?? null,
			expiresAt: opts.expiresAt,
		});
		expect(res.status).toBe(201);
		return {
			id: res.body.id,
			token: res.body.token,
			parentKeyId: res.body.parentKeyId,
		};
	}

	async function createUser(role: "owner" | "member", email: string): Promise<string> {
		const res = await createUserViaApi(h, owner, {
			email,
			name: role === "owner" ? "別オーナー" : "メンバー",
			role,
			password: "user-password-1234",
		});
		expect(res.status).toBe(201);
		return res.body.id as string;
	}

	async function issueRestrictedKey(): Promise<{ id: string; token: string; expiresAt: number }> {
		const res = await owner.post("/api/v1/admin/api-keys", {
			userId: ownerId,
			name: "絞った admin キー",
			scopes: ["read", "admin"],
			addressIds: [ai],
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
		});
		expect(res.status).toBe(201);
		return { id: res.body.id, token: res.body.token, expiresAt: res.body.expiresAt };
	}

	scenario(
		"FR-5-1",
		"オーナー自身のキーでも addressIds で絞れば他のアドレスは見えない",
		async () => {
			await deliverEmail(h, {
				from: "a@ext.jp",
				to: "ai@mail.tsubame.test",
				raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", subject: "AI 宛て" }),
			});
			await deliverEmail(h, {
				from: "a@ext.jp",
				to: "hito@mail.tsubame.test",
				raw: mime({ from: "a@ext.jp", to: "hito@mail.tsubame.test", subject: "人宛て" }),
			});
			await drainQueues(h);

			const all = await owner.get("/api/v1/messages?limit=10");
			const hitoId = all.body.data.find((m: any) => m.addressId === hito)!.id;

			const { token } = await issueKey({ scopes: ["read"], addressIds: [ai] });
			owner.useKey(token);

			const list = await owner.get("/api/v1/messages?limit=10");
			expect(list.status).toBe(200);
			expect(list.body.data).toHaveLength(1);
			expect(list.body.data[0].addressId).toBe(ai);
			expect(list.body.data[0].subject).toBe("AI 宛て");

			const detail = await owner.get(`/api/v1/messages/${hitoId}`);
			expect(detail.status).toBe(404);
		},
	);

	scenario("FR-5-1", "read だけのキーで送信すると 403、管理 API も 403", async () => {
		const { token } = await issueKey({ scopes: ["read"] });
		owner.useKey(token);

		const send = await owner.post("/api/v1/messages", {
			from: "ai@mail.tsubame.test",
			to: "saki@ext.example.jp",
			subject: "送れない",
			text: "本文",
		});
		expect(send.status).toBe(403);

		const admin = await owner.get("/api/v1/admin/users");
		expect(admin.status).toBe(403);
	});

	scenario("FR-5-1", "send だけのキーでは受信メールを一切読めないが、送信はできる", async () => {
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", subject: "秘密の件名" }),
		});
		await drainQueues(h);
		const all = await owner.get("/api/v1/messages?limit=10");
		const msg = all.body.data[0];

		const { token } = await issueKey({ scopes: ["send"] });
		owner.useKey(token);

		for (const path of [
			"/api/v1/messages?limit=10",
			"/api/v1/messages?q=%E7%A7%98%E5%AF%86",
			`/api/v1/messages/${msg.id}`,
			`/api/v1/messages/${msg.id}/raw`,
			"/api/v1/threads?limit=10",
			`/api/v1/threads/${msg.threadId}`,
		]) {
			const res = await owner.get(path);
			expect(res.status, path).toBe(403);
			expect(JSON.stringify(res.body)).not.toContain("秘密の件名");
		}

		const star = await owner.patch(`/api/v1/messages/${msg.id}`, { isStarred: true });
		expect(star.status).toBe(403);

		// outbound のルータも同じ /api/v1/messages に載っている。受信系の検査が送信まで塞がないこと。
		const send = await owner.post("/api/v1/messages", {
			from: "ai@mail.tsubame.test",
			to: "saki@ext.example.jp",
			subject: "送れる",
			text: "本文",
		});
		expect(send.status).toBe(202);
	});

	scenario("FR-5-1", "read だけのキーでは既読は付けられるが、ゴミ箱には移せない", async () => {
		await deliverEmail(h, {
			from: "a@ext.jp",
			to: "ai@mail.tsubame.test",
			raw: mime({ from: "a@ext.jp", to: "ai@mail.tsubame.test", subject: "残すべきメール" }),
		});
		await drainQueues(h);
		const all = await owner.get("/api/v1/messages?limit=10");
		const msgId = all.body.data[0].id as string;

		const { token } = await issueKey({ scopes: ["read"] });
		owner.useKey(token);

		const trash = await owner.patch(`/api/v1/messages/${msgId}`, { status: "trash" });
		expect(trash.status).toBe(403);

		const read = await owner.patch(`/api/v1/messages/${msgId}`, { isRead: true });
		expect(read.status).toBe(200);
		expect(read.body.isRead).toBe(true);

		owner.useKey(null);
		const after = await owner.get(`/api/v1/messages/${msgId}`);
		expect(after.body.status).toBe("received");
	});

	scenario("FR-5-2", "失効したキーは 401 になる", async () => {
		const { id, token } = await issueKey({ scopes: ["read"] });

		owner.useKey(token);
		const before = await owner.get("/api/v1/me");
		expect(before.status).toBe(200);

		// 失効する（セッションに戻してから。キー自身では admin スコープが無い）。
		owner.useKey(null);
		const revoke = await owner.del(`/api/v1/admin/api-keys/${id}`);
		expect(revoke.status).toBe(200);

		owner.useKey(token);
		const after = await owner.get("/api/v1/me");
		expect(after.status).toBe(401);
	});

	scenario("FR-5-2", "発行時だけ平文が返り、一覧・詳細には出ない", async () => {
		const { token } = await issueKey({ scopes: ["read", "send"] });

		expect(token).toBeTruthy();

		const adminList = await owner.get("/api/v1/admin/api-keys");
		expect(adminList.status).toBe(200);
		for (const k of adminList.body.data) {
			expect(k.token).toBeUndefined();
		}

		const meList = await owner.get("/api/v1/me/api-keys");
		expect(meList.status).toBe(200);
		for (const k of meList.body.data) {
			expect(k.token).toBeUndefined();
		}

		owner.useKey(token);
		const me = await owner.get("/api/v1/me");
		expect(me.status).toBe(200);
		expect(me.body.apiKeyId).toBeTruthy();
	});

	scenario("FR-5-3", "失効したキーと同じ設定で再発行できる", async () => {
		const body = {
			userId: ownerId,
			name: "再発行テスト",
			scopes: ["read"],
			addressIds: [ai] as string[] | null,
		};

		const first = await owner.post("/api/v1/admin/api-keys", body);
		expect(first.status).toBe(201);

		const oldClient = createClient(h);
		oldClient.useKey(first.body.token as string);
		expect((await oldClient.get("/api/v1/messages?limit=10")).status).toBe(200);

		// キー自身には admin スコープが無いので、失効はセッションで行う。
		owner.useKey(null);
		const revoke = await owner.del(`/api/v1/admin/api-keys/${first.body.id}`);
		expect(revoke.status).toBe(200);
		expect((await oldClient.get("/api/v1/messages?limit=10")).status).toBe(401);

		const second = await owner.post("/api/v1/admin/api-keys", body);
		expect(second.status).toBe(201);

		const newClient = createClient(h);
		newClient.useKey(second.body.token as string);
		expect((await newClient.get("/api/v1/messages?limit=10")).status).toBe(200);
	});

	scenario("FR-5-2", "期限を過ぎたキーは 401 になる", async () => {
		const { token } = await issueKey({
			scopes: ["read"],
			expiresAt: Math.floor(Date.now() / 1000) - 60,
		});
		owner.useKey(token);
		expect((await owner.get("/api/v1/me")).status).toBe(401);
	});

	scenario("FR-5-2", "キーで叩くと最終使用時刻が記録される", async () => {
		const { id, token } = await issueKey({ scopes: ["read"] });

		owner.useKey(token);
		expect((await owner.get("/api/v1/me")).status).toBe(200);

		owner.useKey(null);
		const detail = await owner.get(`/api/v1/admin/api-keys/${id}`);
		expect(detail.status).toBe(200);
		expect(detail.body.lastUsedAt).not.toBeNull();
	});

	scenario("FR-5-4", "絞ったキーから自分より広いスコープのキーは作れない（403）", async () => {
		const restricted = await issueRestrictedKey();
		owner.useKey(restricted.token);

		const res = await owner.post("/api/v1/me/api-keys", {
			name: "広いキー",
			scopes: ["read", "send"],
		});
		expect(res.status).toBe(403);
	});

	scenario("FR-5-4", "絞ったキーから範囲外アドレスのキーは作れない（403）", async () => {
		const restricted = await issueRestrictedKey();
		owner.useKey(restricted.token);

		const res = await owner.post("/api/v1/me/api-keys", {
			name: "範囲外",
			scopes: ["read"],
			addressIds: [hito],
		});
		expect(res.status).toBe(403);
	});

	scenario("FR-5-4", "対象アドレスを省くと自分の範囲に自動で狭められる", async () => {
		const restricted = await issueRestrictedKey();
		owner.useKey(restricted.token);

		const res = await owner.post("/api/v1/me/api-keys", {
			name: "アドレス省略",
			scopes: ["read"],
		});
		expect(res.status).toBe(201);
		expect(res.body.addressIds).toEqual([ai]);
	});

	scenario("FR-5-4", "期限は親キーの期限を超えられず、自分の期限に丸められる", async () => {
		const restricted = await issueRestrictedKey();
		owner.useKey(restricted.token);

		const res = await owner.post("/api/v1/me/api-keys", {
			name: "長い期限",
			scopes: ["read"],
			expiresAt: Math.floor(Date.now() / 1000) + 2 * 24 * 3600,
		});
		expect(res.status).toBe(201);
		expect(res.body.expiresAt).toBe(restricted.expiresAt);
	});

	scenario("FR-5-4", "絞った admin キーでは他利用者向けに広いキーは作れない（403）", async () => {
		const memberId = await createUser("member", "member-4@example.test");
		const restricted = await issueRestrictedKey();
		owner.useKey(restricted.token);

		const res = await owner.post("/api/v1/admin/api-keys", {
			userId: memberId,
			name: "メンバー用",
			scopes: ["send"],
		});
		expect(res.status).toBe(403);
	});

	scenario("FR-5-4", "絞った admin キーでは他の利用者のキーを失効できない（403）", async () => {
		const memberId = await createUser("member", "member-5@example.test");
		const victim = await issueKey({ userId: memberId, scopes: ["read"] });

		const restricted = await issueRestrictedKey();
		owner.useKey(restricted.token);
		const del = await owner.del(`/api/v1/admin/api-keys/${victim.id}`);
		expect(del.status).toBe(403);

		const victimClient = createClient(h);
		victimClient.useKey(victim.token);
		expect((await victimClient.get("/api/v1/me")).status).toBe(200);
	});

	scenario("FR-5-4", "絞った admin キーでは管理の変更（ルール・アドレス・Webhook）が 403", async () => {
		const restricted = await issueRestrictedKey();
		owner.useKey(restricted.token);

		const rules = await owner.post("/api/v1/admin/rules", {
			scope: "domain",
			name: "作れない",
			action: "deliver",
		});
		expect(rules.status).toBe(403);

		const addr = await owner.patch(`/api/v1/admin/addresses/${ai}`, { name: "変えられない" });
		expect(addr.status).toBe(403);

		const webhook = await owner.post("/api/v1/webhooks", {
			name: "作れない",
			url: "https://example.net/hook",
			events: ["message.received"],
		});
		expect(webhook.status).toBe(403);
	});

	scenario("FR-5-5", "キーで発行した子・孫は親に連なり、親の失効でまとめて失効する", async () => {
		const root = await issueKey({ scopes: ["read", "admin"] });

		const childClient = createClient(h);
		childClient.useKey(root.token);
		const child = await childClient.post("/api/v1/me/api-keys", {
			name: "子",
			scopes: ["read", "admin"],
		});
		expect(child.status).toBe(201);
		expect(child.body.parentKeyId).toBe(root.id);

		const grandchildClient = createClient(h);
		grandchildClient.useKey(child.body.token as string);
		const grandchild = await grandchildClient.post("/api/v1/me/api-keys", {
			name: "孫",
			scopes: ["read", "admin"],
		});
		expect(grandchild.status).toBe(201);
		expect(grandchild.body.parentKeyId).toBe(child.body.id);

		owner.useKey(null);
		const revoke = await owner.del(`/api/v1/admin/api-keys/${root.id}`);
		expect(revoke.status).toBe(200);

		expect((await childClient.get("/api/v1/me")).status).toBe(401);
		expect((await grandchildClient.get("/api/v1/me")).status).toBe(401);

		const audit = await owner.get("/api/v1/admin/audit-logs?targetType=api_key&targetId=" + root.id);
		expect(audit.status).toBe(200);
		const revokeEntry = audit.body.data.find((e: any) => e.action === "api_key.revoke");
		expect(revokeEntry.meta.descendants.sort()).toEqual([child.body.id, grandchild.body.id].sort());
	});

	scenario("FR-5-5", "持ち主のパスワード変更で、そのキーから他人向けに発行した子も失効する", async () => {
		const memberId = await createUser("member", "member-6@example.test");
		const root = await issueKey({ scopes: ["read", "admin"] });

		const rootClient = createClient(h);
		rootClient.useKey(root.token);
		const memberKey = await rootClient.post("/api/v1/admin/api-keys", {
			userId: memberId,
			name: "メンバー用",
			scopes: ["read"],
		});
		expect(memberKey.status).toBe(201);

		const pwClient = createClient(h);
		pwClient.useKey(memberKey.body.token as string);
		expect((await pwClient.get("/api/v1/me")).status).toBe(200);

		owner.useKey(null);
		const change = await owner.patch("/api/v1/me", {
			currentPassword: OWNER.password,
			newPassword: "brand-new-9876",
		});
		expect(change.status).toBe(200);
		expect((await pwClient.get("/api/v1/me")).status).toBe(401);
	});

	scenario("FR-5-5", "持ち主の無効化で、そのキーから他人向けに発行した子が失効する", async () => {
		const secondOwnerId = await createUser("owner", "owner-2@example.test");
		const memberId = await createUser("member", "member-7@example.test");
		const root = await issueKey({ userId: secondOwnerId, scopes: ["read", "admin"] });

		const rootClient = createClient(h);
		rootClient.useKey(root.token);
		const memberKey = await rootClient.post("/api/v1/admin/api-keys", {
			userId: memberId,
			name: "メンバー用",
			scopes: ["read"],
		});
		expect(memberKey.status).toBe(201);

		const pwClient = createClient(h);
		pwClient.useKey(memberKey.body.token as string);
		expect((await pwClient.get("/api/v1/me")).status).toBe(200);

		owner.useKey(null);
		const disable = await owner.patch(`/api/v1/admin/users/${secondOwnerId}`, {
			status: "disabled",
		});
		expect(disable.status).toBe(200);
		expect((await pwClient.get("/api/v1/me")).status).toBe(401);
	});

	scenario("FR-5-5", "持ち主の削除で、そのキーから他人向けに発行した子が失効する", async () => {
		const secondOwnerId = await createUser("owner", "owner-3@example.test");
		const memberId = await createUser("member", "member-8@example.test");
		const root = await issueKey({ userId: secondOwnerId, scopes: ["read", "admin"] });

		const rootClient = createClient(h);
		rootClient.useKey(root.token);
		const memberKey = await rootClient.post("/api/v1/admin/api-keys", {
			userId: memberId,
			name: "メンバー用",
			scopes: ["read"],
		});
		expect(memberKey.status).toBe(201);

		const pwClient = createClient(h);
		pwClient.useKey(memberKey.body.token as string);
		expect((await pwClient.get("/api/v1/me")).status).toBe(200);

		owner.useKey(null);
		const remove = await owner.del(`/api/v1/admin/users/${secondOwnerId}`);
		expect(remove.status).toBe(200);
		expect((await pwClient.get("/api/v1/me")).status).toBe(401);
	});
});
