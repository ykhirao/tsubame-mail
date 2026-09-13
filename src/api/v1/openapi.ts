import { Hono } from "hono";
import type { AppEnv } from "@/api/types";

const app = new Hono<AppEnv>();

const err = (description: string) => ({
	description,
	content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const json = (ref: string, description: string) => ({
	description,
	content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } },
});

const param = (
	name: string,
	schema: Record<string, unknown>,
	description: string,
	location = "query",
) => ({ name, in: location, description, schema, required: location === "path" });

const boolParam = { type: "string", enum: ["true", "false", "1", "0"] } as const;
const addressList = {
	oneOf: [
		{ type: "string", maxLength: 10000 },
		{ type: "array", items: { type: "string", maxLength: 10000 }, minItems: 1, maxItems: 100 },
	],
	description: "単一のアドレス文字列（カンマ区切り可）か、その配列。",
};

const attachmentSchema = {
	type: "object",
	required: ["filename", "contentType", "base64"],
	properties: {
		filename: { type: "string", minLength: 1, maxLength: 255 },
		contentType: { type: "string", pattern: "^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$" },
		base64: { type: "string", minLength: 1 },
	},
};

const messageListItem = {
	type: "object",
	properties: {
		id: { type: "string" },
		threadId: { type: ["string", "null"] },
		addressId: { type: "string" },
		direction: { type: "string", enum: ["inbound", "outbound"] },
		status: {
			type: "string",
			enum: ["received", "sent", "draft", "queued", "failed", "trash"],
		},
		subject: { type: ["string", "null"] },
		snippet: { type: ["string", "null"] },
		fromAddr: { type: "string", description: "差出人。応答側の名前は `from` ではない。" },
		fromName: { type: ["string", "null"] },
		toAddr: {
			type: "string",
			description: "宛先。`+タグ` は付いたまま入るので、確認に生 MIME は要らない。",
		},
		ccAddr: { type: ["string", "null"] },
		spamVerdict: { type: ["string", "null"] },
		receivedAt: { type: "integer", description: "Unix 秒。" },
		isRead: { type: "boolean" },
		isStarred: { type: "boolean" },
		hasAttachments: { type: "boolean" },
	},
};

