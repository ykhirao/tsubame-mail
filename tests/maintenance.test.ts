import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getDb, schema } from "@/db/client";
import { AUDIT_LOG_RETENTION_DAYS, pruneAuditLogs } from "@/services/maintenance";

describe("監査ログの保持期間（#95）", () => {
	it("保持期間より古い行だけを消す", async () => {
		const db = getDb(env);
		const now = Date.UTC(2027, 0, 1);
		const day = 86_400_000;
		await db.insert(schema.auditLogs).values([
			{ id: "aud_old", action: "user.update", createdAt: new Date(now - (AUDIT_LOG_RETENTION_DAYS + 1) * day) },
			{ id: "aud_keep", action: "user.update", createdAt: new Date(now - (AUDIT_LOG_RETENTION_DAYS - 1) * day) },
		]);

		expect(await pruneAuditLogs(env, now)).toBe(1);
		const left = (await db.select({ id: schema.auditLogs.id }).from(schema.auditLogs).all()).map((r) => r.id);
		expect(left).toContain("aud_keep");
		expect(left).not.toContain("aud_old");
	});
});
