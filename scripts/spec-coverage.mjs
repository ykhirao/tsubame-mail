#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = join(root, "docs/spec/requirements.md");
const E2E_DIR = join(root, "e2e");

function readRequirements() {
	const text = readFileSync(SPEC, "utf8");
	const out = [];
	const re = /^###\s+(FR-\d+)\s+(.+)$/gm;
	let m;
	while ((m = re.exec(text)) !== null) {
		out.push({ id: m[1], title: m[2].trim() });
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

function readScenarios() {
	const found = [];
	for (const file of walk(E2E_DIR)) {
		const text = readFileSync(file, "utf8");
		const re = /scenario\(\s*(\[[^\]]*\]|"[^"]*"|'[^']*')\s*,\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
		let m;
		while ((m = re.exec(text)) !== null) {
			const ids = [...m[1].matchAll(/FR-\d+/g)].map((x) => x[0]);
			const name = m[2] ?? m[3] ?? m[4] ?? "";
			if (ids.length === 0) {
				found.push({ ids: [], name, file, invalid: true });
				continue;
			}
			found.push({ ids, name, file });
		}
	}
	return found;
}

const requirements = readRequirements();
const scenarios = readScenarios();

const byId = new Map(requirements.map((r) => [r.id, []]));
const unknown = [];
for (const s of scenarios) {
	for (const id of s.ids) {
		if (byId.has(id)) byId.get(id).push(s);
		else unknown.push({ id, name: s.name, file: s.file });
	}
}

const uncovered = requirements.filter((r) => byId.get(r.id).length === 0);
const invalid = scenarios.filter((s) => s.invalid);

if (process.argv.includes("--json")) {
	console.log(
		JSON.stringify(
			{
				requirements: requirements.map((r) => ({
					...r,
					scenarios: byId.get(r.id).map((s) => s.name),
				})),
				uncovered: uncovered.map((r) => r.id),
				unknown,
			},
			null,
			2,
		),
	);
} else {
	console.log("要件と e2e の対応\n");
	for (const r of requirements) {
		const list = byId.get(r.id);
		const mark = list.length > 0 ? "OK " : "未 ";
		console.log(`${mark} ${r.id} ${r.title}  (${list.length} 件)`);
		for (const s of list) console.log(`        - ${s.name}`);
	}
	if (unknown.length > 0) {
		console.log("\n要件に無い ID を指しているシナリオ:");
		for (const u of unknown) console.log(`  ${u.id} ${u.name} (${u.file})`);
	}
	if (invalid.length > 0) {
		console.log("\n要件 ID を書いていないシナリオ:");
		for (const s of invalid) console.log(`  ${s.name} (${s.file})`);
	}
	if (uncovered.length > 0) {
		console.log(`\ne2e が無い要件が ${uncovered.length} 件あります:`);
		for (const r of uncovered) {
			console.log(`  ${r.id} ${r.title}`);
			console.log(`      雛形を作る: npm run e2e:new ${r.id}`);
		}
	}
}

const failed = uncovered.length > 0 || unknown.length > 0 || invalid.length > 0;
process.exit(failed ? 1 : 0);
