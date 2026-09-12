import { beforeAll, describe, expect, it } from "vitest";
import { users, domains, addresses, addressGrants, threads, messages } from "@/db/schema";
import { newId } from "@/lib/id";
import type { Principal } from "@/shared/contracts/common";
import { applyMigrations, callJson, getTestDb, mountRouter } from "./domains-helpers";
import messagesRoutes from "@/api/v1/messages";
import threadsRoutes from "@/api/v1/threads";
import addressesRoutes from "@/api/v1/addresses";

beforeAll(async () => {
	await applyMigrations();
});

function member(userId: string, addressIds: string[], writable: string[] = addressIds): Principal {
	return { userId, role: "member", via: "session", scopes: ["read"], addressIds, writableAddressIds: writable };
}

function owner(userId: string): Principal {
	return {
		userId,
		role: "owner",
		via: "session",
		scopes: ["read", "send", "admin"],
		addressIds: "all",
		writableAddressIds: "all",
	};
}

/** address_grants が参照する users 行を用意する。 */
function ensureUser(userId: string): void {
	getTestDb()
		.insert(users)
		.values({ id: userId, email: `${userId}@example.test`, name: "テスト", role: "member", status: "active" })
		.onConflictDoNothing()
		.run();
}

function seedHiddenDomain() {
	const db = getTestDb();
	const domainId = newId("domain");
	db.insert(domains).values({
		id: domainId,
		name: `hidden-${domainId.slice(-6)}.example.test`,
		zoneId: "zone",
		zoneName: "example.test",
		mode: "subdomain",
	}).run();
	return domainId;
}

function seededAddress(userId: string, local: string, { hidden = false, subject = "", domainId = seedHiddenDomain() } = {}) {
	ensureUser(userId);
	const db = getTestDb();
	const id = newId("address");
	const addr = `${local}@${id.slice(-6)}.example.test`;
	db.insert(addresses).values({ id, domainId, localPart: local, address: addr }).run();
	db.insert(addressGrants).values({ userId, addressId: id, level: "write", hidden }).run();
	const threadId = `thr_${id}`;
	db.insert(threads).values({
		id: threadId,
		addressId: id,
		subject: subject || local,
		lastMessageAt: new Date(1_770_000_000_000),
		messageCount: 1,
		unreadCount: 1,
	}).run();
	const msgId = newId("message");
	db.insert(messages).values({
		id: msgId,
		threadId,
		addressId: id,
		direction: "inbound",
		status: "received",
		fromAddr: "sender@example.test",
		toAddr: addr,
		subject: subject || id,
		receivedAt: new Date(1_770_000_000_000),
	}).run();
	return { id, address: addr, threadId, messageId: msgId };
}

