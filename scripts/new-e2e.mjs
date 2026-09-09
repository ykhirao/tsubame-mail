#!/usr/bin/env node
// 使い方: npm run e2e:new FR-5
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const id = (process.argv[2] ?? "").toUpperCase();

if (!/^FR-\d+$/.test(id)) {
	console.error("使い方: npm run e2e:new FR-5");
	process.exit(1);
}

const spec = readFileSync(join(root, "docs/spec/requirements.md"), "utf8");
const section = new RegExp(`^###\\s+${id}\\s+(.+?)$([\\s\\S]*?)(?=^###\\s|^##\\s|\\Z)`, "m").exec(spec);
if (!section) {
	console.error(`${id} が docs/spec/requirements.md に見つかりません。`);
	process.exit(1);
}

const title = section[1].trim();
const bodyLines = section[2].split("\n");

const bullets = [];
for (const line of bodyLines) {
	if (/^\s*-\s+/.test(line)) bullets.push(line.replace(/^\s*-\s+/, "").trim());
	else if (bullets.length > 0 && /^\s+\S/.test(line)) bullets[bullets.length - 1] += " " + line.trim();
}

const clean = (s) =>
	s
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();

const num = id.split("-")[1].padStart(2, "0");
const slug = title
	.replace(/[（(].*?[）)]/g, "")
	.trim()
	.replace(/[^\p{L}\p{N}]+/gu, "-")
	.toLowerCase()
	.replace(/^-|-$/g, "");
const file = join(root, `e2e/specs/fr${num}-${slug || "spec"}.e2e.test.ts`);

if (existsSync(file)) {
	console.error(`${file} は既にあります。追記して育ててください。`);
	process.exit(1);
}

const scenarios = (bullets.length > 0 ? bullets : ["（要件の本文を読んでシナリオを書く）"])
	.map((b) => {
		const name = clean(b);
		const short = name.length > 60 ? name.slice(0, 58) + "…" : name;
		return `	scenario("${id}", ${JSON.stringify(short)}, async () => {
		// 要件: ${name}
		// TODO: 実装する。h / owner / seedDomain / deliverEmail / drainQueues が使える。
		expect.fail("未実装");
	});`;
	})
	.join("\n\n");

const content = `import { beforeEach, describe, expect } from "vitest";
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

/**
 * ${id} ${title}
 *
 * 雛形は \`npm run e2e:new ${id}\` が docs/spec/requirements.md から生成した。
 * 要件の文面をそのままシナリオ名にしてある。中身を埋めること。
 */
describe("${id} ${title}", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		void owner;
	});

${scenarios}
});

void deliverEmail;
void drainQueues;
void mime;
void seedDomain;
`;

writeFileSync(file, content);
console.log(`作成: ${file.replace(root + "/", "")}`);
console.log(`シナリオ ${bullets.length} 件の雛形を要件から起こしました。中身を実装してください。`);
