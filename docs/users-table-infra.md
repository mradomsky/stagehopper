# Users table consolidation — Infrastructure change-list (Terraform repo)

Replaces the `memberships` and `user_settings` DynamoDB tables with a single `users` table.
Like [notifications-infra.md](./notifications-infra.md), this documents the work required in
the separate infrastructure (Terraform) repo. Apply it **together with** the app deploy that
carries this change — the app code reads `USERS_TABLE` and no longer reads
`MEMBERSHIPS_TABLE_NAME` or `USER_SETTINGS_TABLE`.

Region: `eu-central-1`. Billing: on-demand (`PAY_PER_REQUEST`), same as the other tables.

## 1. New table

| Logical name | PK (S)   | SK  | Notes                                                                 |
|--------------|----------|-----|-----------------------------------------------------------------------|
| `users`      | `userId` | —   | One row per user. `rooms` map (roomId → `{ color, updatedAt, name }`) is the inverse index of the selections table; notification settings (`enabled`, `leadMinutes`, `notifyAttending`, `notifyMaybe`) live on the same row. |

- No GSIs. Access is GetItem/UpdateItem by `userId`, plus a full Scan for the admin lists
  and the notifier (same pattern the old `memberships`/`user_settings` scans used).

## 2. Tables to drop

- `memberships` (was `MEMBERSHIPS_TABLE_NAME`) — the `users.rooms` map replaces it.
- `user_settings` (was `USER_SETTINGS_TABLE`) — its fields moved onto the `users` row.

The DB is empty at cutover, so there is **no data migration**. Create `users`, repoint the env
vars (below), deploy, then delete the two old tables.

## 3. Env var changes (both Lambdas)

Add `USERS_TABLE = <users table name>` and remove `MEMBERSHIPS_TABLE_NAME` and
`USER_SETTINGS_TABLE` from **both** the API Lambda (`stagehopper`) and the notifier
(`stagehopper-notifier`). `TABLE_NAME`, `PUSH_SUBSCRIPTIONS_TABLE`, `NOTIF_DEDUP_TABLE`,
`SITE_BUCKET` and the VAPID vars are unchanged.

## 4. IAM changes

- **API Lambda (`stagehopper`)** — replace the `memberships` and `user_settings` grants with
  read/write on `users` (GetItem, PutItem, UpdateItem, DeleteItem, Scan). `push_subscriptions`
  and the selections table grants are unchanged. (`deleteAdminUser` now also deletes the user's
  `push_subscriptions` rows, so DeleteItem there is required — it already is for the API fn.)
- **Notifier Lambda (`stagehopper-notifier`)** — replace the `user_settings` (Scan, GetItem,
  UpdateItem) and `memberships` (Query) grants with `users`: Scan, GetItem. `push_subscriptions`
  (Query, DeleteItem), `notif_dedup` (conditional PutItem), the selections table (GetItem) and
  the `SITE_BUCKET` S3 grants are unchanged.

## 5. No API Gateway / route changes

The route surface is identical — every `listMyRooms`, admin, and notification route keeps its
path and request/response shape. Nothing to add or probe in the deploy smoke-test.
