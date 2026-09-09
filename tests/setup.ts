// SQL はテスト用に書き直さない。本番と同じ migrations/ を流す。
import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll } from "vitest";

const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

beforeAll(async () => {
	await applyD1Migrations(env.DB, migrations);
});
