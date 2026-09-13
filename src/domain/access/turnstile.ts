import { ApiError } from "@/shared/errors";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Turnstile のトークンは 2048 バイトまで（Cloudflare の仕様）。 */
const MAX_TOKEN_LENGTH = 2048;

export type TurnstileEnv = {
	TURNSTILE_SECRET?: string;
	/** この画面を出してよいホスト名。カンマ区切り。本番に localhost を入れない。 */
	TURNSTILE_HOSTNAMES?: string;
};

/** siteverify が返す形。success 以外は付かないこともある。 */
type SiteverifyResult = {
	success: boolean;
	action?: string;
	hostname?: string;
	"error-codes"?: string[];
};

function expectedHostnames(env: TurnstileEnv): Set<string> {
	return new Set(
		(env.TURNSTILE_HOSTNAMES ?? "")
			.split(",")
			.map((h) => h.trim())
			.filter(Boolean),
	);
}

/**
 * TURNSTILE_SECRET が無ければ検査そのものを行わない。ローカル開発と vitest には
 * ウィジェットが無く、必須にすると開発でログインできなくなるため。
 * **本番では必ず入れること**（入れ忘れると総当たりの門が 1 つ減る）。
 */
export function turnstileEnabled(env: TurnstileEnv): boolean {
	return Boolean(env.TURNSTILE_SECRET);
}

/**
 * 画面から来た Turnstile のトークンを Cloudflare に問い合わせて確かめる。
 *
 * 落ちる側に倒す（fail closed）。siteverify に届かない・JSON でない・action や
 * hostname が違う、のどれでも 403 にする。通信の失敗を「通す」に倒すと、
 * siteverify を落とすだけで門を素通りできてしまう。
 *
 * `remoteip` は渡さない。Cloudflare の判定材料になるが、画面の前に別の CDN や
 * プロキシが挟まると偽の IP を送ることになり、かえって判定を狂わせる。
 */
export async function verifyTurnstile(
	env: TurnstileEnv,
	token: unknown,
	expectedAction: string,
): Promise<void> {
	if (!turnstileEnabled(env)) return;

	const hostnames = expectedHostnames(env);
	if (hostnames.size === 0) {
		// secret はあるのに許可ホストが無い設定は、全部を落とすか全部を通すかの
		// どちらかにしかならない。落とす側に倒し、設定の誤りを運用で気付けるようにする。
		throw new ApiError("internal", "TURNSTILE_HOSTNAMES が設定されていません");
	}

	if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
		throw new ApiError("forbidden", "ボット確認に失敗しました。画面を読み込み直してやり直してください");
	}

	let result: SiteverifyResult;
	try {
		const res = await fetch(SITEVERIFY_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			signal: AbortSignal.timeout(10_000),
			body: new URLSearchParams({ secret: env.TURNSTILE_SECRET!, response: token }),
		});
		if (!res.ok) throw new Error(`siteverify ${res.status}`);
		result = (await res.json()) as SiteverifyResult;
	} catch {
		throw new ApiError("forbidden", "ボット確認に失敗しました。画面を読み込み直してやり直してください");
	}

	// action と hostname も見る。success だけだと、別の画面（別の action）で取った
	// トークンや、別サイトに置いた同じウィジェットのトークンを使い回せる。
	//
	// Cloudflare の**テスト用キー**（1x0000… など）は実トークンでも `action` を返さず、
	// `hostname` も常に `example.com` になる（`metadata.result_with_testing_key: true`。
	// 2026-09-13 に実測。公式ドキュメントの例とは違う）。動作確認にテストキーを使うときは
	// ここで必ず落ちるので、本物のキーで確かめること。
	if (!result.success || result.action !== expectedAction || !hostnames.has(result.hostname ?? "")) {
		throw new ApiError("forbidden", "ボット確認に失敗しました。画面を読み込み直してやり直してください");
	}
}
