import { z } from "zod";
import { paginationQuery } from "./common";

const filter = z.string().min(1).max(100).optional();

export const auditLogQuery = paginationQuery.extend({
	targetType: filter,
	targetId: filter,
	actorId: filter,
	action: filter,
});
export type AuditLogQuery = z.infer<typeof auditLogQuery>;

export const auditLogEntry = z.object({
	id: z.string(),
	actorId: z.string().nullable(),
	action: z.string(),
	targetType: z.string().nullable(),
	targetId: z.string().nullable(),
	meta: z.unknown(),
	ip: z.string().nullable(),
	createdAt: z.number(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntry>;
