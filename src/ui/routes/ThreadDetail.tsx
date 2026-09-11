import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { MessageDetail } from "@/shared/contracts/messages";
import { AttachmentApi, MessagesApi, ThreadsApi, AddressesApi } from "@/ui/lib/api";
import { EmptyState } from "@/ui/components/EmptyState";
import { FullScreenSpinner } from "@/ui/components/Spinner";
import { hasRemoteImages, MessageHtml } from "@/ui/components/MessageHtml";
import { Attachments } from "@/ui/components/Attachments";
import { ThreadNotificationSheet } from "@/ui/components/ThreadNotificationSheet";
import { CatchAllBadge } from "@/ui/components/mobile/CatchAllBadge";
import { formatDateTime } from "@/ui/lib/format";
import { useIsMobile } from "@/ui/lib/useIsMobile";

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

const stroke = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.8,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

const BackIcon = () => (
	<svg className="h-5 w-5" viewBox="0 0 24 24" {...stroke}>
		<path d="m15 5-7 7 7 7" />
	</svg>
);
const DotsIcon = () => (
	<svg className="h-5 w-5" viewBox="0 0 24 24" {...stroke}>
		<circle cx="5" cy="12" r="1" />
		<circle cx="12" cy="12" r="1" />
		<circle cx="19" cy="12" r="1" />
	</svg>
);

