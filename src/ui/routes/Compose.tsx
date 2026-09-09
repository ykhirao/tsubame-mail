import {
	useCallback,
	useEffect,
	useState,
	type FormEvent,
	type ReactNode,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { MyAddress } from "@/shared/contracts/addresses";
import { MessagesApi } from "@/ui/lib/api";
import { useAuth } from "@/ui/lib/auth";
import { FullScreenSpinner } from "@/ui/components/Spinner";

function readAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const data = reader.result;
			if (typeof data === "string") {
				// FileReader は "data:...;base64,..." を返すので、前置きを落とす。
				const comma = data.indexOf(",");
				resolve(comma >= 0 ? data.slice(comma + 1) : data);
			} else {
				reject(new Error("ファイルの読み込みに失敗しました"));
			}
		};
		reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"));
		reader.readAsDataURL(file);
	});
}

type PendingAttachment = { file: File; base64: string };

const underlineCls =
	"w-full border-b border-[var(--line)] bg-transparent px-1 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none";

const labelCls = "w-16 shrink-0 text-sm text-[var(--text-muted)]";

const sendBtnCls =
	"rounded-full bg-[var(--accent)] px-6 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">{label}</label>
			{children}
		</div>
	);
}

export function Compose() {
	const { me } = useAuth();
	const navigate = useNavigate();
	const [params] = useSearchParams();

	const replyMessageId = params.get("reply");
	const replyAllParam = params.get("all") === "1";
	const requestedFrom = params.get("from") ?? "";

	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<{ status: string } | null>(null);

	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCc, setShowCc] = useState(false);
	const [showBcc, setShowBcc] = useState(false);
	const [subject, setSubject] = useState("");
	const [text, setText] = useState("");
	const [pending, setPending] = useState<PendingAttachment[]>([]);

	const [replyAll, setReplyAll] = useState(replyAllParam);
	const [replyText, setReplyText] = useState("");
	const [replyBusy, setReplyBusy] = useState(false);
	const [originalSubject, setOriginalSubject] = useState<string | null>(null);
	const [replyTo, setReplyTo] = useState("");
	const [replyCc, setReplyCc] = useState("");

	const writable = (me?.addresses ?? []).filter((a) => a.level === "write");

	// from パラメータは address の「id か アドレス文字列」のどちらでも来る。
	const resolveFrom = useCallback(
		(v: string): string => {
			const found = (me?.addresses ?? []).find((a) => a.id === v);
			return found ? found.address : v;
		},
		[me],
	);

	useEffect(() => {
		if (!replyMessageId) return;
		let alive = true;
		MessagesApi.get(replyMessageId)
			.then((m) => {
				if (!alive) return;
				setOriginalSubject(m.subject);
				setReplyTo(m.fromAddr);
				setReplyCc(m.ccAddr ?? "");

				// 返信の差出人はサーバも元メッセージの受信アドレスで決めるので、ここも合わせる。
				const mailboxId = m.addressId;
				const mailbox = (me?.addresses ?? []).find((a) => a.id === mailboxId);
				if (mailbox) setFrom(mailbox.address);
			})
			.catch(() => null);
		return () => {
			alive = false;
		};
	}, [replyMessageId, me]);

	useEffect(() => {
		if (replyMessageId) return;
		if (writable.length === 0 || from) return;
		let chosen = writable[0]!.address;
		if (requestedFrom) {
			const v = resolveFrom(requestedFrom);
			if (writable.some((a) => a.address === v)) chosen = v;
		}
		setFrom(chosen);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [writable, requestedFrom, replyMessageId, from]);

	const onFiles = async (files: FileList | null) => {
		if (!files) return;
		const list: PendingAttachment[] = [];
		for (const file of Array.from(files)) {
			list.push({ file, base64: await readAsBase64(file) });
		}
		setPending((prev) => [...prev, ...list]);
	};

	const submitNew = async (e: FormEvent) => {
		e.preventDefault();
		if (to.trim() === "") {
			setError("宛先を入力してください");
			return;
		}
		if (from === "") {
			setError("差出人を選んでください");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const res = await MessagesApi.send({
				from,
				to: to.trim(),
				cc: showCc && cc.trim() ? cc.trim() : undefined,
				bcc: showBcc && bcc.trim() ? bcc.trim() : undefined,
				subject: subject.trim(),
				text: text,
				attachments: pending.map((p) => ({
					filename: p.file.name,
					contentType: p.file.type || "application/octet-stream",
					base64: p.base64,
				})),
			});
			setDone(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : "送信に失敗しました");
		} finally {
			setBusy(false);
		}
	};

	const submitReply = async (e: FormEvent) => {
		e.preventDefault();
		setReplyBusy(true);
		setError(null);
		try {
			const res = await MessagesApi.reply(replyMessageId!, {
				text: replyText,
				replyAll,
				attachments: pending.map((p) => ({
					filename: p.file.name,
					contentType: p.file.type || "application/octet-stream",
					base64: p.base64,
				})),
			});
			setDone(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : "返信に失敗しました");
		} finally {
			setReplyBusy(false);
		}
	};

	if (done) {
		return (
			<div className="card mx-auto max-w-md p-8 text-center">
				<p className="mb-1 text-3xl">📨</p>
				<h1 className="mb-2 text-lg font-bold text-[var(--text)]">送信を予約しました</h1>
				<p className="mb-5 text-sm text-[var(--text-muted)]">
					メール {done.status === "sent" ? "送信" : "送信待ち（キュー）"}に登録されました。
				</p>
				<Link
					to="/"
					className="inline-block rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
				>
					受信箱に戻る
				</Link>
			</div>
		);
	}

	if (replyMessageId && originalSubject === null) return <FullScreenSpinner />;

	if (replyMessageId) {
		const displaySubject = originalSubject?.trim()
			? /^re:/i.test(originalSubject.trim())
				? originalSubject.trim()
				: `Re: ${originalSubject.trim()}`
			: "（件名なし）";

		return (
			<article className="card mx-auto w-full max-w-2xl p-5">
				<h1 className="mb-1 text-lg font-bold text-[var(--text)]">返信</h1>
				<p className="mb-4 truncate text-sm text-[var(--text-muted)]">{displaySubject}</p>

				{error && (
					<div className="mb-4 rounded border border-[var(--danger)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--danger)]">
						{error}
					</div>
				)}

				<form onSubmit={submitReply} className="space-y-4">
					<div className="flex items-center gap-2">
						<span className={labelCls}>差出人</span>
						<span className="flex-1 truncate text-sm text-[var(--text)]">{from || "元メールのアドレス"}</span>
					</div>
					<div className="flex items-center gap-2">
						<span className={labelCls}>宛先</span>
						<span className="flex-1 truncate text-sm text-[var(--text)]">{replyTo}</span>
					</div>
					{replyAll && replyCc && (
						<div className="flex items-center gap-2">
							<span className={labelCls}>Cc</span>
							<span className="flex-1 truncate text-sm text-[var(--text)]">{replyCc}</span>
						</div>
					)}

					<textarea
						value={replyText}
						onChange={(e) => setReplyText(e.target.value)}
						rows={10}
						placeholder="返信内容を入力"
						className="min-h-[300px] w-full resize-y bg-transparent text-sm leading-relaxed text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none"
					/>

					<AttachRow pending={pending} onFiles={onFiles} />

					<div className="flex items-center justify-between gap-2">
						<label className="flex items-center gap-1.5 text-sm text-[var(--text-muted)]">
							<input
								type="checkbox"
								checked={replyAll}
								onChange={(e) => setReplyAll(e.target.checked)}
								className="accent-[var(--accent)]"
							/>
							全員に返信
						</label>
						<div className="flex items-center gap-3">
							<Link to="/" className="text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
								破棄
							</Link>
							<button type="submit" disabled={replyBusy} className={sendBtnCls}>
								{replyBusy ? "送信中…" : "送信"}
							</button>
						</div>
					</div>
				</form>
			</article>
		);
	}

	return (
		<article className="card mx-auto w-full max-w-2xl p-5">
			<h1 className="mb-4 text-lg font-bold text-[var(--text)]">新しいメール</h1>

			{error && (
				<div className="mb-4 rounded border border-[var(--danger)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[var(--danger)]">
					{error}
				</div>
			)}

			<form onSubmit={submitNew} className="space-y-4">
				<div className="flex items-center gap-2">
					<span className={labelCls}>差出人</span>
					<select
						value={from}
						onChange={(e) => setFrom(e.target.value)}
						className={underlineCls + " flex-1"}
					>
						<option value="" disabled>
							選択してください
						</option>
						{writable.map((a: MyAddress) => (
							<option key={a.id} value={a.address}>
								{a.displayName ? `${a.displayName} <${a.address}>` : a.address}
							</option>
						))}
					</select>
					<div className="flex shrink-0 items-center gap-3 text-xs">
						{!showCc && (
							<button
								type="button"
								onClick={() => setShowCc(true)}
								className="text-[var(--accent)] hover:underline"
							>
								Cc
							</button>
						)}
						{!showBcc && (
							<button
								type="button"
								onClick={() => setShowBcc(true)}
								className="text-[var(--accent)] hover:underline"
							>
								Bcc
							</button>
						)}
					</div>
				</div>

				<div className="flex items-center gap-2">
					<span className={labelCls}>宛先</span>
					<input
						value={to}
						onChange={(e) => setTo(e.target.value)}
						placeholder="カンマ区切りで複数"
						className={underlineCls}
						required
					/>
				</div>

				{showCc && (
					<div className="flex items-center gap-2">
						<span className={labelCls}>Cc</span>
						<input
							value={cc}
							onChange={(e) => setCc(e.target.value)}
							placeholder="カンマ区切りで複数"
							className={underlineCls}
						/>
						<button
							type="button"
							onClick={() => setShowCc(false)}
							aria-label="Cc を削除"
							className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text)]"
						>
							×
						</button>
					</div>
				)}

				{showBcc && (
					<div className="flex items-center gap-2">
						<span className={labelCls}>Bcc</span>
						<input
							value={bcc}
							onChange={(e) => setBcc(e.target.value)}
							placeholder="カンマ区切りで複数"
							className={underlineCls}
						/>
						<button
							type="button"
							onClick={() => setShowBcc(false)}
							aria-label="Bcc を削除"
							className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text)]"
						>
							×
						</button>
					</div>
				)}

				<div className="flex items-center gap-2">
					<span className={labelCls}>件名</span>
					<input
						value={subject}
						onChange={(e) => setSubject(e.target.value)}
						className={underlineCls}
					/>
				</div>

				<textarea
					value={text}
					onChange={(e) => setText(e.target.value)}
					rows={10}
					placeholder="本文"
					className="min-h-[300px] w-full resize-y bg-transparent text-sm leading-relaxed text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none"
				/>

				<AttachRow pending={pending} onFiles={onFiles} />

				<div className="flex items-center justify-end gap-3">
					<Link to="/" className="text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
						破棄
					</Link>
					<button type="submit" disabled={busy} className={sendBtnCls}>
						{busy ? "送信中…" : "送信"}
					</button>
				</div>
			</form>
		</article>
	);
}

function AttachRow({
	pending,
	onFiles,
}: {
	pending: PendingAttachment[];
	onFiles: (files: FileList | null) => void;
}) {
	return (
		<div>
			<label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">添付</label>
			<input
				type="file"
				multiple
				onChange={(e) => void onFiles(e.target.files)}
				className="block w-full text-sm text-[var(--text-muted)] file:mr-2 file:rounded-full file:border-0 file:bg-[var(--surface-hover)] file:px-3 file:py-1 file:text-sm file:text-[var(--text)] hover:file:bg-[var(--surface-selected)]"
			/>
			{pending.length > 0 && (
				<ul className="mt-2 space-y-1 text-xs text-[var(--text-muted)]">
					{pending.map((p, i) => (
						<li key={`${p.file.name}-${i}`} className="flex items-center gap-1">
							<span>📎 {p.file.name}</span>
							{(p.file.size / 1024).toFixed(0)} KB
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
