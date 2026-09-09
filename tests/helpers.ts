import { env } from "cloudflare:test";
import { applyMigrations } from "./helpers/migrate";

/**
 * スキーマは作り直さない。マイグレーションは tests/setup.ts が beforeAll で一度だけ流す。
 * ここで 0000 を流し直すと後から足した列が反映されず、実装とだけ食い違う。
 */
export async function resetDb(): Promise<void> {
	await applyMigrations();
}

export function sampleMime(): string {
	return [
		"From: 山田 太郎 <taro@example.com>",
		"To: a@b.jp, c@d.jp",
		"Cc: e@f.jp",
		"Subject: =?UTF-8?B?44GV44KT44Gr44Gh44Gv44KS?=",
		"Message-ID: <abc-123@x.example>",
		"In-Reply-To: <prev-1@x.example>",
		"References: <prev-1@x.example> <prev-0@x.example>",
		"Date: Mon, 14 Sep 2026 03:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="B"',
		"",
		"--B",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Hello 世界。  テスト",
		"",
		"--B",
		"Content-Type: text/html; charset=utf-8",
		"",
		"<p>Hello</p>",
		"",
		"--B",
		'Content-Type: application/pdf; name="report.pdf"',
		'Content-Disposition: attachment; filename="report.pdf"',
		"",
		"AAAA",
		"",
		"--B--",
	].join("\r\n");
}

export const fakeCtx = {
	waitUntil: () => {},
	passThroughOnException: () => {},
} as unknown as ExecutionContext;
