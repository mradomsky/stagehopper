# Festival Picks — Infrastructure change-list (Terraform repo)

Work in the separate infrastructure (Terraform) repo, under `projects/stagehopper/`, plus the
Clerk dashboard. **Apply all of it before tagging the release that contains #204** (CLAUDE.md
trap 2): with `PICKS_TABLE` unset every Picks route fails and the timetable re-import is refused
(fail closed); with no `username` claim every `PUT festivals/{id}/picks` and
`PUT users/me/profile` answers `400 handle is required`.

Region: `eu-central-1`.

## 1. DynamoDB table `stagehopper-picks`

- Billing `PAY_PER_REQUEST`, deletion protection on, point-in-time recovery on (as the other
  stagehopper tables).
- Key: `festivalId` (S) hash, `userId` (S) range.
- Global secondary index `userId-index`: hash `userId` (S), range `festivalId` (S),
  projection `KEYS_ONLY`. Used to refresh the denormalised `handle` and `colour` on a user's
  rows when either changes, and to delete a user's rows.

Item shape: `{ festivalId, userId, handle, colour, selections, updatedAt }`.

## 2. IAM for the `stagehopper` Lambda

On the table ARN **and** `<table-arn>/index/userId-index`: `dynamodb:Query`. On the table ARN:
`dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem`,
`dynamodb:BatchWriteItem`.

## 3. Lambda environment

`PICKS_TABLE = stagehopper-picks` in `environment.variables`. Not optional: no fallback name.

## 4. API Gateway routes (all to the `stagehopper` Lambda integration)

| Route | Authorizer |
|---|---|
| `GET /api/stagehopper/festivals/{id}/picks` | none (public read) |
| `GET /api/stagehopper/festivals/{id}/picks/me` | JWT |
| `PUT /api/stagehopper/festivals/{id}/picks` | JWT |
| `GET /api/stagehopper/users/me/profile` | JWT |
| `PUT /api/stagehopper/users/me/profile` | JWT |

Confirm the CloudFront `/api/*` behaviour uses `CachingDisabled` (the public `GET picks`
changes on every save and must not be cached at the edge). No new request headers are sent.

## 5. Clerk `apigw` JWT template (dev and prod instances)

Add the claim `"username": "{{user.username || ''}}"`. The Lambda takes the Attendee handle
from it; an empty claim makes the write routes answer `400 handle is required`.

Also confirm the prod instance requires usernames at sign-up (#187) and count existing users
without one: each of them is stuck at that 400 until they get a username.

## Check after applying

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://stagehopper.radomskyi.com/api/stagehopper/festivals/smoke/picks
```

Expect `200 application/json`. `deploy.yml` probes the same URL and fails the release step
otherwise (it catches an unset `PICKS_TABLE` or a missing IAM grant, which a content-type
check alone does not).

## 6. One-time migration of Room selections into Festival Picks (#206)

An operator runs this once, by hand, **after sections 1 to 5 are applied and before the `v*`
tag that ships the Festival page.** It copies every user's Room selections into `stagehopper-picks`
and sets `handle` and `colour` on their `users` row, so migrated users are not asked to choose
a colour before their next save. It is not part of the Lambda or of `deploy.yml`.

### Preconditions

- Sections 1 to 5 are applied: `stagehopper-picks` exists and the Clerk `apigw` template carries
  `username`.
- The Festival page is **not** released yet. Once real Picks exist the real run refuses
  (see "Why it refuses" below).

### Where it runs

On the operator's own machine, from a checkout of this repo at the commit to be released, with
both `npm ci` and `npm ci --prefix lambda` done. It reads and writes the production tables
directly, so it needs AWS credentials and the Clerk **production** secret key.

### Build

```bash
npx esbuild lambda/migrate-picks-cli.ts --bundle --platform=node --target=node22 --format=esm \
  "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
  --outfile=build/migrate-picks.mjs
```

The output goes to `build/` (git-ignored), not `lambda/dist`, which `deploy.yml` uploads.
Running it with no environment must exit 1 with `Missing required environment variable(s): ...`;
that proves the bundle starts.

### Credentials

- **AWS**: a profile with prod access in `eu-central-1`. The run needs `dynamodb:Scan` on the
  Room selections, `users`, rooms, festivals, performances and `stagehopper-picks` tables,
  `dynamodb:UpdateItem` on `users`, and `dynamodb:PutItem` on `stagehopper-picks`.
- **Clerk**: the production instance's secret key (`sk_live_...`). The script only reads users
  (`GET /v1/users`); it never writes to Clerk. Do not type the key into the shell where history
  records it. Read it into the environment instead:

  ```bash
  read -rs CLERK_SECRET_KEY && export CLERK_SECRET_KEY
  ```

- **Table names**: take them from the live function, do not guess:

  ```bash
  aws lambda get-function-configuration --region eu-central-1 --function-name stagehopper \
    --query 'Environment.Variables'
  ```

  Export `AWS_REGION=eu-central-1`, `TABLE_NAME`, `USERS_TABLE`, `ROOMS_TABLE`,
  `FESTIVALS_TABLE`, `PERFORMANCES_TABLE` and `PICKS_TABLE` from that output. All eight
  variables are required; there are no defaults.

### Steps

1. **Dry run.** `node build/migrate-picks.mjs --dry-run` reads everything and writes nothing.
   It prints users, festivals, rows written, rooms dropped and the skipped groups.
   - `not in Clerk` should be close to 0. A large number means the key belongs to the wrong
     Clerk instance: stop and fix the key. Users listed there are accounts Clerk no longer has.
   - `no handle` and `no users row` list users who are skipped; check they are expected.
   - `colours defaulted` lists users given the first palette colour because no Room colour
     was usable.
2. **Real run.** `node build/migrate-picks.mjs`. It sets `handle` and `colour` on each `users`
   row only where they are missing (`if_not_exists`), then puts the Picks rows.
3. **Second real run.** Run it again. The printed counts must equal the first real run's and
   the Picks rows must not change (their `updatedAt` comes from the Room data, never the clock).
4. Tag the release.

### Why it refuses

A Picks row is deleted when its user clears all their picks. A rerun after the Festival page
ships could put that user's old Room picks back. So the real run scans `stagehopper-picks`
first and exits non-zero, writing nothing, if it finds a row newer than the one it would write
or a row it would not produce. A row identical to what the migration produces does not count,
so the second run in step 3 succeeds. `--dry-run` reports both counts instead of refusing.

### Not covered

Picks a user marked in a Room but not yet synced from their device (held in local storage)
are invisible to this script; they are tracked on #203 for the Festival page.
