# Shell Component Standards

Standards for the AI Orchestrator desktop shell — the rails, panels, cards,
headers, badges, empty states, and toolbars that frame every feature. The goal
is one coherent system: dashboard, settings, setup, and feature pages should
feel designed together, not assembled from separate kits.

This document is the reference for **copilot_todo.md item 16**. Read it before
adding or restyling shell-level UI.

---

## 1. Design tokens

Styling flows through a two-layer token system in `src/renderer/styles/_theme.scss`.
**Never hard-code `rgba(...)` or hex values in component styles** — reach for a token.

### Base layer
The raw palette: `--bg-primary…--bg-active`, `--text-primary…--text-disabled`,
`--border-*`, `--primary-*`, `--secondary-*`, status colors, `--glass-*`,
spacing (`--spacing-*`), radius (`--radius-*`), shadows (`--shadow-*`),
transitions (`--transition-*`), z-index (`--z-*`).

### Semantic shell layer
Component-level semantics layered over the base palette. These reference base
tokens, so they adapt to light/dark automatically — defined once:

| Group | Tokens | Use for |
|-------|--------|---------|
| Shell surfaces | `--shell-rail-bg`, `--shell-sidebar-bg`, `--shell-header-bg`, `--shell-workspace-bg` | Rail, sidebar, top bar, workspace backgrounds |
| Settings workspace | `--settings-sidebar-bg`, `--settings-nav-*`, `--settings-group-fg` | The settings shell |
| Cards & surfaces | `--card-bg`, `--card-border`, `--card-radius`, `--card-shadow`, `--surface-sunken-bg`, `--section-icon-bg/-fg` | Card containers, sunken/inset areas |
| Status pills | `--pill-ok-*`, `--pill-warn-*`, `--pill-error-*`, `--pill-info-*`, `--pill-neutral-*`, `--pill-accent-*` | Status pills & badges |
| Segmented control | `--segment-track-*`, `--segment-thumb-*`, `--segment-fg*` | Segmented controls |
| Inline help | `--inline-help-bg/-border/-fg/-icon` | Callout boxes |
| Empty / loading | `--empty-state-*`, `--skeleton-base`, `--skeleton-sheen` | Empty states, skeletons |
| Terminal / charts | `--terminal-surface-*`, `--chart-*` | Terminal & chart surfaces |

Adding a new semantic token? Define it as a reference to a base token in `:root`
so it adapts across themes without per-theme duplication.

---

## 2. Settings UI kit

Reusable components in `src/renderer/app/features/settings/ui/`. Prefer these
over re-implementing card/control styling inline.

| Component | Selector | Purpose |
|-----------|----------|---------|
| `SettingsCardComponent` | `app-settings-card` | Section container: icon + title + description, body slot, `[card-actions]` and `[card-footer]` slots |
| `SegmentedControlComponent` | `app-segmented-control` | Single-select among 2–4 short options |
| `SaveStateBannerComponent` | `app-save-state-banner` | Explicit Saved / Saving / Unsaved / Error state with Apply + Reset |
| `InlineHelpComponent` | `app-inline-help` | `info` / `tip` / `warning` contextual callout |
| `SettingsNavIconComponent` | `app-settings-nav-icon` | Curated 1em stroke-icon set for nav and headers |
| `ValidationRowComponent` | `app-validation-row` | Single-line pass / warn / fail / info validation feedback |
| `CopyRowComponent` | `app-copy-row` | Label + readonly value + copy action for tokens and links |
| `CodePreviewBlockComponent` | `app-code-preview-block` | Bordered code/config preview with copy action |
| `DangerZoneComponent` | `app-danger-zone` | Caution-styled wrapper for destructive or security-sensitive settings |

All are standalone, `OnPush`, and styled with the semantic tokens above.

---

## 3. Layout patterns

