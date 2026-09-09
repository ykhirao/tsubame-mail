import { it } from "vitest";

/**
 * `covers` は `docs/spec/requirements.md` の FR-* と対応する。`npm run spec:coverage` が
 * ソースを静的に走査して未カバーの要件を検出するので、第1引数には**リテラル**を書くこと
 * （変数を渡すと走査から漏れ、カバー済みと見なされない）。
 */
export function scenario(
	covers: string | string[],
	name: string,
	fn: () => void | Promise<void>,
	timeoutMs?: number,
): void {
	const ids = Array.isArray(covers) ? covers : [covers];
	it(`[${ids.join(", ")}] ${name}`, fn, timeoutMs);
}
