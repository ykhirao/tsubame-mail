import type { Principal } from "@/shared/contracts/common";
import type { Db } from "@/db/client";

export type AppEnv = {
	Bindings: CloudflareEnv;
	Variables: {
		db: Db;
		/** 認証ミドルウェアを通ったルートでのみ必ず存在する。 */
		principal: Principal;
		requestId: string;
	};
};
