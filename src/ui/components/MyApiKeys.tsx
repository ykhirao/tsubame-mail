import { useCallback, useEffect, useState } from "react";
import { MyKeysApi, type MyApiKey } from "@/ui/lib/api";
import type { MyAddress } from "@/shared/contracts/addresses";

// 発行したキーは本人の権限を超えられないので、対象は自分が触れるアドレスからだけ選ばせる。
export function MyApiKeys({ addresses }: { addresses: MyAddress[] }) {
	const [keys, setKeys] = useState<MyApiKey[]>([]);
	const [name, setName] = useState("");
	const [canSend, setCanSend] = useState(false);
	const [limitTo, setLimitTo] = useState<string[]>([]);
	const [issued, setIssued] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			const res = await MyKeysApi.list();
			setKeys(res.data.filter((k) => !k.revokedAt));
		} catch {
			/* 一覧が取れなくても発行はできる */
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const create = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			const res = await MyKeysApi.create({
				name: name.trim() || "API キー",
				scopes: canSend ? ["read", "send"] : ["read"],
				addressIds: limitTo.length > 0 ? limitTo : undefined,
			});
			setIssued(res.token);
			setName("");
			setLimitTo([]);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "発行できませんでした");
		} finally {
			setBusy(false);
		}
	};

	const revoke = async (id: string) => {
		await MyKeysApi.revoke(id);
		await load();
	};

	return (
		<section className="card p-5">
			<h2 className="mb-1 text-base font-bold text-[var(--text)]">API キー</h2>
			<p className="mb-4 text-sm text-[var(--text-muted)]">
				プログラムや AI からメールを読み書きするための鍵。
				<strong>自分が触れるアドレスの範囲を超えることはできません。</strong>
			</p>

			{issued && (
				<div className="mb-4 border-l-4 border-[var(--warning)] bg-[var(--surface-sunken)] p-3">
					<p className="mb-2 text-sm text-[var(--text)]">
						発行しました。<strong>この画面を離れると二度と表示できません。</strong>
					</p>
					<code className="block break-all rounded bg-[var(--surface)] px-3 py-2 font-mono text-sm text-[var(--text)]">
						{issued}
					</code>
				</div>
			)}

			{keys.length > 0 && (
				<ul className="mb-4 divide-y divide-[var(--line-soft)]">
					{keys.map((k) => (
						<li key={k.id} className="flex items-center gap-3 py-2 text-sm">
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[var(--text)]">{k.name}</span>
								<span className="block truncate text-xs text-[var(--text-muted)]">
									{k.prefix}… / {k.scopes.join(", ")} /{" "}
									{k.addressIds ? `${k.addressIds.length} アドレスに限定` : "自分の全アドレス"}
								</span>
							</span>
							<button
								type="button"
								onClick={() => void revoke(k.id)}
								className="shrink-0 text-sm text-[var(--danger)] hover:underline"
							>
								失効
							</button>
						</li>
					))}
				</ul>
			)}

			<form onSubmit={create} className="space-y-3">
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="用途がわかる名前（例: 見積の自動処理）"
					className="w-full rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
				/>

				<label className="flex items-center gap-2 text-sm text-[var(--text)]">
					<input
						type="checkbox"
						checked={canSend}
						onChange={(e) => setCanSend(e.target.checked)}
						className="accent-[var(--accent)]"
					/>
					送信も許可する（外さない限り読むだけ）
				</label>

				{addresses.length > 1 && (
					<div>
						<p className="mb-1 text-sm text-[var(--text)]">対象を絞る（未選択なら自分の全アドレス）</p>
						<div className="flex flex-wrap gap-2">
							{addresses.map((a) => {
								const on = limitTo.includes(a.id);
								return (
									<button
										key={a.id}
										type="button"
										onClick={() =>
											setLimitTo((prev) =>
												on ? prev.filter((x) => x !== a.id) : [...prev, a.id],
											)
										}
										className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
											on
												? "border-transparent bg-[var(--surface-selected)] text-[var(--text-on-selected)]"
												: "border-[var(--line)] text-[var(--text-muted)]"
										}`}
									>
										<span
											className="inline-block h-2 w-3 rounded-full"
											style={{ background: a.color }}
										/>
										{a.address}
									</button>
								);
							})}
						</div>
					</div>
				)}

				{error && <p className="text-sm text-[var(--danger)]">{error}</p>}

				<button
					type="submit"
					disabled={busy}
					className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
				>
					{busy ? "発行中…" : "キーを発行"}
				</button>
			</form>
		</section>
	);
}
