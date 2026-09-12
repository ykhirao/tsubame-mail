import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { getDb } from "@/db/client";
import { parseBearer, SESSION_COOKIE } from "@/lib/tokens";
import { ApiError, forbidden, invalidRequest } from "@/shared/errors";
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
import adminAuditLogRoutes from "./v1/admin/audit-logs";
import notificationRoutes, { threadNotificationRouter } from "./v1/notifications";
import deviceRoutes from "./v1/devices";
import pushRoutes from "./v1/push";

// `clone()` は元のストリームを乱さないので、ここで読んでもハンドラ側の
// `c.req.json()` 等はそのまま読める。ヘッダ（Content-Length など）は
// HTTP/2 で省略されたり詐称されたりしうるので信用しない。
async function hasNonEmptyBody(raw: Request): Promise<boolean> {
	if (raw.body === null) return false;
	const reader = raw.clone().body!.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return false;
			if (value.byteLength > 0) return true;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

// サンドボックス化した iframe などは `Origin: null` を送り、URL として読めない。一致しない扱いにする。
function isSameOrigin(origin: string, requestUrl: string): boolean {
	try {
		return new URL(origin).origin === new URL(requestUrl).origin;
	} catch {
		return false;
	}
}

export function createApp() {
	const app = new Hono<AppEnv>();

	// 添付と生 MIME は送信者が書いた中身をこのオリジンから返すので、HTML として
	// 開かれても何も読み込ませず、どこにも埋め込ませない。`sandbox` は付けない
	// （ブラウザによっては Content-Disposition: attachment のダウンロードまで止まる）。
	app.use(
		"*",
		secureHeaders({
			contentSecurityPolicy: {
				defaultSrc: ["'none'"],
				baseUri: ["'none'"],
				formAction: ["'none'"],
				frameAncestors: ["'none'"],
			},
			xFrameOptions: "DENY",
			strictTransportSecurity: "max-age=15552000",
		}),
	);

	app.use("*", async (c, next) => {
		c.set("db", getDb(c.env));
		c.set("requestId", crypto.randomUUID());
		await next();
	});

	// Cookie 認証で動く変更系は、同一登録ドメインの別サブドメインから no-cors で叩けないようにする（#76）。
	// API キー（Bearer）の要求は CSRF の対象外なので検査しない。
	// Sec-Fetch-Site を先に見る: Vite の dev proxy は Host / Origin を書き換えるので、
	// オリジン照合だけで判定すると dev が壊れる。ヘッダが無い非ブラウザは Origin 照合に落とす。
	app.use("/api/*", async (c, next) => {
		const method = c.req.method;
		if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
			const isApiKey = parseBearer(c.req.header("authorization")) !== null;
			const hasSessionCookie = (c.req.header("cookie") ?? "").includes(`${SESSION_COOKIE}=`);
			if (!isApiKey && hasSessionCookie) {
				const site = c.req.header("sec-fetch-site");
				if (site !== undefined) {
					if (site !== "same-origin") throw forbidden("不正なリクエスト元です");
				} else {
					const origin = c.req.header("origin");
					if (origin !== undefined && !isSameOrigin(origin, c.req.url)) {
						throw forbidden("不正なリクエスト元です");
					}
				}
			}
		}
		await next();
	});

	// Cookie は SameSite=Lax なので、同じ登録ドメインの別サブドメインからは form や no-cors fetch で Cookie 付き POST が届く。
	// それらは Content-Type を application/json にできず「無し」か form の 3 種になるので、ボディ付きならここで弾く（#50）。
	// ボディの有無を c.req.raw.body で見ない: workerd は実 HTTP のボディ無し POST でも null にしない（#55）。
	app.use("/api/*", async (c, next) => {
		const method = c.req.method;
		if (method === "POST" || method === "PUT" || method === "PATCH") {
			const rawContentType = c.req.header("content-type");
			if (rawContentType !== undefined) {
				const mimeType = rawContentType.split(";")[0]?.trim().toLowerCase();
				if (mimeType !== "application/json") {
					throw invalidRequest("Content-Type: application/json が必要です");
				}
			} else if (await hasNonEmptyBody(c.req.raw)) {
				throw invalidRequest("Content-Type: application/json が必要です");
			}
		}
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
	app.use("/api/v1/push/*", requireAuth);

	app.route("/api/v1/me/notifications", notificationRoutes);
	app.route("/api/v1/me/devices", deviceRoutes);
	app.route("/api/v1/push", pushRoutes);
	app.route("/api/v1/me", meRoutes);
	app.route("/api/v1/messages", messageRoutes);
	app.route("/api/v1/messages", outboundRoutes);
	app.route("/api/v1/threads", threadNotificationRouter);
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
	app.route("/api/v1/admin/audit-logs", adminAuditLogRoutes);

	app.all("/api/*", (c) =>
		c.json({ error: { code: "not_found", message: "エンドポイントがありません" } }, 404),
	);

	return app;
}
