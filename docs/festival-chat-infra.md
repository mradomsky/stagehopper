# Festival chat — Infrastructure change-list (Terraform repo)

Work in the separate infrastructure (Terraform) repo, under `projects/stagehopper/`.
**Apply all of it before tagging any release that contains #205** (CLAUDE.md trap 2). With
`MESSAGES_TABLE` unset, every chat route answers 500, and an admin Festival delete fails
*after* it has already removed the Festival row (the Messages cascade comes last).

Region: `eu-central-1`.

## 1. DynamoDB table `stagehopper-messages`

- Billing `PAY_PER_REQUEST`, deletion protection on, point-in-time recovery on (as the other
  stagehopper tables). No TTL: Messages are kept until deleted.
- Key: `festivalId` (S) hash, `messageId` (S) range. A `messageId` is `<13-digit zero-padded
  ms>-<8 chars [0-9a-z]>`, so the range key sorts by time.
- Global secondary index `userId-index`: hash `userId` (S), range `messageId` (S),
  projection `KEYS_ONLY`. Not read by this release; #209 (user delete) needs it, and a GSI
  key cannot be changed later, so it is created now.

Item shape: `{ festivalId, messageId, userId, handle, colour, text, createdAt }`. `handle` and
`colour` are a snapshot from post time. The public API never returns `userId`.

## 2. IAM for the `stagehopper` Lambda

- On the table ARN **and** `<table-arn>/index/userId-index`: `dynamodb:Query`.
- On the table ARN: `dynamodb:PutItem`, `dynamodb:DeleteItem`, `dynamodb:BatchWriteItem`.
- Already granted, verify they are still there: `dynamodb:GetItem` on `stagehopper-festivals`
  (POST checks the Festival exists), `dynamodb:UpdateItem` on `stagehopper-users` (rate limit
  `lastPostedAt` and the Attendee refresh), `dynamodb:Query` on `stagehopper-picks` and its `userId-index`, and `dynamodb:UpdateItem` on `stagehopper-picks` (summary, and the Attendee refresh a post triggers when the handle changed).

## 3. Lambda environment

`MESSAGES_TABLE = stagehopper-messages` in `environment.variables`. Not optional: no fallback
name.

## 4. API Gateway routes (all to the `stagehopper` Lambda integration)

| Route | Authorizer |
|---|---|
| `GET /api/stagehopper/festivals/{id}/messages` | none (public read) |
| `POST /api/stagehopper/festivals/{id}/messages` | JWT |
| `DELETE /api/stagehopper/festivals/{id}/messages/{messageId}` | JWT |
| `GET /api/stagehopper/festivals/{id}/summary` | none (public read) |

The `DELETE` route is not under `/admin/`, so it needs no `admin` scope: the Lambda lets an
author delete their own Message and an `admin`-scoped caller delete any.

`GET messages` takes `after` and `before` query parameters. Confirm the CloudFront `/api/*`
behaviour forwards query strings (`query_string = true`) and uses `CachingDisabled`: both
public reads change on every post. No new request headers are sent.

## Known rough edge: 403 arrives as HTML

The Lambda answers 403 for a banned user posting and for deleting someone else's Message. The
CloudFront custom error responses rewrite 403 and 404 on `/api/*` to `200 text/html` until
the infrastructure issue #181 is fixed, so a client sees HTML, not JSON, for those two cases.
#181 blocks the chat UI (#208), not this API.

## Check after applying

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://stagehopper.radomskyi.com/api/stagehopper/festivals/smoke/messages
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://stagehopper.radomskyi.com/api/stagehopper/festivals/smoke/summary
```

Expect `200 application/json` for both. The `deploy.yml` smoke test probes the same URLs and
fails the release step otherwise (an unset `MESSAGES_TABLE` or a missing IAM grant makes them
500, which a content-type check alone would not catch).
