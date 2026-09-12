import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { schema } from "@/db/client";
import { newId } from "@/lib/id";
import { hashToken, randomBytes, secretEquals } from "@/lib/tokens";
import { composeMime } from "@/domain/mail/compose";
import { sendRawEmail, type SenderMailbox } from "@/services/sender";
import type { ExternalEmailSendResult } from "@/shared/contracts/external-email";
import { ApiError, conflict, invalidRequest } from "@/shared/errors";

export const VERIFICATION_CODE_TTL_SECONDS = 30 * 60;
export const VERIFICATION_RESEND_MIN_SECONDS = 60;
export const VERIFICATION_MAX_ATTEMPTS = 5;
/** 1 時間に送れる確認メールの数。登録のやり直しで試行回数の上限を回し、組織のドメインから大量に送らせないため。 */
export const VERIFICATION_MAX_SENDS_PER_HOUR = 5;

const SEND_ACTIONS = ["user.external_email.set", "user.external_email.resend"];

// 登録と再送はどちらも監査ログに残るので、それを数えて送信の回数を縛る。
async function assertSendAllowed(db: Db, userId: string): Promise<void> {
	const [last] = await db
		.select({ createdAt: schema.emailVerifications.createdAt })
		.from(schema.emailVerifications)
		.where(eq(schema.emailVerifications.userId, userId))
		.limit(1);
	if (last && Date.now() - last.createdAt.getTime() < VERIFICATION_RESEND_MIN_SECONDS * 1000) {
		throw new ApiError("rate_limited", "前回の送信から間隔が短すぎます。1 分ほど待ってから送り直してください");
	}
	const since = new Date(Date.now() - 3600 * 1000);
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(schema.auditLogs)
		.where(
			and(
				eq(schema.auditLogs.targetType, "user"),
				eq(schema.auditLogs.targetId, userId),
				sql`${schema.auditLogs.action} in (${sql.join(
					SEND_ACTIONS.map((a) => sql`${a}`),
					sql`, `,
				)})`,
				gt(schema.auditLogs.createdAt, since),
			),
		);
	if (Number(row?.n ?? 0) >= VERIFICATION_MAX_SENDS_PER_HOUR) {
		throw new ApiError("rate_limited", "確認メールを送りすぎています。1 時間ほど待ってから送り直してください");
	}
}

export const VERIFICATION_NO_SENDER_REASON =
	"送信できるアドレスがまだありません。ドメインで送信を有効にしてから送り直してください";

// byte % 10 は 0〜5 が出やすくなるので、上限未満の値だけを使って偏りを無くす。
function generateVerificationCode(): string {
	const limit = 4_294_000_000;
	for (;;) {
		const [n] = new Uint32Array(randomBytes(4).buffer);
		if (n! < limit) return String(n! % 1_000_000).padStart(6, "0");
	}
}

// 外部アドレスをプライマリと衝突させると、auth.ts の findLoginUser が
// 外部 → プライマリの順で解決するため、どちらで入ったのかが曖昧になる。
async function assertExternalEmailAvailable(db: Db, userId: string, email: string): Promise<void> {
	const [other] = await db
		.select({ id: schema.users.id })
		.from(schema.users)
		.where(and(eq(schema.users.externalEmail, email), ne(schema.users.id, userId)))
		.limit(1);
	if (other) throw conflict("そのメールアドレスは既に使われています");

	const [address] = await db
		.select({ id: schema.addresses.id })
		.from(schema.addresses)
		.where(eq(schema.addresses.address, email))
		.limit(1);
	if (address) throw conflict("そのメールアドレスは既にメールボックスとして使われています");
}

async function pickSender(db: Db, userId: string): Promise<SenderMailbox | null> {
	// 本人のプライマリが送信できるならそれを優先する。
	const [user] = await db
		.select({ primaryAddressId: schema.users.primaryAddressId })
		.from(schema.users)
		.where(eq(schema.users.id, userId))
		.limit(1);
	if (user?.primaryAddressId) {
		const row = await db
			.select({
				address: schema.addresses.address,
				displayName: schema.addresses.displayName,
				sendingStatus: schema.domains.sendingStatus,
			})
			.from(schema.addresses)
			.innerJoin(schema.domains, eq(schema.domains.id, schema.addresses.domainId))
			.where(eq(schema.addresses.id, user.primaryAddressId))
			.get();
		if (row?.address && row.sendingStatus === "active") {
			return { address: row.address, name: row.displayName ?? undefined };
		}
	}

	// 無ければ送信が有効なドメインのメールボックスを、誰かのプライマリ（owner を優先）→ 作成順に取る。
	const ownerPrimary = await db
		.select({
			address: schema.addresses.address,
			displayName: schema.addresses.displayName,
		})
		.from(schema.addresses)
		.innerJoin(schema.domains, eq(schema.domains.id, schema.addresses.domainId))
		.where(
			and(
				eq(schema.domains.sendingStatus, "active"),
				eq(schema.addresses.kind, "mailbox"),
				sql`${schema.addresses.id} in (
					select ${schema.users.primaryAddressId} from ${schema.users}
					where ${schema.users.role} = 'owner'
					  and ${schema.users.primaryAddressId} is not null
					  and ${schema.users.primaryAddressId} = ${schema.addresses.id}
				)`,
			),
		)
		.orderBy(asc(schema.addresses.createdAt), asc(schema.addresses.id))
		.limit(1)
		.get();
	if (ownerPrimary?.address) return { address: ownerPrimary.address, name: ownerPrimary.displayName ?? undefined };

	const mailbox = await db
		.select({
			address: schema.addresses.address,
			displayName: schema.addresses.displayName,
		})
		.from(schema.addresses)
		.innerJoin(schema.domains, eq(schema.domains.id, schema.addresses.domainId))
		.where(and(eq(schema.domains.sendingStatus, "active"), eq(schema.addresses.kind, "mailbox")))
		.orderBy(asc(schema.addresses.createdAt), asc(schema.addresses.id))
		.limit(1)
		.get();
	if (mailbox?.address) return { address: mailbox.address, name: mailbox.displayName ?? undefined };
	return null;
}

