# Design system

What the UI must look and behave like. Frontend builds against it; validator reviews code (Standards axis) and screenshots against it. Facts and rules only; no aspirations.

## Tokens

No CSS variables: values are hardcoded. New colours come from this palette, never ad hoc.

- Colors (dark theme only):
  - Page background `#1a1a1a`; surfaces `#1e1e1e`, `#232323`, `#2a2a2a`; inputs `#333`
  - Text `#fffaf0`; muted `#aaa`, `#999`; secondary button text `#ccc`
  - Borders `#444`, `#555`
  - Primary red `#e74c3c` (hover `#c0392b`): main CTAs, input focus, errors
  - Blue `#3a6df0`: notification and install flows only
  - Gold `#ffd700`: marked Picks only. Full opacity = going, 0.55 = maybe
  - Warning `#e0a530`: the save succeeded but a side effect (e.g. Publish) failed
  - `theme-color` meta `#111111`
- Typography: system stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`), no webfont.
- Radii: buttons 8px, small buttons and inputs 6px.

## Components

- Global primitives in `src/app.css`, used before writing new CSS:
  - `.sh-btn` + `.sh-btn-primary` / `.sh-btn-secondary` / `.sh-btn-block`: page-level actions
  - `.sh-btn-sm`: compact bordered buttons in the Room top bar (day/view tabs, ⋮ menu)
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
