---
status: accepted
---

# Nickname and Colour are copied onto every Picks row

A Festival's Picks are read by Visitors in one Query on the Picks table, so each row carries its Attendee's Nickname and Colour rather than joining the `users` table at read time. The name was first the Handle, the `username` claim of Clerk's `apigw` JWT template; since ADR 0006 it is the Nickname on the user row. When a Profile update changes either value, `lambda/attendee.ts` rewrites the copies on every Picks row of that user, found through the `userId-index` GSI (#204).

## Considered Options

- **Join at read time** (BatchGet of user rows per Festival read): no copies to keep fresh, but it turns the public read into many reads.
- **Scan the Picks table on change**: no index, but rows reach 300 KB and a Scan bills each in full, on every user's first Colour pick.
- **A `pickedFestivals` set on the user row**: no GSI, but every writer of Picks rows (including the #206 migration) must maintain it, and a miss leaves stale public copies and undeleted Picks.

## Consequences

- Any new writer of Picks rows writes `handle` (the Nickname's storage attribute) and `colour` from the user row, never from the token. The migration must also write them to the user row, or migrated users are asked to choose a Colour.
- Admin user delete finds a user's Picks through the same GSI.
- Only a Profile update refreshes the copies, in the same request as the change; resolving the Attendee on a Pick save or post never does (a token value must not overwrite a rename).
