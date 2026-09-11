import { describe, expect, it } from "vitest";
import journalRaw from "../migrations/meta/_journal.json?raw";

// Vite の glob で migrations/*.sql をファイル名ごとに列挙する。値は使わず、ファイル一覧だけ必要。
const sqlFiles = import.meta.glob("../migrations/*.sql", {
	query: "?raw",
	import: "default",
	eager: true,
});

function baseName(path: string): string {
	return path.split("/").pop()!.replace(/\.sql$/, "");
}

describe("migrations/meta/_journal.json", () => {
	it("entries の tag が migrations/*.sql のファイル名と 1 対 1 で一致する", () => {
		const journal = JSON.parse(journalRaw) as { entries: { idx: number; tag: string }[] };
		const expectedTags = Object.keys(sqlFiles).map(baseName).sort();
		const actualTags = journal.entries.map((e) => e.tag).sort();
		expect(actualTags).toEqual(expectedTags);
		expect(actualTags).not.toHaveLength(0);
	});

	it("idx が 0 から連番で並び、手書き分と衝突しない", () => {
		const journal = JSON.parse(journalRaw) as { entries: { idx: number; tag: string }[] };
		journal.entries.forEach((e, i) => expect(e.idx).toBe(i));
		const fileTags = Object.keys(sqlFiles).map(baseName);
		expect(journal.entries.map((e) => e.tag).sort()).toEqual([...fileTags].sort());
	});
});
