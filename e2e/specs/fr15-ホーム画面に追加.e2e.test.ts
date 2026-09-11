import { beforeEach, describe, expect } from "vitest";
import { scenario } from "../registry";
import { freshHarness, loginAsOwner, type Client, type Harness } from "../harness";

// worker ランタイムでは node:fs で実ファイルを読めない。Vite の ?raw glob で
// ビルド時にソースを文字列として取り込む（fr09-ui.e2e.test.ts と同じ流儀）。
// 拡張子の無い _headers は exact 指定だと取り込めないため、キーの末尾で選ぶ。
function rawBySuffix(modules: Record<string, string>, suffix: string): string {
	const entry = Object.entries(modules).find(([k]) => k.endsWith(suffix));
	if (!entry) throw new Error(`not found in glob: ${suffix}`);
	return entry[1];
}

const manifestText = rawBySuffix(
	import.meta.glob("../../public/manifest.webmanifest", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
	"manifest.webmanifest",
);

const headersText = rawBySuffix(
	import.meta.glob("../../public/_*", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
	"_headers",
);

const swText = rawBySuffix(
	import.meta.glob("../../src/ui/sw.ts", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
	"sw.ts",
);

const viteConfigText = rawBySuffix(
	import.meta.glob("../../vite.config.ts", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
	"vite.config.ts",
);

describe("FR-15 ホーム画面に追加（PWA）", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		void owner;
	});

	scenario("FR-15", "manifest に名前・起動の形・192/512/maskable のアイコンが揃っている", async () => {
		const manifest = JSON.parse(manifestText) as {
			name: string;
			short_name: string;
			start_url: string;
			display: string;
			icons: { sizes: string; purpose?: string }[];
		};
		expect(manifest.name).toBe("Tsubame Mail");
		expect(manifest.short_name).toBe("Tsubame");
		expect(manifest.start_url).toBe("/?source=pwa");
		expect(manifest.display).toBe("standalone");
		const sizes = manifest.icons.map((i) => i.sizes);
		expect(sizes).toContain("192x192");
		expect(sizes).toContain("512x512");
		expect(manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
	});

	scenario("FR-15", "Service Worker は /api/ をキャッシュせず、/sw.js をハッシュなしで出す", async () => {
		// sw.ts の fetch ハンドラは /api/ のリクエストをキャッシュせず素通しする。
		expect(swText).toMatch(/startsWith\("\/api\/"\)/);
		expect(swText).toMatch(/SHELL_ROOTS/);
		// vite.config.ts が別エントリとして sw を /sw.js（ハッシュなし）に出す。
		expect(viteConfigText).toContain('"sw.js"');
		expect(viteConfigText).toContain('entryFileNames');
		expect(viteConfigText).toMatch(/chunk\.name === "sw"/);
	});

	scenario("FR-15", "_headers で sw.js と manifest を no-cache で配る", async () => {
		expect(headersText).toMatch(/\/sw\.js([\s\S]*?)Cache-Control: no-cache/);
		expect(headersText).toMatch(/\/manifest\.webmanifest([\s\S]*?)Cache-Control: no-cache/);
	});
});
