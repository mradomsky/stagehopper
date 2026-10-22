# Design system

What the UI must look and behave like. Frontend builds against it; validator reviews code (Standards axis) and screenshots against it. Facts and rules only; no aspirations.

## Tokens

Colours are CSS custom properties declared on `:root` in `src/app.css`. Components use `var(--sh-*)`, never a colour literal (`theme-literals.spec.ts` fails on one). Admin routes (`src/routes/admin/**`) are out of scope and stay hardcoded. See ADR 0003 and the glossary term Theme.

- **Public tokens** (a host re-themes by overriding these four; defaults are the dark look):
  - `--sh-bg` `#1a1a1a` page background; `--sh-surface` `#2a2a2a` cards and panels; `--sh-text` `#fffaf0`; `--sh-accent` `#e74c3c` main CTAs, input focus, selected-stage ring, active tab borders
- **Derived tokens** (private, `color-mix()` of the four; name by role, never by value). Mix ratios are tuned so the defaults land within a few RGB levels of the old hardcoded palette:
  - Surfaces: `--sh-bg-deep` (bars), `--sh-stage-header-base`, `--sh-surface-low`, `--sh-surface-overlay` (dialogs, popovers), `--sh-surface-raised` (inputs), `--sh-block-bg`, `--sh-chip-*`; translucent `--sh-panel` / `--sh-panel-soft` derive from `--sh-bg`. `--sh-bg-deep` and `--sh-stage-header-base` mix toward `--sh-fixed-black`, so they read mid-grey on a light Theme (#199).
  - Borders: `--sh-border-faint`, `--sh-border-subtle`, `--sh-border`, `--sh-border-strong`, `--sh-block-border`
  - Text: `--sh-text-strong`, `-soft`, `-muted`, `-faint`, `-dim`
  - Accent: `--sh-accent-hover` (mixes toward `--sh-fixed-black`), `--sh-accent-glow`
  - Washes: `--sh-hover-wash` derives from `--sh-text`
  - Translucent text or white-alpha overlays: `color-mix(in srgb, var(--sh-text) N%, transparent)`; dark translucent surfaces derive from `--sh-bg`. Add a new shade as a derived token, never a literal.
- **Fixed** (do not follow the Theme; one marked block in `app.css`):
  - `--sh-pick-gold` `#ffd700` (+ `-hover`): marked Picks only; full opacity = going, 0.55 = maybe
  - `--sh-notify-blue` / `--sh-notify-blue-text`: notification and install flows only
  - `--sh-warning` `#e0a530`: the save succeeded but a side effect (e.g. Publish) failed
  - `--sh-error` `#e74c3c`: error text (not the accent)
  - `--sh-on-accent` `#fff`; `--sh-fixed-white` / `--sh-fixed-black` on media and scrims; `--sh-fixed-black` is also the darkening input of `--sh-bg-deep`, `--sh-stage-header-base` and `--sh-accent-hover`
  - `--sh-now-stops-soft` / `-strong`: the rainbow now-line and Playing-now pill; `--sh-soon`, `--sh-badge-upcoming`, `--sh-badge-happening`, `--sh-hover-gold`
  - Backdrops and shadows: `rgba(0, 0, 0, …)` literals are allowed. Attendee Colours (`PARTICIPANT_COLORS` in `shared/colours.ts`) and the `theme-color` meta `#111111` are fixed.
- Typography: system stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`), no webfont.
- Radii: buttons 8px, small buttons and inputs 6px.

## Components

- Global primitives in `src/app.css`, used before writing new CSS:
  - `.sh-btn` + `.sh-btn-primary` / `.sh-btn-secondary` / `.sh-btn-block`: page-level actions
  - `.sh-btn-sm`: compact bordered buttons in the Festival page top bar (day/view tabs, ⋮ menu)
  - `.sh-input`: text inputs
  - `.sh-error`: the action failed · `.sh-warning`: saved, side effect failed
- `src/lib/stagehopper/components/`:
  - `Modal`: every dialog
  - `ConfirmDialog`: every destructive action
  - `StatusBar`: transient status messages

## Layout and style rules

- Component styles live in the component's own `<style>` block; only shared primitives go in `app.css`.
- Mobile breakpoint `max-width: 767px`: touch targets ≥ 44px, inputs at 16px font (prevents iOS zoom).
- Hover styles only inside `@media (hover: hover) and (pointer: fine)`.

## Interaction

- Destructive actions confirm via `ConfirmDialog`.
- Data views handle loading, empty, and error states.

## Accessibility baseline

- Every control keyboard reachable with a visible focus state.
- Inputs have labels; icon-only buttons have an accessible name.
