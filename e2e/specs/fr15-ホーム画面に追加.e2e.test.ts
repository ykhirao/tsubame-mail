import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { dismissInstallBanner, shouldShowInstallBanner, trackInstallVisit } from "@/ui/lib/pwa";
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

const useIsMobileText = rawBySuffix(
	import.meta.glob("../../src/ui/lib/useIsMobile.ts", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
	"useIsMobile.ts",
);

const routeModules = import.meta.glob("../../src/ui/routes/*.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;
function routeSource(name: string): string {
	const entry = Object.entries(routeModules).find(([k]) => k.endsWith(`/${name}.tsx`));
	if (!entry) throw new Error(`not found in glob: ${name}.tsx`);
	return entry[1];
}

const DISMISS_KEY = "tsubame-install-dismissed-at";

// pwa.ts は window / navigator / localStorage を読むが workerd には window が無いので、
// vi.stubGlobal で差し替える。matchMedia は standalone の判定だけに効かせ、幅は innerWidth で扱う。
function stubPwaGlobals(opts: { innerWidth?: number; standalone?: boolean } = {}): Map<string, string> {
	const storage = new Map<string, string>();
	vi.stubGlobal("window", {
		innerWidth: opts.innerWidth ?? 390,
		matchMedia: (query: string) => ({
			matches: query === "(display-mode: standalone)" && (opts.standalone ?? false),
		}),
		addEventListener: () => {},
	});
	vi.stubGlobal("navigator", { standalone: false, userAgent: "Mozilla/5.0" });
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => {
			storage.set(k, v);
		},
	});
	return storage;
}

function visitThreeTimes(): void {
	trackInstallVisit();
	trackInstallVisit();
	trackInstallVisit();
}

describe("FR-15 ホーム画面に追加（PWA）", () => {
	let h: Harness;
	let owner: Client;

	beforeEach(async () => {
		h = await freshHarness();
		owner = await loginAsOwner(h);
		void owner;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	scenario("FR-15-1", "manifest に名前・起動の形・192/512/maskable のアイコンが揃っている", async () => {
		const manifest = JSON.parse(manifestText) as {
			name: string;
			short_name: string;
			start_url: string;
			display: string;
			icons: { sizes: string; purpose?: string }[];
		};
		expect(manifest.name).toBe("Tsubamail");
		expect(manifest.short_name).toBe("Tsubamail");
		expect(manifest.start_url).toBe("/?source=pwa");
		expect(manifest.display).toBe("standalone");
		const sizes = manifest.icons.map((i) => i.sizes);
		expect(sizes).toContain("192x192");
		expect(sizes).toContain("512x512");
		expect(manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
	});

	scenario("FR-15-5", "manifest に share_target があり、作成画面へ件名と本文を渡す", async () => {
	const manifest = JSON.parse(manifestText) as {
		share_target: {
			action: string;
			method: string;
			params: { title: string; text: string; url: string };
		};
	};
	expect(manifest.share_target.action).toBe("/compose");
	expect(manifest.share_target.method).toBe("GET");
	expect(manifest.share_target.params.title).toBe("subject");
	expect(manifest.share_target.params.text).toBe("body");
	expect(manifest.share_target.params.url).toBe("url");
});

scenario(["FR-15-1", "FR-15-3"], "Service Worker は /api/ をキャッシュせず、/sw.js をハッシュなしで出す", async () => {
		// sw.ts の fetch ハンドラは /api/ のリクエストをキャッシュせず素通しする。
		expect(swText).toMatch(/startsWith\("\/api\/"\)/);
		expect(swText).toMatch(/SHELL_ROOTS/);
		// vite.config.ts が別エントリとして sw を /sw.js（ハッシュなし）に出す。
		expect(viteConfigText).toContain('"sw.js"');
		expect(viteConfigText).toContain('entryFileNames');
		expect(viteConfigText).toMatch(/chunk\.name === "sw"/);
	});

	scenario("FR-15-1", "_headers で sw.js と manifest を no-cache で配る", async () => {
		expect(headersText).toMatch(/\/sw\.js([\s\S]*?)Cache-Control: no-cache/);
		expect(headersText).toMatch(/\/manifest\.webmanifest([\s\S]*?)Cache-Control: no-cache/);
	});

	scenario("FR-15-2", "useIsMobile は 767px 以下のスマホ幅で真になる", async () => {
		expect(useIsMobileText).toContain('matchMedia("(max-width: 767px)")');
	});

	scenario("FR-15-2", "主要な画面が useIsMobile でスマホ用の配置に切り替える", async () => {
		for (const name of ["AppLayout", "Inbox", "ThreadDetail", "Compose", "Search"]) {
			expect(routeSource(name)).toContain("useIsMobile");
		}
	});

	scenario("FR-15-4", "追加の案内はスマホ・未追加・3 回目以降の訪問のときだけ出す", async () => {
		stubPwaGlobals({ innerWidth: 390, standalone: false });
		// 1・2 回目は出さない。3 回目で出る。
		trackInstallVisit();
		expect(shouldShowInstallBanner()).toBe(false);
		trackInstallVisit();
		expect(shouldShowInstallBanner()).toBe(false);
		trackInstallVisit();
		expect(shouldShowInstallBanner()).toBe(true);
	});

	scenario("FR-15-4", "案内を閉じたら 30 日は出さず、31 日後にはまた出す", async () => {
		const storage = stubPwaGlobals({ innerWidth: 390, standalone: false });
		visitThreeTimes();
		expect(shouldShowInstallBanner()).toBe(true);

		dismissInstallBanner();
		expect(shouldShowInstallBanner()).toBe(false);

		// 31 日前に閉じたことにして、30 日が過ぎたら出す。
		storage.set(DISMISS_KEY, String(Date.now() - 31 * 86_400_000));
		expect(shouldShowInstallBanner()).toBe(true);
	});

	scenario("FR-15-4", "追加済み（standalone）や PC 幅では案内を出さない", async () => {
		// standalone で開いているときは出さない。
		stubPwaGlobals({ innerWidth: 390, standalone: true });
		visitThreeTimes();
		expect(shouldShowInstallBanner()).toBe(false);

		// PC 幅（768px 以上）では 3 回目以降でも出さない。
		stubPwaGlobals({ innerWidth: 1024, standalone: false });
		visitThreeTimes();
		expect(shouldShowInstallBanner()).toBe(false);
	});
});
