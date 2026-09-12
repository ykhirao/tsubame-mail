import type { AttachmentMeta } from "@/shared/contracts/messages";
import { AttachmentApi } from "@/ui/lib/api";
import { formatBytes } from "@/ui/lib/format";

export function Attachments({
	attachments,
	includeTrash = false,
}: {
	attachments: AttachmentMeta[];
	includeTrash?: boolean;
}) {
	if (attachments.length === 0) return null;
	const trashQuery = includeTrash ? "?includeTrash=true" : "";
	return (
		<div className="flex flex-wrap gap-2 border-t border-[var(--line-soft)] pt-3">
			{attachments.map((a) => (
				<a
					key={a.id}
					href={`${AttachmentApi.url(a.id)}${trashQuery}`}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-[var(--line)] px-3 py-1.5 text-xs text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] sm:min-h-0"
				>
					<span>📎</span>
					<span className="max-w-64 truncate">{a.filename}</span>
					<span className="text-[var(--text-muted)]">{formatBytes(a.sizeBytes)}</span>
				</a>
			))}
		</div>
	);
}
