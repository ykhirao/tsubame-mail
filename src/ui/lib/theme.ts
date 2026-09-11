// 配色の実体は styles.css の `:root[data-theme="dark"]` 側にある。ここは値を入れるだけ。
export type Theme = "light" | "dark";

const KEY = "tsubame-theme";

// theme-color は styles.css の --accent に合わせる（ブラウザ UI の色）。
const META_COLOR: Record<Theme, string> = { light: "#0b57d0", dark: "#a8c7fa" };

export function getTheme(): Theme {
	const stored = localStorage.getItem(KEY);
	return stored === "dark" ? "dark" : "light";
}

export function setTheme(theme: Theme): void {
	localStorage.setItem(KEY, theme);
	document.documentElement.dataset.theme = theme;
	// PWA のブラウザ UI もテーマに合わせて塗り替える。
	document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_COLOR[theme]);
}
