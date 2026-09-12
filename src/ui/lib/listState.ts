import { useSyncExternalStore } from "react";

type ListQuery = { address: string; view: string };

type ListState = {
	query: ListQuery;
	loaded: boolean;
	ids: string[];
	scrollTop: number;
};

const EMPTY: ListState = {
	query: { address: "", view: "inbox" },
	loaded: false,
	ids: [],
	scrollTop: 0,
};

let state: ListState = EMPTY;
const listeners = new Set<() => void>();

function emit() {
	for (const l of [...listeners]) l();
}
function subscribe(l: () => void) {
	listeners.add(l);
	return () => listeners.delete(l);
}

export function listKey(q: ListQuery): string {
	return `${q.address}|${q.view}`;
}

/** 保存した一覧の URL。会話から戻る・ゴミ箱へしたあとに同じ絞り込みで開くため。 */
export function listHref(query: ListQuery): string {
	const q = new URLSearchParams();
	if (query.address) q.set("address", query.address);
	if (query.view !== "inbox") q.set("view", query.view);
	const s = q.toString();
	return s ? `/?${s}` : "/";
}

export function useListState(): ListState {
	return useSyncExternalStore(subscribe, () => state);
}

/** 別の絞り込みに切り替えて、一覧を白紙に戻す。 */
export function resetList(query: ListQuery): void {
	state = { query, loaded: false, ids: [], scrollTop: 0 };
	emit();
}

export function setList(query: ListQuery, ids: string[]): void {
	state = { query, loaded: true, ids, scrollTop: state.scrollTop };
	emit();
}

export function commitScrollTop(scrollTop: number): void {
	if (state.scrollTop === scrollTop) return;
	state = { ...state, scrollTop };
	emit();
}

export function prevNext(ofId: string): { prev?: string; next?: string } {
	const i = state.ids.indexOf(ofId);
	if (i < 0) return {};
	return { prev: state.ids[i - 1], next: state.ids[i + 1] };
}
