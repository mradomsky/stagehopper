# Push Notifications — Infrastructure change-list (Terraform repo)

This feature spans two repos. **This file documents the work required in the separate
infrastructure (Terraform) repo.** Apply it **before** deploying the app code, or the
deploy smoke-test fails (new API routes fall through to the SPA `index.html`) and the
notifier Lambda has nothing to deploy into.

Region: `eu-central-1`.

## 0. VAPID keypair (one-time, by hand)

Generate a single app-wide keypair (no rotation mechanism by design):

```bash
npx web-push generate-vapid-keys
```

- **Private key** → set as env var on the **notifier** Lambda (below). Never commit.
- **Public key** → shipped to the client as the build var `VITE_VAPID_PUBLIC_KEY`
  (public by design). CI already reads it in the `Build` step; add it as a GitHub Actions
  **secret** named `VITE_VAPID_PUBLIC_KEY` (the workflow references `secrets.VITE_VAPID_PUBLIC_KEY`).
- **Subject** → `VAPID_SUBJECT = mailto:<admin-email>`.

> **Superseded in part:** the notification *settings* no longer live in a `user_settings`
> table — they moved onto the `users` table that replaced `memberships`. See
> [users-table-infra.md](./users-table-infra.md). The table/IAM/env below are shown in their
> current, consolidated form.

## 1. DynamoDB tables

| Logical name           | PK (S)          | SK (S)          | Notes                                  |
|------------------------|-----------------|-----------------|----------------------------------------|
| `users`                | `userId`        | —               | `rooms` map + `{ enabled, leadMinutes, notifyAttending, notifyMaybe }` (see users-table-infra.md) |
| `push_subscriptions`   | `userId`        | `endpoint`      | one row per device                     |
| `notif_dedup`          | `userId`        | `performanceId` | **TTL** attribute `ttl` (epoch seconds) |

- Billing: on-demand (`PAY_PER_REQUEST`), same as existing tables.
- On `notif_dedup`, enable TTL on attribute **`ttl`**.
- No GSIs required (notifier uses a user-first scan; access is by PK/PK+SK only).

## 2. IAM

**API Lambda (`stagehopper`)** — grant read/write on `users` and
`push_subscriptions` (GetItem, PutItem, UpdateItem, DeleteItem, Query, Scan).

**Notifier Lambda (new)** — grant:
- `users`: Scan, GetItem.
- `push_subscriptions`: Query, DeleteItem.
- `notif_dedup`: PutItem (conditional).
- Selections table (`TABLE_NAME`): GetItem.
- `SITE_BUCKET` S3: GetObject on `data/festivals.json`, `data/timetable-*.json`.

## 3. Notifier Lambda (new function)

- **Function name: `stagehopper-notifier`** — the app repo's CI deploy step targets exactly
  this name (`.github/workflows/deploy.yml` → "Deploy Notifier Lambda"). Match it here.
- Runtime/arch: match the existing `stagehopper` function (Node 22, ESM).
- Handler: `notifier.handler` (bundle `lambda/dist/notifier.mjs`).
- Timeout: **~30s** (loops subscriptions + sends pushes; longer than the API fn).
  Memory: 256–512 MB is plenty.
- Env vars:
  - `TABLE_NAME`, `USERS_TABLE` (same values as the API fn)
  - `PUSH_SUBSCRIPTIONS_TABLE`, `NOTIF_DEDUP_TABLE`
  - `SITE_BUCKET`
  - `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` (set by hand — CI only
    runs `update-function-code`, so a config-replace would wipe these).
- CI (already wired in this repo): the "Deploy Notifier Lambda" step zips
  `lambda/dist/notifier.mjs` and runs `update-function-code --function-name stagehopper-notifier`.
  The function must already exist (created here) before the first deploy targets it.

## 4. EventBridge schedule

- Rule: `rate(1 minute)` (or `cron(* * * * ? *)`), target = notifier Lambda.
- Add the `lambda:InvokeFunction` permission for the EventBridge rule principal.
- The notifier self-gates: it exits immediately unless a festival is happening now and
  has a performance inside the candidate window, so a minute cadence is cheap.

## 5. API Gateway routes (HTTP API v2) — 4 new `aws_apigatewayv2_route`

Each targets the existing `stagehopper` Lambda integration (same as current routes):

```
POST   /api/stagehopper/users/me/notifications
PUT    /api/stagehopper/users/me/notifications
POST   /api/stagehopper/users/me/notifications/subscription
DELETE /api/stagehopper/users/me/notifications/subscription
```

> Miss any of these in Terraform and the request falls through to the SPA `index.html`
> (200 `text/html`) — the deploy smoke-test in the app repo is updated to probe all four
> and will fail the deploy if a route is missing.

## 6. FestivalRecord.timezone

No infra change. `data/festivals.json` gains a `timezone` field per festival, written by
the admin form. Legacy records without it default to `Europe/Berlin` at read time
(client + notifier) — no data migration needed.

## Apply order

1. This repo (Terraform): tables + IAM + notifier fn shell + EventBridge + 4 routes +
   VAPID envs.
2. App repo: tag/release → deploys API handlers, notifier code, SW, popup, and the
   `VITE_VAPID_PUBLIC_KEY` build var.