async function sendVerificationMail(
	db: Db,
	env: CloudflareEnv,
	userId: string,
	toEmail: string,
	code: string,
): Promise<ExternalEmailSendResult> {
	const sender = await pickSender(db, userId);
	if (!sender) return { sent: false, reason: VERIFICATION_NO_SENDER_REASON };

	const raw = composeMime({
		messageId: newId("message"),
		fromAddr: sender.address,
		fromName: sender.name,
		toAddr: toEmail,
		subject: "外部アドレスの確認コード",
		textBody: [
			"外部アドレスの確認コードをお送りします。",
			"",
			`確認コード: ${code}`,
			"",
			"このコードをアプリの画面に入力してください。コードは 30 分で期限が切れます。",
		].join("\n"),
	});
	await sendRawEmail(env, { from: sender, to: [{ address: toEmail }], raw });
	return { sent: true };
}

/**
 * 外部アドレスを登録（差し替え）する。コードを発行して確認メールを送り、未確認に戻す。
 * createdAt を「最後に送った時刻」として使う（再送の 60 秒制限の判定に使う）。
 */
export async function registerExternalEmail(
	db: Db,
	env: CloudflareEnv,
	userId: string,
	email: string,
): Promise<ExternalEmailSendResult> {
	const normalized = email.trim().toLowerCase();
	await assertExternalEmailAvailable(db, userId, normalized);
	await assertSendAllowed(db, userId);

	const code = generateVerificationCode();
	const codeHash = await hashToken(code);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + VERIFICATION_CODE_TTL_SECONDS * 1000);

	await db
		.update(schema.users)
		.set({ externalEmail: normalized, externalVerifiedAt: null, email: normalized })
		.where(eq(schema.users.id, userId));

	await db
		.insert(schema.emailVerifications)
		.values({ userId, email: normalized, codeHash, attempts: 0, expiresAt, createdAt: now })
		.onConflictDoUpdate({
			target: schema.emailVerifications.userId,
			set: { email: normalized, codeHash, attempts: 0, expiresAt, createdAt: now },
		});

	return await sendVerificationMail(db, env, userId, normalized, code);
}

/** 確認に成功したら外部アドレスを返す。成功までの各失敗は ApiError。 */
export async function verifyExternalEmail(db: Db, userId: string, code: string): Promise<string> {
	const row = await db
		.select()
		.from(schema.emailVerifications)
		.where(eq(schema.emailVerifications.userId, userId))
		.get();
	if (!row) throw invalidRequest("確認コードがありません。もう一度送り直してください");

	if (row.expiresAt.getTime() < Date.now()) {
		await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.userId, userId));
		throw invalidRequest("確認コードの期限が切れました。送り直してください");
	}

	if (!secretEquals(await hashToken(code), row.codeHash)) {
		const attempts = row.attempts + 1;
		if (attempts >= VERIFICATION_MAX_ATTEMPTS) {
			await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.userId, userId));
			throw invalidRequest("試行回数の上限に達しました。確認メールを送り直してください");
		}
		await db
			.update(schema.emailVerifications)
			.set({ attempts })
			.where(eq(schema.emailVerifications.userId, userId));
		throw invalidRequest("確認コードが違います");
	}

	await db.update(schema.users).set({ externalVerifiedAt: new Date() }).where(eq(schema.users.id, userId));
	await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.userId, userId));
	return row.email;
}

export async function resendExternalEmail(
	db: Db,
	env: CloudflareEnv,
	userId: string,
): Promise<ExternalEmailSendResult> {
	const row = await db
		.select()
		.from(schema.emailVerifications)
		.where(eq(schema.emailVerifications.userId, userId))
		.get();
	if (!row) throw invalidRequest("確認コードがありません。先に外部アドレスを登録してください");
	await assertSendAllowed(db, userId);

	const code = generateVerificationCode();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + VERIFICATION_CODE_TTL_SECONDS * 1000);
	await db
		.update(schema.emailVerifications)
		.set({ codeHash: await hashToken(code), attempts: 0, expiresAt, createdAt: now })
		.where(eq(schema.emailVerifications.userId, userId));

	return await sendVerificationMail(db, env, userId, row.email, code);
}
