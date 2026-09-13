import { describe, expect, it } from "vitest";
import wranglerJsonc from "../wrangler.jsonc?raw";
import { emailWorkerName } from "@/domain/domains/provision";

/**
 * wrangler.jsonc は JSONC（// 行コメント付き JSON）。文字列内の // まで消さないよう、
 * 文字列リテラルの外にあるコメントだけを 1 文字ずつ見て取り除く。
 */
function stripJsonc(text: string): string {
	let out = "";
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		const next = text[i + 1];

		if (inLineComment) {
			if (ch === "\n") {
				inLineComment = false;
				out += ch;
			}
			continue;
		}
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += next ?? "";
				i++;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		out += ch;
	}
	return out;
}

function parseWranglerJsonc(text: string): {
	name: string;
	vars: Record<string, unknown>;
	env?: Record<string, { name?: string; vars?: Record<string, unknown> }>;
} {
	return JSON.parse(stripJsonc(text));
}

describe("stripJsonc", () => {
	it("文字列中の // は消さず、行コメントとブロックコメントだけ消す", () => {
		const src = [
			'{',
			'  // comment',
			'  "a": "not // a comment",',
			'  "b": 1, /* block */ "c": 2',
			'}',
		].join("\n");
		expect(JSON.parse(stripJsonc(src))).toEqual({ a: "not // a comment", b: 1, c: 2 });
	});
});

describe("wrangler.jsonc の Worker 名", () => {
	it("name と vars.EMAIL_WORKER_NAME が一致する（落とし穴 #2）", () => {
		const config = parseWranglerJsonc(wranglerJsonc);
		expect(config.name).toBeTruthy();
		expect(config.vars.EMAIL_WORKER_NAME).toBe(config.name);
	});

	it("env.* がある場合は各 env の EMAIL_WORKER_NAME がその env の Worker 名と一致する", () => {
		const config = parseWranglerJsonc(wranglerJsonc);
		for (const [key, environment] of Object.entries(config.env ?? {})) {
			// wrangler は env の name を省くと `<name>-<env>` で別の Worker を作り、vars は継承しない。
			const workerName = environment.name ?? `${config.name}-${key}`;
			expect(environment.vars?.EMAIL_WORKER_NAME).toBe(workerName);
		}
	});

	it("ずれていれば検出できる（このテスト自体の健全性確認）", () => {
		const drifted = parseWranglerJsonc(
			wranglerJsonc.replace(/"EMAIL_WORKER_NAME":\s*"[^"]+"/, '"EMAIL_WORKER_NAME": "other-worker"'),
		);
		expect(drifted.vars.EMAIL_WORKER_NAME).not.toBe(drifted.name);
	});

	// 既定値に落ちると、Worker 名の違う環境（ステージング）で本番宛の
	// Email Routing ルールを作ってしまい、本番の受信に混ざる。
	it("EMAIL_WORKER_NAME が無ければ例外にする（既定値へ落とさない）", () => {
		expect(() => emailWorkerName({} as Parameters<typeof emailWorkerName>[0])).toThrow(
			/EMAIL_WORKER_NAME/,
		);
		expect(() =>
			emailWorkerName({ EMAIL_WORKER_NAME: "  " } as Parameters<typeof emailWorkerName>[0]),
		).toThrow(/EMAIL_WORKER_NAME/);
		expect(
			emailWorkerName({ EMAIL_WORKER_NAME: "tsubame-staging" } as Parameters<
				typeof emailWorkerName
			>[0]),
		).toBe("tsubame-staging");
	});
});
