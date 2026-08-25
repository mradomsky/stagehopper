# Deploy-time manifest republish — Infrastructure change-list (Terraform repo)

One IAM statement. Like the other `*-infra.md` files here, this documents work in the
separate infrastructure (Terraform) repo, at `projects/stagehopper/`. Apply it **together
with** the app deploy that carries this change — without it the new "Republish the public
festivals manifest" step in `deploy.yml` fails the release with `AccessDeniedException`.

Region: `eu-central-1`.

## Why

`data/festivals/index.json` is derived from the `stagehopper-festivals` table by the
`stagehopper` Lambda, but it is only rewritten when an admin saves a festival. A release
that changes the manifest's *shape* — a new field, a renamed one — therefore leaves the
live file in the old shape indefinitely, until an unrelated edit happens to rewrite it.
That is not hypothetical: `description` shipped in the manifest builder and stayed invisible
on the festival page for a full release, because nothing wrote a festival afterwards.

The deploy now regenerates the file itself, immediately after `update-function-code`:

```
aws lambda invoke --function-name stagehopper \
  --cli-binary-format raw-in-base64-out \
  --payload '{"republish":"festivals-manifest"}' republish.json
```

This is a **direct invoke**, not an API Gateway request: no route, no authorizer, no new
public surface. The handler takes the maintenance path only when the event carries no
`routeKey`, which every gateway event always does, so the path is unreachable from the
internet. Authorization is the deploy role's IAM, below.

## Change

Add one statement to the GitHub Actions deploy role's inline policy —
`github-website-deployment-worker` / `stagehopper-github-actions-policy`, alongside the
existing `LambdaDeploy` statement:

```hcl
statement {
  sid       = "LambdaRepublish"
  effect    = "Allow"
  actions   = ["lambda:InvokeFunction"]
  resources = ["arn:aws:lambda:eu-central-1:${account_id}:function:stagehopper"]
}
```

No change to the Lambda's own execution role: it already holds `dynamodb:Scan` on
`stagehopper-festivals`, `s3:PutObject` on the site bucket, and
`cloudfront:CreateInvalidation` — everything the republish uses.

## Verifying

After apply, the deploy step prints the invoke's response body and fails the release unless
it is `{"ok":true,...}`. To check by hand:

```bash
aws lambda invoke --region eu-central-1 --function-name stagehopper \
  --cli-binary-format raw-in-base64-out \
  --payload '{"republish":"festivals-manifest"}' /tmp/republish.json && cat /tmp/republish.json
curl -s https://stagehopper.radomskyi.com/data/festivals/index.json
```

## Scope

Only the festivals manifest. Per-festival timetables
(`data/festivals/{id}/timetable.json`) are deliberately left to their own admin writes:
republishing one for a festival that has no performances yet would publish an empty
`days: []` file where the app currently expects a 404.
