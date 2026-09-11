import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import type {
	MailboxNotification,
	NotificationAction,
	NotificationRule,
	NotificationRuleMatcher,
} from "@/shared/contracts/notifications";
import { NotificationsApi } from "@/ui/lib/api";
import { Button } from "@/ui/components/Button";
import { CatchAllBadge } from "@/ui/components/mobile/CatchAllBadge";
import { formatDateTime } from "@/ui/lib/format";
import { SettingsPage, actionLabels, matcherSummary, ruleTemplateByKey } from "./ruleShared";

const actions: NotificationAction[] = ["always", "normal", "silent", "never"];

const actionHint: Record<NotificationAction, string> = {
	always: "おやすみ時間でも必ず通知",
	normal: "通常どおり通知",
	silent: "音を鳴らさず通知",
	never: "この条件のメールは通知しない",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<label className="mb-1 block text-sm font-medium text-[var(--text)]">{label}</label>
			{children}
		</div>
	);
}

const inputCls =
	"w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

function Checkbox({
	checked,
	onChange,
	label,
	description,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	label: string;
	description?: string;
}) {
	return (
		<label className="flex min-h-11 items-start gap-2 px-1 py-1">
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				className="mt-1 size-4 shrink-0 rounded border-[var(--line)] text-[var(--accent)] focus:ring-[var(--accent)]"
			/>
			<span className="min-w-0">
				<span className="block text-sm font-medium text-[var(--text)]">{label}</span>
				{description && (
					<span className="block text-xs text-[var(--text-muted)]">{description}</span>
				)}
			</span>
		</label>
	);
}

