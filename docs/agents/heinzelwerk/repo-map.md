# Repo map

Facts for locating code. Traps live in `CLAUDE.md`; vocabulary in `GLOSSARY.md`.

## Shape

- SvelteKit SPA (`adapter-static`, fallback `index.html`) on S3 + CloudFront.
- API Gateway HTTP API → one API Lambda (`lambda/index.ts`). DynamoDB is the write side.
- Signed-out reads are derived JSON files in the site bucket (`data/festivals/index.json`, `data/festivals/{id}/timetable.json`), not API calls.
- Push notifier Lambda (`lambda/notifier.ts`), invoked by EventBridge every minute.
- Infra (API routes, tables, IAM, CloudFront) is Terraform in the separate `infrastructure` repo, `projects/stagehopper/`.

## Frontend (`src/`)

- Routes: `/` (prerendered; Festival cards with each one's Attendee count and latest Message), `/festival/[id]` (the Festival space: Timetable, everyone's Picks, My Picks, ⋮ menu with description and dates), `/admin/*` (festivals, festivals/[id]/timetable, users). No `/room/*` route: Rooms were removed in #211 with no redirect.
- `src/lib/stagehopper/`:
  - `api.ts`: fetch wrapper; gets a fresh Clerk token per call (Visitor reads like `fetchFestivalSummary` go unsigned)
  - `auth.svelte.ts`, `auth-gate.svelte.ts`: Clerk loader and auth state
  - `festival-space.svelte.ts`: `FestivalSpace`, the Festival page's state (Timetable view, Festival Picks sync, Pending Pick, Colour gate)
  - `festival-chat.svelte.ts`: `FestivalChat`, the Festival chat state (Messages merged by id, 5 s `after=` poll paused while hidden, unread, send / delete, Banned on a POST 403); rendered by `components/FestivalChatPanel.svelte` (desktop column, phone bottom sheet)
  - `festivals.svelte.ts`: Festivals manifest loading, compiled `DEFAULT_FESTIVALS` fallback
  - `timetable.ts`, `timetable-import.ts`, `day-grid.ts`, `schedule-list.ts`, `time.ts` (Day boundary 09:00)
  - `picks.ts`, `selections.ts` (Pick state and Colour helpers), `push.ts`, `install.ts`, `storage.ts`, `types.ts`
  - `components/`: Svelte components, specs colocated
- `src/app.css`: global primitives. `src/hooks.client.ts`, `src/lib/analytics.ts`: PostHog.
- `static/sw.js`: service worker, cache-first for `/data/*` with background revalidation.
- Shared code is imported via the `$shared` alias.

## Backend (`lambda/`)

- `index.ts`: `handler` switches on `event.routeKey` (`"METHOD /api/stagehopper/..."`). `/admin/` routes (except `GET /admin/me`) pass `requireAdmin`. A bare `{republish:"festivals-manifest"}` event rebuilds the manifest (used by deploy).
- Identity: JWT is verified at API Gateway; the Lambda reads `requestContext.authorizer.jwt.claims` (`readIdentity`), user id `clerk:<sub>`.
- Publish: `publishJsonToS3` (PutObject + CloudFront invalidation), `unpublishFromS3`.
- Env: `USERS_TABLE`, `PUSH_SUBSCRIPTIONS_TABLE`, `FESTIVALS_TABLE`, `PERFORMANCES_TABLE`, `PICKS_TABLE` (Festival Picks, GSI `userId-index`), `MESSAGES_TABLE` (Festival chat, GSI `userId-index`), `SITE_ORIGIN`, `SITE_BUCKET`, `CF_DISTRIBUTION_ID`, `NOTIFIER_FUNCTION_NAME`. Notifier adds `NOTIF_DEDUP_TABLE`, `VAPID_*`, and reads `PICKS_TABLE` (dedup key `<festivalId>#<performanceId>`).
- `attendee.ts`: Attendee identity (`resolveAttendee`, `updateProfile`, `normalizeNickname`): Nickname (attribute `handle`, seeded once from the `username` claim) and Colour on the user row, fan-out to Picks rows. Must not import `index.ts`.
- `chat.ts`: Festival chat (`listMessages`, `postMessage`, `deleteMessage`, `festivalSummary`): time-ordered message ids, `after`/`before` cursors, Ban check, 2 s rate limit on the user row's `lastPostedAt`. Returns `{ok}|{error:{status}}`; `index.ts` maps the status. Must not import `index.ts`.
- `notifier.ts`: sends Reminders; `schedule.ts`: pure due-time logic; `secrets.ts`: SSM SecureString reads.
- `migrate-picks.ts` (+ `migrate-picks-cli.ts`): one-shot, operator-run Room Picks → Festival Picks migration (pure `mergePicks`, runner `migratePicks`). Not bundled, not imported by `index.ts`; runbook in `docs/festival-picks-infra.md`. The only code that still reads the old Room tables (with local copies of the Room id helpers); deleted once those tables are gone (#241).
- `build.js`: esbuild bundles to `lambda/dist/{index,notifier}.mjs` (root `npm run build:lambda`). `lambda/package.json` has only `check` (tsc).

## Shared (`shared/`)

Bundled into both Lambdas and the SPA, no runtime deps.
- `festival-fields.ts`: single declaration of `FestivalRecord` / `FESTIVAL_FIELDS` → validator, read guard, manifest projection.
- `colours.ts`: the Colour palette (`PARTICIPANT_COLORS`, `isPaletteColour`), shared by the SPA and the Lambda.
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
- `docs/adr/`: read when touching public reads of Picks (0004; 0001 is superseded), push / VAPID (0002), the open Festival space (0003), Nickname / Colour copies on Picks rows (0005), or the Nickname and public `userId` (0006).
