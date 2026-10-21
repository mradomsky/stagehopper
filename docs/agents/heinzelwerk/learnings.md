# Agent learnings

Curated by lead at the end of each team run, merged by a human. Max 80 lines. Hard-to-reverse decisions go to `docs/adr/`, terms to `GLOSSARY.md`; this file holds the rest.

<!-- format: - **<warning|discovery|codebase>** (#<ticket>): <one line> -->

- **warning** (adopt): Infra changes apply BEFORE tagging the app release, never "together" — several docs/*-infra.md say "together"; CLAUDE.md trap 2 wins.
- **warning** (adopt): Lambda env vars have no fallback names; a renamed var unset in infra is `undefined`/'' at runtime and the feature breaks outright.
- **warning** (adopt): Empty or wrong Clerk issuer on the API Gateway authorizer → 401 on every route, no error elsewhere.
- **warning** (adopt): CORS `allow_headers` must include Authorization, or preflight blocks every signed-in call.
- **warning** (adopt): DynamoDB tables have deletion protection; `terraform -replace` discards PITR — clear data with delete-items, never replace.
- **codebase** (adopt): Notifier VAPID public key/subject are hand-set and protected by `ignore_changes`; CI only runs update-function-code — any full config replace wipes them.
- **codebase** (adopt): API tokens come from a Clerk JWT template, not the session token, because API Gateway needs `aud`.
- **codebase** (#105): API base, data base and storage prefix live in `src/lib/stagehopper/config.ts`; build every fetch URL from `apiBase()`/`dataBase()` at call time. `FESTIVAL_DATA_PATH` and `timetableDataPath()` return defaults only and exist for specs; production code must not fetch through them.
- **warning** (#105): `configure()` re-points fetches only; `imageUrl`/`mapUrl` in the published manifest stay root-relative `/data/...`, so a bundle served from another origin (#109 embed) shows broken images unless it resolves them.
- **discovery** (#105): A fresh worktree has no `node_modules`; link the main checkout's (Windows: `mklink /J node_modules <main>\node_modules`) to run checks, and remove the junction (`rmdir node_modules`) before committing and before `git worktree remove`: removal follows the junction and wipes the main checkout's packages (#106).
- **warning** (#106): Clerk parses `appearance.variables` in JS on browsers without `color-mix()`; a `var()` resolving to a `color-mix()` string throws and `clerk.load` rejects (no sign-in). Pass only public and Fixed tokens there on those browsers; `elements` styles are plain CSS and take any token.
- **warning** (#106): `theme-literals.spec.ts` flags hex, `rgb(a)`, `hsl(a)` and named colours only; `oklch`/`oklab`/`lab`/`lch`/`hwb`/`color()` pass unflagged, and `src/app.html` and `src/routes/**/*.ts` are not scanned.
- **discovery** (#106): Screenshot evidence for signed-out screens: one throwaway Playwright script with `page.route('**/data/**')` proxied to prod (dev has no `/data`), `page.clock.setFixedTime` (now-line, Soon pill and badges move with the clock), `addStyleTag` for a Theme override, diffed with `npx -y pixelmatch a.png b.png diff.png 0.1`.
- **codebase** (#103): Festival create and update both write the whole item (`PutCommand`), so a payload that omits an optional field erases it; the admin form must send every field explicitly. `isListedOnLanding` means listed when absent: read it only through `isListed()`, never by truthiness.
- **warning** (#103): Playwright screenshots against `npm run dev` need `serviceWorkers: 'block'`; `static/sw.js` serves `/data/*` cache-first and bypasses `page.route` mocks.
- **warning** (#204): `lambda/index.spec.ts` mocks one shared `send`; adding a Query to an existing flow (e.g. the re-import gate) makes older specs' mocks answer it too, so give them per-`TableName` answers.
- **codebase** (#204): Handle comes from the `username` claim of the `apigw` JWT template (absent before #204's infra doc is applied → every Picks save is `400 handle is required`). Write Handle/Colour only through `lambda/attendee.ts`, which keeps the copies on Picks rows fresh (ADR 0005).
- **codebase** (#204): A Picks row exists only while it holds a going/maybe state: an empty map deletes it. Row present = Attendee, and it blocks the Festival's timetable re-import; with `PICKS_TABLE` unset the gate fails closed.
- **warning** (#205): Prod CloudFront rewrites every `/api/*` 403 and 404 to `200 text/html` (#181), so a Lambda 403 never reaches the browser as JSON. Answer 200 for idempotent no-ops (unknown id delete, empty reads); a client cannot branch on 403 until #181 is fixed.
- **warning** (#205): `lib-dynamodb` does not unmarshal `ConditionalCheckFailedException.Item` (it is `{S: ...}`); test its presence, never read fields off it.
- **warning** (#205): An in-memory DynamoDB fake in specs must evaluate key and condition operators, or boundary specs (rate limit, cursors) pass vacuously; mutation-check them.
- **warning** (#206): Pick states are not ordered by strength: `1` = going, `2` = maybe (`selections.ts`). "Going beats maybe" is `1` wins, never `Math.max`.
- **warning** (#206): Run the Picks migration (`docs/festival-picks-infra.md` §6) before tagging the release whose SPA reads Festival Picks; once real Festival Picks saves exist its real run refuses to write.
- **discovery** (#206): `lambda/*.ts` cannot run under Node type stripping (imports name `../shared/*.js`); bundle with esbuild first. `python3` is not runnable in the agent shell; use `node -e`.
- **warning** (#206): A report count derived from table state the run itself writes (e.g. "users with no colour") changes after the first run; derive rerun-stable counts from source data.
- **warning** (#207): The notifier reads Festival Picks with `GetItem` on `PICKS_TABLE` and throws on every tick when that env var is missing; `deploy.yml` refuses a release first, which needs the deploy role's `lambda:GetFunctionConfiguration` on `stagehopper-notifier` (`docs/festival-picks-infra.md` §7).
- **codebase** (#207): The Festival page's state is `FestivalSpace` (`festival-space.svelte.ts`). Its Picks save replaces the whole map, so it never PUTs before the first `picks/me` read and re-reads `picks/me` on every poll and tab return; the Pending Pick rides `?tap=`, not localStorage.
- **codebase** (#207): Public Picks rows carry no userId: the own row is matched by Handle from `users/me/profile`, and `AttendeePick.userId` on the Festival page is a synthetic key.
- **discovery** (#207): Root `npm audit --audit-level=high` can turn red from a transitive dev dependency with no code change and fails every PR's CI; fix it in a lockfile-only PR merged first.
- **warning** (#207): `vi.unstubAllGlobals()` in `afterEach` also removes a module-level `vi.stubGlobal` (e.g. `ResizeObserver`); stub inside the test that needs it.
- **discovery** (#207): `ui-shots` (and `merge-gate`) live in the heinzelwerk plugin's `bin/`, not in this repo; there is no `scripts/ui-shots`.
- **codebase** (#210): Landing cards read `GET festivals/{id}/summary` once per listed Festival on mount, in parallel, uncached. `fetchFestivalSummary` shape-checks the body, so a `200 text/html` answer (trap 1, route not live yet) leaves the card bare instead of throwing.
- **codebase** (#208): Festival chat state is `FestivalChat` (`festival-chat.svelte.ts`), separate from `FestivalSpace`. Its poll cursor advances only from a GET, never from a POST (an own post can be newer than an unpolled Message), and a full 200-Message `after=` page re-polls at once.
- **warning** (#208): `POST festivals/{id}/messages` checks only the id's format, not that the Festival exists; the page opens the chat only for a resolved Festival, so keep that gate on any new chat caller.
- **warning** (#208): On phones the collapsed chat sheet (56px) sits above the 52px bottom bar; a scroll area on the Festival page needs bottom padding for both, or its last rows hide behind the sheet.
- **warning** (#208): Svelte `{@const x = state}` inside an `{#if}` stays reactive; capture the value in the handler before clearing the state, or the callback sees null.
- **codebase** (#209): Ban is `banned: true` on the users row, written only by `POST|DELETE admin/users/{userId}/ban` (conditional update, never creates a row). A write route resolves the Attendee without `requireColour`, answers 403 if Banned, then 400 if there is no Colour; reads stay open.
- **codebase** (#209): Admin user delete removes Picks and Messages (Messages through the eventually consistent `userId-index`: ban first, then delete) and replaces a Banned user's row with a `{userId, banned:true}` tombstone. Their next write re-upserts handle, name and email onto it (#239).
- **warning** (#209): The merge gate refuses any PR that touches `.github/workflows/deploy.yml`. Put a new route's smoke entries in their own small PR (human merge) and keep the API PR gate-mergeable, although team.md's API contract says "same PR".
- **codebase** (#209): The Festival page owns Admin state for the chat (`checkAdmin()` in an `$effect` on `auth.user`, passed to `FestivalChat` as an `isAdmin` dep). It is presentation only; the API authorizes every delete.
- **warning** (#209): Admin user delete now queries `MESSAGES_TABLE`; tag a release containing #209 only after `docs/festival-chat-infra.md` §1-3 is applied, or every admin user delete answers 500 (it works today).
- **warning** (#211): Removing a public (no-authorizer) API route: the Lambda 404 becomes CloudFront HTML (#181), so its deploy.yml smoke entry fails the deploy until pruned; the prune PR (human merge) must be on main before the tag. Authorized routes still pass via the authorizer 401.
- **codebase** (#211): No sign-in upsert of the users row any more: a user appears in `/admin/users` only after a Picks save, Message, profile write or push subscription.
- **discovery** (#211): A module imported from both `lambda/` and `src/` cannot be deleted in either side PR without stacking; delete it in a small follow-up PR from main after an early merge of both sides.
