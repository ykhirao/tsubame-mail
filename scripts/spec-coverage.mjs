#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = join(root, "docs/spec/requirements.md");
const E2E_DIR = join(root, "e2e");
const UNTESTABLE = join(E2E_DIR, "untestable.ts");

const SHORT_LEN = 60;

export function cleanMarkdown(s) {
	return s
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function shorten(s) {
	return s.length > SHORT_LEN ? s.slice(0, SHORT_LEN - 1) + "…" : s;
}

/**
 * `### FR-n` の節ごとに、トップレベルの箇条書き（行頭の `- `）を出現順に FR-n-1, FR-n-2… と数える。
 * 続きのインデント行はその箇条書きの一部。番号は文書に書かず、ここで数えたものが ID になる。
 */
export function readRequirements(text = readFileSync(SPEC, "utf8")) {
	const out = [];
	let current = null;
	for (const line of text.split("\n")) {
		const heading = /^###\s+(FR-\d+)\s+(.+)$/.exec(line);
		if (heading) {
			current = { id: heading[1], title: heading[2].trim(), bullets: [] };
			out.push(current);
			continue;
		}
		if (/^##\s/.test(line)) {
			current = null;
			continue;
		}
		if (!current) continue;
		if (/^- /.test(line)) {
			current.bullets.push({ raw: line.replace(/^- /, "").trim() });
		} else if (current.bullets.length > 0 && /^\s+\S/.test(line)) {
			current.bullets[current.bullets.length - 1].raw += " " + line.trim();
		}
	}
	for (const r of out) {
		r.bullets = r.bullets.map((b, i) => {
			const text = cleanMarkdown(b.raw);
			return { id: `${r.id}-${i + 1}`, text, short: shorten(text) };
		});
	}
	return out;
}

function walk(dir) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) files.push(...walk(p));
		else if (p.endsWith(".ts")) files.push(p);
	}
	return files;
}

const STRING_LITERAL = String.raw`"[^"]*"|'[^']*'|` + "`[^`]*`";

function unquote(s) {
	return s.slice(1, -1);
}

function readScenarios() {
	const found = [];
	for (const file of walk(E2E_DIR)) {
		const text = readFileSync(file, "utf8");
		const re = new RegExp(String.raw`scenario\(\s*(\[[^\]]*\]|${STRING_LITERAL})\s*,\s*(${STRING_LITERAL})`, "g");
		let m;
		while ((m = re.exec(text)) !== null) {
			const ids = [...m[1].matchAll(/FR-\d+(?:-\d+)?/g)].map((x) => x[0]);
			found.push({ ids, name: unquote(m[2]), file: relative(root, file) });
		}
	}
	return found;
}

