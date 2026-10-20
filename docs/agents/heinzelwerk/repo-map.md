# Repo map

Facts for locating code. Traps live in `CLAUDE.md`; vocabulary in `GLOSSARY.md`.

## Shape

- SvelteKit SPA (`adapter-static`, fallback `index.html`) on S3 + CloudFront.
- API Gateway HTTP API → one API Lambda (`lambda/index.ts`). DynamoDB is the write side.
- Signed-out reads are derived JSON files in the site bucket (`data/festivals/index.json`, `data/festivals/{id}/timetable.json`), not API calls.
- Push notifier Lambda (`lambda/notifier.ts`), invoked by EventBridge every minute.
- Infra (API routes, tables, IAM, CloudFront) is Terraform in the separate `infrastructure` repo, `projects/stagehopper/`.

## Frontend (`src/`)

- Routes: `/` (prerendered), `/festival/[id]`, `/room/[roomId]` (a Room, or a Lineup when the id is a bare festival id), `/admin/*` (festivals, festivals/[id]/timetable, rooms, users).
- `src/lib/stagehopper/`:
  - `api.ts`: fetch wrapper; gets a fresh Clerk token per call
  - `auth.svelte.ts`, `auth-gate.svelte.ts`: Clerk loader and auth state
  - `room-state.svelte.ts`, `room-sync.svelte.ts`: Room / Lineup state and Picks sync (rune classes)
  - `festivals.svelte.ts`: Festivals manifest loading, compiled `DEFAULT_FESTIVALS` fallback
  - `timetable.ts`, `timetable-import.ts`, `day-grid.ts`, `schedule-list.ts`, `time.ts` (Day boundary 09:00)
  - `picks.ts`, `selections.ts`, `rooms.ts`, `push.ts`, `install.ts`, `storage.ts`, `types.ts`
  - `components/`: Svelte components, specs colocated
- `src/app.css`: global primitives. `src/hooks.client.ts`, `src/lib/analytics.ts`: PostHog.
- `static/sw.js`: service worker, cache-first for `/data/*` with background revalidation.
- Shared code is imported via the `$shared` alias.

## Backend (`lambda/`)

- `index.ts`: `handler` switches on `event.routeKey` (`"METHOD /api/stagehopper/..."`). `/admin/` routes (except `GET /admin/me`) pass `requireAdmin`. A bare `{republish:"festivals-manifest"}` event rebuilds the manifest (used by deploy).
- Identity: JWT is verified at API Gateway; the Lambda reads `requestContext.authorizer.jwt.claims` (`readIdentity`), participant key `clerk:<sub>`.
- Publish: `publishJsonToS3` (PutObject + CloudFront invalidation), `unpublishFromS3`.
- Env: `TABLE_NAME` (selections), `USERS_TABLE`, `PUSH_SUBSCRIPTIONS_TABLE`, `FESTIVALS_TABLE`, `PERFORMANCES_TABLE`, `ROOMS_TABLE`, `PICKS_TABLE` (Festival Picks, GSI `userId-index`), `SITE_ORIGIN`, `SITE_BUCKET`, `CF_DISTRIBUTION_ID`, `NOTIFIER_FUNCTION_NAME`. Notifier adds `NOTIF_DEDUP_TABLE`, `VAPID_*`.
- `attendee.ts`: Attendee identity (`resolveAttendee`, `setAttendeeColour`): Handle from the `username` claim, Colour on the user row, fan-out to Picks rows. Must not import `index.ts`.
- `notifier.ts`: sends Reminders; `schedule.ts`: pure due-time logic; `secrets.ts`: SSM SecureString reads.
- `build.js`: esbuild bundles to `lambda/dist/{index,notifier}.mjs` (root `npm run build:lambda`). `lambda/package.json` has only `check` (tsc).

## Shared (`shared/`)

Bundled into both Lambdas and the SPA, no runtime deps.
- `festival-fields.ts`: single declaration of `FestivalRecord` / `FESTIVAL_FIELDS` → validator, read guard, manifest projection.
- `colours.ts`: the Colour palette (`PARTICIPANT_COLORS`, `isPaletteColour`), shared by the SPA and the Lambda.
- `room-ids.ts`: Room id rules (festival-prefixed and custom id).
- `dynamo-paginate.ts`, `timetable-file.ts`.

## Build, test, run

- `npm run dev` · `npm run build` · `npm run build:lambda`
- `npm run check` (svelte-check, SPA only) · `npm run check --prefix lambda` (tsc)
- `npm test`: vitest + jsdom, runs `src/**`, `lambda/**`, `shared/**` specs.
- Tests: colocated `*.spec.ts`; route specs `src/routes/*-page.spec.ts`; helpers and fixtures in `src/test-support/`; `vitest-setup.ts` provides in-memory `localStorage`. Lambda specs `vi.mock` the AWS SDK clients.

## CI and deploy

- `.github/workflows/deploy.yml` runs on `v*` tags only (and manual dispatch); no CI on PRs.
- Steps: check, test, build, S3 sync (immutable assets, then the rest excluding `data/*`), `sw.js` copied no-cache, CloudFront invalidation, Lambda code updates + `wait function-updated-v2`, API route smoke test, manifest republish.
- `docs/*-infra.md`: handoff notes for infrastructure-repo changes that ship with an app change.

## Reference docs

- `docs/*-infra.md`: read when changing the same infra area. They are applied, historical change-lists; the code and the infrastructure repo are the truth, and each doc's header lists its known-stale parts.
- `docs/adr/`: read when touching public reads of Picks (0001, 0004), push / VAPID (0002), the open Festival space (0003), or Handle / Colour copies on Picks rows (0005).
