# Room removal — Infrastructure change-list (Terraform repo)

Work in the separate infrastructure (Terraform) repo, under `projects/stagehopper/`. The app
side (#211) deletes the Room routes, pages and code. This file lists what the infrastructure
repo must delete afterwards, and the order. Nothing here is applied by an agent.

Region: `eu-central-1`.

## Order in one screen

| Step | What | When |
|---|---|---|
| 0 | Preconditions and recording | before anything |
| 1 | Merge the `deploy.yml` smoke-list PR (human merge) | before the tag |
| 2 | Run the Picks migration (#222) | right before the tag, at low traffic |
| 3 | Tag `v*`, wait for the deploy to finish | after 1 and 2 |
| 4 | Backup both tables | after the release is live |
| 5 | Apply 1: routes, env vars, IAM, outputs, deletion protection off | after 4 |
| 6 | Apply 2: delete the two tables | after a soak, after 5 |

**No `v*` tag until** the Lambda PR, the SPA PR and the `deploy.yml` PR (#211) are merged and
the migration (#222) has run. A tag before the `deploy.yml` PR merges fails the deploy at the
smoke step: the unauthenticated `GET rooms/smoketest/selections` stops answering JSON once the
new Lambda ships, and the manifest republish after it is skipped.

**Never apply step 5 or 6 before the release is live.** The running v0.5.x Lambda still reads
`TABLE_NAME` and `ROOMS_TABLE` and still serves the Room routes. Removing them first breaks
every Room request, and removing the env vars first stops every Room pick-save.

## 0. Preconditions and recording

Check each before the tag. A missing one means the release breaks, not degrades.

- **Picks infra**: `docs/festival-picks-infra.md` sections 1 to 7 are applied. The notifier
  must have `PICKS_TABLE`:

  ```bash
  aws lambda get-function-configuration --function-name stagehopper-notifier \
    --query Environment.Variables.PICKS_TABLE
  aws lambda get-function-configuration --function-name stagehopper \
    --query Environment.Variables.PICKS_TABLE
  ```

  Both must print `"stagehopper-picks"`, not `null`.
- **Chat infra**: `docs/festival-chat-infra.md` sections 1 to 3 are applied (`MESSAGES_TABLE`
  on the API function, the table, the IAM grant). Admin user delete answers 500 without it.

  ```bash
  aws lambda get-function-configuration --function-name stagehopper \
    --query Environment.Variables.MESSAGES_TABLE
  ```
- **Deploy role grant (#224)**: the GitHub deploy role has `lambda:GetFunctionConfiguration`
  on `stagehopper-notifier` (festival-picks-infra.md section 7). Merge #224 only after it.
- **Record the Room table names** before step 5 removes the env vars. The migration CLI reads
  them from the operator's environment, and the backups in step 4 need them:

  ```bash
  aws lambda get-function-configuration --function-name stagehopper \
    --query 'Environment.Variables.{selections:TABLE_NAME,rooms:ROOMS_TABLE}'
  aws lambda get-function-configuration --function-name stagehopper-notifier \
    --query 'Environment.Variables.{selections:TABLE_NAME,rooms:ROOMS_TABLE}'
  ```

  Expected: `stagehopper-selections` and `stagehopper-rooms`. Write the real values into the
  PR that applies step 5.

## 1 to 3. Before and at the tag

1. Merge the `deploy.yml` PR that drops the Room routes from the smoke list.
2. Run the Picks migration (`docs/festival-picks-infra.md` section 6, #222) **right before
   tagging, at low traffic.** Room selections saved between the migration and the deploy are
   not migrated and are lost. The window is minutes, not days.
3. Tag. Wait for the deploy and the manifest republish to finish.

The new Lambda has no Room routes. A request to a removed route answers the gateway's default
`404`, which CloudFront rewrites to `200 text/html` in production (CLAUDE.md trap 1, #181).
Open tabs on the old app fail their Room writes after the release. That is accepted.

## 4. Backup both tables (after the release is live)

Both tables hold the only copy of Room data after the migration. Take on-demand backups, which
outlive the tables, and confirm they are `AVAILABLE` before step 5. Record both backup ARNs in the PR that applies step 5.

```bash
aws dynamodb create-backup --table-name stagehopper-selections --backup-name stagehopper-selections-pre-room-removal
aws dynamodb create-backup --table-name stagehopper-rooms --backup-name stagehopper-rooms-pre-room-removal
aws dynamodb list-backups --table-name stagehopper-selections --query 'BackupSummaries[].[BackupName,BackupStatus]'
aws dynamodb list-backups --table-name stagehopper-rooms --query 'BackupSummaries[].[BackupName,BackupStatus]'
```

Point-in-time recovery is on, but it dies with the table. Keep the backups for the retention
agreed in #241, then delete them.

## 5. Apply 1: detach (every reference except the table resources)

Everything below is in `projects/stagehopper/`. Line numbers are as of infrastructure
`origin/main` (checked 2026-10-21 with `git show origin/main:projects/stagehopper/<file>`); search for the names if they moved.

**API Gateway routes** (`main.tf`), delete the seven `aws_apigatewayv2_route` resources:

| Resource (main.tf) | Route key |
|---|---|
| `create_room` (:562) | `POST /api/stagehopper/rooms` |
| `get_selections` (:573) | `GET /api/stagehopper/rooms/{roomId}/selections` (the only public one) |
| `put_selections_self` (:579) | `PUT /api/stagehopper/rooms/{roomId}/selections` |
| `delete_selections_self` (:587) | `DELETE /api/stagehopper/rooms/{roomId}/selections` |
| `list_my_rooms` (:597) | `GET /api/stagehopper/users/me/rooms` |
| `admin_list_rooms` (:707) | `POST /api/stagehopper/admin/rooms` |
| `admin_delete_room` (:725) | `DELETE /api/stagehopper/admin/rooms/{roomId}` |

Also fix the comments that name them: the Authorizer header (`Every route but GET .../selections`
— the public Festival reads are now the exception) and the count in "the 10 admin routes" if it
is stale.

**API Lambda environment** (`main.tf`, `environment.variables` of `stagehopper`): delete
`TABLE_NAME` (:468) and `ROOMS_TABLE` (:473).

**API Lambda IAM** (`main.tf`, the DynamoDB statement, :372-398):

- remove `aws_dynamodb_table.stagehopper_selections.arn` (:392) and
  `aws_dynamodb_table.stagehopper_rooms.arn` (:396) from `Resource`;
- `dynamodb:TransactWriteItems` is no longer used by the Lambda (the Room save was its only
  caller); remove it from `Action` (:389) unless another consumer needs it;
- update the comments on `UpdateItem` (`rooms.<id>` entry) and `Scan` (room listing and the
  rooms-for-a-festival gate). `Scan` stays: the admin user list still scans `stagehopper-users`.

**Notifier** (`notifications.tf`): the notifier already reads Picks and no longer touches either
table (#207).

- delete the IAM statements `SelectionsRead` (:194) and `RoomsRead` (:203);
- delete `TABLE_NAME` (:276) and `ROOMS_TABLE` (:280) from the notifier's `environment.variables`;
- the `UsersScan` comment says the notifier reads each user's `rooms` map; it no longer does.

**Outputs** (`outputs.tf:21`): delete `stagehopper_dynamodb_table`, which points at the selections
table. Search other repos and workflows for a consumer first (`grep -r stagehopper_dynamodb_table`).

**Deletion protection** (`main.tf:232`, `:338`): in both `aws_dynamodb_table.stagehopper_selections` and
`aws_dynamodb_table.stagehopper_rooms`, set `deletion_protection_enabled = false`. Keep the
resources. Without this, apply 2 fails with `ResourceInUseException`.

`terraform plan` for apply 1 must show only: seven routes destroyed, two env vars and three
IAM statements or entries changed, one output removed, two tables updated in place
(deletion protection). **No table is destroyed in this apply.** Any other destroy, stop.

After applying, probe the live site (CLAUDE.md trap 1):

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://stagehopper.radomskyi.com/api/stagehopper/festivals/smoke/picks
```

It must stay `200 application/json`. Check one signed-in Picks save and one chat post in the
browser.

## 6. Apply 2: delete the tables

After a soak of a few days with no errors in the `stagehopper` and `stagehopper-notifier` logs
mentioning `stagehopper-selections` or `stagehopper-rooms` (an `AccessDeniedException` there
means something still reads them), delete the two `aws_dynamodb_table` resources
(`stagehopper_selections` :227, `stagehopper_rooms` :334) from `main.tf`, and the comment blocks above
them.

`terraform plan` must show exactly two tables destroyed and nothing else. Confirm the step 4
backups are `AVAILABLE` first.

## After step 6

- Delete `lambda/migrate-picks.ts`, `lambda/migrate-picks-cli.ts`, their spec, and the
  `docs/festival-picks-infra.md` section 6 (a follow-up issue tracks it). The script reads the
  tables that no longer exist.
- The `rooms` attribute on `stagehopper-users` rows is left in place. Nothing reads it, and no
  prod cleanup write is planned.
