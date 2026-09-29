# Room festival read — Infrastructure change-list (Terraform repo)

One IAM action. Like the other `*-infra.md` files here, this describes work in the separate
infrastructure (Terraform) repo, under `projects/stagehopper/`.

Region: `eu-central-1`.

## Why

`GET /rooms/{roomId}/selections` now reads a custom-slug room's `stagehopper-rooms` row, so
the SPA can use the festival recorded there instead of guessing "the latest festival" (#176).
Until now the `stagehopper` Lambda only wrote to that table (`UpdateItem` inside the selections
transaction, `DeleteItem`) and scanned it (the re-import gate).

## Change

Add `dynamodb:GetItem` on the `stagehopper-rooms` table ARN to the `stagehopper` Lambda's
execution role.

Order doesn't matter. Without the grant, the read fails with `AccessDeniedException`, the
Lambda logs `Failed to read the room festival:` and returns the room as before. The room
still loads and the SPA falls back to the latest festival, so the fix does nothing until
the grant is applied.