function readUntestable() {
	if (!existsSync(UNTESTABLE)) return { entries: [], invalid: [] };
	const text = readFileSync(UNTESTABLE, "utf8");
	const entries = [];
	const matched = new Set();
	const strict = new RegExp(String.raw`untestable\(\s*"(FR-\d+-\d+)"\s*,\s*(${STRING_LITERAL})\s*\)`, "g");
	let m;
	while ((m = strict.exec(text)) !== null) {
		matched.add(m.index);
		entries.push({ id: m[1], reason: unquote(m[2]) });
	}
	// リテラル以外（変数・テンプレート・配列）で書かれた呼び出しは走査できないので落とす。
	const invalid = [];
	const loose = /(?<!function )untestable\(/g;
	while ((m = loose.exec(text)) !== null) {
		if (matched.has(m.index)) continue;
		invalid.push({ text: text.slice(m.index, m.index + 60).replace(/\s+/g, " "), file: relative(root, UNTESTABLE) });
	}
	return { entries, invalid };
}

export function evaluate({ requirements, scenarios, untestable }) {
	const bullets = new Map();
	const headings = new Set();
	for (const r of requirements) {
		headings.add(r.id);
		for (const b of r.bullets) bullets.set(b.id, { ...b, scenarios: [], untestable: null });
	}

	const unknown = [];
	const legacy = [];
	const noId = [];
	for (const s of scenarios) {
		if (s.ids.length === 0) {
			noId.push(s);
			continue;
		}
		for (const id of s.ids) {
			const b = bullets.get(id);
			if (b) b.scenarios.push(s);
			else if (headings.has(id)) legacy.push({ id, name: s.name, file: s.file });
			else unknown.push({ id, name: s.name, file: s.file });
		}
	}

	const duplicateUntestable = [];
	for (const u of untestable.entries) {
		const b = bullets.get(u.id);
		if (!b) {
			unknown.push({ id: u.id, name: `untestable: ${u.reason}`, file: relative(root, UNTESTABLE) });
			continue;
		}
		if (b.untestable !== null) duplicateUntestable.push(u.id);
		b.untestable = u.reason;
	}

	const all = [...bullets.values()];
	const uncovered = all.filter((b) => b.scenarios.length === 0 && b.untestable === null);
	// untestable に載せた箇条書きに scenario もあるなら、どちらかが嘘。載せた理由を疑う。
	const contradicted = all.filter((b) => b.scenarios.length > 0 && b.untestable !== null);

	return {
		bullets,
		uncovered,
		contradicted,
		unknown,
		legacy,
		noId,
		invalidUntestable: untestable.invalid,
		duplicateUntestable,
	};
}

function isMain() {
	return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
	const requirements = readRequirements();
	const scenarios = readScenarios();
	const untestable = readUntestable();
	const result = evaluate({ requirements, scenarios, untestable });
	const { bullets, uncovered, contradicted, unknown, legacy, noId, invalidUntestable, duplicateUntestable } = result;

	const failed =
		uncovered.length > 0 ||
		contradicted.length > 0 ||
		unknown.length > 0 ||
		legacy.length > 0 ||
		noId.length > 0 ||
		invalidUntestable.length > 0 ||
		duplicateUntestable.length > 0;

	const total = bullets.size;
	const untestableCount = [...bullets.values()].filter((b) => b.untestable !== null).length;
	const coveredCount = [...bullets.values()].filter((b) => b.scenarios.length > 0).length;

	if (process.argv.includes("--json")) {
		console.log(
			JSON.stringify(
				{
					summary: { bullets: total, covered: coveredCount, untestable: untestableCount, uncovered: uncovered.length },
					requirements: requirements.map((r) => {
						const rows = r.bullets.map((b) => bullets.get(b.id));
						return {
							id: r.id,
							title: r.title,
							bullets: rows.map((b) => ({
								id: b.id,
								text: b.text,
								short: b.short,
								scenarios: b.scenarios.map((s) => s.name),
								untestable: b.untestable,
							})),
							// FR 単位の一覧（docs のビルドが見出しの直後に差し込む）。
							scenarios: [...new Set(rows.flatMap((b) => b.scenarios.map((s) => s.name)))],
						};
					}),
					uncovered: uncovered.map((b) => ({ id: b.id, text: b.text })),
					contradicted: contradicted.map((b) => b.id),
					unknown,
					legacy,
					noId: noId.map((s) => ({ name: s.name, file: s.file })),
					invalidUntestable,
					duplicateUntestable,
				},
				null,
				2,
			),
		);
	} else {
		console.log("要件の箇条書きと e2e の対応\n");
		for (const r of requirements) {
			console.log(`${r.id} ${r.title}`);
			for (const { id } of r.bullets) {
				const b = bullets.get(id);
				if (b.scenarios.length > 0) {
					console.log(`  OK ${id} ${b.short}  (${b.scenarios.length} 件)`);
					for (const s of b.scenarios) console.log(`        - ${s.name}`);
				} else if (b.untestable !== null) {
					console.log(`  -- ${id} ${b.short}`);
					console.log(`        e2e 対象外: ${b.untestable}`);
				} else {
					console.log(`  未 ${id} ${b.short}`);
				}
			}
			console.log("");
		}
		console.log(
			`箇条書き ${total} 件: e2e あり ${coveredCount}、e2e 対象外 ${untestableCount}、未カバー ${uncovered.length}`,
		);
		if (legacy.length > 0) {
			console.log("\nFR 見出しだけの古い ID を指しているシナリオ（FR-5-3 のように箇条書きまで書く）:");
			for (const u of legacy) console.log(`  ${u.id} ${u.name} (${u.file})`);
		}
		if (unknown.length > 0) {
			console.log("\n要件に無い ID を指しているもの:");
			for (const u of unknown) console.log(`  ${u.id} ${u.name} (${u.file})`);
		}
		if (noId.length > 0) {
			console.log("\n要件 ID を書いていないシナリオ:");
			for (const s of noId) console.log(`  ${s.name} (${s.file})`);
		}
		if (invalidUntestable.length > 0) {
			console.log('\nuntestable の引数がリテラルではありません（untestable("FR-9-1", "理由") の形で書く）:');
			for (const u of invalidUntestable) console.log(`  ${u.text} (${u.file})`);
		}
		if (duplicateUntestable.length > 0) {
			console.log("\nuntestable に二重に載っている ID:");
			for (const id of duplicateUntestable) console.log(`  ${id}`);
		}
		if (contradicted.length > 0) {
			console.log("\nuntestable に載っているのに scenario がある箇条書き（untestable から外す）:");
			for (const b of contradicted) console.log(`  ${b.id} ${b.short}`);
		}
		if (uncovered.length > 0) {
			console.log(`\ne2e が無い箇条書きが ${uncovered.length} 件あります:`);
			for (const b of uncovered) {
				console.log(`  ${b.id} ${b.text}`);
				console.log(`      雛形を作る: npm run e2e:new ${b.id}`);
			}
		}
	}

	// process.exit だとパイプ先への書き込みが途中で切れる（--json を読む側が壊れる）。
	process.exitCode = failed ? 1 : 0;
}
