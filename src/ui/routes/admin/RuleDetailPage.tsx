import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { AdminAddress, DomainSummary, Rule } from "./api";
import { api, ApiClientError, getAllPages } from "./api";
import { AdminGate } from "./gate";
import { AuditLogCard, DetailItem, DetailList } from "./detail";
import { actionLabels, DeleteRuleModal, RuleModal } from "./RulesPage";
import {
	Badge,
	Button,
	Card,
	CardHeader,
	ErrorBanner,
	formatDateTime,
	Page,
} from "./components";

const epoch = (v: string | number): number =>
	typeof v === "number" ? v : Math.floor(new Date(v).getTime() / 1000);

export function RuleDetailPage() {
	const { id } = useParams();
	const navigate = useNavigate();
	const [rule, setRule] = useState<Rule | null>(null);
	const [domains, setDomains] = useState<DomainSummary[]>([]);
	const [addresses, setAddresses] = useState<AdminAddress[]>([]);
	const [error, setError] = useState("");
	const [editTarget, setEditTarget] = useState<Rule | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<Rule | null>(null);

	const load = useCallback(async () => {
		if (!id) return;
		setError("");
		try {
			const [ruleRes, domainList, addressList] = await Promise.all([
				api.get<Rule>(`/api/v1/admin/rules/${id}`),
				getAllPages<DomainSummary>("/api/v1/admin/domains"),
				getAllPages<AdminAddress>("/api/v1/admin/addresses"),
			]);
			setRule(ruleRes);
			setDomains(domainList);
			setAddresses(addressList);
		} catch (e) {
			setError(e instanceof ApiClientError ? e.message : "ルールの詳細を読めませんでした");
		}
	}, [id]);

	useEffect(() => {
		load();
	}, [load]);

	const scopeLabel = rule?.scope === "domain" ? "ドメイン" : "アドレス";

	return (
		<AdminGate>
			<Page title="ルールの詳細">
				<ErrorBanner message={error} onDismiss={() => setError("")} />
				{rule && (
					<>
						<div className="mb-4 flex flex-wrap gap-2">
							<Button onClick={() => setEditTarget(rule)}>編集</Button>
							<Button variant="danger" onClick={() => setDeleteTarget(rule)}>
								削除
							</Button>
						</div>
						<Card>
							<CardHeader title="基本情報" />
							<DetailList>
								<DetailItem label="名前">{rule.name}</DetailItem>
								<DetailItem label="スコープ">{scopeLabel}</DetailItem>
								<DetailItem label="対象">
									{rule.scope === "domain" ? (
										rule.domainId ? (
											<Link
												to={`/admin/domains/${rule.domainId}`}
												className="text-[var(--accent)] hover:underline"
											>
												{domains.find((d) => d.id === rule.domainId)?.name ?? rule.domainId}
											</Link>
										) : (
											"—"
										)
									) : rule.addressId ? (
										<Link
											to={`/admin/addresses/${rule.addressId}`}
											className="text-[var(--accent)] hover:underline"
										>
											{addresses.find((a) => a.id === rule.addressId)?.address ?? rule.addressId}
										</Link>
									) : (
										"—"
									)}
								</DetailItem>
								<DetailItem label="アクション">{actionLabels[rule.action]}</DetailItem>
								<DetailItem label="対象の値">{rule.target ?? "—"}</DetailItem>
								<DetailItem label="From 条件">{rule.matcher.from ?? "（すべてに一致）"}</DetailItem>
								<DetailItem label="To 条件">{rule.matcher.to ?? "（すべてに一致）"}</DetailItem>
								<DetailItem label="件名条件">{rule.matcher.subject ?? "（すべてに一致）"}</DetailItem>
								<DetailItem label="本文条件">{rule.matcher.contains ?? "（すべてに一致）"}</DetailItem>
								<DetailItem label="優先度">{rule.priority}</DetailItem>
								<DetailItem label="状態">
									<Badge color={rule.enabled ? "green" : "gray"}>
										{rule.enabled ? "有効" : "無効"}
									</Badge>
								</DetailItem>
								<DetailItem label="作成日時">{formatDateTime(epoch(rule.createdAt))}</DetailItem>
							</DetailList>
						</Card>
						<AuditLogCard filter={{ targetType: "rule", targetId: id }} />
					</>
				)}
				{rule && editTarget && (
					<RuleModal
						scope={rule.scope}
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
					<DeleteRuleModal
						rule={deleteTarget}
						onClose={() => setDeleteTarget(null)}
						onDeleted={() => navigate("/admin/rules")}
					/>
				)}
			</Page>
		</AdminGate>
	);
}
