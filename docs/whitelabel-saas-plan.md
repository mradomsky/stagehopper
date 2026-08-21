# White-label StageHopper — what it takes to sell the timetable

An analysis of the work required to turn StageHopper into a product a festival organizer
pays for: an embeddable, branded timetable they drop into their own website or app.

**Constraints this plan works under**

- The consumer app (`/`, `/room/*`) keeps behaving exactly as it does today. Nothing in
  here changes what a visitor to stagehopper.radomskyi.com sees.
- The landing page stays as-is. The white-label offer is not advertised there yet.
- Early-stage: the goal is the shortest credible path to a first paying festival, not a
  complete multi-tenant platform.

---

## 1. Where the codebase already helps

Three things about the current architecture make this much cheaper than it could have been:

| Asset | Why it matters |
|---|---|
| **Guest browse mode** (`RoomState.isGuestMode`, `/room/tmr26`) | A sign-in-free, read-only lineup view already exists and is already shipped. That *is* the v1 embed experience — it needs a chrome-less route and a theme, not new behaviour. |
| **Props-only components** | `TimetableGrid`, `StageColumn`, `PerformanceBlock`, `ArtistDetailsCard` take plain props and import no global state. They can be driven by a different state class without touching them. |
| **Timetables are static CDN files** | `data/timetable-{festivalId}.json` is a public S3 object behind CloudFront. Serving an embed to a festival's traffic spike costs almost nothing and needs no new read path. |

The rendering layer is embeddable today. What is missing is everything *around* it:
packaging, tenancy, configuration, and billing.

## 2. What blocks embedding today

Concrete, file-level coupling that has to be undone. None of these are hard individually;
they are listed because each one silently breaks an embed on a customer domain.

| # | Blocker | Location |
|---|---|---|
| 1 | `API_BASE = '/api/stagehopper'` — same-origin relative. On `festival.com` this resolves to the customer's server. | `src/lib/stagehopper/api.ts:21` |
| 2 | `FESTIVAL_DATA_PATH = '/data/festivals.json'` and `timetableDataPath()` — same problem, root-relative. | `festivals.svelte.ts:16`, `timetable.ts:27` |
| 3 | `FESTIVAL_ROOM_ID_PATTERN = /^(ps26\|tmr26)-[0-9a-f]{6}$/` — festival ids hardcoded in a regex, so `parseRoomIdInput` doesn't recognise any festival added through the admin UI. Not currently broken: such ids fall through to the custom-slug branch, which happens to return them unchanged (verified). It works by accident, and stops working the moment slugifying and the room-id shape diverge. | `src/lib/stagehopper/rooms.ts:8` |
| 4 | localStorage keys are a flat `stagehopper:*` namespace with no tenant scope, and in a cross-origin iframe they land in partitioned storage (Safari/Firefox default) — picks silently vanish between visits. | `src/lib/stagehopper/storage.ts:14-15` |
| 5 | `Access-Control-Allow-Origin: SITE_ORIGIN` — exactly one origin, from an env var. | `lambda/index.ts:139-147` |
| 6 | Google Identity Services with one client ID whose authorized origins are ours. GSI/FedCM in a third-party iframe is unreliable at best; every customer domain would need registering. | `google-identity.ts`, `auth.ts` |
| 7 | Service worker + Web Push are registered at our site scope. An embed on a customer domain cannot register them at all. | `static/sw.js`, `push.ts` |
| 8 | Theme is hardcoded hex throughout — `#1a1a1a` / `#fffaf0` / `#e74c3c` in `app.css`, per-component colours elsewhere. Brand string `🎵 StageHopper` in `RoomNav.svelte:40`. | `src/app.css`, components |
| 9 | No tenant concept anywhere: one global `festivals.json`, one global `ADMIN_EMAILS` allowlist, no `orgId` on any record, admin list endpoints full-table `Scan`. | `lambda/index.ts` |

**The fork in the road is #6 and #7.** Making rooms, picks-sharing and push notifications
work *inside* a customer's page means solving cross-origin auth, per-tenant Google
credentials or a first-party token exchange, and per-origin service workers. That is a
quarter of work on its own, and it is not what an organizer is buying.

**Recommendation: v1 embed is anonymous.** Browse the lineup, mark picks, picks persist
locally. Anything account-shaped (rooms, friends, notifications) is a button that opens
the hosted app on our origin — which doubles as the acquisition funnel back into the
consumer product. This keeps the entire auth stack out of the embed's scope.

## 3. Delivery mechanism

Three ways to put a timetable in someone else's product:

**A. Script tag + iframe.** One `embed.js` from our CDN, a `<div data-stagehopper-festival="…">`,
an iframe pointing at `embed.stagehopper.app`, `postMessage` for auto-height and events.
Total style isolation, works on WordPress/Squarespace/Wix (which is what most festival
sites actually are), one-line install, we ship updates without the customer redeploying.
Costs: no SEO value for the customer, and the storage-partitioning problem in #4.

**B. Web component / npm package.** Svelte compiles to custom elements; a real package for
teams with a frontend. Same-origin, so storage and eventually auth just work. Costs: CSS
bleeds both directions, version drift across customers, much higher support burden.

**C. Hosted branded page.** `timetable.festival.com` (their CNAME) or
`festival.stagehopper.app`. Everything works — auth, push, PWA, SEO, sharing — and
integration effort is zero. It is just not literally inside their page.

**Recommendation: A first, C nearly free alongside it** (C is the same embed route rendered
full-page on a different hostname), **B deferred** until a customer with a real app asks and
pays for it.

## 4. Work breakdown

### Phase 0 — Foundations (no user-visible change)

Small, safe, and unblocks everything after it.

- Replace the hardcoded festival-id regex in `rooms.ts` with a shape check (blocker #3), so
  room-id parsing stops depending on the slug branch coincidentally preserving valid ids.
- Introduce a runtime config module: API base URL, data base URL, storage key prefix.
  Defaults reproduce today's behaviour exactly, so the consumer app is untouched.
- Tokenize the theme into CSS custom properties (`--sh-bg`, `--sh-fg`, `--sh-accent`,
  `--sh-radius`, `--sh-font`) with the current values as defaults.
- Add an `ANY /api/stagehopper/{proxy+}` catch-all route in the Terraform repo. Today every
  endpoint is declared route-by-route in a separate repo and enforced by a deploy smoke test
  (`deploy.yml`); the phases below add 10–15 endpoints, and each one currently costs a
  cross-repo infra PR. Keep the smoke test — it still validates reachability.

### Phase 1 — Sellable embed (no tenancy, no billing)

This is the smallest thing that can be sold. Onboarding is manual: you create the festival
in the existing admin console and hand the customer a snippet.

- **`/embed/[festivalId]` route** — chrome-less: no site header, no footer, no install promo,
  no sign-in. Renders `TimetableGrid` plus the artist details card and map overlay.
- **`embed-state.svelte.ts`** — a small state class alongside `RoomState`, not a
  modification of it. It needs the timetable fetch, day navigation, local picks, stage
  favourites and the details card; it needs none of the polling, PUT debouncing, participant
  merging or auth. `RoomState` (1000 lines) and its 1274-line test file stay untouched, so
  the consumer app cannot regress.
- **`embed.js` loader** — vanilla, tiny, versioned URL, cache-forever. Injects the iframe,
  handles auto-resize via `postMessage`, exposes `window.StageHopper.mount()` for SPA hosts.
- **Configuration via query params**: theme colours, font, `?days=`, `?stages=`,
  `?compact=1`, initial day.
- **Bundle discipline**: assert in CI that the embed route does not pull in
  `google-identity`, `push`, or admin code. An embed that ships the sign-in SDK is both
  slow and a privacy question at review time.
- **Separate origin** — serve from `embed.stagehopper.app` (own distribution) so the app's
  storage and future cookies are out of scope and caching policy can differ.

**Ship this and sell 2–3 pilots at a real price before building Phase 2.** The pilots decide
what Phase 2 actually contains; guessing costs more than asking.

### Phase 2 — Tenancy and self-serve

Only worth doing once someone has paid for Phase 1.

- **`orgs` table** (PK `orgId`): name, plan, status, allowed origins, theme, publishable key,
  Stripe customer id. **`org_members`** (PK `orgId`, SK `userId`) with owner/editor roles.
  `ADMIN_EMAILS` survives as *platform* superadmin only.
- **`orgId` on every festival record.** Per-org published data at
  `data/festivals-{orgId}.json`; timetables keep their current global path (festival ids are
  already globally unique). The existing global `data/festivals.json` keeps being written,
  containing only festivals flagged `listPublicly` — so the consumer landing page renders
  exactly as it does now.
- **Draft vs published timetables.** Right now `importFestivalTimetable` writes straight to
  the public CloudFront path. An unannounced lineup leaking early is a genuine commercial
  problem for an organizer. Drafts go to a private S3 prefix read through the API; publishing
  copies to the public path.
- **Replace `PUT /admin/festivals`.** It rewrites the entire festival list in one call —
  with multiple tenants that is a cross-tenant clobber waiting to happen. It has to become
  per-festival CRUD scoped by `orgId`.
- **Re-importable timetables with stable ids.** Import is write-once today (409 if a
  timetable exists), and `assignPerformanceIds` mints random ids. Organizers revise lineups
  constantly. A naive re-import reassigns every id — and **every selection in every room is
  keyed on performance id**, so a re-upload silently wipes everyone's picks. Re-import must
  diff against the existing file and preserve ids where artist+stage+time still match, with
  a preview of adds/moves/removals before it writes. This is the highest-consequence item in
  the whole plan.
- **CSV/spreadsheet import.** No organizer will hand-author `{formatVersion: 1, …}` JSON.
  A column-mapping upload UI is the single biggest adoption blocker after the embed itself.
- **Publishable keys + origin allowlist.** `GET /api/embed/{publishableKey}/config` returns
  the festival list, theme and entitlements; it checks `Origin`/`Referer` against the org's
  allowed domains and sets `Content-Security-Policy: frame-ancestors` accordingly, so the
  embed can't be hotlinked by non-customers. CORS becomes a per-request allowlist lookup
  instead of the single `SITE_ORIGIN` (blocker #5). Rate-limit it.
- **Organizer console** at `/organizer` — distinct from the platform `/admin`. Festival CRUD,
  timetable upload, theme picker, live embed preview, snippet to copy.
- **Fix the admin scans.** `listAdminRooms`/`listAdminUsers` full-table `Scan` and merge by
  id. Fine at zero scale; with tenants it is both a cost problem and a cross-tenant data
  exposure. Needs org-partitioned keys or GSIs before any of it is exposed to a customer.

### Phase 3 — Monetization and retention

- **Stripe**: Checkout for subscribe, Billing Portal for self-service, a webhook route
  syncing `plan`/`status` onto the org row. Entitlements enforced in the config endpoint.
- **Free tier with a "Powered by StageHopper" badge**, removable on paid. The badge is the
  acquisition channel for the consumer app — treat it as a growth feature, not a downgrade.
- **Embed analytics.** Views, unique visitors, most-picked artists, stage-conflict hotspots.
  This is the thing organizers will actually renew for — they have no other read on lineup
  engagement before gates open. Keep it cookieless (hashed daily visitor id) so it needs no
  consent banner; that is both a selling point and a GDPR simplification for EU customers.
  It also doubles as the metering basis if pricing goes usage-based.
- **Hosted branded subdomain** (delivery option C) — `*.stagehopper.app` is cheap
  (one wildcard cert); per-customer CNAMEs with their own ACM cert can wait.

### Phase 4 — Later

Native app embedding (web component / webview SDK), i18n (every string is inline English and
`formatDateLabel` hardcodes `en-US` — a hard blocker for most of the European market), and
embedded rooms with cross-origin auth if customers actually ask for the social layer inside
their own page.

## 5. Pricing shape

Worth deciding early because it changes what Phase 3 builds.

Festivals are **seasonal and annual**. A flat monthly SaaS subscription fits badly: an
organizer with one July event will not pay twelve months for one weekend of use, and churn
every August will look like a dying business. Two shapes fit better:

- **Per-event licence**, tiered by expected attendance, sold per edition. Matches how
  organizers already budget (they buy per-event services constantly).
- **Annual platform plan** for promoters running multiple events a year — the better
  customer, and the one that produces predictable revenue.

Free tier with the attribution badge in both cases. Expect lumpy, strongly seasonal revenue
either way; that is a fact about the market, not a pricing mistake to engineer around.

## 6. Non-code prerequisites for selling to businesses

These are cheap to ignore and expensive to discover during a customer's procurement review:

- **No staging environment exists.** Deploys go from a release tag straight to the live
  bucket. That is acceptable for a side project and not acceptable once a customer's public
  website embeds you. A staging stack is a prerequisite for the first paid pilot.
- **Deploy freeze during festival weekends.** Peak traffic and peak stakes coincide; a bad
  deploy mid-festival is a refund conversation.
- **DPA / GDPR posture.** The organizer is the data controller for their lineup and audience
  data, you are the processor. A signed DPA is a routine blocker in EU procurement. An
  anonymous, cookieless embed (per Phase 1 and Phase 3) makes this dramatically easier.
- **Support expectations.** Organizers will email at 2am during their event. Decide what
  response commitment the price includes before quoting one.

## 7. Recommended sequencing

1. **Phase 0** — a few days, no product risk, fixes a live bug on the way through.
2. **Phase 1** — the embed. Sell manual-onboarding pilots off it.
3. **Let the pilots specify Phase 2.** Tenancy, self-serve and billing are all justified by
   a customer who has paid; without one they are speculative platform work.

The single most important scoping decision is in §2: **keep the embed anonymous.** It keeps
Phase 1 to a route, a state class and a loader script, instead of a cross-origin identity
project.
