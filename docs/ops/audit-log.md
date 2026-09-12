# 監査ログ

管理 API（domains / addresses / rules / webhooks / users / api-keys）の変更操作と
端末（push devices）の登録・削除、利用者自身の API キー発行・失効、メールボックスの署名の変更、
オーナー作成（bootstrap）は `audit_logs` テーブルに記録される。誰が・いつ・何に対して・IP 何から操作したかを
後から追えるようにするためのもので、配信メッセージ本体の内容（本文など）は記録しない。
記録するのは `src/domain/access/policy.ts` の `recordAudit`。記録に失敗しても本処理は落とさない。

## 記録される項目

| 列 | 内容 |
| --- | --- |
| `id` | 監査ログの一意 ID |
| `actor_id` | 操作したユーザ（API キーの場合はその持ち主のユーザ） |
| `action` | 操作種別（下記） |
| `target_type` | 対象種別（`domain` / `address` / `rule` / `webhook` / …） |
| `target_id` | 対象レコードの ID |
| `meta` | 操作固有の補足（JSON）。秘密情報（webhook secret など）は入れない |
| `ip` | リクエスト元 IP |
| `created_at` | 操作時刻（unix秒） |

## action と meta

| action | 操作 | meta に含まれる主なもの |
| --- | --- | --- |
| `domain.connect` | ドメイン接続 | `name`, `zoneId`, `mode`, `confirmApex`, `enableSending`, `localParts` |
| `domain.disconnect` | ドメイン切断 | `name`, `zoneId`, `cleanup`, `removedRoutingRules`, `removedDnsRecords`, `failures` |
| `domain.catchall` | catch-all 変更 | `name`, `zoneId`, `enabled` |
| `domain.sending` | Email Sending の有効・無効の切り替え | `name`, `zoneId`, `enabled` |
| `domain.verify` | 確認の再実行 | `name`, `zoneId`, `routingStatus`, `sendingStatus` |
| `address.create` | アドレス作成 | `address`, `localPart`, `domainId`, `kind`, `aliasTargetId`, `isCatchAll` |
| `address.update` | アドレス変更 | `address`, `kind`, `aliasTargetId`, `isCatchAll`, `archived` |
| `address.signature` | 署名の変更（write 権限の利用者が設定画面から。API キーでは 403） | `address`, `before` / `after`（文字数。本文は残さない） |
| `address.delete` | アドレス削除 | `address`, `domainId`, `kind` |
| `rule.create` | ルール作成 | `name`, `scope`, `domainId` / `addressId`, `action`, `target`, `priority`, `enabled` |
| `rule.update` | ルール更新 | 更新後の `name`, `scope`, `domainId` / `addressId`, `action`, `target`, `priority`, `enabled` |
| `rule.delete` | ルール削除 | `name` |
| `webhook.create` | webhook 作成 | `name`, `url`, `events`, `addressIds`, `enabled`（secret は含まない） |
| `webhook.update` | webhook 更新 | `name`, `url`（secret は含まない） |
| `webhook.delete` | webhook 削除 | `name` |
| `webhook.retry` | 手動再送（`target_id` は webhook の id） | `deliveryId`, `attempt` |
| `device.register` | 端末の登録（再登録の上書きも含む） | `name`, `platform`（endpoint・キーは含まない） |
| `device.delete` | 端末の削除 | `name` |
| `user.create` | 利用者・エージェント作成 | `email`, `role` |
| `user.update` | 利用者・エージェント変更 | `name`, `role`, `status`, `passwordChanged`, `revokedDescendantKeys`（パスワード変更・無効化で、その人のキーから他の利用者向けに発行され連鎖で失効したキー） |
| `user.delete` | 利用者・エージェント削除 | `email`, `role`, `revokedDescendantKeys`（その人のキーから発行され、連鎖で失効したキー） |
| `user.grants.replace` | アドレス権限の一括差し替え | `grants` |
| `api_key.create` | API キー発行（利用者自身・管理画面） | `name`, `scopes`, `addressIds`, `apiKeyId`（発行に使ったキー。セッションなら null）。管理画面はさらに `userId`, `expiresAt` |
| `api_key.revoke` | API キー失効（利用者自身・管理画面） | `apiKeyId`（自分で失効）/ `userId`, `name`（管理画面）、`descendants`（連鎖で失効した子孫のキー） |
| `auth.bootstrap` | オーナー作成（初回セットアップ） | `email` |

`target_type` は `domain` / `address` / `rule` / `webhook` / `device` / `user` / `api_key`。`user.*` と `auth.bootstrap` は `user`、`api_key.*` は `api_key` を指す。
再発行（差し替え）は「旧キーの `api_key.revoke` + 新キーの `api_key.create`」の 2 行になる。
利用者自身のパスワード変更（`PATCH /v1/me`）とログイン・ログアウトは記録しない。

## API で読む

owner のセッションか、`addressIds` を絞っていない admin スコープの API キーで
`GET /v1/admin/audit-logs` を叩くと、新しい順に読める（絞ったキーは 403）。クエリ: `targetType` / `targetId` /
`actorId` / `action` / `limit`（既定 50）/ `cursor`。レスポンスは `{ data, next_cursor }`。
管理画面の各詳細ページ（ドメイン・アドレス・ユーザー・API キー・ルール・Webhook）は、その対象の分を同じ API で出す。

```bash
curl -s "$HOST/api/v1/admin/audit-logs?action=user.create&limit=20" \
  -H "Authorization: Bearer tsb_..."
```

## 見る

```console
-- 最近の操作
SELECT action, actor_id, target_type, target_id, meta, ip, datetime(created_at, 'unixepoch') AS at
FROM audit_logs
ORDER BY created_at DESC
LIMIT 50;
```

## 保存期間

**400 日**（約 13 か月）より古い行は、5 分ごとの cron（`src/services/maintenance.ts` `pruneAuditLogs`）が 1 回 1000 行ずつ消す。
年に 1 度の見直しでも前年分が残る長さにした。設定項目にはしない（要件の「設定を増やさない」方針）。
長く残す必要があるなら、消える前に上の SELECT で書き出して別に保管する。
