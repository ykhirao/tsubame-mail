# 監査ログ

管理 API（domains / addresses / rules / webhooks / api-keys / users）の変更操作と
端末（push devices）の登録・削除は `audit_logs` テーブルに記録される。誰が・いつ・何に対して・IP 何から操作したかを
後から追えるようにするためのもので、配信メッセージ本体の内容（本文など）は記録しない。

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
| `domain.verify` | 確認の再実行 | `name`, `zoneId`, `routingStatus`, `sendingStatus` |
| `address.create` | アドレス作成 | `address`, `localPart`, `domainId`, `kind`, `aliasTargetId`, `isCatchAll` |
| `address.update` | アドレス変更 | `address`, `kind`, `aliasTargetId`, `isCatchAll`, `archived` |
| `address.delete` | アドレス削除 | `address`, `domainId`, `kind` |
| `rule.create` | ルール作成 | `name`, `scope`, `domainId` / `addressId`, `action`, `target` |
| `rule.update` | ルール更新 | `name`, `scope`, `action`, `target` |
| `rule.delete` | ルール削除 | `name`, `scope` |
| `webhook.create` | webhook 作成 | `name`, `url`, `events`, `addressIds`, `enabled`（secret は含まない） |
| `webhook.update` | webhook 更新 | `name`, `url`（secret は含まない） |
| `webhook.delete` | webhook 削除 | `name` |
| `webhook.retry` | 手動再送 | `deliveryId`, `attempt` |
| `device.register` | 端末の登録（再登録の上書きも含む） | `name`, `platform`（endpoint・キーは含まない） |
| `device.delete` | 端末の削除 | `name` |

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