export function ThreadDetail() {
	const { id } = useParams();
	const navigate = useNavigate();
	const isMobile = useIsMobile();
	const [searchParams] = useSearchParams();
	const includeTrash = searchParams.get("view") === "trash";
	const [messages, setMessages] = useState<MessageDetail[] | null>(null);
	const [subject, setSubject] = useState<string | null>(null);
	const [notFound, setNotFound] = useState(false);
	const [imagesAllowed, setImagesAllowed] = useState<ReadonlySet<string>>(new Set());
	const [starred, setStarred] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
	const [notifSheetOpen, setNotifSheetOpen] = useState(false);
	const [catchAllIds, setCatchAllIds] = useState<ReadonlySet<string>>(new Set());

	// envelope_to は受信メールすべてに入るので、受け皿がキャッチオールかどうかはアドレスで見る。
	useEffect(() => {
		let alive = true;
		AddressesApi.list()
			.then((res) => alive && setCatchAllIds(new Set(res.data.filter((a) => a.isCatchAll).map((a) => a.id))))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	useEffect(() => {
		if (!id) return;
		let alive = true;
		ThreadsApi.get(id, { includeTrash })
			.then((t) => {
				if (!alive) return;
				setSubject(t.subject);
				setMessages(t.messages);
				setStarred(t.messages.at(-1)?.isStarred ?? false);
				setExpandedIds(new Set());
				const unread = t.messages.filter((m) => !m.isRead);
				void Promise.all(unread.map((m) => MessagesApi.patch(m.id, { isRead: true }))).then(
					() => alive && markLocalRead(t.messages),
				);
			})
			.catch(() => alive && setNotFound(true));
		return () => {
			alive = false;
		};
	}, [id, includeTrash]);

	const markLocalRead = useCallback((msgs: MessageDetail[]) => {
		setMessages((prev) =>
			(prev ?? msgs).map((m) => (m.isRead ? m : { ...m, isRead: true })),
		);
	}, []);

	const lastId = messages?.at(-1)?.id;

	const toggleStar = async () => {
		if (!lastId) return;
		const next = !starred;
		setStarred(next);
		try {
			await MessagesApi.patch(lastId, { isStarred: next });
		} catch {
			setStarred(!next);
		}
	};

	const moveToTrash = async () => {
		if (!lastId) return;
		await MessagesApi.patch(lastId, { status: "trash" });
		navigate("/");
	};

	const markUnread = async () => {
		if (!lastId) return;
		await MessagesApi.patch(lastId, { isRead: false });
		navigate("/");
	};

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
		<article className="card w-full">
			{!isMobile && (
				<header className="flex items-center justify-between gap-2 border-b border-[var(--line-soft)] px-5 py-3">
					<h1 className="min-w-0 truncate text-lg font-bold text-[var(--text)]">
						{subject?.trim() || "（件名なし）"}
					</h1>
					<Link to="/" className="shrink-0 text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
						← 受信箱
					</Link>
				</header>
			)}

			{isMobile && (
				<header className="sticky top-0 z-20 flex items-center gap-1 border-b border-[var(--line-soft)] bg-[var(--surface)] px-2 py-1">
					<button
						type="button"
						onClick={() => navigate(-1)}
						aria-label="戻る"
						className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
					>
						<BackIcon />
					</button>
					<h1 className="line-clamp-2 min-w-0 flex-1 text-sm font-bold leading-tight text-[var(--text)]">
						{subject?.trim() || "（件名なし）"}
					</h1>
					<button
						type="button"
						onClick={() => void toggleStar()}
						aria-label={starred ? "スターを外す" : "スターを付ける"}
						className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
					>
						<svg
							className="h-5 w-5"
							viewBox="0 0 24 24"
							fill={starred ? "var(--warning)" : "none"}
							stroke={starred ? "var(--warning)" : "currentColor"}
							strokeWidth="1.8"
							strokeLinejoin="round"
						>
							<path d="m12 4 2.4 5 5.6.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.6-.8z" />
						</svg>
					</button>
					<button
						type="button"
						onClick={() => setMenuOpen(true)}
						aria-label="その他の操作"
						className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
					>
						<DotsIcon />
					</button>
				</header>
			)}

			<div className={`divide-y divide-[var(--line-soft)] ${isMobile ? "pb-24" : ""}`}>
				{messages.map((m) => {
					const color = avatarColor(m.fromAddr);
					const isLast = m.id === messages.at(-1)?.id;
					if (isMobile && !isLast && !expandedIds.has(m.id)) {
						return (
							<button
								key={m.id}
								type="button"
								onClick={() => setExpandedIds((prev) => new Set(prev).add(m.id))}
								className="flex w-full items-center gap-3 px-5 py-3 text-left text-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)]"
							>
								<span
									className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
									style={{ background: color.bg, color: color.fg }}
									aria-hidden
								>
									{initialOf(m)}
								</span>
								<span className="min-w-0 flex-1 truncate">
									<span className="text-[var(--text)]">{m.fromName || m.fromAddr}</span>
									<span className="ml-2 truncate">{m.subject}</span>
								</span>
								<span className="shrink-0 text-xs">{formatDateTime(m.receivedAt)}</span>
							</button>
						);
					}
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
										<span className="flex shrink-0 items-baseline gap-2 text-xs text-[var(--text-muted)]">
											{formatDateTime(m.receivedAt)}
											{m.direction === "inbound" && (
												<a
													href={AttachmentApi.rawUrl(m.id)}
													download
													title="受信したままの元のメール（.eml）を保存する"
													className="hover:text-[var(--text)] hover:underline"
												>
													eml を保存
												</a>
											)}
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

									{m.envelopeTo && catchAllIds.has(m.addressId) && (
										<p className="mt-1 flex items-center gap-1 text-xs text-[var(--text-muted)]">
											<CatchAllBadge />
											<span>宛先 {m.envelopeTo}</span>
										</p>
									)}

									<div className="mt-3">
										{m.htmlBody ? (
											<>
												{!imagesAllowed.has(m.id) && hasRemoteImages(m.htmlBody) && (
													<div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--surface-sunken)] px-3 py-2 text-xs text-[var(--text-muted)]">
														<span>
															外部の画像を読み込んでいません。表示すると、開いたことや IP アドレスが送信者に伝わることがあります。
														</span>
														<button
															onClick={() => setImagesAllowed((prev) => new Set(prev).add(m.id))}
															className="pill shrink-0 border border-[var(--line)] px-3 py-1 text-xs text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)]"
														>
															画像を表示
														</button>
													</div>
												)}
												<MessageHtml html={m.htmlBody} allowRemoteImages={imagesAllowed.has(m.id)} />
											</>
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

			{!isMobile && (
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
			)}

			{isMobile && (
				<div
					className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-[var(--line)] bg-[var(--surface)] px-4 pt-3"
					style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
				>
					<button
						disabled={!replyTarget}
						onClick={() => navigate(`/compose?reply=${replyTarget?.id ?? ""}`)}
						className="h-12 flex-1 rounded-full bg-[var(--accent)] text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
					>
						返信
					</button>
					<button
						disabled={!replyTarget}
						onClick={() => navigate(`/compose?reply=${replyTarget?.id ?? ""}&all=1`)}
						className="h-12 flex-1 rounded-full border border-[var(--line)] text-sm text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
					>
						全員に返信
					</button>
				</div>
			)}

			{isMobile && menuOpen && (
				<div className="fixed inset-0 z-40">
					<div
						className="absolute inset-0 bg-black/40"
						onClick={() => setMenuOpen(false)}
						aria-hidden
					/>
					<div
						className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-[var(--surface)] p-2"
						style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
					>
						<button
							type="button"
							onClick={() => {
								setMenuOpen(false);
								setNotifSheetOpen(true);
							}}
							className="flex h-12 w-full items-center px-4 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
						>
							この会話の通知…
						</button>
						<button
							type="button"
							onClick={() => {
								setMenuOpen(false);
								void moveToTrash();
							}}
							className="flex h-12 w-full items-center px-4 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
						>
							ゴミ箱へ
						</button>
						<button
							type="button"
							onClick={() => {
								setMenuOpen(false);
								void markUnread();
							}}
							className="flex h-12 w-full items-center px-4 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)]"
						>
							未読にする
						</button>
					</div>
				</div>
			)}

			{notifSheetOpen && id && (
				<ThreadNotificationSheet
					threadId={id}
					mailboxId={messages[0]?.addressId ?? null}
					onClose={() => setNotifSheetOpen(false)}
				/>
			)}
		</article>
	);
}
