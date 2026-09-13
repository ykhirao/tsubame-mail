-- 無効な API キーを繰り返し送ってくる相手を、しばらく門前で返すためのカウンタ。
-- Rate Limiting binding が本番で発火しない（精査 #147）ので、数える側を自前で持つ。
--
-- ip_hash は IP の SHA-256。生の IP を残すと、失敗しただけの相手の所在が
-- ログより長く手元に残る。突き合わせは同じ関数で毎回ハッシュして行う。
CREATE TABLE auth_failures (
	ip_hash TEXT PRIMARY KEY,
	failures INTEGER NOT NULL DEFAULT 0,
	-- この時刻を過ぎたら数え直す（窓の終わり）。
	window_ends_at INTEGER NOT NULL,
	-- 上限を超えたときだけ入る。ここを過ぎるまで門前で返す。
	blocked_until INTEGER
);

-- 掃除（cron）が窓の切れた行だけを拾えるように。
CREATE INDEX auth_failures_window_idx ON auth_failures (window_ends_at);