### Workspace rail (`app-workspace-rail`)
A slim **56px** icon rail, leftmost in the dashboard. Holds global destinations
and the control-plane toggle. Tooltip-first (`title` on every button). Icon
buttons are 40px, square, with hover, `:active` press (scale 0.94), and
`:focus-visible` outline. Router destinations use `routerLinkActive="active"`;
the active treatment is shared with toggle buttons via `.rail-btn.active`.

Use the rail for **persistent, app-level navigation**. Do not put
session/project state here — that belongs in the wide sidebar.

### Wide sidebar
The session/project column. Resizable (`ViewLayoutService.sidebarWidth`).
Its header (`app-sidebar-header`) is intentionally minimal — a label plus the
new-session control. Keep it focused on the session list it sits above.

### Control plane (`.control-plane-panel`)
A first-class, full-height docked panel (not a floating card) opened from the
rail. Holds workspace-layout presets and the full feature navigation. Slides in
with `slideInRight`. Always provide a labelled entry point — never hide
navigation behind ambiguous "More…" affordances.

### Title-bar status cluster (`.title-bar-overlay`)
Status widgets (startup health, updates, pause, quota, and short background
activity chips) live in **one framed cluster**, not as separate floating
widgets. New title-bar widgets join the cluster and match its ~28px height.

---

## 4. Surfaces

- **Cards** — `--card-bg` + `--card-border` + `--card-radius` + `--card-shadow`.
  In settings, use `SettingsCardComponent`. Elsewhere, mirror its token usage.
- **Section headers** — icon chip (`--section-icon-bg` / `--section-icon-fg`,
  34–40px rounded) + title + one-line summary.
- **Sunken areas** — previews, inset panels: `--surface-sunken-bg`.

---

## 5. Status, badges & feedback

- **Status pills** — use the `--pill-*` families. Map domain status to a band:
  ready → `ok`, warning/degraded → `warn`, error/unavailable → `error`,
  informational → `info`, disabled/neutral → `neutral`, emphasis → `accent`.
- **Save-state** — any draft/apply flow uses `SaveStateBannerComponent` so the
  Saved / Saving / Unsaved / Needs restart language is identical everywhere.
- **Inline help** — `InlineHelpComponent` for contextual guidance inside a
  complex area. `info` to explain, `tip` to hint, `warning` to caution.

---

## 6. Empty, loading & error states

- **Loading** — prefer a **shell skeleton** (faux layout with shimmering
  `--skeleton-base` / `--skeleton-sheen` blocks) over a bare spinner. See the
  dashboard CLI-detection skeleton and the settings skeleton.
- **Empty** — a titled message (`--empty-state-title-fg` / `--empty-state-fg`)
  **with a next-step action**, never a dead end. See `SetupCenterComponent`.
- **Error** — reuse the status-pill error band; offer a retry or a route to
  the relevant diagnostics (Doctor / Setup Center).

---

## 7. Motion

- Transitions use `--transition-fast` / `--transition-normal`.
- Press feedback: `transform: scale(0.94)` on `:active` for icon buttons.
- Panel entrances: `slideInRight` (docked panels), `fadeInUp` (cards/overlays),
  `sidebar-in` (the wide sidebar).
- **Reduced motion** — `styles/_animations.scss` globally neutralizes animation
  and transition durations under `prefers-reduced-motion: reduce`. Skeleton
  shimmer and progress transitions additionally opt out in their own
  `@media (prefers-reduced-motion: reduce)` blocks. Any new looping animation
  must degrade gracefully.

---

## 8. Checklist for new shell components

- [ ] Standalone, `ChangeDetectionStrategy.OnPush`, signals for state.
- [ ] Styling uses semantic tokens — no raw hex / `rgba()`.
- [ ] Reuses a settings-UI-kit component if one fits.
- [ ] Has hover, `:active`, and `:focus-visible` states for interactive elements.
- [ ] Honors reduced motion.
- [ ] Loading and empty states are designed, not afterthoughts.
- [ ] Inline styles extracted to a co-located `.scss` once non-trivial.
