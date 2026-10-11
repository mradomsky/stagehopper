# Agent learnings

Curated by lead at the end of each team run, merged by a human. Max 80 lines. Hard-to-reverse decisions go to `docs/adr/`, terms to `GLOSSARY.md`; this file holds the rest.

<!-- format: - **<warning|discovery|codebase>** (#<ticket>): <one line> -->

- **warning** (adopt): Infra changes apply BEFORE tagging the app release, never "together" — several docs/*-infra.md say "together"; CLAUDE.md trap 2 wins.
- **warning** (adopt): Missing dynamodb:GetItem on the rooms table fails silently — a custom-id Room falls back to the latest Festival, only a console.error in Lambda logs.
- **warning** (adopt): Lambda env vars have no fallback names; a renamed var unset in infra is `undefined`/'' at runtime and the feature breaks outright.
- **warning** (adopt): Empty or wrong Clerk issuer on the API Gateway authorizer → 401 on every route, no error elsewhere.
- **warning** (adopt): CORS `allow_headers` must include Authorization, or preflight blocks every signed-in call.
- **warning** (adopt): DynamoDB tables have deletion protection; `terraform -replace` discards PITR — clear data with delete-items, never replace.
- **codebase** (adopt): Notifier VAPID public key/subject are hand-set and protected by `ignore_changes`; CI only runs update-function-code — any full config replace wipes them.
- **codebase** (adopt): API tokens come from a Clerk JWT template, not the session token, because API Gateway needs `aud`.