const spec = {
	openapi: "3.1.0",
	info: {
		title: "Tsubamail API",
		version: "1.0.0",
		description:
			"メールを読む・送る・整理するための HTTP API。\n\n" +
			"ここに載せているのは API キーで叩ける範囲だけ。管理 API（`/api/v1/admin/*`）と " +
			"Webhook 設定、ブラウザのセッションでしか使えない通知・端末の API は含めていない。\n\n" +
			"日時はすべて Unix 秒。一覧は `{ data, next_cursor }` で返り、`next_cursor` が " +
			"`null` になるまで `cursor` に渡して辿る。",
	},
	servers: [{ url: "/", description: "このホスト" }],
	tags: [
		{ name: "health", description: "疎通確認" },
		{ name: "me", description: "今のキーの権限" },
		{ name: "addresses", description: "使えるメールボックス" },
		{ name: "messages", description: "メールを読む・送る・整理する" },
		{ name: "threads", description: "会話" },
		{ name: "attachments", description: "添付と生 MIME" },
	],
	paths: {
		"/api/health": {
			get: {
				tags: ["health"],
				summary: "疎通確認",
				description: "認証不要。",
				security: [],
				responses: {
					"200": {
						description: "正常",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: { ok: { type: "boolean" }, app: { type: "string" } },
								},
							},
						},
					},
				},
			},
		},
		"/api/v1/me": {
			get: {
				tags: ["me"],
				summary: "今のキーのスコープと対象アドレスを知る",
				description:
					"スコープは要らない。`addressIds` が `\"all\"` なら対象アドレスの制限が無い。",
				responses: {
					"200": json("Me", "キーの権限と持ち主"),
					"401": err("認証が必要"),
				},
			},
		},
		"/api/v1/addresses": {
			get: {
				tags: ["addresses"],
				summary: "使えるメールボックスの一覧",
				description:
					"`from` に使えるのはここに出るアドレスだけ。決め打ちせずここから取る。\n\n" +
					"このエンドポイントだけ `limit` の既定が 100・上限が 200 で、他の一覧（25/100）と違う。",
				parameters: [
					param("limit", { type: "integer", minimum: 1, maximum: 200, default: 100 }, "1 ページの件数。"),
					param("cursor", { type: "string" }, "前のページの `next_cursor`。"),
					param("includeArchived", { type: "string", enum: ["true", "false"] }, "アーカイブ済みも含める。"),
				],
				responses: {
					"200": json("AddressPage", "アドレスの一覧"),
					"401": err("認証が必要"),
					"403": err("スコープが足りない（`read` が要る）"),
				},
			},
		},
		"/api/v1/messages": {
			get: {
				tags: ["messages"],
				summary: "メールを探す",
				description:
					"`status` を指定しなければゴミ箱は除いて返る。\n\n" +
					"`q` では `from:` `to:` `subject:` `body:` `since:` `until:` `is:` `has:` `in:` が使える。" +
					"演算子に該当しない語（フリーワード）は 10 個まで。\n\n" +
					"**宛先と差出人は、絞り込みが `to` / `from`、返る値が `toAddr` / `fromAddr` で名前が違う。**" +
					"応答に `to` / `from` という項目は無い（送信のボディだけがその名前を使う）。" +
					"`toAddr` には `+タグ` が付いたままの宛先が入るので、サブアドレスの確認に生 MIME は要らない。",
				parameters: [
					param("limit", { type: "integer", minimum: 1, maximum: 100, default: 25 }, "1 ページの件数。"),
					param("cursor", { type: "string" }, "前のページの `next_cursor`。"),
					param("q", { type: "string", maxLength: 500 }, "検索語。演算子が使える。"),
					param("address", { type: "string" }, "アドレス文字列（`@` を含む）か addressId。"),
					param("from", { type: "string" }, "差出人の部分一致。"),
					param("to", { type: "string" }, "宛先の部分一致。"),
					param("subject", { type: "string" }, "件名の部分一致。"),
					param("body", { type: "string" }, "本文の部分一致。"),
					param("since", { type: "string" }, "`YYYY-MM-DD`。この日から。"),
					param("until", { type: "string" }, "`YYYY-MM-DD`。この日の 23:59:59 UTC まで含む。"),
					param("direction", { type: "string", enum: ["inbound", "outbound"] }, "受信か送信か。"),
					param(
						"status",
						{ type: "string", enum: ["received", "sent", "draft", "queued", "failed", "trash"] },
						"状態。`trash` を指定したときだけゴミ箱が返る。",
					),
					param("unread", boolParam, "未読だけ。"),
					param("starred", boolParam, "スター付きだけ。"),
					param("has_attachment", boolParam, "添付があるものだけ。"),
					param("thread", { type: "string" }, "この会話のメールだけ。"),
					param(
						"order",
						{ type: "string", enum: ["received_at", "relevance"], default: "received_at" },
						"並び順。`relevance` は `q` にフリーワードがあるときだけ効く。",
					),
				],
				responses: {
					"200": json("MessagePage", "メールの一覧"),
					"400": err("検索パラメータが不正（`details` に該当項目）"),
					"401": err("認証が必要"),
					"403": err("スコープが足りない（`read` が要る）"),
				},
			},
			post: {
				tags: ["messages"],
				summary: "メールを送る",
				description:
					"受理されると 202 と `{ id, status: \"queued\" }` が返る。実際の送信はキューが行うので、" +
					"結果は後から `GET /api/v1/messages/{id}` の `status` で確かめる。\n\n" +
					"`from` は自分が使えるアドレスでなければならない。本文（`text` / `html`）はどちらも必須ではない。",
				requestBody: {
					required: true,
					content: { "application/json": { schema: { $ref: "#/components/schemas/SendMessage" } } },
				},
				responses: {
					"202": json("SendResult", "受理した（まだ送っていない）"),
					"400": err("入力が不正、または宛先が 0 件"),
					"401": err("認証が必要"),
					"403": err("スコープ（`send`）か、その `from` を使う権限が無い"),
					"429": err("送信が多すぎる（60 秒あたり 100 回）"),
				},
			},
		},
		"/api/v1/messages/{id}": {
			get: {
				tags: ["messages"],
				summary: "メールを 1 通取る",
				description: "本文と添付の一覧が付く。",
				parameters: [
					param("id", { type: "string" }, "メールの id。", "path"),
					param("includeTrash", boolParam, "ゴミ箱のメールも取れるようにする。"),
				],
				responses: {
					"200": json("MessageDetail", "メール"),
					"401": err("認証が必要"),
					"403": err("スコープが足りない（`read` が要る）"),
					"404": err("無いか、権限が無い"),
				},
			},
			patch: {
				tags: ["messages"],
				summary: "既読・スター・ゴミ箱を変える",
				description:
					"3 つのうち少なくとも 1 つを指定する。更新後のメール（本文と添付を含む）が返る。\n\n" +
					"`status` を指定するときだけ `send` スコープとそのアドレスへの write 権限も要る。",
				parameters: [param("id", { type: "string" }, "メールの id。", "path")],
				requestBody: {
					required: true,
					content: { "application/json": { schema: { $ref: "#/components/schemas/MessagePatch" } } },
				},
				responses: {
					"200": json("MessageDetail", "更新後のメール"),
					"400": err("入力が不正、または 3 つとも指定が無い"),
					"401": err("認証が必要"),
					"403": err("スコープか権限が足りない"),
					"404": err("無いか、権限が無い"),
				},
			},
		},
		"/api/v1/messages/{id}/reply": {
			post: {
				tags: ["messages"],
				summary: "返信する",
				description:
					"宛先を省くとサーバが決める（差出人、`replyAll` なら To/Cc も）。件名と `In-Reply-To` も" +
					"サーバが引き継ぐので、`subject` や `inReplyTo` を送っても無視される。",
				parameters: [param("id", { type: "string" }, "返信元メールの id。", "path")],
				requestBody: {
					required: true,
					content: { "application/json": { schema: { $ref: "#/components/schemas/Reply" } } },
				},
				responses: {
					"202": json("SendResult", "受理した（まだ送っていない）"),
					"400": err("入力が不正、または宛先が 0 件"),
					"401": err("認証が必要"),
					"403": err("スコープ（`read` と `send`）か権限が足りない"),
					"404": err("返信元が無いか、権限が無い"),
					"429": err("送信が多すぎる"),
				},
			},
		},
		"/api/v1/messages/{id}/raw": {
			get: {
				tags: ["attachments"],
				summary: "生の MIME を取る",
				parameters: [
					param("id", { type: "string" }, "メールの id。", "path"),
					param("includeTrash", { type: "string", enum: ["true"] }, "ゴミ箱のメールも取る。ここは `true` だけが効く。"),
				],
				responses: {
					"200": {
						description: "`message/rfc822`",
						content: { "message/rfc822": { schema: { type: "string", format: "binary" } } },
					},
					"401": err("認証が必要"),
					"403": err("スコープが足りない（`read` が要る）"),
					"404": err("無いか、権限が無い"),
				},
			},
		},
		"/api/v1/threads": {
			get: {
				tags: ["threads"],
				summary: "会話の一覧",
				parameters: [
					param("limit", { type: "integer", minimum: 1, maximum: 100, default: 25 }, "1 ページの件数。"),
					param("cursor", { type: "string" }, "前のページの `next_cursor`。"),
					param("address", { type: "string" }, "アドレス文字列か addressId。"),
					param(
						"view",
						{ type: "string", enum: ["inbox", "starred", "sent", "trash"] },
						"どの入れ物を見るか。",
					),
				],
				responses: {
					"200": json("ThreadPage", "会話の一覧"),
					"400": err("検索パラメータが不正"),
					"401": err("認証が必要"),
					"403": err("スコープが足りない（`read` が要る）"),
				},
			},
		},
		"/api/v1/threads/{id}": {
			get: {
				tags: ["threads"],
				summary: "会話を開く",
				description:
					"古い順に最大 200 通。それより古いものがあれば `hasOlder` が `true` になるので、" +
					"`olderCursor` を `before` に渡して続きを取る。",
				parameters: [
					param("id", { type: "string" }, "会話の id。", "path"),
					param("includeTrash", boolParam, "ゴミ箱のメールも含める。"),
					param("before", { type: "string" }, "前の応答の `olderCursor`。"),
				],
				responses: {
					"200": json("ThreadDetail", "会話"),
					"401": err("認証が必要"),
					"403": err("スコープが足りない（`read` が要る）"),
					"404": err("無いか、権限が無い"),
				},
			},
		},
		"/api/v1/attachments/{id}": {
			get: {
				tags: ["attachments"],
				summary: "添付を取る",
				parameters: [
					param("id", { type: "string" }, "添付の id。", "path"),
					param("includeTrash", { type: "string", enum: ["true"] }, "ゴミ箱のメールの添付も取る。ここは `true` だけが効く。"),
				],
				responses: {
					"200": {
						description: "ファイルの中身",
						content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
					},
					"401": err("認証が必要"),
					"403": err("スコープが足りない（`read` が要る）"),
					"404": err("無いか、権限が無い"),
				},
			},
		},
	},
	components: {
		securitySchemes: {
			bearerAuth: {
				type: "http",
				scheme: "bearer",
				description:
					"発行された API キーを `Authorization: Bearer tsb_...` で送る。\n\n" +
					"キーにはスコープ（`read` / `send` / `admin`）と対象アドレスが設定されていて、" +
					"権限は持ち主のそれとの積集合で効く。今の権限は `GET /api/v1/me` で分かる。",
			},
		},
		schemas: {
			Error: {
				type: "object",
				properties: {
					error: {
						type: "object",
						required: ["code", "message"],
						properties: {
							code: {
								type: "string",
								enum: [
									"invalid_request",
									"unauthorized",
									"forbidden",
									"not_found",
									"conflict",
									"rate_limited",
									"internal",
								],
							},
							message: { type: "string", description: "日本語の説明。" },
							details: { description: "入力が不正なときに該当項目が入る。形は一定でない。" },
						},
					},
				},
			},
			Me: {
				type: "object",
				properties: {
					id: { type: "string" },
					email: { type: "string" },
					name: { type: "string" },
					role: { type: "string", enum: ["owner", "member", "agent"] },
					status: { type: "string", enum: ["active", "disabled"] },
					mustChangePassword: { type: "boolean" },
					lastLoginAt: { type: ["integer", "null"] },
					via: { type: "string", enum: ["session", "api_key"] },
					apiKeyId: { type: ["string", "null"] },
					scopes: { type: "array", items: { type: "string", enum: ["read", "send", "admin"] } },
					addressIds: {
						oneOf: [{ type: "array", items: { type: "string" } }, { type: "string", enum: ["all"] }],
						description: "`\"all\"` なら制限が無い。",
					},
					writableAddressIds: {
						oneOf: [{ type: "array", items: { type: "string" } }, { type: "string", enum: ["all"] }],
					},
					addresses: { type: "array", items: { $ref: "#/components/schemas/Address" } },
				},
			},
			Address: {
				type: "object",
				properties: {
					id: { type: "string" },
					address: { type: "string" },
					localPart: { type: "string" },
					displayName: { type: ["string", "null"] },
					domainId: { type: "string" },
					domainName: { type: "string" },
					kind: { type: "string", enum: ["mailbox", "alias"] },
					level: { type: "string", enum: ["read", "write"], description: "owner も `write`。" },
					isCatchAll: { type: "boolean" },
					color: { type: "string" },
					signature: { type: ["string", "null"] },
					unreadCount: { type: "integer" },
					archived: { type: "boolean" },
				},
			},
			AttachmentMeta: {
				type: "object",
				properties: {
					id: { type: "string" },
					filename: { type: "string" },
					contentType: { type: "string" },
					sizeBytes: { type: "integer" },
					isInline: { type: "boolean" },
				},
			},
			MessageListItem: messageListItem,
			MessageDetail: {
				allOf: [
					messageListItem,
					{
						type: "object",
						properties: {
							envelopeTo: { type: ["string", "null"] },
							textBody: { type: ["string", "null"] },
							htmlBody: { type: ["string", "null"] },
							attachments: {
								type: "array",
								items: { $ref: "#/components/schemas/AttachmentMeta" },
							},
						},
					},
				],
			},
			ThreadListItem: {
				type: "object",
				properties: {
					id: { type: "string" },
					addressId: { type: "string" },
					subject: { type: ["string", "null"] },
					lastMessageAt: { type: "integer" },
					messageCount: { type: "integer" },
					unreadCount: { type: "integer" },
					address: { type: ["string", "null"] },
					addressColor: { type: ["string", "null"] },
					lastFromAddr: { type: ["string", "null"] },
					lastFromName: { type: ["string", "null"] },
					snippet: { type: ["string", "null"] },
					hasAttachments: { type: "boolean" },
					isStarred: { type: "boolean" },
					envelopeTo: { type: ["string", "null"] },
				},
			},
			ThreadDetail: {
				type: "object",
				properties: {
					id: { type: "string" },
					addressId: { type: "string" },
					subject: { type: ["string", "null"] },
					messages: {
						type: "array",
						items: { $ref: "#/components/schemas/MessageDetail" },
						description: "古い順。",
					},
					hasOlder: { type: "boolean" },
					olderCursor: { type: ["string", "null"] },
					olderCount: { type: "integer" },
				},
			},
			MessagePage: {
				type: "object",
				properties: {
					data: { type: "array", items: { $ref: "#/components/schemas/MessageListItem" } },
					next_cursor: { type: ["string", "null"] },
				},
			},
			ThreadPage: {
				type: "object",
				properties: {
					data: { type: "array", items: { $ref: "#/components/schemas/ThreadListItem" } },
					next_cursor: { type: ["string", "null"] },
				},
			},
			AddressPage: {
				type: "object",
				properties: {
					data: { type: "array", items: { $ref: "#/components/schemas/Address" } },
					next_cursor: { type: ["string", "null"] },
				},
			},
			SendMessage: {
				type: "object",
				required: ["from", "to"],
				properties: {
					from: { type: "string", maxLength: 10000, description: "自分が使えるアドレス。" },
					to: addressList,
					cc: addressList,
					bcc: addressList,
					subject: { type: "string", description: "UTF-8 で 600 バイトまで。" },
					text: { type: "string", description: "本文（プレーン）。1MB まで。" },
					html: { type: "string", description: "本文（HTML）。1MB まで。" },
					attachments: { type: "array", items: attachmentSchema, maxItems: 50 },
					inReplyTo: { type: "string", pattern: "^<[^\\s<>]+>$", description: "`<id@domain>` の形。" },
				},
				description:
					"宛先は To/Cc/Bcc を合わせて 100 件まで。添付は 1 件 20MB・合計 25MB まで、" +
					"本文と件名の合計は 1.5MB まで。",
			},
			Reply: {
				type: "object",
				properties: {
					text: { type: "string" },
					html: { type: "string" },
					replyAll: { type: "boolean", default: false },
					to: addressList,
					cc: addressList,
					attachments: { type: "array", items: attachmentSchema, maxItems: 50 },
				},
			},
			MessagePatch: {
				type: "object",
				minProperties: 1,
				properties: {
					isRead: { type: "boolean" },
					isStarred: { type: "boolean" },
					status: {
						type: "string",
						enum: ["received", "trash"],
						description: "`trash` でゴミ箱へ、`received` で戻す。",
					},
				},
			},
			SendResult: {
				type: "object",
				properties: {
					id: { type: "string" },
					status: { type: "string", enum: ["queued", "sent", "failed"] },
				},
			},
		},
	},
	security: [{ bearerAuth: [] }],
};

