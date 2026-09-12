import { useCallback, useEffect, useState } from "react";
import type { AdminAddress, DomainSummary, Rule, RuleAction, RuleScope } from "./api";
import { api, ApiClientError, getAllPages } from "./api";
import { AdminGate } from "./gate";
import {
	Badge,
	Button,
	Card,
	CardHeader,
	Checkbox,
	EmptyState,
	ErrorBanner,
	Label,
	MobileActions,
	MobileField,
	Modal,
	Notice,
	Page,
	Select,
	TableRow,
	tdCls,
	TextInput,
	thCls,
} from "./components";

const actionLabels: Record<RuleAction, string> = {
	deliver: "配信する（deliver）",
	forward: "転送する（forward）",
	reject: "拒否する（reject）",
	drop: "落とす（drop）",
	mark: "処理する（mark）",
};

const actionsForScope: Record<RuleScope, RuleAction[]> = {
	domain: ["deliver", "forward", "reject", "drop"],
	address: ["mark"],
};

const scopeInfo: Record<RuleScope, { title: string; description: string; tone: "info" | "warn" }> = {
	domain: {
		title: "ドメインスコープ（受信時）",
		description:
			"受信がこのアプリに届く前に評価します。転送・拒否はここでしか効きません（email ハンドラで完結するため）。",
		tone: "warn",
	},
	address: {
		title: "アドレススコープ（配信後）",
		description:
			"メールがアドレスに配信された後、振り分けを評価します（既読化・スター・破棄など）。受信時の転送・拒否は扱いません。",
		tone: "info",
	},
};

function RuleTargetLabel({
	rule,
	domains,
	addresses,
}: {
	rule: Rule;
	domains: DomainSummary[];
	addresses: AdminAddress[];
}) {
	if (rule.scope === "domain") {
		return <span className="font-medium text-[var(--text)]">{domains.find((d) => d.id === rule.domainId)?.name ?? rule.domainId}</span>;
	}
	return <span className="font-medium text-[var(--text)]">{addresses.find((a) => a.id === rule.addressId)?.address ?? rule.addressId}</span>;
}

