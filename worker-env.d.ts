// バインディングの型定義。`wrangler types` でも生成できるが、並列作業のため手書きしている。
// バインディングを増やしたら wrangler.jsonc と両方を更新すること。
//
// 型は `Cloudflare.Env` として定義する。vitest-pool-workers の `cloudflare:test` が
// 返す env もこの名前空間を見るので、テストからも同じ型が使える。
import type { InboundQueueMessage, OutboundQueueMessage } from "@/services/queue";

declare global {
	namespace Cloudflare {
		interface Env {
			APP_NAME: string;
			EMAIL_WORKER_NAME: string;

			DB: D1Database;
			BUCKET: R2Bucket;
			ASSETS: Fetcher;
			INBOUND_QUEUE: Queue<InboundQueueMessage>;
			OUTBOUND_QUEUE: Queue<OutboundQueueMessage>;
			EMAIL: SendEmail;
			LOGIN_RATE_LIMIT: RateLimit;
			SEND_RATE_LIMIT: RateLimit;

			/** Cloudflare API トークン（Zone / Email Routing / Email Sending）。Worker Secret。 */
			CF_API_TOKEN?: string;
			/** Cloudflare アカウント ID。Worker Secret または var。 */
			CF_ACCOUNT_ID?: string;
			/**
			 * 最初のオーナーを作るときの合言葉。**20 文字以上**。Worker Secret。
			 *
			 * オーナーは Cloudflare の DNS とメールルーティングを触れる強い権限を持つ。
			 * デプロイ直後に URL を見つけただけの相手にオーナーを取られないよう、
			 * デプロイできる人だけが知っている値を一致条件にする。
			 * 未設定なら誰もオーナーを作れない。
			 */
			INTERNAL_SECRET?: string;
		}
	}

	type CloudflareEnv = Cloudflare.Env;
}

export {};
