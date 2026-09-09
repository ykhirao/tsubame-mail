import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@/db/client";
import {
	addressFilter,
	canRead,
	canWrite,
	countActiveOwners,
	intersectAddressSets,
	isOwner,
	requireOwner,
	resolvePrincipal,
} from "@/domain/access/policy";
import { ApiError } from "@/shared/errors";
import { createAddress, createDomain, createUser, db, grant, resetDb } from "./auth-helpers";

beforeEach(resetDb);

async function fixture() {
	const domainId = await createDomain();
	const a = await createAddress(domainId, "a");
	const b = await createAddress(domainId, "b");
	const c = await createAddress(domainId, "c");
	return { a, b, c };
}

describe("resolvePrincipal — ロール", () => {
	it("owner + セッションは全アドレス", async () => {
		const owner = await createUser({ role: "owner", password: "password-1234" });
		const p = await resolvePrincipal(db(), { user: owner });
		expect(p.via).toBe("session");
		expect(p.addressIds).toBe("all");
		expect(p.writableAddressIds).toBe("all");
		expect(p.scopes).toEqual(["read", "send", "admin"]);
	});

	it("member は grants から解決され、read grant では書けない", async () => {
		const { a, b } = await fixture();
		const user = await createUser({ role: "member", password: "password-1234" });
		await grant(user.id, a, "read");
		await grant(user.id, b, "write");

		const p = await resolvePrincipal(db(), { user });
		expect([...(p.addressIds as string[])].sort()).toEqual([a, b].sort());
		expect(p.writableAddressIds).toEqual([b]);

		expect(canRead(p, a)).toBe(true);
		expect(canWrite(p, a)).toBe(false);
		expect(canWrite(p, b)).toBe(true);
	});

	it("grant の無いアドレスは読めない", async () => {
		const { a, c } = await fixture();
		const user = await createUser({ role: "agent" });
		await grant(user.id, a, "write");
		const p = await resolvePrincipal(db(), { user });
		expect(canRead(p, c)).toBe(false);
		expect(canWrite(p, c)).toBe(false);
	});

	it("grant が無ければ何も読めない", async () => {
		const user = await createUser({ role: "member", password: "password-1234" });
		const p = await resolvePrincipal(db(), { user });
		expect(p.addressIds).toEqual([]);
		expect(p.writableAddressIds).toEqual([]);
	});
});

describe("resolvePrincipal — API キーは権限を狭める方向にしか効かない", () => {
	it("owner のキーでも addressIds があれば all にならない", async () => {
		const { a, b } = await fixture();
		const owner = await createUser({ role: "owner", password: "password-1234" });

		const p = await resolvePrincipal(db(), {
			user: owner,
			apiKey: { id: "key_1", scopes: ["read"], addressIds: [a] },
		});
		expect(p.addressIds).not.toBe("all");
		expect(p.addressIds).toEqual([a]);
		expect(p.writableAddressIds).toEqual([a]);
		expect(canRead(p, b)).toBe(false);
		expect(p.via).toBe("api_key");
		expect(p.apiKeyId).toBe("key_1");
	});

	it("addressIds が null なら所有ユーザーの権限そのまま", async () => {
		const { a } = await fixture();
		const user = await createUser({ role: "agent" });
		await grant(user.id, a, "write");

		const p = await resolvePrincipal(db(), {
			user,
			apiKey: { id: "key_2", scopes: ["read", "send"], addressIds: null },
		});
		expect(p.addressIds).toEqual([a]);
		expect(p.writableAddressIds).toEqual([a]);
	});

	it("キーはユーザーが持っていないアドレスを増やせない（積集合になる）", async () => {
		const { a, b, c } = await fixture();
		const user = await createUser({ role: "member", password: "password-1234" });
		await grant(user.id, a, "read");

		const p = await resolvePrincipal(db(), {
			user,
			apiKey: { id: "key_3", scopes: ["read"], addressIds: [a, b, c] },
		});
		expect(p.addressIds).toEqual([a]);
		// read grant なので、キーが何を言っても書けない。
		expect(p.writableAddressIds).toEqual([]);
		expect(canWrite(p, a)).toBe(false);
	});

	it("キーの scopes だけが有効で、知らない値は落とす", async () => {
		const owner = await createUser({ role: "owner", password: "password-1234" });
		const p = await resolvePrincipal(db(), {
			user: owner,
			apiKey: { id: "key_4", scopes: ["read", "danger", "read"], addressIds: null },
		});
		expect(p.scopes).toEqual(["read"]);
	});

	it("admin スコープの無い owner のキーでは管理操作を通さない", async () => {
		const owner = await createUser({ role: "owner", password: "password-1234" });
		const withoutAdmin = await resolvePrincipal(db(), {
			user: owner,
			apiKey: { id: "key_5", scopes: ["read"], addressIds: null },
		});
		expect(isOwner(withoutAdmin)).toBe(false);
		expect(() => requireOwner(withoutAdmin)).toThrow(ApiError);

		const withAdmin = await resolvePrincipal(db(), {
			user: owner,
			apiKey: { id: "key_6", scopes: ["admin"], addressIds: null },
		});
		expect(isOwner(withAdmin)).toBe(true);
		expect(() => requireOwner(withAdmin)).not.toThrow();
	});

	it("member は admin スコープを持っていても owner ではない", async () => {
		const user = await createUser({ role: "member", password: "password-1234" });
		const p = await resolvePrincipal(db(), {
			user,
			apiKey: { id: "key_7", scopes: ["admin"], addressIds: null },
		});
		expect(isOwner(p)).toBe(false);
	});
});

describe("集合とクエリ補助", () => {
	it("intersectAddressSets は all を単位元として扱う", () => {
		expect(intersectAddressSets("all", "all")).toBe("all");
		expect(intersectAddressSets("all", ["x"])).toEqual(["x"]);
		expect(intersectAddressSets(["x", "y"], "all")).toEqual(["x", "y"]);
		expect(intersectAddressSets(["x", "y"], ["y", "z"])).toEqual(["y"]);
		expect(intersectAddressSets(["x"], [])).toEqual([]);
	});

	it("addressFilter は all のとき undefined、それ以外は IN 条件", async () => {
		const owner = await createUser({ role: "owner", password: "password-1234" });
		const ownerPrincipal = await resolvePrincipal(db(), { user: owner });
		expect(addressFilter(ownerPrincipal, schema.messages.addressId)).toBeUndefined();

		const narrowed = await resolvePrincipal(db(), {
			user: owner,
			apiKey: { id: "key_8", scopes: ["read"], addressIds: ["adr_1"] },
		});
		expect(addressFilter(narrowed, schema.messages.addressId)).toBeDefined();
	});

	it("触れるアドレスが 0 件でも安全側（何も返さない条件）になる", async () => {
		const user = await createUser({ role: "agent" });
		const p = await resolvePrincipal(db(), { user });
		const filter = addressFilter(p, schema.messages.addressId);
		expect(filter).toBeDefined();
		const rows = await db().select().from(schema.messages).where(filter);
		expect(rows).toEqual([]);
	});
});

describe("countActiveOwners", () => {
	it("有効な owner だけを数え、除外指定が効く", async () => {
		const owner = await createUser({ role: "owner", password: "password-1234" });
		await createUser({ role: "owner", password: "password-1234", status: "disabled" });
		await createUser({ role: "member", password: "password-1234" });

		expect(await countActiveOwners(db())).toBe(1);
		expect(await countActiveOwners(db(), owner.id)).toBe(0);
	});
});
