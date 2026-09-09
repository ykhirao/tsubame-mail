/** キーを他所で手組みさせないため、組み立ては必ずこのファイルの関数を通すこと。 */

const pad2 = (n: number) => String(n).padStart(2, "0");

export function rawMessageKey(messageId: string, date: Date): string {
	return `raw/${date.getUTCFullYear()}/${pad2(date.getUTCMonth() + 1)}/${messageId}.eml`;
}

export function attachmentKey(messageId: string, attachmentId: string): string {
	return `att/${messageId}/${attachmentId}`;
}

/**
 * `ForwardableEmailMessage.raw` は長さの分からない ReadableStream なので、そのまま R2 に
 * 渡すと "Provided readable stream must have a known length" で落ちる。`rawSize` があれば
 * FixedLengthStream を挟み、メールをメモリに全部載せずに流し込む。
 */
export async function saveRaw(
	env: CloudflareEnv,
	messageId: string,
	raw: ReadableStream<Uint8Array>,
	date: Date,
	rawSize?: number,
): Promise<string> {
	const key = rawMessageKey(messageId, date);

	if (typeof rawSize === "number") {
		const fixed = new FixedLengthStream(rawSize);
		const pumping = raw.pipeTo(fixed.writable);
		const putting = env.BUCKET.put(key, fixed.readable);
		await Promise.all([pumping, putting]);
		return key;
	}

	// 長さが分からない場合だけ、やむを得ず一度メモリに読み切る。
	const body = await new Response(raw).arrayBuffer();
	await env.BUCKET.put(key, body);
	return key;
}

export function getRaw(env: CloudflareEnv, key: string): Promise<R2ObjectBody | null> {
	return env.BUCKET.get(key);
}

export async function putAttachment(
	env: CloudflareEnv,
	messageId: string,
	attachmentId: string,
	content: Uint8Array,
	contentType: string,
): Promise<string> {
	const key = attachmentKey(messageId, attachmentId);
	await env.BUCKET.put(key, content, { httpMetadata: { contentType } });
	return key;
}

export function getAttachment(env: CloudflareEnv, key: string): Promise<R2ObjectBody | null> {
	return env.BUCKET.get(key);
}
