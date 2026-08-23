# Festivals + timetable → DynamoDB — Infrastructure change-list (Terraform repo)

Moves the write-side source of truth for festivals and their timetables off S3 JSON blobs
and onto two new DynamoDB tables. Like [clerk-auth-infra.md](./clerk-auth-infra.md), this
documents the work in the separate infrastructure (Terraform) repo, at
`projects/stagehopper/`. Apply it **together with** the app deploy that carries this change
— the Lambda's new routes read/write these tables directly, and stop reading/writing
`data/festivals.json` and `data/timetable-{id}.json`.

Region: `eu-central-1` (matching every existing table).

## 1. New tables

**`stagehopper-festivals`** — one item per festival, the write-side source of truth for the
festival list.

| Attribute | Key |
|---|---|
| `id` | Partition key (string) |

Other attributes (`name`, `location`, `startDate`, `endDate`, `timezone`, `imageUrl`,
`mapUrl`, `description`) are unstructured on the table — the Lambda validates them, same as
every other table here.

**`stagehopper-performances`** — one item per performance, the write-side source of truth
for every festival's timetable.

| Attribute | Key |
|---|---|
| `festivalId` | Partition key (string) |
| `id` | Sort key (string) — the performance id |

Other attributes: `date`, `artist`, `stage`, `startTime`, `endTime`, `artistImage`,
`instagram`, `artists` (lineup-feed enrichment, import-only).

Both tables: `billing_mode = "PAY_PER_REQUEST"`, `deletion_protection_enabled = true` —
matching `stagehopper-users`, `stagehopper-selections`, and `stagehopper-push-subscriptions`.
No GSIs on either: every access pattern is a `Query` on the partition key (or a bounded
`Scan` on the small festivals table), and public reads never touch DynamoDB at all — they
read the derived S3/CloudFront copies these tables republish on every write.

## 2. IAM

The `stagehopper` Lambda's execution role needs, on both new tables:
`dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `Scan`, `BatchWriteItem`.

No change to the `stagehopper-notifier` function's permissions — it keeps reading the
public S3 artifacts (`data/festivals/index.json`, `data/festivals/{id}/timetable.json`),
never the tables directly.

## 3. S3 path changes (no bucket/IAM change, just what's written where)

| Old | New |
|---|---| 
| `data/festivals.json` (full records) | `data/festivals/index.json` — slim manifest: `id, name, location, startDate, endDate, timezone, imageUrl` |
| `data/timetable-{id}.json` | `data/festivals/{id}/timetable.json` |

Images and maps (`data/festival-images/…`, `data/festival-maps/…`) are unchanged — not part
of this migration.

## 4. Cutover

Hard cutover, one deploy window, matching the [Clerk keyspace cutover](./clerk-auth-infra.md#6-keyspace-cutover)
precedent:

1. Create both tables (this Terraform).
2. Backfill the one live festival (`szg26`) and its timetable performances into the new
   tables by hand — trivially small, no migration tooling needed.
3. Deploy the app + Lambda together (new admin routes, new public S3 paths, updated
   frontend fetch paths).
4. Confirm `data/festivals/index.json` and `data/festivals/szg26/timetable.json` are
   published and correct.
5. Delete the old `data/festivals.json` and `data/timetable-szg26.json`.

No dual-write period, no schema versioning — see the design conversation this document
comes out of for why.
