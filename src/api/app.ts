import { Hono } from "hono";
import { getDb } from "@/db/client";
import { ApiError } from "@/shared/errors";
import { requireAuth, requireOwner } from "./middleware/auth";
import type { AppEnv } from "./types";

import authRoutes from "./v1/auth";
import meRoutes from "./v1/me";
import outboundRoutes from "./v1/outbound";
import messageRoutes from "./v1/messages";
import threadRoutes from "./v1/threads";
import { attachmentsRouter, rawRouter } from "./v1/attachments";
import { rulesRouter } from "./v1/admin/rules";
import adminUserRoutes from "./v1/admin/users";
import adminApiKeyRoutes from "./v1/admin/api-keys";
import webhookRoutes from "./v1/webhooks";
import addressRoutes from "./v1/addresses";
import adminDomainRoutes from "./v1/admin/domains";
import adminAddressRoutes from "./v1/admin/addresses";

export function createApp() {
	const app = new Hono<AppEnv>();

	app.use("*", async (c, next) => {
		c.set("db", getDb(c.env));
		c.set("requestId", crypto.randomUUID());
		await next();
	});

	// エラーの整形は onError で行う。ミドルウェアの try/catch では捕まえられない
	// （Hono の compose がハンドラの throw を先に拾って onError に回すため）。
	app.onError((err, c) => {
		if (err instanceof ApiError) {
			return c.json(err.toJSON(), err.status as 400);
		}
		console.error("unhandled error", err);
		return c.json({ error: { code: "internal", message: "内部エラーが発生しました" } }, 500);
	});

	app.get("/api/health", (c) => c.json({ ok: true, app: c.env.APP_NAME }));

	app.route("/api/v1/auth", authRoutes);

	app.use("/api/v1/me/*", requireAuth);
	app.use("/api/v1/messages/*", requireAuth);
	app.use("/api/v1/threads/*", requireAuth);
	app.use("/api/v1/addresses/*", requireAuth);
	app.use("/api/v1/attachments/*", requireAuth);
	app.use("/api/v1/admin/*", requireAuth, requireOwner);
	app.use("/api/v1/webhooks/*", requireAuth, requireOwner);

	app.route("/api/v1/me", meRoutes);
	app.route("/api/v1/messages", messageRoutes);
	app.route("/api/v1/messages", outboundRoutes);
	app.route("/api/v1/threads", threadRoutes);
	app.route("/api/v1/attachments", attachmentsRouter);
	app.route("/api/v1", rawRouter);
	app.route("/api/v1/admin/users", adminUserRoutes);
	app.route("/api/v1/admin/api-keys", adminApiKeyRoutes);
	app.route("/api/v1/admin/rules", rulesRouter);
	app.route("/api/v1/webhooks", webhookRoutes);
	app.route("/api/v1/addresses", addressRoutes);
	app.route("/api/v1/admin/domains", adminDomainRoutes);
	app.route("/api/v1/admin/addresses", adminAddressRoutes);

	app.all("/api/*", (c) =>
		c.json({ error: { code: "not_found", message: "エンドポイントがありません" } }, 404),
	);

	return app;
}
