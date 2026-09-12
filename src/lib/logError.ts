import { DrizzleQueryError } from "drizzle-orm/errors";

// drizzle のクエリ失敗はメッセージにバインド値（検索語やメールの一部）をそのまま含み、observability に残る（#146）。
export function redactError(err: unknown): unknown {
	if (err instanceof DrizzleQueryError) {
		return { name: "DrizzleQueryError", cause: err.cause?.message ?? null };
	}
	return err;
}
