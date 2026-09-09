#!/usr/bin/env node
// 使い方: node scripts/spec-drift.mjs <比較元>
// 逃げ道: コミットメッセージに [no-spec] を入れる。
import { execSync } from "node:child_process";

const base = process.argv[2] ?? defaultBase();

function sh(cmd) {
	return execSync(cmd, { encoding: "utf8" }).trim();
}

function defaultBase() {
	// 履歴を共有している ref だけを使う。このリポジトリの main は
	// 書き直す前の別系統なので、共通の祖先が無ければ 1 つ前のコミットを見る。
	for (const ref of ["origin/main", "main"]) {
		try {
			sh(`git rev-parse --verify ${ref}`);
			sh(`git merge-base ${ref} HEAD`);
			return ref;
		} catch {
		}
	}
	return "HEAD~1";
}

let changed = [];
try {
	changed = sh(`git diff --name-only ${base}...HEAD`).split("\n").filter(Boolean);
} catch {
	console.error(`比較元 ${base} と比べられません。`);
	process.exit(0);
}

if (changed.length === 0) {
	console.log("変更がありません。");
	process.exit(0);
}

const messages = sh(`git log --format=%B ${base}..HEAD`);
if (messages.includes("[no-spec]")) {
	console.log("[no-spec] が付いているので仕様の確認をとばします。");
	process.exit(0);
}

const behaviour = changed.filter(
	(f) =>
		(f.startsWith("src/api/") ||
			f.startsWith("src/domain/") ||
			f.startsWith("src/services/") ||
			f.startsWith("src/db/schema.ts")) &&
		!f.endsWith(".d.ts"),
);

const spec = changed.filter((f) => f === "docs/spec/requirements.md" || f.startsWith("e2e/"));

if (behaviour.length === 0) {
	console.log("振る舞いに関わる変更はありません。");
	process.exit(0);
}

console.log(`振る舞いに関わる変更 ${behaviour.length} 件:`);
for (const f of behaviour.slice(0, 20)) console.log(`  ${f}`);

if (spec.length > 0) {
	console.log(`\n仕様・e2e も更新されています（${spec.length} 件）。`);
	process.exit(0);
}

console.log(`
仕様も e2e も触られていません。

  docs/spec/requirements.md に何を実現するのかを書き、
  npm run e2e:new FR-<番号> で e2e を起こしてください。

意図的に仕様が変わらない変更（リファクタ・バグ修正）なら、
コミットメッセージに [no-spec] を入れてください。`);
process.exit(1);
