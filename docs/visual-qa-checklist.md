# Visual QA Checklist

Manual visual-regression checkpoints for the desktop shell and settings
(**copilot_todo.md item 18**). Run through this after any shell, settings, or
theming change. Pair it with `scripts/visual-qa-screenshots.mjs` to capture
before/after screenshots.

Capture **every screen below in both dark and light themes**. Switch theme via
Settings → Display → Appearance, or (for the screenshot script) by toggling the
`data-theme` attribute on `<html>`.

## How to capture

```bash
# 1. Launch the app with the DevTools protocol exposed
npm run dev -- --remote-debugging-port=9222      # dev
# or, for a packaged build, launch it with --remote-debugging-port=9222

# 2. Navigate to the screen you want, then capture dark + light
node scripts/visual-qa-screenshots.mjs <label>
# screenshots are written to ./visual-qa/<label>-<theme>.png

# Or capture the standard route set automatically
node scripts/visual-qa-screenshots.mjs --all
```

---

## Shell

- [ ] **Dashboard — workspace** — rail visible, wide sidebar with sessions,
      a session open. Rail icons aligned; active route highlighted.
- [ ] **Dashboard — control plane open** — panel docked full-height on the
      right, workspace-layout presets, feature nav. Rail "Tools & Views"
      button shows its active state.
- [ ] **Dashboard — sidebar collapsed** — `⌘B`; the toggle button sits flush
      against the rail (not under it).
- [ ] **Dashboard — loading skeleton** — shown briefly during CLI detection;
      faux rail + sidebar + workspace blocks shimmer.
- [ ] **Dashboard — no-CLIs error** — `app-cli-error` retry state.
- [ ] **Title-bar status cluster** — updates / pause / quota widgets framed as
      one cohesive cluster, consistent height, no "floating widget" gaps.
- [ ] **Startup banner** — degraded and failed variants; "Open setup" CTA.

## Settings

- [ ] **Settings shell** — sticky header, search box, nav icons, grouped
      sections (Agents / Workspace / Network & Remote / Diagnostics).
- [ ] **Settings — search** — typing filters the nav; the "no settings match"
      empty state appears for a non-matching query.
- [ ] **Settings — section header** — icon chip + title + summary per section.
- [ ] **Display / Appearance** — theme segmented control + font-size slider;
      density + sidebar controls; `SaveStateBanner` shows Saved → Unsaved →
      Saving; the inline-help tip.
- [ ] **Network** — draft/apply card with the inline-help info callout.
- [ ] **Remote Nodes** — inline-help info callout, validation row, copy rows,
      config preview block, and restart-required save banner.
- [ ] **Settings — loading skeleton** — skeleton cards before settings load.
- [ ] **Wide tabs** (Models, MCP, Doctor, …) — embedded full-width, no 760px cap.

## Setup Center (`/setup`)

- [ ] **Ready** — green hero, full progress bar, all checks ready.
- [ ] **Degraded** — amber hero, partial progress, "Resolve" buttons on
      degraded/unavailable checks, grouped by category.
- [ ] **Empty / unavailable** — dashed empty card with a "Try again" action.
- [ ] **Loading** — skeleton lines shimmer.

## Cross-cutting

- [ ] **Light theme** — every screen above; surfaces, borders, and pills read
      correctly (no dark-only hardcoded colors).
- [ ] **Reduced motion** — with `prefers-reduced-motion: reduce`, skeletons and
      panel entrances do not animate.
- [ ] **Focus states** — keyboard-tab through the rail, settings nav, and
      cards; `:focus-visible` outlines are visible.
- [ ] **Status pills** — ok / warn / error / info / neutral bands are
      distinguishable in both themes.
