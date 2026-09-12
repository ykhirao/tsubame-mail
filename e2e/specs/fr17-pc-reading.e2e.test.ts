import { beforeEach, describe, expect } from "vitest";
import { scenario } from "../registry";
import {
	deliverEmail,
	drainQueues,
	freshHarness,
	loginAsOwner,
	mime,
	seedDomain,
	type Client,
	type Harness,
} from "../harness";

// UI の実装をソースの形で確かめる（fr09 / fr15 と同じ流儀）。
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

const inboxText = rawBySuffix(ui, "routes/Inbox.tsx");
const threadText = rawBySuffix(ui, "routes/ThreadDetail.tsx");
const layoutText = rawBySuffix(ui, "routes/AppLayout.tsx");
const mainText = rawBySuffix(ui, "main.tsx");
const listStateText = rawBySuffix(ui, "lib/listState.ts");
const viewPrefsText = rawBySuffix(ui, "lib/viewPrefs.ts");

describe("FR-17 PC の読み進め", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await freshHarness();
	});

	scenario("FR-17-1", "一覧の並びと位置を保つ層が、会話の前後と戻り先を知る", () => {
		// 一覧の状態は画面遷移で消えない層が必要。クエリ・並び順・スクロールを持たせる契約を固定する。
		expect(listStateText).toMatch(/useSyncExternalStore/);
		expect(listStateText).toMatch(/ids/);
		expect(listStateText).toMatch(/scrollTop/);
		expect(listStateText).toMatch(/export function prevNext/);
		// Inbox がその層に一覧の順序を渡し、会話から位置を復元する。
		expect(inboxText).toMatch(/setList/);
		expect(inboxText).toMatch(/commitScrollTop/);
		expect(inboxText).toMatch(/scrollTop =/);
	});

	scenario("FR-17-1", "会話の上部に前へ/次へがあり、一覧の順で移る", () => {
		expect(threadText).toMatch(/前へ/);
		expect(threadText).toMatch(/次へ/);
		expect(threadText).toMatch(/prevNext/);
		// 一覧を読んでいない（直リンク・通知から）ときは出ない＝未取得で disabled になる。
		expect(threadText).toContain("disabled={!prev}");
		expect(threadText).toContain("disabled={!next}");
	});

	scenario("FR-17-2", "768px 以上で一覧と本文を左右に分けて並べる", () => {
		expect(mainText).toContain('<Route path="/" element={<MailShell />} />');
		expect(mainText).toContain('<Route path="/threads/:id" element={<MailShell />} />');
		expect(layoutText).toMatch(/MailShell/);
		expect(layoutText).toMatch(/w-\[380px\]/);
		// 本文が未選択なら右側に導線を出す。
		expect(layoutText).toMatch(/会話を選んでください/);
	});

	scenario("FR-17-2", "本文の全画面を端末ごとに設定でき、分割を畳める", () => {
		expect(viewPrefsText).toMatch(/localStorage/);
		expect(viewPrefsText).toMatch(/fullscreen/);
		// 本文の上部の小さな切り替えで、分割/全画面を選べる。
		expect(threadText).toMatch(/全画面/);
		expect(threadText).toMatch(/分割/);
		expect(threadText).toMatch(/useLayoutPref/);
	});

	scenario("FR-17-2", "PC の会話も最後の 1 通以外を畳んで押して開く", () => {
		expect(threadText).toMatch(/!isLast && !expandedIds\.has\(m\.id\)/);
	});

	scenario("FR-17-3", "PC の一覧に選択と、まとめて既読・未読・ゴミ箱を出す", () => {
		expect(inboxText).toMatch(/type="checkbox"/);
		expect(inboxText).toMatch(/既読にする/);
		expect(inboxText).toMatch(/未読にする/);
		expect(inboxText).toMatch(/ゴミ箱へ/);
	});

	scenario("FR-17-3", "まとめて既読が複数スレッドに効く（API で確かめる）", async () => {
		// seedDomain が owner に割り当てを付けるので、先に owner を作る。
		const owner = await loginAsOwner(h);
		await seedDomain(h, { addresses: ["ai"] });
		for (let i = 0; i < 3; i++) {
			const raw = mime({
				from: `sender${i}@ext.example.jp`,
				to: "ai@mail.tsubame.test",
				subject: "Topic " + (i + 1),
				messageId: `fr17-read-${i}-${crypto.randomUUID()}@tsubame.test`,
				body: "本文です。",
			});
			await deliverEmail(h, { from: `sender${i}@ext.example.jp`, to: "ai@mail.tsubame.test", raw });
		}
		await drainQueues(h);
		const list = await owner.get("/api/v1/threads");
		expect(list.body.data.length).toBe(3);
		for (const t of list.body.data) expect(t.unreadCount).toBeGreaterThan(0);

		// UI の「既読にする」と同じ手順: 選んだ各会話の未読を 1 通ずつ読み済みに変える。
		for (const t of list.body.data) {
			const detail = await owner.get(`/api/v1/threads/${t.id}`);
			const unread = detail.body.messages.filter((m: { isRead: boolean }) => !m.isRead);
			for (const m of unread) {
				await owner.patch(`/api/v1/messages/${m.id}`, { isRead: true });
			}
		}

		const after = await owner.get("/api/v1/threads");
		for (const t of after.body.data) expect(t.unreadCount).toBe(0);
	});

	scenario("FR-17-3", "まとめてゴミ箱が複数スレッドを一覧から消す（API で確かめる）", async () => {
		// seedDomain が owner に割り当てを付けるので、先に owner を作る。
		const owner = await loginAsOwner(h);
		await seedDomain(h, { addresses: ["ai"] });
		for (let i = 0; i < 3; i++) {
			const raw = mime({
				from: `sender${i}@ext.example.jp`,
				to: "ai@mail.tsubame.test",
				subject: "Topic " + (i + 1),
				messageId: `fr17-trash-${i}-${crypto.randomUUID()}@tsubame.test`,
				body: "本文です。",
			});
			await deliverEmail(h, { from: `sender${i}@ext.example.jp`, to: "ai@mail.tsubame.test", raw });
		}
		await drainQueues(h);
		const list = await owner.get("/api/v1/threads");

		// UI の「ゴミ箱へ」と同じ手順: 各会話の最新 1 通をゴミ箱に移す。
		for (const t of list.body.data) {
			const detail = await owner.get(`/api/v1/threads/${t.id}`);
			const last = detail.body.messages.at(-1);
			await owner.patch(`/api/v1/messages/${last.id}`, { status: "trash" });
		}

		const inbox = await owner.get("/api/v1/threads");
		expect(inbox.body.data.length).toBe(0);
		const trash = await owner.get("/api/v1/threads?view=trash");
		expect(trash.body.data.length).toBe(3);
	});

	scenario("FR-17-1", "会話の URL に一覧の絞り込み（表示・メールボックス）を引き継ぐ", () => {
			expect(inboxText).toMatch(/rowParams\.set\("address"/);
			expect(inboxText).toMatch(/rowParams\.set\("view"/);
			expect(threadText).toMatch(/threadHref/);
			expect(threadText).toMatch(/new URLSearchParams\(searchParams\)/);
		});

		scenario("FR-17-1", "戻る・ゴミ箱へ・未読にするは保存した一覧へ戻る（通知から開いたら受信箱）", () => {
			expect(threadText).toContain('const backHref = store.loaded ? listHref(store.query) : "/";');
			expect(threadText).toMatch(/navigate\(backHref\)/);
			expect(threadText).toMatch(/to=\{backHref\}/);
		});
});
