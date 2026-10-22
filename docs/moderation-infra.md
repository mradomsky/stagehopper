# Moderation (ban, unban, user-delete cascade) — Infrastructure change-list (Terraform repo)

Work in the separate infrastructure (Terraform) repo, under `projects/stagehopper/`.
**Apply all of it before tagging any release that contains #209** (CLAUDE.md trap 2). The
`deploy.yml` smoke test probes the two new routes, and a smoke failure skips the manifest
republish step that follows it.

Region: `eu-central-1`.

## 0. Prerequisite: the chat infra

Apply `docs/festival-chat-infra.md` sections 1 to 3 first (the `stagehopper-messages` table
with its `userId-index`, the IAM grants, `MESSAGES_TABLE`). The chat infra is not live in prod
yet. Admin user delete now queries that index, so with `MESSAGES_TABLE` unset **every admin
user delete answers 500**, where today it works.

## 1. API Gateway routes (both to the `stagehopper` Lambda integration)

| Route | Authorizer |
|---|---|
| `POST /api/stagehopper/admin/users/{userId}/ban` | JWT, `authorization_scopes = ["admin"]` |
| `DELETE /api/stagehopper/admin/users/{userId}/ban` | JWT, `authorization_scopes = ["admin"]` |

Same authorizer and scope as every other `/admin/*` route (`docs/clerk-auth-infra.md`). The
Lambda also checks the scope itself. `{userId}` arrives URL-encoded (`clerk%3A...`).

## 2. No new table, env var or IAM — verify these exist

- `stagehopper-users`: `dynamodb:UpdateItem` (ban, unban), `dynamodb:PutItem` (the tombstone a
  Banned user's delete leaves), `dynamodb:GetItem`, `dynamodb:BatchWriteItem`.
- `stagehopper-messages` and `<table-arn>/index/userId-index`: `dynamodb:Query`, plus
  `dynamodb:BatchWriteItem` on the table (the delete cascade). Per `festival-chat-infra.md` §2.
- `stagehopper-picks` and its `userId-index`: `dynamodb:Query`, `dynamodb:BatchWriteItem`.

## Behaviour worth knowing

- A Banned user gets 403 on `PUT festivals/{id}/picks` and `POST festivals/{id}/messages`. Reads
  stay open.
- Deleting a Banned user removes their Picks, Messages and profile data but keeps a
  `{ userId, banned: true }` row, so the delete does not lift the ban. They stay listed on the
  admin users page as Banned.

## Known rough edge: 403 and 404 arrive as HTML

The new routes answer 403 (non-admin) and 404 (unknown user). Until #181 is fixed, CloudFront
rewrites 403 and 404 on `/api/*` to `200 text/html`, so a client sees HTML for those cases.

## Check after applying

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -X POST   https://stagehopper.radomskyi.com/api/stagehopper/admin/users/clerk%3Asmoke/ban
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -X DELETE https://stagehopper.radomskyi.com/api/stagehopper/admin/users/clerk%3Asmoke/ban
```

Expect `401 application/json` from the authorizer for both. `text/html` means the route is not
wired. The `deploy.yml` smoke test runs the same probes.
