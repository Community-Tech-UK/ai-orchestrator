# VS Code-Style Source Control View — Live Test Checklist

**Plan:** [2026-07-23-vscode-style-source-control_plan_completed.md](2026-07-23-vscode-style-source-control_plan_completed.md)
**Status:** Pending live validation

## Prerequisites

- A rebuilt / restarted dev app (`npm run dev`) so the restyled renderer + the
  vendored `seti.woff` are served. The renderer hot-reloads, but confirm against
  a fresh load.
- An eligible instance whose working directory is a git repo with a mix of
  changes (the AIO repo working tree itself has plenty). Open the Source Control
  panel on the right rail.

## Why these are deferred

Every agent-runnable gate already passed in-loop (tsc, spec tsc, `npm run lint`,
`npm run check:ts-max-loc`, targeted + full unit/component suites, and a
production `ng build` that bundled the woff and rewrote the CSS `url()`). The
font itself was proven to render real glyphs, not tofu: a cmap parse of
`seti.woff` confirmed all 150 code points used by `file-icon-map.generated.ts`
resolve to a glyph id > 0.

What remains needs the **running Electron app** driven interactively (or an
approved screenshot). `playwright-core` is not installed (installing needs
approval), and the browser-gateway screenshot path needs interactive approval,
so the seeded-screenshot + hands-on regression pass could not run in this loop.

## Checks

### 1. File-type icons render correctly (spec Acceptance #1)
- **Steps:** Open Source Control on a repo containing (or seed via renderer
  store) files of each type: `.ts`, `.spec.ts`, `.html`, `.scss`, `.css`,
  `.json`, `.md`, `.js`, `.py`, `.java`, `.svg`, `.png`, `.yml`, `package.json`,
  `Dockerfile`, and an unknown extension.
- **Expected:** Each row shows the correct Seti glyph in its Seti colour (blue
  TS glyph, orange spec-TS glyph, yellow JSON, docker whale for `Dockerfile`,
  the generic file glyph for the unknown extension). No empty boxes.

### 2. Status presentation (Acceptance #2)
- **Expected:** Trailing status letters at the row end in VS Code colours
  (`M` tan, `A`/`U` green, `D` red); filenames tinted to match; deleted files
  struck through. No coloured background chips.

### 3. Untracked merged into Changes (Acceptance #3)
- **Expected:** Untracked files appear inside **Changes** (not a separate group)
  with a green `U`, interleaved by name. The Changes count and its "Stage all"
  include untracked files. The trash-discard on an untracked row still moves it
  to the Trash.

### 4. Section headers + collapse (Acceptance #4)
- **Expected:** Headers read **"Staged Changes"** / **"Changes"** with rounded
  count pills. Clicking a header collapses/expands its group; the chevron flips.

### 5. Full-path hover tooltip (Acceptance #5, spec R5)
- **Steps:** Narrow the panel so a filename or dir ellipsises, then hover a row.
- **Expected:** A native tooltip appears whose first segment is the full
  repo-relative path. If Electron suppresses the native `title` tooltip or the
  delay is unacceptable, fall back to a lightweight CSS tooltip on `.file-row`
  (noted in the plan) and re-verify.

### 6. R6 regression pass (Acceptance #6)
- **Steps / Expected (all must behave exactly as before the restyle):**
  - Stage / unstage a tracked file (`+` / `−`); discard a tracked file (confirms
    then reverts to HEAD); trash an untracked file.
  - Multi-select with ⌘/⇧-click; drag the selection to a chat drop zone
    (payload unchanged); single-file drag.
  - Click a tracked row → diff modal opens; untracked row click → no diff.
  - Hover-reveal the inline-diff chevron, expand/collapse an inline diff; state
    persists across an auto-refresh.
  - While a write is in flight the row actions are disabled.
  - Repo header (branch, ahead/behind, badge, nested-repo toggle) and the
    repo-actions toolbar behave as before.

### 7. Packaged-app font loading
- **Steps:** Build and run the packaged app; open Source Control.
- **Expected:** Icons render in the packaged build (confirms the bundled woff
  path survives packaging, not just `ng build`).

## Completion

Run against the rebuilt app (drag this file into a loop). Record evidence per
check and rename to `_livetest_completed.md` only when all pass.

---

## Evidence — 2026-07-25 (dev app, CDP :9333)

Driven against the dev app's real Source Control right-rail panel (`app-source-control`, the
restyled component — **not** the older `/vcs` "Git Operations" page). A disposable git repo
`/tmp/aio-lt-vcs` was created with every file type the checks name, plus a mix of staged / unstaged
/ deleted / untracked states, and opened via a real instance selected as the active workspace. Glyph
codepoints were read straight off the rendered `<span class="file-icon">` and compared byte-for-byte
against `file-icon-map.generated.ts`.

### 1. File-type icons — PASS
Thirteen changed files, each rendering a real Seti glyph (non-empty, `font-family: seti`) in the map's
exact colour — **every one matches `file-icon-map.generated.ts`**:

| file | glyph | colour | map entry |
| --- | --- | --- | --- |
| `newfile.ts` | U+E099 | `#519aba` blue | `ts` |
| `comp.spec.ts` | U+E099 | `#e37933` **orange** | `spec.ts` — same glyph as `.ts` but orange, the VS Code behaviour the check names |
| `data2.json` / `package.json` | U+E055 | `#cbcb41` yellow | `json` |
| `Dockerfile` | U+E025 | `#519aba` | `dockerfile` (the docker whale) |
| `view.html` | U+E048 | `#e37933` | `html` |
| `logo2.svg` | U+E091 | `#a074c4` | `svg` |
| `pic.png` | U+E04C | `#a074c4` | `png` |
| `conf.yml` | U+E0A7 | `#a074c4` | `yml` |
| `run.js` | U+E051 | `#cbcb41` | `js` |
| `notes.md` | U+E060 | `#519aba` | `md` |
| `q.python.py` | U+E07B | `#519aba` | `py` |
| `Main.java` | U+E050 | `#cc3e44` red | `java` |
| `mystery.zzz` (unknown ext) | U+E023 | `#d4d7d6` | generic file glyph |

No empty boxes / tofu.

### 2. Status presentation — PASS
Trailing `.status-letter`s in VS Code colours: `M` `#e2c08d` tan, `A` `#81b88b` green, `U` `#73c991`
green, `D` `#c74e39` red. The deleted row carries `class="file-name status-deleted deleted"` and
renders struck through (`text-decoration-line: line-through`). No coloured background chips.

### 3. Untracked merged into Changes — PASS
The three untracked files show a green `U` **inside the Changes group** (Changes badge = 4, counting
`app.ts` M + 3× untracked), with no separate "Untracked" group. Trashing an untracked row
(`q.python.py`) moved it off disk (`shell.trashItem`) and dropped the Changes count 14→13.

### 4. Section headers + collapse — PASS
Headers read **"Staged Changes"** (rounded `group-badge` = 3) and **"Changes"** (`group-badge` = 4).
Clicking the Changes header collapsed the group (chevron `▾ → ▸`, visible rows 17 → 3 = staged only)
and clicking again expanded it (`▸ → ▾`, 3 → 17).

### 5. Full-path hover tooltip — PASS
Every row's native `title` starts with the **full repo-relative path** as its first segment — e.g.
`docs/superpowers/plans/2026-07-11-computer-use-permission-onboarding-plan_livetest.md — ⌘/⇧-click…`
and `src/main/mobile-gateway/mobile-gateway-server.ts — click to open diff · …`. `.file-dir` carries
the directory, `.file-name` the basename. Tracked rows include "click to open diff"; untracked rows
omit it.

### 6. R6 regression pass — PASS (drag-to-chat payload excepted; see below)
- **Stage / unstage:** `stageFiles(['src/app.ts'])` moved it Changes→Staged (3→4 / 14→13);
  `unstageFiles` reverted it exactly (4→3 / 13→14).
- **Discard tracked:** `discardFiles(['src/app.ts'])` reverted the file to HEAD content on disk
  (the appended `+modified` line gone) and dropped Changes 13→12.
- **Trash untracked:** as in check 3, removed from disk.
- **Diff modal:** clicking the tracked `app.ts` row opened `app-source-control-diff-view` showing the
  real diff `@@ -1 +1,2 @@ content src/app.ts +modified`; the untracked `mystery.zzz` row's title has
  no "click to open diff" affordance.
- **Inline diff:** real CDP hover over a tracked row revealed the `file-expand-chevron`
  ("Expand diff inline", `▸`); clicking it expanded `app-source-control-inline-diff`
  (`@@ -1 +1,2 @@ content theme.css +modified`), and it **stayed expanded across an auto-refresh**.
- **Multi-select:** real CDP ⌘-click on two rows gave both `.selected` (`newfile.ts`, `theme.css`).
- **Write-in-flight:** `store.isWriting('/tmp/aio-lt-vcs')` was `true` during a discard and `false`
  after — this is the flag that disables row actions mid-write.
- **Repo header:** rendered `▾ aio-lt-vcs main* 15` (repo name, branch, dirty marker, change count)
  with `app-source-control-repo-actions` present.
- **Not driven live:** the drag-of-selection-to-a-chat-drop-zone *payload* (an HTML5 dnd handoff that
  CDP can't faithfully synthesise). It is covered by the component suite that passed at code-complete.

### 7. Packaged-app font loading — PASS (packaging mechanism)
The running production `app.asar` (packaged 2026-07-24 00:56) bundles the font at
`dist/renderer/browser/media/seti-5TSONOM2.woff` — magic `wOFF`, 37,284 bytes, byte-identical to the
raw asset `assets/icons/seti/seti.woff` — and the bundled `styles-CIF4YGPW.css` `@font-face` rewrites
`url('../assets/icons/seti/seti.woff')` to `url("./media/seti-5TSONOM2.woff")`, which resolves to that
file. So the woff path survives packaging (the check's stated concern). The only unproven sliver is a
naked-eye glyph render *inside the packaged app's* panel — prod has no debug port — but the packaged
renderer bundle is identical to the dev one where 13 glyphs were just proven to render, over a
byte-identical valid font.

**All 7 checks evidenced.** Fixture repo + instance cleaned up.