describe("メールボックスの非表示（FR-19）", () => {
	it("GET /addresses は割り当ての無いアドレスに hidden=false、非表示のものを true で返す", async () => {
		seedHiddenDomain();
		const uid = "usr_hidden";
		const visible = seededAddress(uid, "visible");
		const hidden = seededAddress(uid, "hidden", { hidden: true });
		const app = mountRouter("/", addressesRoutes, member(uid, [visible.id, hidden.id]));

		const res = await callJson(app, "/");
		expect(res.status).toBe(200);
		const byId = new Map(res.json.data.map((a: { id: string; hidden: boolean }) => [a.id, a.hidden]));
		expect(byId.get(visible.id)).toBe(false);
		expect(byId.get(hidden.id)).toBe(true);
	});

	it("割り当てのないアドレスへの非表示変更は 404（管理者モードで読めるだけのアドレスも 404）", async () => {
		const domainId = seedHiddenDomain();
		const uid = "usr_hidden";
		const mine = seededAddress(uid, "mine", { domainId });
		const otherId = newId("address");
		getTestDb().insert(addresses).values({
			id: otherId,
			domainId,
			localPart: "other",
			address: `other@${otherId.slice(-6)}.example.test`,
		}).run();
		const app = mountRouter("/", addressesRoutes, owner(uid));

		const res = await callJson(app, `/${otherId}/hidden`, {
			method: "PATCH",
			body: JSON.stringify({ hidden: true }),
		});
		expect(res.status).toBe(404);

		const ok = await callJson(app, `/${mine.id}/hidden`, {
			method: "PATCH",
			body: JSON.stringify({ hidden: true }),
		});
		expect(ok.status).toBe(200);
		expect(ok.json.data.hidden).toBe(true);
	});

	it("API キーでも非表示を変更できる（見え方の設定なので）", async () => {
		seedHiddenDomain();
		const uid = "usr_hidden";
		const mine = seededAddress(uid, "mine");
		const key: Principal = {
			userId: uid,
			role: "member",
			via: "api_key",
			scopes: ["read"],
			addressIds: [mine.id],
			writableAddressIds: [mine.id],
		};
		const app = mountRouter("/", addressesRoutes, key);
		const res = await callJson(app, `/${mine.id}/hidden`, {
			method: "PATCH",
			body: JSON.stringify({ hidden: true }),
		});
		expect(res.status).toBe(200);
		expect(res.json.data.hidden).toBe(true);
	});

	it("メッセージ一覧・スレッド一覧・検索の既定から非表示のメールボックスを除く", async () => {
		seedHiddenDomain();
		const uid = "usr_hidden";
		const visible = seededAddress(uid, "visible", { subject: "見えるメール" });
		const hidden = seededAddress(uid, "hidden", { hidden: true, subject: "隠すメール" });
		const p = member(uid, [visible.id, hidden.id]);

		const msgs = await callJson(mountRouter("/", messagesRoutes, p), "/");
		expect(msgs.status).toBe(200);
		const msgIds = msgs.json.data.map((m: { id: string }) => m.id);
		expect(msgIds).toContain(visible.messageId);
		expect(msgIds).not.toContain(hidden.messageId);

		const search = await callJson(mountRouter("/", messagesRoutes, p), "/?q=隠すメール");
		expect(search.status).toBe(200);
		expect(search.json.data.map((m: { id: string }) => m.id)).not.toContain(hidden.messageId);

		const threads = await callJson(mountRouter("/", threadsRoutes, p), "/");
		expect(threads.status).toBe(200);
		const threadIds = threads.json.data.map((t: { id: string }) => t.id);
		expect(threadIds).toContain(visible.threadId);
		expect(threadIds).not.toContain(hidden.threadId);
	});

	it("address= で名指ししたときは非表示でも出す", async () => {
		seedHiddenDomain();
		const uid = "usr_hidden";
		const hidden = seededAddress(uid, "hidden", { hidden: true, subject: "隠すメール" });
		const p = member(uid, [hidden.id]);

		const msgs = await callJson(mountRouter("/", messagesRoutes, p), `/?address=${hidden.id}`);
		expect(msgs.status).toBe(200);
		expect(msgs.json.data.map((m: { id: string }) => m.id)).toContain(hidden.messageId);
	});

	it("includeHidden=true でまとめた一覧・検索にも出す", async () => {
		seedHiddenDomain();
		const uid = "usr_hidden";
		const hidden = seededAddress(uid, "hidden", { hidden: true, subject: "隠すメール" });
		const p = member(uid, [hidden.id]);

		const msgs = await callJson(mountRouter("/", messagesRoutes, p), "/?includeHidden=true");
		expect(msgs.status).toBe(200);
		expect(msgs.json.data.map((m: { id: string }) => m.id)).toContain(hidden.messageId);

		const search = await callJson(mountRouter("/", messagesRoutes, p), "/?q=隠すメール&includeHidden=true");
		expect(search.status).toBe(200);
		expect(search.json.data.map((m: { id: string }) => m.id)).toContain(hidden.messageId);
	});

	it("他人の非表示設定は影響しない", async () => {
		seedHiddenDomain();
		const shared = seededAddress("usr_a", "shared", { subject: "共有メール" });
		ensureUser("usr_b");
		getTestDb()
			.insert(addressGrants)
			.values({ userId: "usr_b", addressId: shared.id, level: "read", hidden: true })
			.run();
		// A は該当アドレスに hidden を持たないので、B の非表示に引きずられない。
		const p = member("usr_a", [shared.id]);
		const msgs = await callJson(mountRouter("/", messagesRoutes, p), "/");
		expect(msgs.status).toBe(200);
		expect(msgs.json.data.map((m: { id: string }) => m.id)).toContain(shared.messageId);
	});

	it("非表示 150 件でもバインド上限 100 を超えず 500 にならない", async () => {
		const domainId = seedHiddenDomain();
		const uid = "usr_hidden";
		ensureUser(uid);
		const db = getTestDb();
		const msgIds: string[] = [];
		for (let i = 0; i < 150; i++) {
			const id = newId("address");
			db.insert(addresses).values({
				id,
				domainId,
				localPart: `h${i}`,
				address: `h${i}@${id.slice(-6)}.example.test`,
			}).run();
			db.insert(addressGrants).values({ userId: uid, addressId: id, level: "read", hidden: true }).run();
			const msgId = newId("message");
			msgIds.push(msgId);
			db.insert(messages).values({
				id: msgId,
				addressId: id,
				direction: "inbound",
				status: "received",
				fromAddr: "sender@example.test",
				toAddr: `h${i}@x.example.test`,
				subject: `hidden-${i}`,
				receivedAt: new Date(1_770_000_000_000),
			}).run();
		}
		const res = await callJson(mountRouter("/", messagesRoutes, owner(uid)), "/?limit=100");
		expect(res.status).toBe(200);
		const returned = new Set(res.json.data.map((m: { id: string }) => m.id));
		// 非表示 150 件のメールが 1 件も漏れてこない（バインド上限 100 を超えたとしても 500 にならない）
		for (const id of msgIds) expect(returned.has(id)).toBe(false);
	});
});
