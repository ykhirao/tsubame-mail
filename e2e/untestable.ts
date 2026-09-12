import { untestable } from "./registry";

// ここに載せてよいのは、API か worker の振る舞いとして確かめようが無い箇条書きだけ。
// UI の振る舞いでも、それを支える API があれば scenario にする。

untestable("FR-9-1", "日本語で直接書く方針。翻訳レイヤーが無いことは振る舞いとして観測できない");
untestable("FR-9-3", "設定項目を増やさない方針。個々の設定の有無は FR-16 などの箇条書きで確かめる");
untestable("FR-16-8", "FR-9 の例外の宣言と画面の畳み方。確かめる振る舞いが無い");
untestable("FR-17-4", "FR-9 の例外の宣言。中身は FR-17-1〜3 で確かめる");
