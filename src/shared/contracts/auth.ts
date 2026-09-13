import { z } from "zod";
import { role, scope } from "./common";

export const MIN_PASSWORD_LENGTH = 12;

export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(200);

/** 画面のウィジェットが入れる隠しフィールド。Turnstile を設定していない環境では来ない。 */
const turnstileToken = z.string().max(2048).optional();

export const loginBody = z.object({
	email: z.email(),
	password: z.string().min(1).max(200),
	"cf-turnstile-response": turnstileToken,
});
export type LoginBody = z.infer<typeof loginBody>;

/** オーナーが 1 人でも居れば 409。 */
export const bootstrapBody = z.object({
	email: z.email(),
	name: z.string().min(1).max(100),
	password: passwordSchema,
	/** Worker Secret の INTERNAL_SECRET と突き合わせる。 */
	secret: z.string().min(1),
	"cf-turnstile-response": turnstileToken,
});
export type BootstrapBody = z.infer<typeof bootstrapBody>;

export const sessionInfo = z.object({
	userId: z.string(),
	email: z.string(),
	name: z.string(),
	role,
	via: z.enum(["session", "api_key"]),
	scopes: z.array(scope),
	expiresAt: z.number().nullable(),
});
export type SessionInfo = z.infer<typeof sessionInfo>;
