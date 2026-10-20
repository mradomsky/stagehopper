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
