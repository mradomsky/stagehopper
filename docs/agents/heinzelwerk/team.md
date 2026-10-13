# Team rules

How heinzelwerk agents work in this repo. Mode rules (single repo vs workspace) live in the `heinzelwerk:team-modes` skill; this file holds only what is specific to this repo.

- **Backend paths**: `lambda/` (API Lambda `index.ts`, push `notifier.ts`)
- **Frontend paths**: `src/`, `static/`
- **E2E**: none. `deploy.yml`'s API smoke test runs against prod only, after a `v*` tag.
- **UI preview**: `npm run dev -- --port $PORT --strictPort` · base URL `http://localhost:$PORT` · screenshots via `npx playwright screenshot` · publish via `scripts/ui-shots`. Room and admin pages need a Clerk sign-in and the live API; without a test session, screenshot only signed-out pages (`/`, `/festival/{id}`, a Lineup at `/room/{festivalId}`).
- **Signed-in screens** (Room with Picks, admin pages): no test session exists yet, so they are **exempt from screenshots**. Cover them with component tests at the route seam instead, and list them in the PR body under `Not screenshotted (signed-in): <screens>`. Validator accepts that list in place of screenshots and never sends a task back for these screens alone. The exemption ends once a Clerk test session for Playwright exists.
- **Infra paths**: none in this repo. Terraform lives in the separate `infrastructure` repo under `projects/stagehopper/`; agents do not edit it from here.
- **Shared paths** (only the task's named owner edits): `shared/` (bundled into both Lambdas and the SPA)
- **Worktree setup** (run once in every new task worktree): `npm ci --prefer-offline --no-audit --no-fund` and `npm ci --prefix lambda --prefer-offline --no-audit --no-fund`
- **Checks** (validator runs every one, in order; failures only):
  1. `npm run check -- --threshold error`
  2. `npm run check --prefix lambda`
  3. `npm test -- --reporter=dot` (covers `src/`, `lambda/`, `shared/` specs)
  4. `npm audit --audit-level=high`
- **Security**: secret scan via gitleaks as a pre-commit hook (each developer installs it: `gitleaks git --pre-commit --staged` in `.git/hooks/pre-commit`; hooks live in the shared `.git`, so every worktree gets it) · dependency audit is check 4.
- **Coding standards**: none written: smell baseline, the traps in `CLAUDE.md`, and `docs/agents/heinzelwerk/design.md` for UI.
- **Risk areas** (validator reviews diffs touching these on Opus):
  - Auth and admin gating: `requireAdmin`, `hasAdminScope`, `readIdentity` in `lambda/index.ts`; `src/lib/stagehopper/auth*.svelte.ts`. Authorization decisions; the admin rule is deliberately duplicated in Terraform (#159).
  - Public publish: `shared/festival-fields.ts`, `publishJsonToS3` and the manifest / timetable publishers. Every Festival record field becomes public.
  - DynamoDB writes and transactions (e.g. the Picks save that also writes `ROOMS_TABLE`), and any change needing a new table or env var: prod data, no migration tooling, infra must ship first.
  - Data deletion: `unpublishFromS3`, any Room / user / Performance delete path.
  - Deploy and caching: `.github/workflows/deploy.yml`, `static/sw.js`, cache headers. A bad worker or header gets pinned on devices.
  - Push and secrets: `lambda/notifier.ts`, `lambda/secrets.ts` (VAPID key via SSM, never env vars).
  - External integrations: Clerk, PostHog, web-push.
- **Contracts** (validator checks every diff touching these):
  - API: the route switch in `lambda/index.ts` ↔ callers in `src/lib/stagehopper/api.ts` · provider backend. A new or changed route also needs the `aws_apigatewayv2_route` in the infrastructure repo and an entry in `deploy.yml`'s smoke-test list, in the same PR.
  - Shared types: `shared/**` · provider = the task's named owner.
  - Infra: the `infrastructure` repo, `projects/stagehopper/` · provider infra (human). A change needing infra ships a `docs/*-infra.md` handoff note in the same PR.
  - Theme: the four public tokens (`--sh-bg`, `--sh-surface`, `--sh-text`, `--sh-accent`) on `:root` in `src/app.css` (ADR 0003) · provider frontend. Hosts override them (embed #109, #112, #116): never rename or remove one; a new public token needs an ADR update.
- Worktree per task, no direct commits to main, PR only, agents never merge except through `scripts/merge-gate`.
