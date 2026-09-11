import { describe, expect, it } from "vitest";
import ciYml from "../.github/workflows/ci.yml?raw";
import deployYml from "../.github/workflows/deploy.yml?raw";
import deploySh from "../scripts/deploy.sh?raw";
import wranglerJsonc from "../wrangler.jsonc?raw";

const SHA40 = /^[0-9a-f]{40}$/;
const USES_LINE = /^\s*uses:\s*(\S+)/gm;

function usesRefs(yaml: string): string[] {
	const refs = [];
	for (const m of yaml.matchAll(USES_LINE)) refs.push(m[1]!);
	return refs;
}

function stripJsonc(text: string): string {
	let out = "";
	let inS = false, line = false, block = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!, nx = text[i + 1];
		if (line) { if (ch === "\n") { line = false; out += ch; } continue; }
		if (block) { if (ch === "*" && nx === "/") { block = false; i++; } continue; }
		if (inS) {
			out += ch;
			if (ch === "\\") { out += nx ?? ""; i++; }
			else if (ch === '"') inS = false;
			continue;
		}
		if (ch === '"') { inS = true; out += ch; continue; }
		if (ch === "/" && nx === "/") { line = true; i++; continue; }
		if (ch === "/" && nx === "*") { block = true; i++; continue; }
		out += ch;
	}
	return out;
}

type WranglerQueueCfg = {
	queues: { consumers: { queue: string; dead_letter_queue?: string }[] };
};

describe("CI とデプロイ設定の回帰（#45 / #46 / キュー DLQ）", () => {
	it("workflow の uses: がすべて 40 桁の SHA で固定されている", () => {
		for (const [name, yml] of [
			["ci.yml", ciYml],
			["deploy.yml", deployYml],
		] as const) {
			const refs = usesRefs(yml);
			expect(refs).not.toHaveLength(0);
			for (const ref of refs) {
				const sha = ref.split("@")[1] ?? "";
				expect(SHA40.test(sha), `${name}: ${ref}`).toBe(true);
			}
		}
	});

	it("deploy.sh が D1_DATABASE_ID の UUID 形式（^[0-9a-f-]{36}$）を検査している", () => {
		expect(deploySh).toMatch(/\^\[0-9a-f-\]\{36\}\$/);
	});

	it("wrangler.jsonc の tsubame-inbound / tsubame-outbound の両 consumer に dead_letter_queue がある", () => {
		const cfg = JSON.parse(stripJsonc(wranglerJsonc)) as WranglerQueueCfg;
		const consumers = cfg.queues.consumers;
		expect(consumers).toBeTruthy();
		for (const name of ["tsubame-inbound", "tsubame-outbound"]) {
			const c = consumers.find((x) => x.queue === name);
			expect(c).toBeTruthy();
			expect(c!.dead_letter_queue, name).toBeTruthy();
		}
	});
});
