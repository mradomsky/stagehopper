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
| 4 | localStorage keys are a flat `stagehopper:*` namespace with no tenant scope, and in a cross-origin iframe they land in partitioned storage — on Safari also evicted after roughly a week, so picks silently vanish between visits. Resolved by the storage proxy (§5, #111). | `src/lib/stagehopper/storage.ts:14-15` |
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
Costs: no SEO value for the customer. The storage-partitioning problem in blocker #4 turns
out to be solvable within this option — see the storage proxy in §5 — rather than a reason
to prefer B.

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

Every item below is a GitHub issue, split across two milestones. **Demo-ready** is the
sendable artifact; **First Customer** is everything deferred until someone is actually
paying, recorded now so the traps are not rediscovered under time pressure.

### Demo-ready

| # | Item |
|---|---|
| [#102](https://github.com/mradomsky/stagehopper/issues/102) | Replace the hardcoded festival-id regex in `rooms.ts` |
| [#103](https://github.com/mradomsky/stagehopper/issues/103) | `isListedOnLanding` on festival records; filter the landing page |
| [#104](https://github.com/mradomsky/stagehopper/issues/104) | Make timetable import replaceable (blunt overwrite) |
| [#105](https://github.com/mradomsky/stagehopper/issues/105) | Extract runtime config: API base, data base, storage prefix |
| [#106](https://github.com/mradomsky/stagehopper/issues/106) | Refactor the theme to CSS custom properties |
| [#107](https://github.com/mradomsky/stagehopper/issues/107) | Spike: iframe storage behaviour on iOS Safari |
| [#108](https://github.com/mradomsky/stagehopper/issues/108) | Lineup extraction runbook — prospect demo in under 30 minutes |
| [#109](https://github.com/mradomsky/stagehopper/issues/109) | `/embed/[festivalId]` route and `embed-state` |
| [#110](https://github.com/mradomsky/stagehopper/issues/110) | `embed.js`: iframe injection, auto-resize, versioned protocol |
| [#111](https://github.com/mradomsky/stagehopper/issues/111) | Storage proxy: picks in the host page's first-party storage |
| [#112](https://github.com/mradomsky/stagehopper/issues/112) | Theme the embed via query parameters |
| [#113](https://github.com/mradomsky/stagehopper/issues/113) | URL-encoded picks: shareable links and hand-off to the app |
| [#114](https://github.com/mradomsky/stagehopper/issues/114) | Deploy guardrails: render smoke test and bundle hygiene |
| [#115](https://github.com/mradomsky/stagehopper/issues/115) | Public demo: fictional festival plus a host page |

### First Customer

| # | Item |
|---|---|
| [#116](https://github.com/mradomsky/stagehopper/issues/116) | Persist embed theme on the festival record |
| [#117](https://github.com/mradomsky/stagehopper/issues/117) | Id-preserving timetable re-import |
| [#118](https://github.com/mradomsky/stagehopper/issues/118) | Cookieless embed analytics |
| [#119](https://github.com/mradomsky/stagehopper/issues/119) | Go-live readiness: staging, deploy freeze, DPA |
| [#120](https://github.com/mradomsky/stagehopper/issues/120) | Draft vs published timetables |
| [#121](https://github.com/mradomsky/stagehopper/issues/121) | Embed access control: keys, origin allowlist, dynamic CORS |
| [#122](https://github.com/mradomsky/stagehopper/issues/122) | Tenancy: organizations, org-scoped festivals, per-festival CRUD |
| [#123](https://github.com/mradomsky/stagehopper/issues/123) | API Gateway catch-all route |

## 5. Decisions taken, and what they replaced

The first draft of this plan assumed a pilot customer was reachable. There is none, and no
existing relationship with any organizer. That changes several conclusions, recorded here
because the superseded versions were wrong in ways worth remembering.

**The demo is the deliverable, not a sellable pilot.** With cold outbound only, the artifact
that matters is a link you can send. "Ship Phase 1, sell 2–3 pilots, let them specify Phase 2"
assumed warm intros. The sequencing survives; its justification does not.

**Demos are tiered.** The public demo runs a fictional festival — using a real festival's
brand and press images to sell to *other* festivals is not nominative use. Prospect demos use
that prospect's own published lineup, which is both defensible and far higher-converting.

**Lineup ingestion is a sales tool, not a product feature.** Originally filed as "CSV import
is the biggest adoption blocker". Wrong for now: prospects upload nothing, we do. LLM-assisted
extraction into the existing validated format costs almost no code and works across HTML, PDF
and pasted schedules. A CSV mapping UI is deferred indefinitely — it serves self-serve
onboarding, which does not exist yet.

**Timetable overwrite before id preservation.** Blunt overwrite unblocks demo iteration now;
the id-preserving diff (#117) is real work that only matters once someone has picks worth
losing. Both are needed, in that order, and #104 must not reach a live festival before #117.

**The embed has picks.** A read-only schedule is a prettier version of what their site already
has. Tap-to-mark is the entire pitch.

**Storage goes through the host page.** Picks written inside a cross-origin iframe are
third-party storage — partitioned everywhere, and evicted on Safari after roughly a week.
Instead the iframe `postMessage`s to `embed.js`, which writes to the customer's *own*
first-party storage. Third-party rules stop applying. The customer pays nothing extra for it:
that script is already required for iframe injection and auto-resize. This was missing from
the first draft entirely; it is better than the URL-encoding fallback originally proposed,
which survives for a different job — hand-off to the hosted app and shareable plans (#113).

**Staging is deferred, not a prerequisite.** Originally called a hard requirement before the
first paid pilot. It is a second bucket, distribution, Lambda pair, table set and Terraform
rework — heavy for a solo developer pre-revenue, against an existing 882-test suite. The
targeted substitute is a post-deploy check that renders the embed headless and asserts the
grid drew (#114), which catches the failure that would actually cost a deal. Staging's real
trigger is the day a bad deploy can break *someone else's* homepage.

**Cookielessness is a design constraint, not a nicety.** It is what keeps the embed out of a
customer's consent-banner scope, which is the difference between a one-line paste and a legal
review. It binds the analytics work (#118) as an acceptance criterion.

## 6. Pricing shape

Worth deciding before #118 and #121, because it changes what they enforce.

Festivals are **seasonal and annual**. A flat monthly subscription fits badly: an organizer
with one July event will not pay twelve months for one weekend, and churn every August will
look like a dying business. Two shapes fit better:

- **Per-event licence**, tiered by expected attendance, sold per edition — matching how
  organizers already budget.
- **Annual platform plan** for promoters running several events a year: the better customer,
  and the one producing predictable revenue.

Free tier with a "Powered by StageHopper" badge in both cases — it is the acquisition channel
back into the consumer app, so treat it as a growth feature rather than a downgrade. Expect
lumpy, strongly seasonal revenue either way; that is a fact about the market, not a pricing
mistake to engineer around.

## 7. Sequencing

1. **#102–#107** — foundations and the spike. Small, no product risk, and #102 fixes
   accidental behaviour on the way through.
2. **#108–#115** — the embed and the demo. Outreach copy can be tested against #115 while the
   rest is still being built.
3. **First Customer items stay closed until there is one.** #122 in particular is the largest
   piece of work in the plan and entirely speculative until someone pays.

The scoping decision that keeps step 2 small is in §3: **the embed is anonymous.**
Account-shaped features link out to the hosted app rather than working in-frame, which keeps
cross-origin identity and per-origin service workers out of scope entirely.
