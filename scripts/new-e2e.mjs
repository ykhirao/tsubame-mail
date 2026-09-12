#!/usr/bin/env node
// 使い方: npm run e2e:new FR-5      （FR-5 の全箇条書きの雛形を新しいファイルに起こす）
//         npm run e2e:new FR-5-3    （箇条書き 1 つ分の雛形を出す。ファイルがあれば標準出力に出す）
import { writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readRequirements } from "./spec-coverage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (process.argv[2] ?? "").toUpperCase();
const parsed = /^(FR-\d+)(?:-(\d+))?$/.exec(arg);

if (!parsed) {
	console.error("使い方: npm run e2e:new FR-5   または   npm run e2e:new FR-5-3");
	process.exit(1);
}

const [, frId, bulletNo] = parsed;
const requirement = readRequirements().find((r) => r.id === frId);
if (!requirement) {
	console.error(`${frId} が docs/spec/requirements.md に見つかりません。`);
	process.exit(1);
}

let bullets = requirement.bullets;
if (bulletNo !== undefined) {
	const one = bullets.find((b) => b.id === arg);
	if (!one) {
		console.error(`${arg} はありません（${frId} の箇条書きは ${bullets.length} 件: ${frId}-1〜${frId}-${bullets.length}）。`);
		process.exit(1);
	}
	bullets = [one];
}

const num = frId.split("-")[1].padStart(2, "0");
const slug = requirement.title
	.replace(/[（(].*?[）)]/g, "")
	.trim()
	.replace(/[^\p{L}\p{N}]+/gu, "-")
	.toLowerCase()
	.replace(/^-|-$/g, "");
const file = join(root, `e2e/specs/fr${num}-${slug || "spec"}.e2e.test.ts`);

const scenarios = (bullets.length > 0 ? bullets : [{ id: `${frId}-1`, text: "（要件の本文を読んでシナリオを書く）", short: "" }])
	.map((b) => {
		const short = b.short || b.text;
		return `	scenario("${b.id}", ${JSON.stringify(short)}, async () => {
		// 要件: ${b.text}
		// TODO: 実装する。h / owner / seedDomain / deliverEmail / drainQueues が使える。
		expect.fail("未実装");
	});`;
	})
	.join("\n\n");

if (existsSync(file)) {
	if (bulletNo === undefined) {
		console.error(`${file.replace(root + "/", "")} は既にあります。箇条書きを 1 つ指定すると雛形だけ出します: npm run e2e:new ${frId}-1`);
		process.exit(1);
	}
	console.log(`${file.replace(root + "/", "")} は既にあります。次を describe の中に足してください:\n`);
	console.log(scenarios);
	process.exit(0);
}

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

describe("${frId} ${requirement.title}", () => {
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
console.log(`シナリオ ${bullets.length} 件の雛形を要件の箇条書きから起こしました。中身を実装してください。`);
