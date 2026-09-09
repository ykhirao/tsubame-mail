import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { MessageDetail } from "@/shared/contracts/messages";
import { MessagesApi, ThreadsApi } from "@/ui/lib/api";
import { EmptyState } from "@/ui/components/EmptyState";
import { FullScreenSpinner } from "@/ui/components/Spinner";
import { MessageHtml } from "@/ui/components/MessageHtml";
import { Attachments } from "@/ui/components/Attachments";
import { formatDateTime } from "@/ui/lib/format";

const AVATAR_COLORS = [
	{ bg: "#fce8e6", fg: "#c5221f" },
	{ bg: "#fef7e0", fg: "#b06000" },
	{ bg: "#e6f4ea", fg: "#1e8e3e" },
	{ bg: "#e8f0fe", fg: "#0b57d0" },
	{ bg: "#f3e8fd", fg: "#8430ce" },
	{ bg: "#e0f7fa", fg: "#007b83" },
];

function avatarColor(addr: string) {
	let sum = 0;
	for (let i = 0; i < addr.length; i++) sum += addr.charCodeAt(i);
	return AVATAR_COLORS[sum % AVATAR_COLORS.length]!;
}

function initialOf(m: MessageDetail): string {
	const name = m.fromName?.trim();
	if (name) return name[0]!.toUpperCase();
	return m.fromAddr[0]?.toUpperCase() ?? "?";
}

export function ThreadDetail() {
	const { id } = useParams();
	const navigate = useNavigate();
	const [messages, setMessages] = useState<MessageDetail[] | null>(null);
	const [subject, setSubject] = useState<string | null>(null);
	const [notFound, setNotFound] = useState(false);

	useEffect(() => {
		if (!id) return;
		let alive = true;
		ThreadsApi.get(id)
			.then((t) => {
				if (!alive) return;
				setSubject(t.subject);
				setMessages(t.messages);
				const unread = t.messages.filter((m) => !m.isRead);
				void Promise.all(unread.map((m) => MessagesApi.patch(m.id, { isRead: true }))).then(
					() => alive && markLocalRead(t.messages),
				);
			})
			.catch(() => alive && setNotFound(true));
		return () => {
			alive = false;
		};
	}, [id]);

	const markLocalRead = useCallback((msgs: MessageDetail[]) => {
		setMessages((prev) =>
			(prev ?? msgs).map((m) => (m.isRead ? m : { ...m, isRead: true })),
		);
	}, []);

	if (notFound) {
		return (
			<EmptyState icon="🔍" title="スレッドが見つかりません">
				<Link to="/" className="text-[var(--accent)] hover:underline">
					受信箱に戻る
				</Link>
			</EmptyState>
		);
	}

	if (!messages) return <FullScreenSpinner />;

	const replyTarget =
		messages.filter((m) => m.direction === "inbound").at(-1) ?? messages.at(-1);

	return (
		<article className="card mx-auto w-full max-w-[1000px]">
			<header className="flex items-center justify-between gap-2 border-b border-[var(--line-soft)] px-5 py-3">
				<h1 className="min-w-0 truncate text-lg font-bold text-[var(--text)]">
					{subject?.trim() || "（件名なし）"}
				</h1>
				<Link to="/" className="shrink-0 text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
					← 受信箱
				</Link>
			</header>

			<div className="divide-y divide-[var(--line-soft)]">
				{messages.map((m) => {
					const color = avatarColor(m.fromAddr);
					return (
						<section key={m.id} className="px-5 py-4">
							<div className="flex items-start gap-3">
								<div
									className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
									style={{ background: color.bg, color: color.fg }}
									aria-hidden
								>
									{initialOf(m)}
								</div>

								<div className="min-w-0 flex-1">
									<div className="flex items-baseline justify-between gap-2">
										<p className="min-w-0 truncate text-sm text-[var(--text)]">
											<span className="font-semibold">
												{m.fromName || m.fromAddr}
											</span>
											<span className="ml-1 text-xs text-[var(--text-muted)]">
												&lt;{m.fromAddr}&gt;
											</span>
										</p>
										<span className="shrink-0 text-xs text-[var(--text-muted)]">
											{formatDateTime(m.receivedAt)}
										</span>
									</div>

									<p className="mt-0.5 text-xs text-[var(--text-muted)]">
										宛先: {m.toAddr}
										{m.ccAddr ? <span className="ml-2">Cc: {m.ccAddr}</span> : null}
										{m.spamVerdict && m.spamVerdict !== "clean" ? (
											<span className="ml-2 rounded bg-[var(--warning)]/15 px-1 text-[var(--warning)]">
												スパム判定
											</span>
										) : null}
									</p>

									<div className="mt-3">
										{m.htmlBody ? (
											<MessageHtml html={m.htmlBody} />
										) : m.textBody ? (
											<div className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text)]">
												{m.textBody}
											</div>
										) : (
											<p className="text-sm text-[var(--text-muted)]">本文がありません</p>
										)}
									</div>

									{m.attachments.length > 0 && (
										<div className="mt-3">
											<Attachments attachments={m.attachments} />
										</div>
									)}
								</div>
							</div>
						</section>
					);
				})}
			</div>

			<footer className="flex items-center gap-2 border-t border-[var(--line-soft)] px-5 py-3">
				<button
					disabled={!replyTarget}
					onClick={() => navigate(`/compose?reply=${replyTarget?.id ?? ""}`)}
					className="pill border border-[var(--line)] px-4 py-1.5 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
				>
					返信
				</button>
				<button
					disabled={!replyTarget}
					onClick={() => navigate(`/compose?reply=${replyTarget?.id ?? ""}&all=1`)}
					className="pill border border-[var(--line)] px-4 py-1.5 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
				>
					全員に返信
				</button>
			</footer>
		</article>
	);
}
