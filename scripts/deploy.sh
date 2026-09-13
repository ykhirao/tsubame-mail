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
#   TURNSTILE_SITEKEY / TURNSTILE_HOSTNAMES
#                   Turnstile のサイトキーと、ウィジェットを置くホスト名（カンマ区切り）。
#                   任意だが**両方まとめて**渡す。省くとボット確認が無効のままになる。
#                   秘密鍵は `wrangler secret put TURNSTILE_SECRET` で別に入れる。
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
# Turnstile も同じ理由で環境ごとに分ける。実ドメインと自分のウィジェットの sitekey は
# 公開リポジトリに置けないため（AGENTS.md「実環境の値をコミットしない」）。
SITEKEY_PLACEHOLDER_PRODUCTION="0xPRODUCTION_SITEKEY"
SITEKEY_PLACEHOLDER_STAGING="0xSTAGING_SITEKEY"
HOSTS_PLACEHOLDER_PRODUCTION="production.invalid"
HOSTS_PLACEHOLDER_STAGING="staging.invalid"

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
	"")
		PLACEHOLDER="$PLACEHOLDER_PRODUCTION"
		SITEKEY_PLACEHOLDER="$SITEKEY_PLACEHOLDER_PRODUCTION"
		HOSTS_PLACEHOLDER="$HOSTS_PLACEHOLDER_PRODUCTION"
		WRANGLER_ENV=()
		;;
	staging)
		PLACEHOLDER="$PLACEHOLDER_STAGING"
		SITEKEY_PLACEHOLDER="$SITEKEY_PLACEHOLDER_STAGING"
		HOSTS_PLACEHOLDER="$HOSTS_PLACEHOLDER_STAGING"
		WRANGLER_ENV=(--env staging)
		;;
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

# ---- Turnstile の検証 ------------------------------------------------------
# 任意。両方揃ったときだけ注入する。入れない場合はプレースホルダのまま残るが、
# TURNSTILE_SECRET が無ければサーバは検査そのものを行わないので実害はない
# （.invalid なので、secret だけ入れて片方を忘れた場合は必ず 403 になって気付く）。
SITEKEY="${TURNSTILE_SITEKEY:-}"
HOSTNAMES="${TURNSTILE_HOSTNAMES:-}"
if [[ -n "$SITEKEY" || -n "$HOSTNAMES" ]]; then
	if [[ -z "$SITEKEY" || -z "$HOSTNAMES" ]]; then
		echo "エラー: TURNSTILE_SITEKEY と TURNSTILE_HOSTNAMES は両方まとめて渡してください。" >&2
		exit 1
	fi
	# sed の置換先にそのまま埋め込むため、区切り文字（/ & \）を含む値を弾く。
	if [[ "$SITEKEY" == *[/\&\\]* || "$HOSTNAMES" == *[/\&\\]* ]]; then
		echo "エラー: TURNSTILE_SITEKEY / TURNSTILE_HOSTNAMES に / & \\ は使えません。" >&2
		exit 1
	fi
	# 本番の門を手元から抜けられるようになるため、localhost を混ぜさせない。
	if [[ "$HOSTNAMES" == *localhost* || "$HOSTNAMES" == *127.0.0.1* ]]; then
		echo "エラー: TURNSTILE_HOSTNAMES に localhost / 127.0.0.1 を入れないでください。" >&2
		exit 1
	fi
fi

# ---- 設定生成 --------------------------------------------------------------
# sed の置換対象（UUID 文字列）は固定のプレースホルダなので置換後の値（実 ID は
# ハイフン付き 16 進）が sed の置換記号と衝突しても安全なように、置換は固定文字列で行う。
SED_ARGS=(-e "s/$PLACEHOLDER/$DATABASE_ID/")
if [[ -n "$SITEKEY" ]]; then
	SED_ARGS+=(-e "s/$SITEKEY_PLACEHOLDER/$SITEKEY/" -e "s/$HOSTS_PLACEHOLDER/$HOSTNAMES/")
fi
if ! sed "${SED_ARGS[@]}" "$BASE" > "$OUT"; then
	echo "エラー: $OUT の生成に失敗しました。" >&2
	exit 1
fi
if [[ -n "$SITEKEY" ]]; then
	echo "→ Turnstile を注入しました（ホスト名: ${HOSTNAMES}）"
else
	echo "→ Turnstile は未指定のためプレースホルダのままです（ボット確認は無効）"
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
