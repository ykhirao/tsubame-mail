import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { attachments, messages } from "@/db/schema";
import { getAttachment, getRaw } from "@/services/r2";
import { notFound } from "@/shared/errors";
import { requireScope } from "@/domain/access/policy";
import type { AppEnv } from "@/api/types";

export const attachmentsRouter = new Hono<AppEnv>();
export const rawRouter = new Hono<AppEnv>();

/**
 * 権限が無いときは 403 ではなく 404 を返す。
 * 403 だと「その ID のものは存在する」と教えてしまい、他人の受信箱の中身を
 * ID 総当たりで推測されうる。メッセージ本体の取得も 404 に揃えてある。
 */
function assertCanAccess(addressIds: string[] | "all", addressId: string): void {
	if (addressIds !== "all" && !addressIds.includes(addressId)) {
		throw notFound("見つかりません");
	}
}

// 型は送信者が MIME に書いた値なので、そのまま返すと攻撃者の text/html や SVG を
// このアプリのオリジンから配ることになる。ブラウザが開いても害の無い型だけを通す。
const SAFE_CONTENT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/pdf",
	"text/plain",
	"text/csv",
]);

function servedContentType(declared: string): string {
	const essence = declared.split(";")[0]!.trim().toLowerCase();
	return SAFE_CONTENT_TYPES.has(essence) ? essence : "application/octet-stream";
}

attachmentsRouter.get("/:id", async (c) => {
	const principal = c.get("principal");
	requireScope(principal, "read");
	const db = c.get("db");

	const att = await db.select().from(attachments).where(eq(attachments.id, c.req.param("id"))).get();
	if (!att) throw notFound("添付が見つかりません");

	const msg = await db.select().from(messages).where(eq(messages.id, att.messageId)).get();
	if (!msg) throw notFound("添付が見つかりません");
	assertCanAccess(principal.addressIds, msg.addressId);

	const obj = await getAttachment(c.env, att.r2Key);
	if (!obj) throw notFound("添付の本文が見つかりません");

	c.header("Content-Type", servedContentType(att.contentType));
	c.header(
		"Content-Disposition",
		`attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
	);
	return c.body(await obj.arrayBuffer());
});

rawRouter.get("/messages/:id/raw", async (c) => {
	const principal = c.get("principal");
	requireScope(principal, "read");
	const db = c.get("db");

	const msg = await db
		.select()
		.from(messages)
		.where(eq(messages.id, c.req.param("id")))
		.get();
	if (!msg?.rawR2Key) throw notFound("メッセージが見つかりません");
	assertCanAccess(principal.addressIds, msg.addressId);

	const obj = await getRaw(c.env, msg.rawR2Key);
	if (!obj) throw notFound("生 MIME が見つかりません");

	c.header("Content-Type", "message/rfc822");
	c.header("Content-Disposition", `attachment; filename="${msg.id}.eml"`);
	return c.body(await obj.arrayBuffer());
});
