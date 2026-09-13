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
			/** Web Push の VAPID 秘密鍵（JWK の JSON）。Worker Secret。変えると全端末の購読が無効になる。 */
			VAPID_PRIVATE_KEY?: string;
			/** VAPID の連絡先（`mailto:`）。実環境の宛先をリポジトリに書かないため Worker Secret に置く。 */
			VAPID_SUBJECT?: string;
			/**
			 * Turnstile（ボット確認）の秘密鍵。Worker Secret。
			 * **未設定なら確認そのものを行わない**（ローカル・vitest はウィジェットが無いため）。
			 * 本番で入れ忘れると、総当たりを止める門が無くなる。
			 */
			TURNSTILE_SECRET?: string;
			/**
			 * ウィジェットを置いてよいホスト名。カンマ区切り。siteverify が返す hostname と突き合わせる。
			 * **本番の値に localhost / 127.0.0.1 を入れない**（入れると手元から本番の門を抜けられる）。
			 */
			TURNSTILE_HOSTNAMES?: string;
			/**
			 * Turnstile のサイトキー。**秘密ではない**（画面の HTML に出る）ので vars に置く。
			 * 未設定なら画面はウィジェットを出さず、サーバも検査しない。
			 */
			TURNSTILE_SITEKEY?: string;
		}
	}

	type CloudflareEnv = Cloudflare.Env;
}

export {};
