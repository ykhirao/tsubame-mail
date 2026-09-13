#!/usr/bin/env bash
# tsubame のデプロイ（本番 / ステージング）。
#
# wrangler.jsonc の d1_databases[].database_id はプレースホルダ（コミット不可の
# アカウント固有 ID）のため、実行時に環境変数 D1_DATABASE_ID から実 ID を
# 注入した設定 wrangler.local.jsonc を生成して使う。生成物は .gitignore に
# 明示してあるためコミットされない。
#
# 使い方:
#   D1_DATABASE_ID="<UUID>" ./scripts/deploy.sh                    # 本番。ビルド含む一連
#   D1_DATABASE_ID="<UUID>" ./scripts/deploy.sh --env staging      # ステージング
#   D1_DATABASE_ID="<UUID>" ./scripts/deploy.sh --skip-build
#   D1_DATABASE_ID="<UUID>" ./scripts/deploy.sh --keep-config  # wrangler.local.jsonc を残す（手動の d1 execute 用）
#
# 環境変数:
#   D1_DATABASE_ID  デプロイ対象 D1 の database_id（必須）。**環境ごとに違う値**を渡すこと。
#   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID  任意。GitHub Actions から渡す場合
#                                                    wrangler が自動で読む。
set -euo pipefail

cd "$(dirname "$0")/.."

BASE="wrangler.jsonc"
OUT="wrangler.local.jsonc"
# 環境ごとに別のプレースホルダを使う。1 種類だと sed の置換が両方の環境に当たり、
# ステージングのデプロイで本番の D1 を向いてしまう。
PLACEHOLDER_PRODUCTION="00000000-0000-0000-0000-000000000000"
PLACEHOLDER_STAGING="11111111-1111-1111-1111-111111111111"

SKIP_BUILD=0
KEEP_CONFIG=0
ENV_NAME=""
prev=""
for arg in "$@"; do
	case "$arg" in
		--skip-build) SKIP_BUILD=1 ;;
		--keep-config) KEEP_CONFIG=1 ;;
		--env=*) ENV_NAME="${arg#--env=}" ;;
		*) if [[ "$prev" == "--env" ]]; then ENV_NAME="$arg"; fi ;;
	esac
	prev="$arg"
done

case "$ENV_NAME" in
	"") PLACEHOLDER="$PLACEHOLDER_PRODUCTION"; WRANGLER_ENV=() ;;
	staging) PLACEHOLDER="$PLACEHOLDER_STAGING"; WRANGLER_ENV=(--env staging) ;;
	*)
		echo "エラー: 知らない --env です: ${ENV_NAME}（使えるのは staging だけ）" >&2
		exit 1
		;;
esac

# ---- database_id の検証 ----------------------------------------------------
DATABASE_ID="${D1_DATABASE_ID:-}"
if [[ -z "$DATABASE_ID" ]]; then
	echo "エラー: D1_DATABASE_ID を設定してください。" >&2
	echo "  D1_DATABASE_ID=\"<D1 の database_id>\" ./scripts/deploy.sh" >&2
	exit 1
fi
if [[ "$DATABASE_ID" == "$PLACEHOLDER" ]]; then
	echo "エラー: D1_DATABASE_ID がプレースホルダのままです。" >&2
	exit 1
fi
# sed の置換先にそのまま埋め込むため、UUID 以外の文字（/ & など）を許さない。
if [[ ! "$DATABASE_ID" =~ ^[0-9a-f-]{36}$ ]]; then
	echo "エラー: D1_DATABASE_ID が UUID の形式ではありません。" >&2
	exit 1
fi

# ---- 設定生成 --------------------------------------------------------------
# sed の置換対象（UUID 文字列）は固定のプレースホルダなので置換後の値（実 ID は
# ハイフン付き 16 進）が sed の置換記号と衝突しても安全なように、置換は固定文字列で行う。
if ! sed "s/$PLACEHOLDER/$DATABASE_ID/" "$BASE" > "$OUT"; then
	echo "エラー: $OUT の生成に失敗しました。" >&2
	exit 1
fi
# 失敗時にも一時ファイルを残さない。--keep-config なら手動の d1 execute などで使えるよう残す。
if [[ "$KEEP_CONFIG" == "1" ]]; then
	echo "→ --keep-config 指定: $OUT を残します（.gitignore で除外済み）"
else
	trap 'rm -f "$OUT"' EXIT
fi

echo "→ $OUT を生成しました（.gitignore で除外済み）"

# ---- ビルド（--skip-build で省略可） ---------------------------------------
if [[ "$SKIP_BUILD" == "1" ]]; then	echo "→ --skip-build が指定されたためビルドをスキップします"
else
	echo "→ npm run build（dist/client を作成）"
	npm run build
fi

# ---- マイグレーション適用（remote） ------------------------------------------
echo "→ D1 マイグレーション適用（remote）"
npx wrangler d1 migrations apply DB --config "$OUT" "${WRANGLER_ENV[@]}" --remote

# ---- デプロイ -----------------------------------------------------------------
echo "→ wrangler deploy"
npx wrangler deploy --config "$OUT" "${WRANGLER_ENV[@]}"

echo "→ デプロイ完了。確認: curl -s https://<公開ホスト>/api/health"
