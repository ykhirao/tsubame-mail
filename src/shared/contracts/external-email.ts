import { z } from "zod";

export const setExternalEmailBody = z.object({ email: z.email() });
export type SetExternalEmailBody = z.infer<typeof setExternalEmailBody>;

export const verifyExternalEmailBody = z.object({
	code: z.string().regex(/^\d{6}$/, "6 桁の数字で入力してください"),
});
export type VerifyExternalEmailBody = z.infer<typeof verifyExternalEmailBody>;

/** 送信できたかどうか。送れるアドレスが無いときは理由付きで sent=false になる。 */
export type ExternalEmailSendResult = { sent: boolean; reason?: string };
