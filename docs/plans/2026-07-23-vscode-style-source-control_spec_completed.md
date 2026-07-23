# VS Code-Style Source Control View — Spec

**Date:** 2026-07-23
**Status:** Implemented & verified in-loop — plan at [2026-07-23-vscode-style-source-control_plan_completed.md](2026-07-23-vscode-style-source-control_plan_completed.md). Interactive real-app checks deferred to [2026-07-23-vscode-style-source-control_livetest.md](2026-07-23-vscode-style-source-control_livetest.md).
**Requested by:** James — "This is our AIO sourcetree/git view. I would much rather it looked like VS Code. With icons for different file types and stuff like that."

## Summary

Restyle the Source Control panel (`src/renderer/app/features/source-control/`) to match VS Code's SCM view: file-type icons (Seti, VS Code's default icon theme), VS Code status colours and letters, tinted/struck-through filenames, "Staged Changes"/"Changes" section headers with rounded count badges, untracked files merged into Changes with a green `U`, and collapsible sections. All existing behaviour (stage/unstage/discard, inline diffs, multi-select, drag-to-attach, write-token gating) is preserved unchanged.

## Current State (verified 2026-07-23)

- `source-control.component.html` (313 lines) renders three flat groups per repo: `Staged (N)`, `Changes (N)`, `Untracked (N)` (`source-control.component.html:108-294`).
- Each row: expand-chevron button → leading 14×14 status **badge chip** (`M`/`A`/`D`/`?` on a coloured background) → filename → dimmed dir path → hover action buttons (`⌫`, `+`/`−`).
- **No file-type icons anywhere.** `src/renderer/assets/icons/` contains only `.gitkeep`; no icon font or SVG set exists in the repo.
- Status colours are bespoke (`.status-modified` #e1b400 etc. in `source-control.component.scss`), not VS Code's.
- Untracked files are a separate group of plain path strings (`GitStatusResponse.untracked: string[]`).
- Data types: `FileChange { path, status, oldPath?, staged }`, `FileChangeStatus = 'added'|'modified'|'deleted'|'renamed'|'copied'|'untracked'|'ignored'` (`source-control.types.ts`).

## Target Design (reference: VS Code default dark SCM view)

### R1 — File-type icons (the headline feature)

Every file row gets a 16px file-type icon between the row's left edge and the filename, exactly where VS Code puts it.

- **Icon set: Seti** — VS Code's built-in default file-icon theme, so the result matches James's screenshot (blue `TS` glyph for TypeScript, markdown glyph for `.md`, html/scss/json glyphs, etc.). Seti-UI is MIT-licensed; the VS Code `vscode-seti` extension (also MIT, Microsoft/vscode repo) ships `seti.woff` plus a theme JSON mapping filenames/extensions → glyph + colour.
- **Delivery: vendored assets, no npm dependency.** Vendor `seti.woff` into `src/renderer/assets/icons/seti/` together with a `LICENSE` file carrying the Seti-UI and Microsoft MIT notices. No runtime package install.
- **Mapping: precompiled TS.** A one-off generator script reads the vendored upstream theme JSON and emits `file-icon-map.generated.ts` (extension → `{ fontCharacter, color }`, filename → same, plus the default file glyph). The generated file is committed and never hand-edited (per repo convention).
- **Resolution order** (mirrors VS Code): exact filename match (`package.json`, `Dockerfile`, …) → longest matching compound extension (`.d.ts`, `.spec.ts` where Seti defines one) → plain extension → default file icon.
- **Rendering:** a small standalone `FileIconComponent` (`<app-file-icon [path]="…" />`, OnPush, `input()` API) renders the glyph via an `@font-face`-registered `seti` font with the mapped per-type colour. Icons keep their Seti colours in all statuses (VS Code behaviour); only the filename text takes the status colour.

### R2 — VS Code status presentation

- **Status letter moves to the far right of the row** (trailing, like VS Code), rendered as a plain coloured letter — no background chip. Letters: `M` modified, `A` added/index-added, `D` deleted, `R` renamed, `C` copied, `U` untracked, `!` ignored.
- **Filename is tinted with the status colour**; the dir-path suffix stays muted as today.
- **Deleted files render with a strikethrough filename** (as in the screenshot's `trigger-matcher.ts`).
- **Colours** — VS Code's git decoration palette, exposed as new theme variables in `_theme.scss` so they can later follow theme changes:
  - modified `#e2c08d`
  - added `#81b88b`
  - untracked `#73c991`
  - deleted `#c74e39`
  - renamed/copied `#73c991`
  - ignored `#8c8c8c`
- The old badge-chip styles are removed from `source-control.component.scss`.

### R3 — Untracked files merge into "Changes"

- Renderer-side only: the Changes group renders `unstaged` + `untracked` (untracked mapped to synthetic `FileChange { path, status: 'untracked' }`), sorted case-insensitively by basename within the merged list, untracked interleaved (VS Code sorts by name, not by status).
- Group count = unstaged + untracked (matching the screenshot's `45`-style badge).
- Behaviour branches stay as today: untracked rows keep trash-discard, no inline-diff chevron target, stage via `git add`.
- The IPC shape (`GitStatusResponse`) and main-process `VcsManager` are **unchanged** — this is purely a view-model merge in the renderer.
- "Stage all" on the Changes group stages both unstaged and untracked (VS Code behaviour); the separate "Stage all untracked" button disappears with the group.

### R4 — Section headers, VS Code style

- Titles become **"Staged Changes"** and **"Changes"** (no inline parenthesised counts).
- Count moves into a **rounded pill badge** right-aligned in the header (VS Code badge look; themed background, small bold number).
- Section headers get a **collapse chevron** and toggle their group (component-local signal state per repo+group; default expanded; state need not persist across restarts).
- Header row styled like VS Code section headers: small caps-ish 11px bold label, subtle hover.

### R5 — Row chrome

- Row height ~22px, tighter than today, 13px UI font for the filename (drop the monospace row font; VS Code uses the UI font), path suffix 12px muted.
- The per-row **inline-diff expand chevron is kept** (it's an AIO feature VS Code doesn't have) but becomes **hidden until row hover or while its diff is expanded**, so the resting look matches VS Code's clean rows.
- Hover action buttons keep current functions/order; restyle to VS Code-ish minimal glyphs (discard ↩, stage +, unstage −) with no visual chrome until hover. Keyboard/focus reveal preserved.
- Selected/hover row background switches to the standard list-hover/list-selection treatment already used by the theme vars.
- **Hovering a file row must show the full filename/path.** Truncated names (ellipsised basename or dir) get a tooltip whose first segment is the full repo-relative path, before any interaction hints (the current template already carries `[title]="file.path + …"` — keep it, verify it actually surfaces in the running app, and add it to the acceptance tests). Requested by James 2026-07-23.

### R6 — Unchanged behaviour (regression guard)

Multi-select (⌘/⇧-click), drag-to-attach payloads, click-to-open diff modal, inline diff expansion persistence, write-token disabling, repo header (branch, ahead/behind, repo badge, nested-repo toggle), and the repo-actions toolbar all behave exactly as before. Only their visual skin changes where noted.

## Decisions (defaults chosen; flag if you want different)

1. **Seti icon font vendored** (matches the screenshot / VS Code default) rather than an SVG icon theme like Material — smaller asset, exact look parity, MIT-clean.
2. **Untracked merged into Changes with `U`** (VS Code's default `git.untrackedChanges: mixed`) — the separate "Untracked" group goes away.
3. **Inline-diff chevron kept but hover-revealed** — preserves the inline-diff feature without breaking the VS Code silhouette.
4. **List view only.** VS Code's optional folder-tree SCM mode is **out of scope** (screenshot shows list view). A tree toggle can be a follow-up spec.
5. Status colours hard-wired to VS Code's dark-theme palette via new CSS variables (the app is currently dark-only).

## Out of Scope

- Tree-view (folder-grouped) mode for the change list.
- Icon theming beyond Seti, or user-selectable icon themes.
- Any change to git behaviour, IPC contracts, `VcsManager`, or the diff viewers' internals.
- Using file icons elsewhere in the app (file explorer, attachments) — the `FileIconComponent` is built shared-ready under `src/renderer/app/shared/`, but wiring other surfaces is follow-up work.

## Acceptance Criteria

1. Every row in Staged Changes/Changes shows the correct Seti icon for at least: `.ts`, `.spec.ts`, `.html`, `.scss`, `.css`, `.json`, `.md`, `.js`, `.py`, `.java`, `.svg`, `.png`, `.yml`, `package.json`, `Dockerfile`, and an unknown extension (default glyph).
2. Status letters appear at the row end with VS Code colours; filenames are tinted; deleted files struck through.
3. Untracked files appear inside "Changes" with a green `U`; counts and "Stage all" include them; trash-discard still works for them.
4. Section headers read "Staged Changes"/"Changes" with count pills and collapse on click.
5. Hovering any file row (including truncated names) shows the full repo-relative path as a tooltip, verified in the running dev app.
6. All R6 behaviours verified unchanged (unit tests + dev-app check).
7. Canonical verification checklist green; Seti license file present next to the vendored assets.

## Verification Approach

Unit tests for icon resolution, status letter/colour mapping, and the Changes merge; JIT-render component test for row markup; real-UI check in the dev app via renderer store seeding + screenshot compared against the VS Code reference. No livetest deferral expected — everything is dev-app verifiable.
