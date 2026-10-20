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
- **codebase** (#206): Room selections rows carry no `updatedAt` and include a `@room` display-name row per Room; per-(user, Room) recency lives only in the users row's `rooms` map.
- **warning** (#206): Run the Picks migration (`docs/festival-picks-infra.md` §6) before tagging the release whose SPA reads Festival Picks; once real Festival Picks saves exist its real run refuses to write.
- **discovery** (#206): `lambda/*.ts` cannot run under Node type stripping (imports name `../shared/*.js`); bundle with esbuild first. `python3` is not runnable in the agent shell; use `node -e`.
- **warning** (#206): A report count derived from table state the run itself writes (e.g. "users with no colour") changes after the first run; derive rerun-stable counts from source data.
- **warning** (#207): The notifier reads Festival Picks with `GetItem` on `PICKS_TABLE` and throws on every tick when that env var is missing; `deploy.yml` refuses a release first, which needs the deploy role's `lambda:GetFunctionConfiguration` on `stagehopper-notifier` (`docs/festival-picks-infra.md` §7).
- **codebase** (#207): The Festival page's state is `FestivalSpace` (`festival-space.svelte.ts`). Its Picks save replaces the whole map, so it never PUTs before the first `picks/me` read and re-reads `picks/me` on every poll and tab return; the Pending Pick rides `?tap=`, not localStorage.
- **codebase** (#207): Public Picks rows carry no userId: the own row is matched by Handle from `users/me/profile`, and `ParticipantMark.userId` on the Festival page is a synthetic key.
- **warning** (#207): `fetchTimetableForRoom` / `resolveRoomFestival` fall back to the latest Festival for an unknown id; a Festival-keyed caller must check `getFestivalById` first, or `/festival/bogus` reads and writes Picks under the bogus id.
- **discovery** (#207): Root `npm audit --audit-level=high` can turn red from a transitive dev dependency with no code change and fails every PR's CI; fix it in a lockfile-only PR merged first.
- **warning** (#207): `vi.unstubAllGlobals()` in `afterEach` also removes a module-level `vi.stubGlobal` (e.g. `ResizeObserver`); stub inside the test that needs it.
