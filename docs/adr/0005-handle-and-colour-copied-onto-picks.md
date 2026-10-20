---
status: accepted
---

# Handle and Colour are copied onto every Picks row

A Festival's Picks are read by Visitors in one Query on the Picks table, so each row carries its Attendee's Handle and Colour rather than joining the `users` table at read time. The Handle comes from the `username` claim of Clerk's `apigw` JWT template, never from the request body. When a write changes either value, `lambda/attendee.ts` rewrites the copies on every Picks row of that user, found through the `userId-index` GSI (#204).

## Considered Options

- **Join at read time** (BatchGet of user rows per Festival read): no copies to keep fresh, but it turns the public read into many reads.
- **Scan the Picks table on change**: no index, but rows reach 300 KB and a Scan bills each in full, on every user's first Colour pick.
- **A `pickedFestivals` set on the user row**: no GSI, but every writer of Picks rows (including the #206 migration) must maintain it, and a miss leaves stale public copies and undeleted Picks.

## Consequences

- Any new writer of Picks rows writes `handle` and `colour` from the user row. The migration must also write them to the user row, or migrated users are asked to choose a Colour.
- Admin user delete finds a user's Picks through the same GSI.
- A Handle renamed in Clerk reaches the copies on that user's next write, not before.
