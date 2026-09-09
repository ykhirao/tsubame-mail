import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";

// migrations/ の SQL を読んでバインディングで渡す。tests/setup.ts が env.DB に流す。
// スキーマを二重管理しないため、テストも本番と同じマイグレーションを使う。
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },

			miniflare: {
				bindings: {
					TEST_MIGRATIONS: migrations,
					// テストで最初のオーナーを作れるようにする。本番は Worker Secret に 1 件だけ入れる。
					// 最初のオーナーを作るときの合言葉。本番は 20 文字以上の乱数を Worker Secret に入れる。
					INTERNAL_SECRET: "test-internal-secret-0123456789",
				},
			},
		}),
	],
	resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
	test: { setupFiles: ["./tests/setup.ts"] },
});
