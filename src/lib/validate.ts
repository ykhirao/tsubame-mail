import type { z } from "zod";
import { invalidRequest } from "@/shared/errors";

type JsonSource = { json: () => Promise<unknown> };

export async function readJson<T extends z.ZodType>(req: JsonSource, schema: T): Promise<z.infer<T>> {
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
