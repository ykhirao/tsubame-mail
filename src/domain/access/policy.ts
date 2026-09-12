/**
 * クエリは必ず `addressFilter()` で絞ること。`user_id` で直接絞ると、
 * 共有アドレスと API キーの address_ids がどちらも効かなくなる。
 */
import { and, eq, sql } from "drizzle-orm";
import type { Column, SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { schema } from "@/db/client";
import { newId } from "@/lib/id";
import type { Principal, Role, Scope } from "@/shared/contracts/common";
import { defaultColorFor } from "@/shared/colors";
import { forbidden } from "@/shared/errors";
import { redactError } from "@/lib/logError";

export const ALL_SCOPES: Scope[] = ["read", "send", "admin"];

export type AddressSet = string[] | "all";

export type PrincipalUser = {
	id: string;
	role: Role;
};

export type PrincipalApiKey = {
	id: string;
	scopes: string[];
	/** null なら所有ユーザーの権限そのまま。配列ならその積集合になる。 */
	addressIds: string[] | null;
};

export type ResolvePrincipalOptions = {
	user: PrincipalUser;
	apiKey?: PrincipalApiKey | null;
	sessionId?: string;
	/** セッションの管理者モードの期限。owner のセッションで、今より後なら全アドレスを読める。 */
	adminModeUntil?: Date | null;
};

export function intersectAddressSets(a: AddressSet, b: AddressSet): AddressSet {
	if (a === "all") return b === "all" ? "all" : [...new Set(b)];
	if (b === "all") return [...new Set(a)];
	const right = new Set(b);
	return [...new Set(a.filter((id) => right.has(id)))];
}

export function addressSetHas(set: AddressSet, addressId: string): boolean {
	return set === "all" || set.includes(addressId);
}

export type UserAddressAccess = {
	readable: AddressSet;
	writable: AddressSet;
};

/** API キーの絞り込みと管理者モードは含まない。owner も割り当てたアドレスだけ（FR-11 / FR-19）。 */
export async function resolveUserAddressAccess(
	db: Db,
	user: PrincipalUser,
): Promise<UserAddressAccess> {
	const grants = await db
		.select({ addressId: schema.addressGrants.addressId, level: schema.addressGrants.level })
		.from(schema.addressGrants)
		.where(eq(schema.addressGrants.userId, user.id));

	const readable = grants.map((g) => g.addressId);
	const writable = grants.filter((g) => g.level === "write").map((g) => g.addressId);
	return { readable, writable };
}

/** API キーは権限を広げられない。必ず持ち主の権限との積集合になる。 */
export async function resolvePrincipal(
	db: Db,
	opts: ResolvePrincipalOptions,
): Promise<Principal> {
	const base = await resolveUserAddressAccess(db, opts.user);
	const apiKey = opts.apiKey ?? null;

	if (!apiKey) {
		const adminMode =
			opts.user.role === "owner" && !!opts.adminModeUntil && opts.adminModeUntil.getTime() > Date.now();
		return {
			userId: opts.user.id,
			role: opts.user.role,
			via: "session",
			scopes: [...ALL_SCOPES],
			// 管理者モードで広がるのは読む範囲だけ。送信や既読などの変更は割り当てたアドレスに留める。
			addressIds: adminMode ? "all" : base.readable,
			writableAddressIds: base.writable,
			...(adminMode ? { adminMode: true, ownAddressIds: base.readable as string[] } : {}),
			...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
		};
	}

	const limit: AddressSet = apiKey.addressIds === null ? "all" : apiKey.addressIds;
	return {
		userId: opts.user.id,
		role: opts.user.role,
		via: "api_key",
		scopes: normalizeScopes(apiKey.scopes),
		addressIds: intersectAddressSets(base.readable, limit),
		writableAddressIds: intersectAddressSets(base.writable, limit),
		apiKeyId: apiKey.id,
		...(apiKey.addressIds !== null ? { keyRestricted: true } : {}),
	};
}

export function normalizeScopes(raw: unknown): Scope[] {
	if (!Array.isArray(raw)) return [];
	const known = new Set<string>(ALL_SCOPES);
	return [...new Set(raw.filter((s): s is Scope => typeof s === "string" && known.has(s)))];
}

export function canRead(principal: Principal, addressId: string): boolean {
	return addressSetHas(principal.addressIds, addressId);
}

/** 自分に割り当てたアドレス。管理者モードで読めるだけのアドレスは含めない（自分の設定を書ける範囲。FR-19）。 */
export function ownAddresses(principal: Principal): AddressSet {
	return principal.adminMode ? (principal.ownAddressIds ?? []) : principal.addressIds;
}

/** 既読・スター・移動のような状態の変更。管理者モードで読めるだけの他人のメールは変えない（FR-19）。 */
export function canModify(principal: Principal, addressId: string): boolean {
	if (principal.adminMode) return (principal.ownAddressIds ?? []).includes(addressId);
	return canRead(principal, addressId);
}

export function canWrite(principal: Principal, addressId: string): boolean {
	return canRead(principal, addressId) && addressSetHas(principal.writableAddressIds, addressId);
}

export function hasScope(principal: Principal, scope: Scope): boolean {
	return principal.scopes.includes(scope);
}

export function requireRead(principal: Principal, addressId: string): void {
	requireScope(principal, "read");
	if (!canRead(principal, addressId)) throw forbidden("このアドレスを参照する権限がありません");
}

export function requireWrite(principal: Principal, addressId: string): void {
	requireScope(principal, "send");
	if (!canWrite(principal, addressId)) throw forbidden("このアドレスから送信する権限がありません");
}

export function requireScope(principal: Principal, scope: Scope): void {
	if (!hasScope(principal, scope)) throw forbidden(`このキーには ${scope} スコープがありません`);
}

/** scope だけでは通さない。owner のキーでも admin スコープが要る。 */
export function requireOwner(principal: Principal): void {
	if (principal.role !== "owner") throw forbidden("オーナーのみ実行できます");
	requireScope(principal, "admin");
}

export function isOwner(principal: Principal): boolean {
	return principal.role === "owner" && hasScope(principal, "admin");
}

// id の数だけバインド変数を積む inArray は D1 の 100 個上限を越える（#57）。
// 列の値を JSON 1 本で json_each に渡して比較する。空配列は何も一致しない（fail-closed）。
export function jsonIdsIn(column: Column, ids: string[]): SQL {
	return sql`${column} in (select value from json_each(${JSON.stringify(ids)}))`;
}

/** "all" では undefined を返す。そのまま `and(...)` に渡してよい。 */
export function addressFilter(principal: Principal, column: Column): SQL | undefined {
	if (principal.addressIds === "all") return undefined;
	return jsonIdsIn(column, principal.addressIds);
}

export function writableAddressFilter(principal: Principal, column: Column): SQL | undefined {
	if (principal.writableAddressIds === "all") return undefined;
	return jsonIdsIn(column, principal.writableAddressIds);
}

export async function listAccessibleAddresses(db: Db, principal: Principal) {
	const filter = addressFilter(principal, schema.addresses.id);
	const rows = await db
		.select({
			id: schema.addresses.id,
			address: schema.addresses.address,
			displayName: schema.addresses.displayName,
			color: schema.addresses.color,
			signature: schema.addresses.signature,
			archivedAt: schema.addresses.archivedAt,
		})
		.from(schema.addresses)
		.where(filter);

	// GET /v1/addresses と同じ形で返す。
	// 同じ「自分が触れるアドレス」を別の形で返すと、片方だけを見て書いた画面が黙って壊れる
	// （作成画面の差出人が空になる不具合が実際に起きた）。
	return rows.map((row, index) => ({
		id: row.id,
		address: row.address,
		displayName: row.displayName,
		color: row.color ?? defaultColorFor(index),
		signature: row.signature,
		archived: row.archivedAt !== null,
		level: canWrite(principal, row.id) ? ("write" as const) : ("read" as const),
		canWrite: canWrite(principal, row.id),
	}));
}

export type AuditEntry = {
	actorId: string | null;
	action: string;
	targetType?: string;
	targetId?: string;
	meta?: Record<string, unknown>;
	ip?: string | null;
};

/** 記録の失敗で本処理を落とさない。監査は副次的な関心事。 */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
	try {
		await db.insert(schema.auditLogs).values({
			id: newId("audit"),
			actorId: entry.actorId,
			action: entry.action,
			targetType: entry.targetType ?? null,
			targetId: entry.targetId ?? null,
			meta: entry.meta ?? null,
			ip: entry.ip ?? null,
		});
	} catch (err) {
		console.error("audit_logs への記録に失敗", entry.action, redactError(err));
	}
}

export async function countActiveOwners(db: Db, excludeUserId?: string): Promise<number> {
	const where = excludeUserId
		? and(
				eq(schema.users.role, "owner"),
				eq(schema.users.status, "active"),
				sql`${schema.users.id} <> ${excludeUserId}`,
			)
		: and(eq(schema.users.role, "owner"), eq(schema.users.status, "active"));

	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(schema.users)
		.where(where);
	return Number(row?.count ?? 0);
}
