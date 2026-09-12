import { it } from "vitest";

/**
 * `docs/spec/requirements.md` の `### FR-n` の中のトップレベルの箇条書きを、出現順に数えた ID。
 * 文書には番号を書かない。`npm run spec:coverage` が数える。
 */
export type BulletId = `FR-${number}-${number}`;

/**
 * `covers` は箇条書き単位の ID（`"FR-5-3"`）。`npm run spec:coverage` がソースを静的に走査して
 * 未カバーの箇条書きを検出するので、第1引数には**リテラル**を書くこと
 * （変数を渡すと走査から漏れ、カバー済みと見なされない）。
 */
export function scenario(
	covers: BulletId | BulletId[],
	name: string,
	fn: () => void | Promise<void>,
	timeoutMs?: number,
): void {
	const ids = Array.isArray(covers) ? covers : [covers];
	it(`[${ids.join(", ")}] ${name}`, fn, timeoutMs);
}

/**
 * e2e で確かめられない箇条書き（見た目・方針・非機能）の宣言。`e2e/untestable.ts` に並べる。
 * 静的に走査するので、引数はどちらもリテラルで書くこと。
 */
export function untestable(_id: BulletId, _reason: string): void {}
