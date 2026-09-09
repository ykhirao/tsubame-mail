import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = ReturnType<typeof getDb>;

export function getDb(env: CloudflareEnv) {
	return drizzle(env.DB, { schema });
}

export { schema };
