import { useSyncExternalStore } from "react";

export type LayoutPref = "split" | "fullscreen";

const KEY = "tsubame-layout";
const listeners = new Set<() => void>();

function read(): LayoutPref {
	return localStorage.getItem(KEY) === "fullscreen" ? "fullscreen" : "split";
}
function subscribe(l: () => void) {
	listeners.add(l);
	return () => listeners.delete(l);
}

export function getLayoutPref(): LayoutPref {
	return read();
}

export function setLayoutPref(pref: LayoutPref): void {
	localStorage.setItem(KEY, pref);
	for (const l of [...listeners]) l();
}

export function useLayoutPref(): [LayoutPref, (p: LayoutPref) => void] {
	return [useSyncExternalStore(subscribe, getLayoutPref), setLayoutPref];
}
