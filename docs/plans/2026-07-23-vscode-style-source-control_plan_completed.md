# VS Code-Style Source Control View — Implementation Plan

**Date:** 2026-07-23
**Spec:** [2026-07-23-vscode-style-source-control_spec_completed.md](2026-07-23-vscode-style-source-control_spec_completed.md)
**Status:** Implemented & verified in-loop; interactive real-app checks deferred to [2026-07-23-vscode-style-source-control_livetest.md](2026-07-23-vscode-style-source-control_livetest.md).

## As-Built Notes (2026-07-23)

All work landed renderer-only, as scoped. Highlights / deviations:

- **Language bridges (Phase 1.2).** The Seti theme resolves common code
  extensions (`.ts/.js/.md/.html/.scss/.json/.py/.java/.yml`) via *language
  ids*, not `fileExtensions`. The generator therefore carries a curated
  `EXTENSION_LANGUAGE_BRIDGE` and a `FILENAME_LANGUAGE_BRIDGE` (e.g.
  `Dockerfile` → dockerfile) so results match VS Code; direct `fileExtensions`/
  `fileNames` always win. `package.json` resolves via the `.json` extension
  (Seti has no special package.json glyph — matches VS Code).
- **Generated file lint.** eslint reported the `/* eslint-disable */` header as
  an *unused* directive; added a global `ignores: ["**/*.generated.ts"]` to
  `eslint.config.js` instead (cleaner; oxlint doesn't cover `src/renderer`).
- **Font `url()` path.** esbuild resolves stylesheet `url()` relative to the
  authoring partial, so the `@font-face` uses `url('../assets/icons/seti/
  seti.woff')` (from `src/renderer/styles/_file-icons.scss`). A production
  `ng build` bundles the woff (hashed under `media/`) and rewrites the URL —
  confirmed in-loop.
- **Font-render proof (in-loop, no GUI).** A cmap parse of `seti.woff` confirmed
  all 150 code points used by `file-icon-map.generated.ts` map to a real glyph
  id (> 0) — zero tofu.
- Generated map is 277 lines (under the 700 hard cap) and idempotent
  (`generate:file-icons --check` clean).

All work is renderer-only. No IPC, preload, main-process, or contracts changes. Files touched live under `src/renderer/` plus one generator script under `scripts/`.

## Phase 1 — File-icon infrastructure (new, shared-ready)

### 1.1 Vendor Seti assets
- Create `src/renderer/assets/icons/seti/` containing:
  - `seti.woff` — from the `vscode-seti` built-in extension in the Microsoft/vscode repo (MIT).
  - `vs-seti-icon-theme.json` — the upstream mapping (icon definitions with `fontCharacter` + `fontColor`; `fileExtensions`, `fileNames`, `languageIds` maps). Kept as generator input only; not shipped to the bundle.
  - `LICENSE.md` — Seti-UI MIT notice (Jesse Weed) + Microsoft MIT notice, with upstream URLs and the commit/tag fetched from.
- Verify `angular.json` copies `src/renderer/assets` into the build (expected — existing assets config; confirm, and confirm the font URL resolves in `npm run dev`).

### 1.2 Generator script
- `scripts/generate-seti-icon-map.ts` (run with `tsx`, add npm script `generate:file-icons`).
- Reads the vendored theme JSON, emits `src/renderer/app/shared/file-icons/file-icon-map.generated.ts`:
  - `SETI_EXTENSION_ICONS: Record<string, FileIconDef>` (compound extensions included, keys lowercase),
  - `SETI_FILENAME_ICONS: Record<string, FileIconDef>`,
  - `SETI_DEFAULT_ICON: FileIconDef`,
  - `FileIconDef = { glyph: string; color: string }` (glyph = the font character).
- **Gate hazards, handle in the generator:** emit compact multi-entry lines so the file stays under the 700-line hard cap for new files (`scripts/check-ts-max-loc.ts`), and start the file with a generated-file header + `/* eslint-disable */` so `npm run lint` and oxlint skip style rules. File is committed; never hand-edited (repo convention).

### 1.3 Resolver + component
- `src/renderer/app/shared/file-icons/file-icon.ts` — pure `resolveFileIcon(path: string): FileIconDef`:
  1. exact basename match (case-insensitive, e.g. `package.json`, `Dockerfile`),
  2. longest compound-extension match (split basename on `.`, try longest suffix first — covers `.d.ts` etc. where Seti defines them),
  3. plain extension,
  4. `SETI_DEFAULT_ICON`.
- `src/renderer/app/shared/file-icons/file-icon.component.ts` — standalone, OnPush, `path = input.required<string>()`, computed `icon = resolveFileIcon(...)`; template: single `<span class="file-icon" aria-hidden="true" [style.color]="icon().color">{{ icon().glyph }}</span>`.
- Register the font once in the global stylesheet (`src/renderer/styles/styles.scss` or wherever existing `@font-face`/global styles live — confirm at implementation time): `@font-face { font-family: 'seti'; src: url('assets/icons/seti/seti.woff') format('woff'); }` plus a `.file-icon` base class (font-family seti, 16px, width 16px, centered, no font ligatures).

### 1.4 Phase 1 tests
- `file-icon.spec.ts`: resolution for `.ts`, `.spec.ts`, `.html`, `.scss`, `.css`, `.json`, `.md`, `.js`, `.py`, `.java`, `.svg`, `.png`, `.yml`, `package.json`, `Dockerfile`, unknown extension → default; case-insensitivity; path-with-directories input.
- Targeted run: `npm run test:quiet -- src/renderer/app/shared/file-icons/file-icon.spec.ts`.

## Phase 2 — Source-control view restyle

### 2.1 View-model merge (untracked → Changes)
- New pure module `src/renderer/app/features/source-control/source-control-rows.ts`:
  - `buildChangesRows(status: GitStatusResponse): FileChange[]` — `unstaged` + `untracked.map(p => ({ path: p, status: 'untracked', staged: false }))`, sorted case-insensitively by basename (name-sort, statuses interleaved, VS Code behaviour).
  - `statusLetter(status: FileChangeStatus): string` — `M A D R C U !` (moves/extends the component's `statusChar`, adding `U` for untracked).
- Component (`source-control.component.ts`):
  - use `buildChangesRows` for the Changes group; counts come from the merged array length.
  - row handlers branch on `file.status === 'untracked'` (not on group): discard → `onDiscardUntracked`, row click → no diff (`null`), no inline-diff expansion target.
  - "Stage all" on Changes stages the merged list; delete `onStageAllUntracked` (its behaviour is absorbed) — check nothing else references it.
  - add per-repo section-collapse state: `collapsedGroups = signal<Set<string>>` keyed `${repo.absolutePath}:staged|changes` + `toggleGroup`/`isGroupCollapsed`. Component-local; no persistence.

### 2.2 Template (`source-control.component.html`)
- Delete the third "Untracked" group entirely; Changes `@for` iterates the merged rows (track `file.path`).
- Group headers → clickable `<button>` rows: chevron ▾/▸, title "Staged Changes" / "Changes", right-aligned count pill `<span class="group-badge">`. Body renders only when not collapsed.
- Row layout becomes: `[inline-diff chevron (hover-revealed)] [app-file-icon] [file-name] [file-dir] [hover actions] [status letter]`:
  - `<app-file-icon [path]="file.path" />` after the chevron slot.
  - status element moves to the row end: `<span class="status-letter" [class]="'status-' + file.status">{{ statusLetter(file.status) }}</span>` with `[title]="statusLabel(file.status)"`.
  - `file-name` gets `[class]` binding for `status-<x>` tint + `class.deleted` strikethrough.
  - untracked rows render the chevron spacer (no diff), all others keep the working chevron.
- Keep every existing binding for drag, multi-select, tooltips, disabled-while-writing.
- **Full-path hover tooltip (spec R5, James 2026-07-23):** every file row's `[title]` must start with the full repo-relative path (current bindings already do — preserve through the restyle, including the merged untracked rows). While in the dev app, confirm the native tooltip actually appears on hover; if Electron suppresses it or the delay is unacceptable, fall back to a lightweight CSS tooltip on `.file-row` showing the full path. Assert the `title` attribute in the JIT-render spec.

### 2.3 Styles
- `src/renderer/styles/_theme.scss`: add VS Code git-decoration variables — `--scm-modified: #e2c08d; --scm-added: #81b88b; --scm-untracked: #73c991; --scm-deleted: #c74e39; --scm-renamed: #73c991; --scm-ignored: #8c8c8c;`.
- `source-control.component.scss`:
  - remove `.status-badge` chip styles; add `.status-letter` (trailing, 11px semi-bold, per-status `color: var(--scm-*)`, no background).
  - `.file-name.status-*` tint rules + `.file-name.deleted { text-decoration: line-through; }`.
  - row: ~22px height, UI font (drop monospace) 13px name / 12px dir, hover/selected backgrounds from existing theme vars.
  - `.file-expand-chevron` hidden (`opacity: 0`) unless row hover/focus-within or `aria-expanded="true"`.
  - `.group-header` (VS Code-ish: 11px bold, subtle hover) + `.group-badge` pill (rounded, themed bg, min-width, centered bold number).
  - restyle `.file-action` glyphs minimal (keep hit-targets ≥22px).
- SCSS is not LOC-gated; keep the file tidy anyway.

### 2.4 Phase 2 tests
- `source-control-rows.spec.ts`: merge ordering (case-insensitive by basename, untracked interleaved), synthetic `FileChange` shape, counts, `statusLetter` including `U` and `!`.
- Component JIT-render spec (pattern from the workboard feature tests): seed a repo with staged modified + deleted + unstaged + untracked files; assert — icon element per row, trailing letters `M/D/U`, strikethrough class on deleted, "Staged Changes"/"Changes" headers with pill counts, untracked row inside Changes with trash-discard button, collapse toggle hides rows.
- Update any existing specs that asserted old markup (`Staged (`, `.status-badge`, Untracked group) — search before assuming none: `rg -l "status-badge|Untracked \(" src/`.

## Phase 3 — Verification

1. Targeted specs (above), then the canonical checklist:
   ```bash
   npx tsc --noEmit
   npx tsc --noEmit -p tsconfig.spec.json
   npm run lint
   npm run check:ts-max-loc
   npm run test:quiet
   ```
2. **Deferred to live test** → [2026-07-23-vscode-style-source-control_livetest.md](2026-07-23-vscode-style-source-control_livetest.md): the real-app seeded-screenshot visual pass (icon correctness / colours / strikethrough / badges / collapse / hover reveals against the VS Code reference), the interactive R6 regression pass, and packaged-app font loading. `playwright-core` is not installed (installing needs approval) and the browser-gateway screenshot needs interactive approval, so the running-app checks could not run in this loop. Everything verifiable without the running GUI was verified in-loop (targeted specs, full-suite shards, production build, and the cmap font-render proof).

## Risks / Watch-outs

- **Generated map vs repo gates:** 700-line hard cap for new TS files and lint — mitigated in 1.2 (compact emission + eslint-disable header). Confirm `check:dead`/`verify:exports` don't flag the generated exports (all are imported by `file-icon.ts`).
- **Font path in dev vs build:** relative `url()` resolution differs between dev-server and packaged bundle; verify in dev, and keep the path inside the standard `assets/` root which the existing build already copies.
- **Untracked semantics:** after the merge, logic must branch on `status === 'untracked'`, never on group membership — a missed branch would send an untracked file to `git restore` (wrong) instead of trash. Covered by the JIT-render spec + regression pass.
- **Concurrent loop-writers:** this repo is edited by live loop agents; re-run `git status` before starting and keep changes scoped to the files listed here.

## Completion

When every phase is verified: update both docs' status/as-built notes, rename this file `*_plan_completed.md`, rename the spec `*_spec_completed.md`, and update the spec's plan link. Do not commit either doc before that point (and do not commit at all unless James asks).