// 作成と編集で項目が完全に同じなので 1 つにしてある。rule があれば編集。
function RuleModal({
	scope,
	domains,
	addresses,
	rule,
	onClose,
	onSaved,
}: {
	scope: RuleScope;
	domains: DomainSummary[];
	addresses: AdminAddress[];
	rule?: Rule;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [domainId, setDomainId] = useState(rule?.domainId ?? domains[0]?.id ?? "");
	const [addressId, setAddressId] = useState(
		rule?.addressId ?? addresses.find((a) => a.kind === "mailbox")?.id ?? "",
	);
	const [name, setName] = useState(rule?.name ?? "");
	const [action, setAction] = useState<RuleAction>(
		rule?.action ?? actionsForScope[scope][0] ?? "deliver",
	);
	const [matcherFrom, setMatcherFrom] = useState(rule?.matcher.from ?? "");
	const [matcherTo, setMatcherTo] = useState(rule?.matcher.to ?? "");
	const [matcherSubject, setMatcherSubject] = useState(rule?.matcher.subject ?? "");
	const [matcherContains, setMatcherContains] = useState(rule?.matcher.contains ?? "");
	const [target, setTarget] = useState(rule?.target ?? "");
	const [priority, setPriority] = useState(rule?.priority ?? 0);
	const [enabled, setEnabled] = useState(rule?.enabled ?? true);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const save = async () => {
		setError("");
		setBusy(true);
		try {
			const matcher: Record<string, string> = {};
			if (matcherFrom) matcher.from = matcherFrom;
			if (matcherTo) matcher.to = matcherTo;
			if (matcherSubject) matcher.subject = matcherSubject;
			if (matcherContains) matcher.contains = matcherContains;

			const body = {
				scope,
				domainId: scope === "domain" ? domainId : undefined,
				addressId: scope === "address" ? addressId : undefined,
				name,
				action,
				matcher,
				target: target.trim() || null,
				priority,
				enabled,
			};
			if (rule) await api.patch(`/api/v1/admin/rules/${rule.id}`, body);
			else await api.post("/api/v1/admin/rules", body);
			onSaved();
		} catch (e) {
			setError(
				e instanceof ApiClientError
					? e.message
					: rule
						? "ルールの更新に失敗しました"
						: "ルールの作成に失敗しました",
			);
		} finally {
			setBusy(false);
		}
	};

	const matchesAll = !matcherFrom && !matcherTo && !matcherSubject && !matcherContains;
	// 条件が空のルールはすべてのメールに当たる。拒否や破棄だと全部が消えるので、明示の確認を求める。
	const [allConfirmed, setAllConfirmed] = useState(false);
	const valid = name && (scope === "domain" ? domainId : addressId) && (!matchesAll || allConfirmed);

	return (
		<Modal
			title={`${rule ? "ルールを編集" : "ルールを作成"}（${scopeInfo[scope].title}）`}
			onClose={onClose}
		>
			<ErrorBanner message={error} onDismiss={() => setError("")} />
			<div className="space-y-4">
				<Notice tone={scopeInfo[scope].tone}>{scopeInfo[scope].description}</Notice>

				{scope === "domain" ? (
					<div>
						<Label>対象ドメイン</Label>
						<Select value={domainId} onChange={(e) => setDomainId(e.target.value)}>
							{domains.map((d) => (
								<option key={d.id} value={d.id}>
									{d.name}
								</option>
							))}
						</Select>
					</div>
				) : (
					<div>
						<Label>対象アドレス</Label>
						<Select value={addressId} onChange={(e) => setAddressId(e.target.value)}>
							{addresses
								.filter((a) => a.kind === "mailbox")
								.map((a) => (
									<option key={a.id} value={a.id}>
										{a.address}
									</option>
								))}
						</Select>
					</div>
				)}

				<div>
					<Label>名前</Label>
					<TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="営業メールは拒否" />
				</div>

				<div>
					<Label>アクション</Label>
					<Select value={action} onChange={(e) => setAction(e.target.value as RuleAction)}>
						{actionsForScope[scope].map((a) => (
							<option key={a} value={a}>
								{actionLabels[a]}
							</option>
						))}
					</Select>
				</div>

				<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
					<div>
						<Label>From 条件</Label>
						<TextInput value={matcherFrom} onChange={(e) => setMatcherFrom(e.target.value)} placeholder="部分一致" />
					</div>
					<div>
						<Label>To 条件</Label>
						<TextInput value={matcherTo} onChange={(e) => setMatcherTo(e.target.value)} placeholder="部分一致" />
					</div>
					<div>
						<Label>件名条件</Label>
						<TextInput value={matcherSubject} onChange={(e) => setMatcherSubject(e.target.value)} placeholder="部分一致" />
					</div>
					<div>
						<Label>本文条件</Label>
						<TextInput value={matcherContains} onChange={(e) => setMatcherContains(e.target.value)} placeholder="部分一致" />
					</div>
				</div>
				<p className="text-xs text-[var(--text-muted)]">
					条件はすべて空欄で「全件一致」。条件は部分一致・大文字小文字を無視します。
				</p>
				{matchesAll && (
					<Notice tone={action === "reject" || action === "drop" ? "danger" : "warn"}>
						<p>条件が空なので、このルールは{scope === "domain" ? "このドメイン宛て" : "このアドレス宛て"}のすべてのメールに当たります。</p>
						<label className="mt-2 flex min-h-11 items-center gap-2">
							<input type="checkbox" checked={allConfirmed} onChange={(e) => setAllConfirmed(e.target.checked)} />
							すべてのメールに当てることを確認しました
						</label>
					</Notice>
				)}

				<div>
					<Label>対象の値（action ごとの引数）</Label>
					<TextInput value={target} onChange={(e) => setTarget(e.target.value)} placeholder={action === "forward" ? "転送先メールアドレス" : "任意"} />
				</div>

				<div className="flex items-center gap-4">
					<div className="w-32">
						<Label>優先度</Label>
						<TextInput
							type="number"
							value={priority}
							onChange={(e) => setPriority(Number(e.target.value))}
						/>
					</div>
					<label className="flex items-center gap-2 text-sm text-[var(--text)]">
						<Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
						有効
					</label>
				</div>

				<div className="flex justify-end gap-2 pt-2">
					<Button variant="secondary" onClick={onClose}>
						キャンセル
					</Button>
					<Button onClick={save} disabled={busy || !valid}>
						{rule ? "保存する" : "作成する"}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function RuleTable({
	scope,
	rules,
	domains,
	addresses,
	onEdit,
	onDelete,
	onChanged,
}: {
	scope: RuleScope;
	rules: Rule[];
	domains: DomainSummary[];
	addresses: AdminAddress[];
	onEdit: (r: Rule) => void;
	onDelete: (r: Rule) => void;
	onChanged: () => void;
}) {
	const info = scopeInfo[scope];
	return (
		<Card className="mb-6">
			<CardHeader
				title={info.title}
				description={info.description}
				action={
						<AddButton
							scope={scope}
							domains={domains}
							addresses={addresses}
							onCreated={onChanged}
						/>
					}
			/>
			{rules.length === 0 ? (
				<EmptyState message="このスコープのルールはまだありません。" />
			) : (
				<>
				<div className="hidden overflow-x-auto md:block">
				<table className="w-full min-w-[720px]">
					<thead>
						<tr className="border-b border-[var(--line)] bg-[var(--surface-sunken)]">
							<th className={thCls}>対象</th>
							<th className={thCls}>名前</th>
							<th className={thCls}>アクション</th>
							<th className={thCls}>条件</th>
							<th className={thCls}>優先度</th>
							<th className={thCls}>状態</th>
							<th className={thCls}></th>
						</tr>
					</thead>
					<tbody>
						{rules.map((r) => (
							<TableRow key={r.id}>
								<td className={tdCls}>
									<RuleTargetLabel rule={r} domains={domains} addresses={addresses} />
								</td>
								<td className={tdCls}>
									<span className="font-medium text-[var(--text)]">{r.name}</span>
									{r.target && <div className="text-xs text-[var(--text-muted)]">→ {r.target}</div>}
								</td>
								<td className={tdCls}>
									<Badge color={actionColor(r.action)}>{r.action}</Badge>
								</td>
								<td className={tdCls}>
									<MatcherText matcher={r.matcher} />
								</td>
								<td className={tdCls}>{r.priority}</td>
								<td className={tdCls}>
									<Badge color={r.enabled ? "green" : "gray"}>{r.enabled ? "有効" : "無効"}</Badge>
								</td>
								<td className={tdCls}>
									<div className="flex items-center gap-1">
										<Button variant="secondary" onClick={() => onEdit(r)}>
											編集
										</Button>
										<Button variant="danger" onClick={() => onDelete(r)}>
											削除
										</Button>
									</div>
								</td>
							</TableRow>
						))}
					</tbody>
				</table>
				</div>
				<ul className="md:hidden">
					{rules.map((r) => (
						<li key={r.id} className="border-b border-[var(--line-soft)] px-4 py-3">
							<div className="flex items-center justify-between gap-2">
								<span className="min-w-0 flex-1 font-medium text-[var(--text)]">{r.name}</span>
								<Badge color={actionColor(r.action)}>{r.action}</Badge>
							</div>
							{r.target && <div className="mt-0.5 text-xs text-[var(--text-muted)]">→ {r.target}</div>}
							<div className="mt-2 space-y-1">
								<MobileField label="対象">
									<RuleTargetLabel rule={r} domains={domains} addresses={addresses} />
								</MobileField>
								<MobileField label="条件">
									<MatcherText matcher={r.matcher} />
								</MobileField>
								<MobileField label="優先度">{r.priority}</MobileField>
								<MobileField label="状態">
									<Badge color={r.enabled ? "green" : "gray"}>{r.enabled ? "有効" : "無効"}</Badge>
								</MobileField>
							</div>
							<MobileActions>
								<Button variant="secondary" onClick={() => onEdit(r)}>
									編集
								</Button>
								<Button variant="danger" onClick={() => onDelete(r)}>
									削除
								</Button>
							</MobileActions>
						</li>
					))}
				</ul>
				</>
			)}
		</Card>
	);
}

function actionColor(action: RuleAction): "green" | "purple" | "red" | "gray" | "blue" {
	switch (action) {
		case "deliver":
			return "green";
		case "forward":
			return "purple";
		case "reject":
		case "drop":
			return "red";
		case "mark":
			return "blue";
	}
}

function AddButton({
	scope,
	domains,
	addresses,
	onCreated,
}: {
	scope: RuleScope;
	domains: DomainSummary[];
	addresses: AdminAddress[];
	onCreated: () => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button onClick={() => setOpen(true)}>ルールを追加</Button>
			{open && (
				<RuleModal
					scope={scope}
					domains={domains}
					addresses={addresses}
					onClose={() => setOpen(false)}
					onSaved={() => {
						setOpen(false);
						onCreated();
					}}
				/>
			)}
		</>
	);
}

function MatcherText({ matcher }: { matcher: Rule["matcher"] }) {
	const parts: string[] = [];
	if (matcher.from) parts.push(`from: ${matcher.from}`);
	if (matcher.to) parts.push(`to: ${matcher.to}`);
	if (matcher.subject) parts.push(`件名: ${matcher.subject}`);
	if (matcher.contains) parts.push(`本文: ${matcher.contains}`);
	if (parts.length === 0) return <span className="text-[var(--text-muted)]">全件一致</span>;
	return <span className="break-all text-xs">{parts.join(" / ")}</span>;
}

export function RulesPage() {
	const [rules, setRules] = useState<Rule[]>([]);
	const [domains, setDomains] = useState<DomainSummary[]>([]);
	const [addresses, setAddresses] = useState<AdminAddress[]>([]);
	const [error, setError] = useState("");
	const [editTarget, setEditTarget] = useState<Rule | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<Rule | null>(null);

	const load = useCallback(async () => {
		try {
			const [ruleList, domainList, addressList] = await Promise.all([
				getAllPages<Rule>("/api/v1/admin/rules"),
				getAllPages<DomainSummary>("/api/v1/admin/domains"),
				getAllPages<AdminAddress>("/api/v1/admin/addresses"),
			]);
			// why: 受信の判定は priority の高い順に当たるので、画面もその順で見せないと効くルールを読み違える。
			setRules([...ruleList].sort((a, b) => b.priority - a.priority));
			setDomains(domainList);
			setAddresses(addressList);
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "一覧の取得に失敗しました");
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const domainRules = rules.filter((r) => r.scope === "domain");
	const addressRules = rules.filter((r) => r.scope === "address");

	const confirmDelete = async () => {
		if (!deleteTarget) return;
		setError("");
		try {
			await api.del(`/api/v1/admin/rules/${deleteTarget.id}`);
			setDeleteTarget(null);
			await load();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "削除に失敗しました");
		}
	};

	return (
		<AdminGate>
			<Page title="ルーティングルール">
				<ErrorBanner message={error} onDismiss={() => setError("")} />
				<div className="mb-6">
					<Notice tone="warn">
						ルールには <strong>ドメインスコープ（受信時に転送/拒否）</strong> と{" "}
						<strong>アドレススコープ（配信後の振り分け）</strong> の 2 種類があり、別物です。
						混ぜて表示していません。作る場所が違うのでご注意ください。
					</Notice>
				</div>

				{domains.length === 0 ? (
					<EmptyState message="先に「ドメイン管理」からドメインを接続してください。" />
				) : (
					<RuleTable
						scope="domain"
						rules={domainRules}
						domains={domains}
						addresses={addresses}
						onEdit={setEditTarget}
						onDelete={setDeleteTarget}
						onChanged={load}
					/>
				)}

				{addresses.length === 0 ? (
					<EmptyState message="先に「アドレス管理」からメールボックスを作成してください。" />
				) : (
					<RuleTable
						scope="address"
						rules={addressRules}
						domains={domains}
						addresses={addresses}
						onEdit={setEditTarget}
						onDelete={setDeleteTarget}
						onChanged={load}
					/>
				)}

				{editTarget && (
					<RuleModal
						scope={editTarget.scope}
						domains={domains}
						addresses={addresses}
						rule={editTarget}
						onClose={() => setEditTarget(null)}
						onSaved={() => {
							setEditTarget(null);
							load();
						}}
					/>
				)}

				{deleteTarget && (
					<Modal title="ルールを削除" onClose={() => setDeleteTarget(null)}>
						<div className="space-y-4">
							<Notice tone="info">{deleteTarget.name} を削除します。</Notice>
							<div className="flex justify-end gap-2">
								<Button variant="secondary" onClick={() => setDeleteTarget(null)}>
									キャンセル
								</Button>
								<Button variant="danger" onClick={confirmDelete}>
									削除する
								</Button>
							</div>
						</div>
					</Modal>
				)}
			</Page>
		</AdminGate>
	);
}
