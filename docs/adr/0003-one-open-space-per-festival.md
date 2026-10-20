---
status: accepted
---

# One open space per Festival, no private Rooms

Rooms (private groups per Festival, joined by link) made the app feel empty to a newcomer: every space started with one person. We replaced them with a single shared space per Festival — everyone's Picks visible, one open Festival chat — so a new user lands among people, and dropped Rooms, Friends and groups entirely rather than layering a social graph on top. Existing Room Picks were merged per user into Festival Picks (going beats maybe) in a one-shot migration; Rooms with a custom id and no Festival were dropped.

## Consequences

- Identity is app-wide (Handle, Colour), not per space; colours are no longer claimed.
- An open room needs a moderation floor from day one: Admin message delete, ban, server-side rate limit.
- Private groups, if ever wanted again, are a new feature, not a revival: the Room tables, ids and routes are gone.
