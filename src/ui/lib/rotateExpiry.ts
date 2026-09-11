/**
 * 再発行するキーの有効期限。元の有効期間の長さを保って先送りする。
 * 元の expiresAt をそのまま渡すと、期限切れのキーを再発行したときに
 * 最初から切れている鍵ができる。
 */
export function rotatedExpiry(
	key: { expiresAt: number | null; createdAt: number },
	nowSec: number = Math.floor(Date.now() / 1000),
): number | undefined {
	if (!key.expiresAt) return undefined;
	const span = key.expiresAt - key.createdAt;
	return nowSec + (span > 0 ? span : 0);
}