export function NotificationRuleEdit() {
	const { id } = useParams();
	const isNew = id === "new";
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const template = ruleTemplateByKey(searchParams.get("template"));

	const [mailboxes, setMailboxes] = useState<MailboxNotification[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [notFound, setNotFound] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [name, setName] = useState(template?.name ?? "");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [subject, setSubject] = useState(template?.matcher.subject ?? "");
	const [body, setBody] = useState("");
	const [mailboxIds, setMailboxIds] = useState<Set<string>>(new Set());
	const [hasAttachment, setHasAttachment] = useState(false);
	const [replyToOwn, setReplyToOwn] = useState(false);
	const [ccOnly, setCcOnly] = useState(false);
	const [action, setAction] = useState<NotificationAction>(template?.action ?? "normal");
	const [enabled, setEnabled] = useState(true);

	const [dryResult, setDryResult] = useState<{
		count: number;
		rows: { fromAddr: string; subject: string | null; receivedAt: number }[];
	} | null>(null);
	const [dryBusy, setDryBusy] = useState(false);

	useEffect(() => {
		if (!isNew) {
			void (async () => {
				try {
					const s = await NotificationsApi.get();
					const rule = s.rules.find((r) => r.id === id);
					setMailboxes(s.mailboxes);
					if (!rule) {
						setNotFound(true);
					} else {
						fillRule(rule);
					}
				} catch (e) {
					setError(e instanceof Error ? e.message : "ルールの取得に失敗しました");
				} finally {
					setLoaded(true);
				}
			})();
		} else {
			void (async () => {
				try {
					const s = await NotificationsApi.get();
					setMailboxes(s.mailboxes);
				} catch (e) {
					setError(e instanceof Error ? e.message : "メールボックスの取得に失敗しました");
				} finally {
					setLoaded(true);
				}
			})();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id]);

	function fillRule(rule: NotificationRule) {
		setName(rule.name);
		setFrom(rule.matcher.from ?? "");
		setTo(rule.matcher.to ?? "");
		setSubject(rule.matcher.subject ?? "");
		setBody(rule.matcher.body ?? "");
		setMailboxIds(new Set(rule.matcher.mailboxIds ?? []));
		setHasAttachment(rule.matcher.hasAttachment ?? false);
		setReplyToOwn(rule.matcher.replyToOwn ?? false);
		setCcOnly(rule.matcher.ccOnly ?? false);
		setAction(rule.action);
		setEnabled(rule.enabled);
	}

	const buildMatcher = useCallback((): NotificationRuleMatcher => {
		const m: NotificationRuleMatcher = {};
		if (from) m.from = from;
		if (to) m.to = to;
		if (subject) m.subject = subject;
		if (body) m.body = body;
		if (mailboxIds.size) m.mailboxIds = [...mailboxIds];
		if (hasAttachment) m.hasAttachment = true;
		if (replyToOwn) m.replyToOwn = true;
		if (ccOnly) m.ccOnly = true;
		return m;
	}, [from, to, subject, body, mailboxIds, hasAttachment, replyToOwn, ccOnly]);

	const save = async () => {
		if (!name.trim()) {
			setError("名前を入力してください");
			return;
		}
		setError(null);
		try {
			if (isNew) {
				await NotificationsApi.createRule({
					name: name.trim(),
					matcher: buildMatcher(),
					action,
					enabled: true,
				});
			} else if (id) {
				await NotificationsApi.updateRule(id, {
					name: name.trim(),
					matcher: buildMatcher(),
					action,
				});
			}
			navigate("/settings/notifications/rules");
		} catch (e) {
			setError(e instanceof Error ? e.message : "保存に失敗しました");
		}
	};

	const tryDryRun = async () => {
		setDryBusy(true);
		setDryResult(null);
		try {
			const res = await NotificationsApi.dryRun({
				rule: { name: name.trim() || "試すルール", matcher: buildMatcher(), action, enabled: true },
			});
			setDryResult({
				count: res.data.length,
				rows: res.data.slice(0, 3).map((e) => ({
					fromAddr: e.fromAddr,
					subject: e.subject,
					receivedAt: e.receivedAt,
				})),
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : "試す実行に失敗しました");
		} finally {
			setDryBusy(false);
		}
	};

	const remove = async () => {
		if (!id || isNew) return;
		try {
			await NotificationsApi.deleteRule(id);
			navigate("/settings/notifications/rules");
		} catch (e) {
			setError(e instanceof Error ? e.message : "削除に失敗しました");
		}
	};

	const summaryMatcher = buildMatcher();
	const mailboxName = (mid: string) => mailboxes.find((m) => m.id === mid)?.address;
	const summary = isNew
		? "新しいルールを作ります。最初に一致したルールだけが効きます。"
		: `${actionLabels[action]} ・ ${matcherSummary(summaryMatcher, mailboxName)}`;

	return (
		<SettingsPage title={isNew ? "ルールを追加" : "ルールの編集"} summary={summary}>
			{notFound ? (
				<div className="card px-5 py-10 text-center text-sm text-[var(--text-muted)]">
					ルールが見つかりません
					<Button variant="ghost" onClick={() => navigate("/settings/notifications/rules")}>
						rules
					</Button>
				</div>
			) : !loaded ? (
				<div className="text-sm text-[var(--text-muted)]">読み込み中…</div>
			) : (
				<div className="flex flex-col gap-4">
					{error && (
						<div className="rounded-md border border-[var(--danger)] bg-[var(--surface-hover)] px-4 py-3 text-sm text-[var(--danger)]">
							{error}
						</div>
					)}

					<div className="card flex flex-col gap-3 p-4">
						<Field label="名前">
							<input
								value={name}
								onChange={(e) => setName(e.target.value)}
								maxLength={200}
								placeholder="例: 営業メールを通知しない"
								className={inputCls}
							/>
						</Field>
					</div>

					<div className="card flex flex-col gap-3 p-4">
						<p className="text-sm font-medium text-[var(--text)]">条件（すべてに一致）</p>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<Field label="差出人を含む">
								<input
									value={from}
									onChange={(e) => setFrom(e.target.value)}
									placeholder="部分一致"
									className={inputCls}
								/>
							</Field>
							<Field label="宛先を含む">
								<input
									value={to}
									onChange={(e) => setTo(e.target.value)}
									placeholder="部分一致"
									className={inputCls}
								/>
							</Field>
							<Field label="件名を含む">
								<input
									value={subject}
									onChange={(e) => setSubject(e.target.value)}
									placeholder="部分一致"
									className={inputCls}
								/>
							</Field>
							<Field label="本文を含む">
								<input
									value={body}
									onChange={(e) => setBody(e.target.value)}
									placeholder="部分一致"
									className={inputCls}
								/>
							</Field>
						</div>
						<p className="text-xs text-[var(--text-muted)]">
							条件は部分一致で、大文字小文字は無視します。空欄は条件にしません。
						</p>

						<div>
							<label className="mb-1 block text-sm font-medium text-[var(--text)]">
								メールボックス
							</label>
							{mailboxes.length === 0 ? (
								<p className="text-xs text-[var(--text-muted)]">メールボックスがありません</p>
							) : (
								<div className="flex flex-col gap-1">
									{mailboxes.map((m) => (
										<label key={m.id} className="flex min-h-11 items-center gap-2 px-1">
											<input
												type="checkbox"
												checked={mailboxIds.has(m.id)}
												onChange={(e) =>
													setMailboxIds((prev) => {
														const next = new Set(prev);
														if (e.target.checked) next.add(m.id);
														else next.delete(m.id);
														return next;
													})
												}
												className="size-4 rounded border-[var(--line)] text-[var(--accent)] focus:ring-[var(--accent)]"
											/>
											<span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: m.color }} />
											<span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
												{m.address}
											</span>
											{m.isCatchAll && <CatchAllBadge />}
										</label>
									))}
								</div>
							)}
						</div>

						<div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
							<Checkbox
								checked={hasAttachment}
								onChange={setHasAttachment}
								label="添付あり"
							/>
							<Checkbox
								checked={replyToOwn}
								onChange={setReplyToOwn}
								label="自分たちが送った会話への返信"
							/>
							<Checkbox
								checked={ccOnly}
								onChange={setCcOnly}
								label="CC にだけ入っている"
							/>
						</div>
					</div>

					<div className="card flex flex-col gap-3 p-4">
						<p className="text-sm font-medium text-[var(--text)]">動作</p>
						<div className="grid grid-cols-2 gap-2">
							{actions.map((a) => (
								<button
									key={a}
									type="button"
									onClick={() => setAction(a)}
									className={`flex min-h-11 items-center justify-center rounded-full px-3 text-sm font-medium transition-colors ${
										action === a
											? "bg-[var(--accent)] text-white"
											: "border border-[var(--line)] text-[var(--text)] hover:bg-[var(--surface-hover)]"
									}`}
								>
									{actionLabels[a]}
								</button>
							))}
						</div>
						<p className="text-xs text-[var(--text-muted)]">{actionHint[action]}</p>
					</div>

					<div className="card flex flex-col gap-3 p-4">
						<p className="text-sm font-medium text-[var(--text)]">最近のメールで試す</p>
						<p className="text-xs text-[var(--text-muted)]">
							直近 50 通にこの条件を当てて、一致するものを確認できます。
						</p>
						<Button variant="ghost" onClick={() => void tryDryRun()} disabled={dryBusy}>
							{dryBusy ? "確認中…" : "試す"}
						</Button>
						{dryResult && (
							<div className="flex flex-col gap-2 text-sm">
								<p className="font-medium text-[var(--text)]">
									{dryResult.count === 0
										? "一致するメールはありませんでした"
										: `直近 50 通のうち ${dryResult.count} 件が一致`}
								</p>
								{dryResult.rows.map((r, i) => (
									<div
										key={i}
										className="rounded-md bg-[var(--surface-hover)] px-3 py-2"
									>
										<p className="truncate font-medium text-[var(--text)]">
											{r.fromAddr}
										</p>
										<p className="truncate text-xs text-[var(--text-muted)]">
											{r.subject ?? "（件名なし）"} ・ {formatDateTime(r.receivedAt)}
										</p>
									</div>
								))}
								{dryResult.rows.length < dryResult.count && (
									<p className="text-xs text-[var(--text-muted)]">
										ほか {dryResult.count - dryResult.rows.length} 件
									</p>
								)}
							</div>
						)}
					</div>

					<div className="flex items-center justify-between gap-2 pt-1">
						{!isNew ? (
							<Button
								variant="danger"
								onClick={() => {
									if (window.confirm("このルールを削除しますか？")) void remove();
								}}
								className="min-h-11"
							>
								削除
							</Button>
						) : (
							<span />
						)}
						<Button onClick={() => void save()} className="min-h-11 px-6">
							保存
						</Button>
					</div>
				</div>
			)}
		</SettingsPage>
	);
}
