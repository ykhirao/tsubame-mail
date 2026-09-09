// 配色の実体は styles.css の `:root[data-theme="dark"]` 側にある。ここは値を入れるだけ。
export type Theme = "light" | "dark";

const KEY = "tsubame-theme";

export function getTheme(): Theme {
	const stored = localStorage.getItem(KEY);
	return stored === "dark" ? "dark" : "light";
}

export function setTheme(theme: Theme): void {
	localStorage.setItem(KEY, theme);
	document.documentElement.dataset.theme = theme;
}
