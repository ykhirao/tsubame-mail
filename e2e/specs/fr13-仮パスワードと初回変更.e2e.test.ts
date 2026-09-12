import { beforeEach, describe, expect } from "vitest";
import { scenario } from "../registry";
import {
	createClient,
	freshHarness,
	loginAsOwner,
	type Client,
	type Harness,
} from "../harness";

// UI の実装をソースの形で確かめる（fr09 / fr15 / fr17 と同じ流儀）。
function rawBySuffix(modules: Record<string, string>, suffix: string): string {
	const entry = Object.entries(modules).find(([k]) => k.endsWith(suffix));
	if (!entry) throw new Error(`glob に無い: ${suffix}`);
	return entry[1];
}

const usersPageText = rawBySuffix(
	import.meta.glob("../../src/ui/routes/admin/UsersPage.tsx", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
	"admin/UsersPage.tsx",
);

describe("FR-13 仮パスワードと初回変更", () => {
	let h: Harness;
	let owner: Client;

	const EXISTING_EMAIL = "member@tsubame.test";
	const EXISTING_PASSWORD = "member-original-password-123";

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
	});

	async function createTemporaryMember(): Promise<{
		id: string;
		temporaryPassword: string;
	}> {
		const created = await owner.post("/api/v1/admin/users", {
			email: EXISTING_EMAIL,
			name: "仮パスワードのメンバー",
			role: "member",
		});
		expect(created.status).toBe(201);
		expect(typeof created.body.temporaryPassword).toBe("string");
		return { id: created.body.id, temporaryPassword: created.body.temporaryPassword };
	}

	scenario("FR-13", "パスワードを指定しないメンバー作成で仮パスワードが発行され、それでログインできる", async () => {
		const { temporaryPassword } = await createTemporaryMember();

		expect(temporaryPassword).toHaveLength(20);

		const member = createClient(h);
		const login = await member.post("/api/v1/auth/login", {
			email: EXISTING_EMAIL,
			password: temporaryPassword,
		});
		expect(login.status).toBe(200);
		expect(login.body.role).toBe("member");
	});

	scenario("FR-13", "仮パスワードは作成の応答で一度だけ返り、一覧・詳細に平文は残らない", async () => {
		const { id, temporaryPassword } = await createTemporaryMember();

		const createdDetail = await owner.get(`/api/v1/admin/users/${id}`);
		expect(createdDetail.status).toBe(200);
		expect(createdDetail.body.hasPassword).toBe(true);

		const list = await owner.get("/api/v1/admin/users");
		expect(list.status).toBe(200);
		for (const u of list.body.data) {
			expect(u).not.toHaveProperty("temporaryPassword");
			expect(JSON.stringify(u)).not.toContain(temporaryPassword);
		}

		expect(createdDetail.body).not.toHaveProperty("temporaryPassword");
		expect(JSON.stringify(createdDetail.body)).not.toContain(temporaryPassword);
	});

	scenario("FR-13", "仮パスワードで入った本人は、変更するまで他の画面に進めない", async () => {
		const { temporaryPassword } = await createTemporaryMember();

		const member = createClient(h);
		await member.post("/api/v1/auth/login", {
			email: EXISTING_EMAIL,
			password: temporaryPassword,
		});
		const me = await member.get("/api/v1/me");
		expect(me.status).toBe(200);
		expect(me.body.mustChangePassword).toBe(true);

		// パスワードを変えると mustChangePassword が消える。
		// （変更で全セッションが落ちるため、新しいパスワードで入れ直して確認する。）
		const changed = await member.patch("/api/v1/me", {
			currentPassword: temporaryPassword,
			newPassword: "member-new-password-123",
		});
		expect(changed.status).toBe(200);
		expect(changed.body.passwordChanged).toBe(true);

		const relogin = createClient(h);
		const login2 = await relogin.post("/api/v1/auth/login", {
			email: EXISTING_EMAIL,
			password: "member-new-password-123",
		});
		expect(login2.status).toBe(200);
		const me2 = await relogin.get("/api/v1/me");
		expect(me2.status).toBe(200);
		expect(me2.body.mustChangePassword).toBe(false);
	});

	scenario("FR-13", "パスワードを変えると、その利用者の全セッションを落とす", async () => {
		const created = await owner.post("/api/v1/admin/users", {
			email: EXISTING_EMAIL,
			name: "メンバー",
			role: "member",
			password: EXISTING_PASSWORD,
		});
		expect(created.status).toBe(201);
		expect(created.body.temporaryPassword).toBeNull();
		const first = createClient(h);
		await first.post("/api/v1/auth/login", {
			email: EXISTING_EMAIL,
			password: EXISTING_PASSWORD,
		});
		expect((await first.get("/api/v1/me")).body.mustChangePassword).toBeFalsy();

		const second = createClient(h);
		await second.post("/api/v1/auth/login", {
			email: EXISTING_EMAIL,
			password: EXISTING_PASSWORD,
		});
		expect((await first.get("/api/v1/me")).status).toBe(200);
		expect((await second.get("/api/v1/me")).status).toBe(200);

		const change = await first.patch("/api/v1/me", {
			currentPassword: EXISTING_PASSWORD,
			newPassword: "member-new-password-123",
		});
		expect(change.status).toBe(200);

		expect((await first.get("/api/v1/me")).status).toBe(401);
		expect((await second.get("/api/v1/me")).status).toBe(401);

		const relogin = createClient(h);
		expect(
			(await relogin.post("/api/v1/auth/login", {
				email: EXISTING_EMAIL,
				password: "member-new-password-123",
			})).status,
		).toBe(200);
	});

	scenario("FR-13", "ユーザー作成でパスワードを空にでき、仮パスワードを 1 度だけ表示する", () => {
		// 空なら仮パスワードを発行する送信に変わる。
		expect(usersPageText).toContain('password === "" || password.length >= 12');
		expect(usersPageText).toContain('password: role === "agent" || password === "" ? undefined : password');
		// 作成の応答の temporaryPassword を拾って、閉じる前に一枚見せる。
		expect(usersPageText).toContain("temporaryPassword");
		expect(usersPageText).toContain("setTemporaryPassword(res.temporaryPassword)");
		expect(usersPageText).toContain("仮パスワードはこれきりしか表示されません");
	});

	scenario("FR-13", "agent はパスワードを持たず、仮パスワードも発行されない", async () => {
		const created = await owner.post("/api/v1/admin/users", {
			email: "agent@tsubame.test",
			name: "エージェント",
			role: "agent",
		});
		expect(created.status).toBe(201);
		expect(created.body.temporaryPassword).toBeNull();
		expect(created.body.hasPassword).toBe(false);

		const agent = createClient(h);
		const login = await agent.post("/api/v1/auth/login", {
			email: "agent@tsubame.test",
			password: "any-password-123",
		});
		expect(login.status).toBe(401);
	});
});
