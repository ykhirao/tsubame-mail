import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { readJson } from "@/lib/validate";
import { recordAudit } from "@/domain/access/policy";
import { setExternalEmailBody } from "@/shared/contracts/external-email";
import { registerExternalEmail } from "@/services/verification-mail";
import { notFound } from "@/shared/errors";
import { clientIp, getPrincipal, requireOwner, requireSession } from "../../middleware/auth";
import type { AppEnv } from "../../types";

const app = new Hono<AppEnv>();

app.use("*", requireOwner);

app.put("/:id/external-email", requireSession, async (c) => {
	const principal = getPrincipal(c);
	const id = c.req.param("id");
	const body = await readJson(c.req, setExternalEmailBody);
	const db = c.get("db");

	const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
	if (!user) throw notFound("ユーザーが見つかりません");

	const result = await registerExternalEmail(db, c.env, id, body.email);
	await recordAudit(db, {
		actorId: principal.userId,
		action: "user.external_email.set",
		targetType: "user",
		targetId: id,
		meta: { email: body.email.trim().toLowerCase(), sent: result.sent },
		ip: clientIp(c),
	});
	return c.json(result);
});

export default app;
