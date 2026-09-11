import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "node:path";
import fs from "node:fs";

export default defineConfig({
	plugins: [react(), tailwind(), assertSw()],
	resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
	build: {
		outDir: "dist/client",
		emptyOutDir: true,
		rollupOptions: {
			// sw.ts は assets のハッシュ名にすると登録 URL が固定できず、更新が届かない。
			input: {
				app: path.resolve(import.meta.dirname, "index.html"),
				sw: path.resolve(import.meta.dirname, "src/ui/sw.ts"),
			},
			output: {
				entryFileNames: (chunk) =>
					chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
			},
		},
	},
	server: {
		proxy: { "/api": "http://127.0.0.1:8787" },
	},
});

// not_found_handling: single-page-application の Worker は sw.js が無いと
// ナビゲーションが index.html を返して登録が壊れるため、確実に生成させる。
function assertSw(): Plugin {
	let outDir = "";
	return {
		name: "assert-sw",
		configResolved(config) {
			outDir = path.resolve(config.build.outDir);
		},
		closeBundle() {
			if (!fs.existsSync(path.join(outDir, "sw.js"))) {
				this.error("dist/client/sw.js がありません。Service Worker のビルドに失敗しています。");
			}
		},
	};
}
