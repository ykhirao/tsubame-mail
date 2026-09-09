import { useCallback, useEffect, useState } from "react";
import type { AdminAddress, DomainSummary, Rule, RuleAction, RuleScope } from "./api";
import { api, ApiClientError } from "./api";
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

function CreateRuleModal({
	scope,
	domains,
	addresses,
	onClose,
	onCreated,
}: {
	scope: RuleScope;
	domains: DomainSummary[];
	addresses: AdminAddress[];
	onClose: () => void;
	onCreated: () => void;
}) {
	const [domainId, setDomainId] = useState(domains[0]?.id ?? "");
	const [addressId, setAddressId] = useState(addresses.find((a) => a.kind === "mailbox")?.id ?? "");
	const [name, setName] = useState("");
	const [action, setAction] = useState<RuleAction>(actionsForScope[scope][0] ?? "deliver");
	const [matcherFrom, setMatcherFrom] = useState("");
	const [matcherTo, setMatcherTo] = useState("");
	const [matcherSubject, setMatcherSubject] = useState("");
	const [matcherContains, setMatcherContains] = useState("");
	const [target, setTarget] = useState("");
	const [priority, setPriority] = useState(0);
	const [enabled, setEnabled] = useState(true);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const create = async () => {
		setError("");
		setBusy(true);
		try {
			const matcher: Record<string, string> = {};
			if (matcherFrom) matcher.from = matcherFrom;
			if (matcherTo) matcher.to = matcherTo;
			if (matcherSubject) matcher.subject = matcherSubject;
			if (matcherContains) matcher.contains = matcherContains;

			await api.post("/api/v1/admin/rules", {
				scope,
				domainId: scope === "domain" ? domainId : undefined,
				addressId: scope === "address" ? addressId : undefined,
				name,
				action,
				matcher,
				target: target.trim() || null,
				priority,
				enabled,
			});
			onCreated();
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "ルールの作成に失敗しました");
		} finally {
			setBusy(false);
		}
	};

	const valid = name && (scope === "domain" ? domainId : addressId);

	return (
		<Modal title={`ルールを作成（${scopeInfo[scope].title}）`} onClose={onClose}>
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

				<div className="grid grid-cols-2 gap-3">
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
					<Button onClick={create} disabled={busy || !valid}>
						作成する
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
	onDelete,
}: {
	scope: RuleScope;
	rules: Rule[];
	domains: DomainSummary[];
	addresses: AdminAddress[];
	onDelete: (r: Rule) => void;
}) {
	const info = scopeInfo[scope];
	return (
		<Card className="mb-6">
			<CardHeader
				title={info.title}
				description={info.description}
				action={<AddButton scope={scope} domains={domains} addresses={addresses} />}
			/>
			{rules.length === 0 ? (
				<EmptyState message="このスコープのルールはまだありません。" />
			) : (
				<div className="overflow-x-auto">
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
									<Button variant="danger" onClick={() => onDelete(r)}>
										削除
									</Button>
								</td>
							</TableRow>
						))}
					</tbody>
				</table>
				</div>
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
}: {
	scope: RuleScope;
	domains: DomainSummary[];
	addresses: AdminAddress[];
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button onClick={() => setOpen(true)}>ルールを追加</Button>
			{open && (
				<CreateRuleModal
					scope={scope}
					domains={domains}
					addresses={addresses}
					onClose={() => setOpen(false)}
					onCreated={() => setOpen(false)}
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
	const [deleteTarget, setDeleteTarget] = useState<Rule | null>(null);

	const load = useCallback(async () => {
		try {
			const [rRes, dRes, aRes] = await Promise.all([
				api.get<{ data: Rule[] }>("/api/v1/admin/rules"),
				api.get<{ data: DomainSummary[] }>("/api/v1/admin/domains"),
				api.get<{ data: AdminAddress[] }>("/api/v1/admin/addresses"),
			]);
			setRules(rRes.data);
			setDomains(dRes.data);
			setAddresses(aRes.data);
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
						onDelete={setDeleteTarget}
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
						onDelete={setDeleteTarget}
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