app.get("/openapi.json", (c) => c.json(spec));

// CDN のビューアは CSP で読み込めないので、仕様を fetch して素の DOM で組み立てる。
app.get("/openapi", (c) => {
	return c.html(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tsubamail API</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e3e3e3;--soft:#f7f7f8;--accent:#2563eb;--get:#0a7b34;--post:#9a5b00;--patch:#6b21a8}
@media(prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e8e8ea;--muted:#9a9aa2;--line:#2c2e33;--soft:#1d1f23;--accent:#7aa2f7;--get:#4ec27f;--post:#d9a441;--patch:#c084fc}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:24px;margin:0 0 4px}
.sub{color:var(--muted);font-size:14px;margin:0 0 24px}
.lead{white-space:pre-wrap;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:14px 16px;font-size:14px;margin:0 0 28px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:32px 0 10px;font-weight:600}
.op{border:1px solid var(--line);border-radius:10px;margin:0 0 10px;overflow:hidden}
.op>summary{cursor:pointer;padding:11px 14px;display:flex;gap:10px;align-items:center;list-style:none}
.op>summary::-webkit-details-marker{display:none}
.op[open]>summary{border-bottom:1px solid var(--line);background:var(--soft)}
.m{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 7px;border-radius:5px;background:var(--soft);border:1px solid var(--line);flex:none}
.m.GET{color:var(--get)}.m.POST{color:var(--post)}.m.PATCH{color:var(--patch)}
.p{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.s{color:var(--muted);font-size:13px;margin-left:auto;text-align:right;flex:none;max-width:45%}
.body{padding:14px}
.desc{white-space:pre-wrap;font-size:14px;margin:0 0 14px}
h3{font-size:12px;color:var(--muted);margin:16px 0 6px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600}
code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 5px;border-radius:4px}
.req{color:#c0392b;font-size:11px}
@media(prefers-color-scheme:dark){.req{color:#ff8a80}}
a{color:var(--accent)}
.err{padding:20px;border:1px solid var(--line);border-radius:10px;color:var(--muted)}
</style>
</head>
<body>
<div class="wrap" id="root"><p class="err">読み込み中…</p></div>
<script src="/api/v1/openapi.js"></script>
</body>
</html>`);
});

// インラインの <script> は CSP に阻まれるので、描画は別ファイルとして配る。
app.get("/openapi.js", (c) => {
	c.header("Content-Type", "text/javascript; charset=utf-8");
	return c.body(String.raw`
const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
const code = (s) => "<code>" + esc(s) + "</code>";

function typeOf(sc) {
  if (!sc) return "";
  if (sc.oneOf) return sc.oneOf.map(typeOf).join(" | ");
  if (sc.$ref) return sc.$ref.split("/").pop();
  const t = Array.isArray(sc.type) ? sc.type.join("|") : sc.type || "";
  if (sc.enum) return sc.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (t === "array") return typeOf(sc.items) + "[]";
  return t;
}

function limits(sc) {
  if (!sc) return "";
  const out = [];
  if (sc.default !== undefined) out.push("既定 " + JSON.stringify(sc.default));
  if (sc.minimum !== undefined || sc.maximum !== undefined) out.push([sc.minimum, sc.maximum].filter((v) => v !== undefined).join("〜"));
  if (sc.maxLength !== undefined) out.push("最大 " + sc.maxLength + " 文字");
  if (sc.maxItems !== undefined) out.push("最大 " + sc.maxItems + " 件");
  return out.join(" / ");
}

function params(list) {
  if (!list || !list.length) return "";
  const rows = list.map((p) =>
    "<tr><td>" + code(p.name) + (p.required ? ' <span class="req">必須</span>' : "") +
    "</td><td>" + code(typeOf(p.schema)) + "</td><td>" + esc(p.description || "") +
    (limits(p.schema) ? " <span style=\"color:var(--muted)\">(" + esc(limits(p.schema)) + ")</span>" : "") +
    "</td></tr>"
  ).join("");
  const q = list.filter((p) => p.in === "query").length;
  const label = q === list.length ? "クエリ" : q === 0 ? "パス" : "パラメータ";
  return "<h3>" + label + "</h3><table><tr><th>名前</th><th>型</th><th>説明</th></tr>" + rows + "</table>";
}

function schemaTable(spec, ref) {
  const name = ref.$ref ? ref.$ref.split("/").pop() : null;
  let sc = name ? spec.components.schemas[name] : ref;
  if (!sc) return "";
  const parts = sc.allOf || [sc];
  const props = Object.assign({}, ...parts.map((p) => p.properties || {}));
  const required = parts.flatMap((p) => p.required || []);
  const keys = Object.keys(props);
  if (!keys.length) return "";
  const rows = keys.map((k) => {
    const p = props[k];
    const lim = limits(p);
    return "<tr><td>" + code(k) + (required.includes(k) ? ' <span class="req">必須</span>' : "") +
      "</td><td>" + code(typeOf(p)) + "</td><td>" + esc(p.description || "") +
      (lim ? " <span style=\"color:var(--muted)\">(" + esc(lim) + ")</span>" : "") + "</td></tr>";
  }).join("");
  const note = parts.map((p) => p.description).filter(Boolean).join(" ");
  return (note ? "<p class=\"desc\">" + esc(note) + "</p>" : "") +
    "<table><tr><th>項目</th><th>型</th><th>説明</th></tr>" + rows + "</table>";
}

function render(spec) {
  const byTag = new Map();
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const tag = (op.tags || ["other"])[0];
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ path, method: method.toUpperCase(), op });
    }
  }
  let html = "<h1>" + esc(spec.info.title) + "</h1>" +
    '<p class="sub">' + esc(spec.info.version) + " ・ <a href=\"/api/v1/openapi.json\">openapi.json</a></p>" +
    '<p class="lead">' + esc(spec.info.description) + "</p>";

  for (const tag of spec.tags) {
    const ops = byTag.get(tag.name);
    if (!ops) continue;
    html += "<h2>" + esc(tag.description || tag.name) + "</h2>";
    for (const { path, method, op } of ops) {
      html += '<details class="op"><summary>' +
        '<span class="m ' + method + '">' + method + "</span>" +
        '<span class="p">' + esc(path) + "</span>" +
        '<span class="s">' + esc(op.summary || "") + "</span></summary><div class=\"body\">";
      if (op.description) html += '<p class="desc">' + esc(op.description) + "</p>";
      html += params(op.parameters);
      const rb = op.requestBody && op.requestBody.content["application/json"];
      if (rb) html += "<h3>本文</h3>" + schemaTable(spec, rb.schema);
      const rows = Object.entries(op.responses).map(([st, r]) => {
        const sc = r.content && Object.values(r.content)[0] && Object.values(r.content)[0].schema;
        const t = sc ? typeOf(sc) : Object.keys(r.content || {})[0] || "";
        return "<tr><td>" + code(st) + "</td><td>" + (t ? code(t) : "") + "</td><td>" + esc(r.description) + "</td></tr>";
      }).join("");
      html += "<h3>応答</h3><table><tr><th>状態</th><th>形</th><th>説明</th></tr>" + rows + "</table></div></details>";
    }
  }
  document.getElementById("root").innerHTML = html;
}

fetch("/api/v1/openapi.json")
  .then((r) => r.json())
  .then(render)
  .catch(() => {
    document.getElementById("root").innerHTML =
      '<p class="err">仕様を読み込めませんでした。<a href="/api/v1/openapi.json">openapi.json</a> を直接開いてください。</p>';
  });
`);
});

export default app;
