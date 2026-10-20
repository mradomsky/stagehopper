---
status: superseded by ADR-0004
---

# Room selections are readable by anyone holding the Room id

`GET /rooms/{roomId}/selections` is the one API route without the Clerk authorizer: the Room id works as a capability URL, so a shared link shows the group's Picks without sign-in. We accepted unauthenticated reads of Picks in exchange for frictionless sharing; every write still requires sign-in.

Source: docs/clerk-auth-infra.md#3-route-changes
