import { beforeEach, describe, expect, it } from "vitest";
import {
	buildTestApp,
	createAddress,
	createApiKeyFor,
	createDomain,
	createUser,
	json,
	request,
	resetDb,
	sessionCookie,
} from "./auth-helpers";

const app = buildTestApp();

beforeEach(resetDb);

const PASSWORD = "correct-horse-1234";

async function loginCookie(email: string) {
	const res = await request(app, "/api/v1/auth/login", json({ email, password: PASSWORD }));
	expect(res.status).toBe(200);
	return sessionCookie(res);
}

// 絞った admin キー（#58 の clamp 前提）が期限・範囲で縛れない資格情報を作れないことを確かめる（#121）。
describe("#121 ユーザー管理の変更系は Cookie セッションの owner だけ", () => {
	let domainId: string;
	let addressId: string;
	let ownerId: string;
	let cookie: string;
	let key: Awaited<ReturnType<typeof createApiKeyFor>>;

	beforeEach(async () => {
		domainId = await createDomain();
		addressId = await createAddress(domainId, "box");
		const owner = await createUser({ role: "owner", email: "o@example.test", password: PASSWORD });
		ownerId = owner.id;
		cookie = await loginCookie(owner.email);
		key = await createApiKeyFor({ userId: ownerId, scopes: ["admin"], addressIds: [addressId] });
	});

	it("POST で owner を新規作成できない（キーは 403、セッションは 201）", async () => {
		const body = { email: "new-owner@example.test", name: "新オーナー", role: "owner", password: "pw-1234567890" };

		expect((await request(app, "/api/v1/admin/users", { bearer: key.token, ...json(body) })).status).toBe(403);
		expect((await request(app, "/api/v1/admin/users", { cookie, ...json(body) })).status).toBe(201);
	});

	it("自分の password の PATCH は 403、セッションは 200（キーは失効させる資格情報を変えられない）", async () => {
		expect(
			(await request(app, `/api/v1/admin/users/${ownerId}`, {
				bearer: key.token,
				method: "PATCH",
				body: JSON.stringify({ password: "hijacked-1234" }),
			})).status,
		).toBe(403);
		expect(
			(await request(app, `/api/v1/admin/users/${ownerId}`, {
				cookie,
				method: "PATCH",
				body: JSON.stringify({ password: "hijacked-1234" }),
			})).status,
		).toBe(200);
	});

	it("自分への grants の PUT は 403、セッションは 200", async () => {
		expect(
			(await request(app, `/api/v1/admin/users/${ownerId}/grants`, {
				bearer: key.token,
				method: "PUT",
				body: JSON.stringify({ grants: [{ addressId, level: "write" }] }),
			})).status,
		).toBe(403);
		expect(
			(await request(app, `/api/v1/admin/users/${ownerId}/grants`, {
				cookie,
				method: "PUT",
				body: JSON.stringify({ grants: [{ addressId, level: "write" }] }),
			})).status,
		).toBe(200);
	});

	it("DELETE は 403、一覧・参照（GET）はキーでも 200", async () => {
		expect((await request(app, `/api/v1/admin/users/${ownerId}`, { bearer: key.token, method: "DELETE" })).status).toBe(403);
		expect((await request(app, "/api/v1/admin/users", { bearer: key.token })).status).toBe(200);
		expect((await request(app, `/api/v1/admin/users/${ownerId}`, { bearer: key.token })).status).toBe(200);
	});
});
