ALTER TABLE `addresses` ADD `color` text;
--> statement-breakpoint
-- 既存のメールボックスにも作成順で既定色を振る。
-- 色の一覧は src/shared/colors.ts と同じ並び。増減させるときは両方を直すこと。
UPDATE addresses SET color = (
	SELECT CASE (r.n % 20)
			WHEN 0 THEN '#1a73e8'
			WHEN 1 THEN '#d93025'
			WHEN 2 THEN '#188038'
			WHEN 3 THEN '#e8710a'
			WHEN 4 THEN '#8430ce'
			WHEN 5 THEN '#00796b'
			WHEN 6 THEN '#c5221f'
			WHEN 7 THEN '#3f51b5'
			WHEN 8 THEN '#7cb342'
			WHEN 9 THEN '#795548'
			WHEN 10 THEN '#0097a7'
			WHEN 11 THEN '#b06000'
			WHEN 12 THEN '#ad1457'
			WHEN 13 THEN '#1a237e'
			WHEN 14 THEN '#827717'
			WHEN 15 THEN '#6a1b9a'
			WHEN 16 THEN '#e65100'
			WHEN 17 THEN '#455a64'
			WHEN 18 THEN '#2e7d32'
			WHEN 19 THEN '#b71c1c'
		END
	FROM (
		SELECT rowid AS rid, (ROW_NUMBER() OVER (ORDER BY rowid) - 1) AS n FROM addresses
	) r
	WHERE r.rid = addresses.rowid
) WHERE color IS NULL;
