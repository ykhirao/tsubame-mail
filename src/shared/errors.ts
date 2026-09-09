export const errorCodes = [
	"unauthorized",
	"forbidden",
	"not_found",
	"invalid_request",
	"conflict",
	"rate_limited",
	"internal",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

const statusByCode: Record<ErrorCode, number> = {
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	invalid_request: 400,
	conflict: 409,
	rate_limited: 429,
	internal: 500,
};

export class ApiError extends Error {
	readonly code: ErrorCode;
	readonly status: number;
	readonly details?: unknown;

	constructor(code: ErrorCode, message: string, details?: unknown) {
		super(message);
		this.code = code;
		this.status = statusByCode[code];
		this.details = details;
	}

	toJSON() {
		return { error: { code: this.code, message: this.message, details: this.details } };
	}
}

export const unauthorized = (m = "認証が必要です") => new ApiError("unauthorized", m);
export const forbidden = (m = "権限がありません") => new ApiError("forbidden", m);
export const notFound = (m = "見つかりません") => new ApiError("not_found", m);
export const invalidRequest = (m: string, details?: unknown) =>
	new ApiError("invalid_request", m, details);
export const conflict = (m: string) => new ApiError("conflict", m);
