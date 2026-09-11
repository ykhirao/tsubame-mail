import type { z } from "zod";
import { invalidRequest } from "@/shared/errors";

type JsonSource = { json: () => Promise<unknown>; header: (name: string) => string | undefined };

/**
 * Hono の `HonoRequest.json()` は Content-Type を見ずに body を `JSON.parse` する。
 * `<form enctype="text/plain">` で JSON 風の文字列を送ると、Cookie が SameSite=Lax でも
 * 同じ登録ドメインの別サブドメインからは素通りする。`application/json` を明示的に要求して塞ぐ。
 */
export async function readJson<T extends z.ZodType>(req: JsonSource, schema: T): Promise<z.infer<T>> {
	const mimeType = (req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (mimeType !== "application/json") {
		throw invalidRequest("Content-Type: application/json が必要です");
	}

	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		throw invalidRequest("JSON ボディが必要です");
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		throw invalidRequest("リクエストの内容が不正です", parsed.error.issues);
	}
	return parsed.data as z.infer<T>;
}

export function unixSeconds(value: Date | null | undefined): number | null {
	return value ? Math.floor(value.getTime() / 1000) : null;
}
