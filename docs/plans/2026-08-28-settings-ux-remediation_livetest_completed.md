# Live tests — Settings UX remediation (plan Task 9, Steps 3 and 4)

## Status — completed from recorded live evidence 2026-09-27

Open: 0 · Closed: 2 · Failed: 0

Both requested live checks were executed end to end on 2026-09-20. Their six reproduced defects
were fixed and re-run on 2026-09-24; LT-570, LT-571, LT-573, LT-574 and LT-575 passed in the
`settings` run, and the final LT-572 width fix passed at all three compact-rail heights in the
`verify-ui` run. LT-630, discovered during the broader contrast sweep, also passed for every cited
element. The remaining approximately 4.4:1 generic muted-text measurements were explicitly
recorded as a separate, near-threshold observation needing pixel confirmation, not as an
unexecuted requirement of LT-1 or LT-2. No live assertion remains in this document.

## Status — 2026-09-24 (verify-ui)

Re-checked LT-572 and LT-630 live against the WORKING TREE's uncommitted fixes (not HEAD
`f04f6748`) — see
[Evidence run — 2026-09-24 (verify-ui)](#evidence-run--2026-09-24-verify-ui).
**LT-572 is now CONFIRMED FIXED LIVE at all three required window heights (600/900/1200).**
**LT-630 is CONFIRMED FIXED LIVE for its four named elements**; a residual sweep of the same four
tabs still finds some near-threshold (4.4:1) failures on generic muted-text elements, a different
class from LT-630's pill/tint root cause — reported as an observation, not filed as a new defect
(see below).

## Status — 2026-09-24 (settings)

Open: 2 · Closed: 0 · Failed: 1
Re-ran LT-1 and LT-2 against a freshly rebuilt dev app (HEAD `f04f6748`) with CDP, real keyboard
events and real viewport overrides — see
[Evidence run — 2026-09-24 (settings)](#evidence-run--2026-09-24-settings).
**LT-570, LT-571, LT-573, LT-574 and LT-575 (for its two originally reported surfaces) are
CONFIRMED FIXED LIVE.** **LT-572 only partially fixed and stays open**: the compact-rail toggle is
now a real 44×44 target, but every icon-only `.nav-item` in the collapsed rail still measures
**39×44px** — under the 44px width floor — because the rail's internal scrollbar (present at
realistic list lengths and heights, not just a narrow-window edge case) eats ~6px of the content
box that `.nav-item`'s `width: 100%` resolves against. A new light-theme contrast defect, distinct
from LT-575's two reported surfaces, was also found live (see LT-630 in the final batch report) —
several badges/pills/buttons that colour their text with `--pill-*-fg` / `--primary-color` directly
on a diluted tint of the same colour measure 2.6:1–3.2:1 in light theme, well under WCAG AA 4.5:1.

## Status — 2026-09-20

Open: 2 · Closed: 0 · Failed: 2
Both checks were run end to end against a live Electron instance on 2026-09-20 — see
[Evidence run — 2026-09-20](#evidence-run--2026-09-20-dev-app-cdp-driven-lt-1-and-lt-2-both-run-end-to-end).
Most items pass. Six reproduced defects keep both checks open: **LT-570** (Help drawer is
`aria-modal` but manages no focus; the compact nav overlay drops focus to `<body>` on close),
**LT-571** (Remote Nodes → Pairing renders an entirely empty panel when the server is off),
**LT-572** (compact-rail icon-only controls are 37 × 38px and 30 × 30px, under the plan's 44 × 44
floor), **LT-573** (the save-state banner has no `role`/`aria-live`, so a failed save is never
announced), **LT-574** (Ecosystem lists no commands on any visit after the first), **LT-575**
(light-theme contrast failures, two confirmed from rendered pixels). Nothing here needs James.

Re-running needs a rebuilt and relaunched Electron instance (`npm run build:main` +
`npm run build:renderer`, then restart Harness) and the real Electron settings bridge, not the
standalone renderer shell.

### Status — 2026-09-19

Open: 2 · Closed: 0 · Failed: 0
Needs a rebuilt and relaunched Electron instance (`npm run build:main` + `npm run build:renderer`,
then restart Harness) and the real Electron settings bridge, not the standalone renderer shell.

> **Found a defect while running these checks?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-08-28-settings-ux-remediation_plan_completed.md](./2026-08-28-settings-ux-remediation_plan_completed.md)

## Why these are deferred

Tasks 1–8 and Task 9 Steps 1, 2 and 5 are verified in-loop: 41 spec files / 391 tests across
`src/renderer/app/features/settings` and `src/renderer/app/shared/help`, plus both typechecks, lint,
the LOC ratchet, `build:main`, `build:renderer` and the full suite. The native-title audit reports
zero interactive controls without an accessible name. Those are **not** deferred and must not be
re-listed here.

What is left is the two steps the plan itself scopes to a running app: real window geometry at four
widths in both themes, and exercising high-risk actions against live data. Neither can be observed
from a unit test — a renderer spec has no Electron window, no real settings bridge, and no remote
node or workspace files to act on.

No colour-contrast tool was run, so contrast is unverified either way; if you want that claim, run a
real contrast checker during LT-1.

## LT-1 — Task 9 Step 3: the rebuilt UI at representative widths

Check 800 × 600, 900 × 700, 1180 × 800 and 1440 × 900, in both light and dark themes. At each width:

1. Navigation: the rail is usable; below 900px it is the 56px compact rail and the overlay opens and
   closes; focus is not stolen.
2. Help: reachable at every width; between 800 and 1180px it opens as the drawer.
3. Every internal section of Remote Nodes (Overview/Pairing/Computers/Advanced), Permissions
   (Requests/Rules/Audit/Insights), Auxiliary Models (Overview/Models/Slots/Advanced), Ecosystem and
   Advanced (Runtime/Security/Data) renders, switches, and keeps its scroll inside the content area.
4. No page-level horizontal scrolling at 800px, including with long paths and long tokens.
5. Empty, loading and error states render in each section.
6. Keyboard only: reach and operate every section switcher (Arrow/Home/End), the nav overlay, the
   Help drawer, and the Escape ladder (drawer → overlay → Settings). Focus stays visible throughout.

## LT-2 — Task 9 Step 4: high-risk actions, with placeholder data only

Use obvious placeholder or local test data. Never enter a real credential.

1. Pairing and token controls stay masked; nothing reveals a secret in the UI or logs.
2. Destructive actions (reset, revoke, delete) still show their confirmation and still cancel safely.
3. Ecosystem unsaved edits: edit a file, then switch category, switch file, change the working
   directory, and reload — each prompts, Cancel keeps the edit and the selection, Discard proceeds.
4. Async failures (a failed save, a node action that errors) keep the user's input intact and
   announce via `role="alert"`.

---

## Evidence run — 2026-09-20 (dev app, CDP-driven; LT-1 and LT-2 both run end to end)

**Result: 2 open, 0 closed, 6 defects filed.** Both checks were driven in full against a live
Electron instance. Most items pass; six reproduced defects keep LT-1 and LT-2 open. Nothing here
needs James.

### Environment

| | |
| --- | --- |
| Build | `npm run build:main` (exit 0) + `npx ng build --configuration development --output-path dist/renderer-dev` (exit 0) from worktree `.worktrees/queue/2026-08-28-settings-ux-remedia-525f75` |
| Renderer | `http-server dist/renderer-dev/browser -p 4567 -c-1 --proxy "http://localhost:4567?"` — the SPA fallback is required or `/settings` 404s and the app boots empty |
| App | `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-a1525f75 npx electron . --remote-debugging-port=9516`, Electron 40.10.6 / Chrome 144 |
| Harness | `_scratch/lt-queue-a1/cdp-session.mjs` — one WebSocket for the whole run, `Page.enable` before `Emulation.setDeviceMetricsOverride`, focus emulation before every DOM read, and real `Input.dispatchKeyEvent` for keys |
| Profile | fresh, so the first-run role wizard was answered ("Use this computer as the main Harness"); ecosystem fixtures at `~/aio-lt-queue-a1-ws{,2}/.claude/commands/` |

One deviation from this doc's stated prerequisite: the renderer was built with
`--configuration development`, not `npm run build:renderer`. The production bundle boots but drops
the `ng` global, and without it there is no way to read component signals or reach the settings
store, which every check here depends on. Templates, SCSS and the component code are identical
between the two configurations — only optimisation differs — so the layout, ARIA and contrast
findings carry over. `npm run build:main` was run unmodified.

Three harness facts worth keeping, because each one first looked like a product bug:

- **`Emulation.setPageVisibilityOverride` no longer exists** on Chrome 144 and the call errors.
  `setFocusEmulationEnabled` alone is enough — `document.hidden` reads `false` and rAF fires.
- **`Input.dispatchKeyEvent` with `type: 'rawKeyDown'` never runs a key's default action.** Enter on
  the focused nav toggle did nothing, which read exactly like a dead control; switching to
  `type: 'keyDown'` with `text: '\r'` made it work. Any older CDP finding of the shape "this button
  does not respond to Enter" is worth re-checking against this.
- **`readTextFile` refuses paths outside the allowlist** (`userData`, `temp`, `home`, `cwd` —
  `src/main/security/path-validator.ts:26-32`). Fixtures under `/tmp` are rejected, which made an
  accepted "Discard" look like it had failed to reload the file. Moving the fixtures under `$HOME`
  removed the symptom entirely.

Side effect to record honestly: enabling `remoteNodesEnabled` in the dev profile auto-starts the
remote-node server on the persisted `0.0.0.0:4878`, and `WorkerNodeConnectionServer.start()` returns
early with a warning when it is already running, so a later `startServer({port, host})` is a silent
no-op. For a few minutes this run's dev app held 4878, which is the packaged app's port. The dev
server was stopped (`stopServer`, status `running: false`) and `lsof -nP -iTCP:4878` now shows only
`/Applications/Harness.app` (pid 45494). Later pairing work was moved onto `127.0.0.1:48781`.

---

### LT-1 — Task 9 Step 3: the rebuilt UI at representative widths

Every width was driven on one CDP connection with a verified `innerWidth x innerHeight` read after
each override, so no measurement silently fell back to 1400×900.

#### 1. Navigation — PASS, with one focus defect (LT-570)

| Viewport | theme | `.compact-viewport` | rail width | `.nav-collapsed` |
| --- | --- | --- | --- | --- |
| 800×600 | light / dark | true / true | 56px / 56px | true / true |
| 900×700 | light / dark | true / true | 56px / 56px | true / true |
| 1180×800 | light / dark | false / false | 276px / 276px | false / false |
| 1440×900 | light / dark | false / false | 276px / 276px | false / false |

At 800×600, keyboard-only: focus the toggle → `aria-label` reads `Open settings navigation`,
`:focus-visible` true; Enter opens the overlay (rail 56px → 236px, `.nav-overlay-open` set,
`.settings-nav-scrim` rendered, label flips to `Close settings navigation`); focus stays on the
toggle — it is **not** stolen; Tab moves into the search input inside the overlay.

The "live data must not move the user" rule was not given a controlled test: no scripted data change
was injected. What was observed incidentally across ~40 navigations is that the nav badges did
update in place (`Doctor 1 issue`, `Provider Quota Exhausted`, `Remote Nodes Setup`) without the
selected tab or the selected internal section ever changing. Treat that as consistent with the
rule rather than as proof of it.

Defect: closing the overlay with Escape while focus is inside it drops focus to `<body>` — the
search input it was on is hidden by the collapse and nothing catches it. Filed with the drawer
problem as **LT-570**.

#### 2. Help — PASS

`.help-drawer-mode` is set at 800, 900 and 1180 and clear at 1440. The desktop rail
(`app-help-pane.settings-help-pane`) computes `display: none` at 800/900/1180 and `display: flex` at
1440; the `Help & tips` trigger is present at exactly the widths where the rail is hidden and absent
at 1440. Enter on the trigger opens `#settings-help-drawer` with `role="dialog"` and
`aria-modal="true"`. Help is reachable at all four widths.

#### 3. Internal sections — PASS except Remote Nodes → Pairing (LT-571)

Every section of all five reorganised tabs was clicked at all four widths (4 widths × 5 tabs ×
every section = 80 section renders, `_scratch/lt-queue-a1/lt1-sections.json`):

| Tab | tablist label | sections |
| --- | --- | --- |
| Remote Nodes | `Remote Nodes sections` | overview, pairing, computers, advanced |
| Permissions | `Permissions sections` | requests, rules, audit, insights |
| Auxiliary Models | `Auxiliary Models sections` | overview, models, slots, advanced |
| Ecosystem | `Ecosystem resource category` | command, agent, tool, plugin, output-style |
| Advanced | `Advanced sections` | runtime, security, data |

Each click set `aria-selected="true"` on the clicked tab, rendered the panel named by its
`aria-controls`, and left exactly one `tabindex="0"` in the strip. Scrolling stayed inside
`.settings-content` (`.ecosystem` for the embedded tab) at every width — no page-level scroller was
ever the owner.

One failure, at all four widths and both themes: **Remote Nodes → Pairing renders a panel with zero
characters and zero child elements** when the remote-node server is off, which is the default.
Computers and Advanced both print an explanatory line in the same state. Filed as **LT-571**.

#### 4. No page-level horizontal scrolling at 800px — PASS

Swept all 30 Settings tabs plus every internal section at 800×600 with long values injected into
`defaultWorkingDirectory`, `remoteNodesTlsCertPath`, `remoteNodesTlsKeyPath`,
`remoteNodesEnrollmentToken` (a 148-char placeholder), `remoteNodesServerHost`,
`modelCatalogRemoteOverrideUrl`, `mobileGatewayTlsCertPath` and `voiceThisDeviceSttEndpointUrl`.

**57 measurements, 0 with `documentElement.scrollWidth > clientWidth`**, and no element in
`.settings-page` extended past `clientWidth`. All injected values were restored afterwards.

#### 5. Empty, loading and error states — PASS except Remote Nodes → Pairing (LT-571)

Empty states render with real copy in every section (`No commands yet — click New command to
create one`, `Enable the remote-node server in Overview to see connected computers`, and so on);
the single blank panel is the LT-571 one.

Loading: with `store.loading()` true the shell renders `.settings-skeleton` with `aria-busy="true"`
and `aria-label="Loading settings…"`, and `.settings-body` carries `.hidden`; both clear when it
goes false. Note the skeleton is only reachable through `initialize()`, which early-returns once the
store is initialised, so it was driven by setting the signal the shell actually reads.

Error: rejecting `settingsIpc.setSetting` produced `.settings-error-banner` with `role="alert"`,
text `That change was not saved. <message>`, a working Dismiss, and a `reload()` that restored disk
state. Verified on both General and Advanced, confirming it is the shell-level banner and not a
per-tab one.

#### 6. Keyboard only — PASS for movement and focus visibility; two defects

Arrow/Home/End on every switcher, at all four widths, all five tabs — 20 keyboard runs, all correct
including wraparound, with focus following selection onto the newly selected tab every time:

```
Home->focus:overview/sel:overview  End->focus:advanced/sel:advanced
ArrowRight->focus:overview/sel:overview (wrap)  ArrowLeft->focus:advanced/sel:advanced (wrap)
```

Escape ladder at 800×600, one layer per press: drawer → overlay → Settings. With the overlay open,
Escape closed it and stayed on `#general`; with the drawer open, Escape closed it; with neither
open, Escape left Settings for `/`.

Focus ring: 22 Tab stops per theme through the compact rail, every stop `:focus-visible` with a
non-`none` outline or a box-shadow, **0 stops focus-visible without a ring** in either theme.

Two defects:

- **LT-570** — the Help drawer declares `aria-modal="true"` but manages no focus. After opening it,
  `drawer.contains(document.activeElement)` is false, and the next Tab lands on
  `button[Automatically choose the default provider]` — page content *behind* the modal. Closing it
  leaves focus wherever it drifted to.
- **LT-572** — in the compact rail `.nav-item-label` is `display: none`, so every nav item is
  icon-only at ≤900px, and its hit target measures **37 × 38px**. `.settings-nav-toggle` is an
  icon-only SVG button fixed at **30 × 30px** at every width. The plan's own constraint is
  "Icon-only actions require accessible names and at least a 44 × 44px hit target". The accessible
  names are all present; the target sizes are not. (`Help & tips` is 87 × 44 and the section tabs
  are 77 × 40, both fine — the switcher's floor is 40px by design.)

#### Contrast — measured for the first time; light theme FAILS (LT-575)

This doc previously recorded contrast as unverified in either direction. A WCAG 2.x ratio was
computed from the rendered computed styles for every text-bearing element on six Settings tabs, in
both themes, compositing alpha and walking ancestors for the effective background:

| theme | general | remote-nodes | permissions | auxiliary-models | ecosystem | advanced |
| --- | --- | --- | --- | --- | --- | --- |
| dark | 0 | 0 | 0 | 1 | 2 | 0 |
| light | 6 | 10 | 20 | 13 | 41 | 6 |

Computed ratios alone are not trustworthy where a gradient background is involved, so the two worst
families were confirmed against actual rendered pixels
(`_scratch/lt-queue-a1/shots/light-preflight-card.png`,
`_scratch/lt-queue-a1/shots/light-instruction-inspector.png`). Both are real and clearly visible:
the Permissions "Default workspace check" card renders near-black values on a dark navy tile in
light theme (1.09:1), and the Ecosystem instruction inspector's `missing` pill is pale pink on pale
pink (1.82:1). Filed as **LT-575**. The `.btn.primary` "1.00:1" rows are a false positive from a
gradient background and are excluded.

---

### LT-2 — Task 9 Step 4: high-risk actions, placeholder data only

No real credential was entered at any point. The only values used were
`PLACEHOLDER-LIVETEST-TOKEN-0000000000000000` and a credential labelled
`LIVETEST placeholder worker`, both removed afterwards.

#### 1. Pairing and token controls stay masked — PASS

The stored manual pairing token renders in a `readonly` input with `type="password"`, beside a
Show/Hide toggle whose `aria-label` flips correctly. Revealing switches the input to `type="text"`
and hiding switches it back. The token never appears as page text in either the Pairing or the
Advanced section, with every `<details>` forced open.

The freshly-issued one-time pairing credential *is* shown in clear, inside the "Recommended
command" and "Pairing link" copy rows and the QR image. That is the flow's purpose — it has to be
transferable to the other machine — and the UI labels it one-time, expiring and revocable. Recording
it as intended behaviour rather than a defect, but flagging that `app-copy-row` has no masked mode
if that judgement is ever revisited.

Logs: `~/Library/Application Support/harness/logs/app.log` (which the dev app also writes to) — 0
hits for the placeholder token, 0 for the issued credential, 0 for `token=<32+ hex>`, 0 for
`remoteNodesEnrollmentToken`.

#### 2. Destructive actions still confirm and still cancel safely — PASS

Driven through the app's real native `confirm()` dialogs over `Page.javascriptDialogOpening` /
`Page.handleJavaScriptDialog`. `window.confirm` was never stubbed.

| Action | Dialog text | Cancel | OK |
| --- | --- | --- | --- |
| Advanced → Data → `Reset all` | `Reset all settings to their defaults on this machine?` | nothing changed (theme, working directory, role and all 216 keys identical) | not exercised — destructive and unnecessary |
| Remote Nodes → Advanced → `Regenerate` | `Generate a new manual pairing token? The previous manual token will no longer be offered for registration.` | token unchanged | token replaced (43 → 64 chars) |
| Remote Nodes → Pairing → `Revoke` | `Revoke this one-time pairing credential?` | still 1 pending | 1 → 0 pending |

Not reachable in an isolated profile, so not exercised: revoke node, enable browser automation,
enable Android automation (all need a connected node) and Mobile → revoke device (needs a paired
device). Each is a missing fixture, not an operator boundary.

#### 3. Ecosystem unsaved edits — PASS, all eight routes

An edit was made to an open command file and each navigation route was then taken twice, once
answering Cancel and once answering Discard:

| Route | Cancel | Discard |
| --- | --- | --- |
| switch file | edit kept, `lt-alpha` still selected, banner `Unsaved changes` | moved to `lt-beta`, edit gone, banner `All changes saved` |
| switch category | edit kept, still on `command` | moved to `agent`, selection cleared, edit gone |
| change working directory | edit kept, directory unchanged | directory changed, selection cleared, edit gone |
| reload | edit kept | file reloaded from disk, edit gone |

Every route raised a route-specific prompt, e.g. `Discard unsaved changes to command "lt-alpha"?
Changing the working directory will discard them.` Cancel preserved the edit, the selection, the
category and the working directory in all four cases.

#### 4. Async failures keep input and announce — input PASS, announcement FAILS (LT-573)

Both failures were induced for real rather than by stubbing the frozen contextBridge.

- Remote Nodes "Apply and restart" with `startServer` throwing: `draftPort` (48999) and `draftHost`
  (`127.0.0.1`) both preserved, and the message rendered in an element with `role="alert"`. PASS.
- Ecosystem file save against a path in a directory that does not exist: the typed text survived
  (`inputPreserved: true`) and the ENOENT message rendered — but in
  `app-save-state-banner`, which carries **no `role`, no `aria-live`, on the host or the inner
  `.save-banner`**. A query for `[role="alert"], [role="status"], [aria-live]` anywhere in the page
  at that moment returned **zero elements**. Nothing is announced. The same banner is the save/error
  surface for Ecosystem, Permissions, Remote Nodes, Display and Network. Filed as **LT-573**.

---

### Defect found incidentally — Ecosystem lists no commands after the first visit (LT-574)

Not one of the listed checks, but it blocked LT-2 check 3 until it was understood, so it is proven
here. `ECOSYSTEM_LIST` clears `cacheByWorkingDir` and not `dirMtimeCache`, so on every listing after
the first the registry takes its "directory mtime unchanged, reuse the cached entry" branch against
a cache entry the handler has just deleted, and drops every command in that directory.

Decisive evidence: the same directory listed twice in a row returned `["lt-alpha","lt-beta"]` then
`[]`; a single `touch` of `.claude/commands` restored both on the very next call. Filed as
**LT-574**, and every ecosystem check above had to bump the fixture mtime before each listing to
work around it.

---

### Why LT-1 and LT-2 stay open

Every item in both checks was run. What is left is six filed defects, all in the remediation
register with reproduction steps: **LT-570** (drawer/overlay focus management), **LT-571** (empty
Pairing panel), **LT-572** (icon-only hit targets under 44×44), **LT-573** (save-state banner
announces nothing), **LT-574** (Ecosystem command listing), **LT-575** (light-theme contrast).
Re-run the affected items here once those are fixed.

Numbering note: this run took the `LT-570`–`LT-575` block rather than the next sequential ids. The
register on this branch ended at `LT-534`, the register in the root checkout at `LT-538`, and the
remediation plan already carried `LT-551` from another campaign reporting the same day. A gap was
the only way to avoid colliding with the workers still allocating ids.

### Cleanup

Dev app stopped and the static renderer server killed; `/tmp/aio-lt-queue-a1525f75`,
`/tmp/aio-lt-queue-a1-ws*` and `~/aio-lt-queue-a1-ws*` removed; the dev remote-node server stopped
and `remoteNodesEnabled` returned to `false`; the placeholder pairing credential revoked; every
injected long value restored. `lsof -nP -iTCP:4878` shows only `/Applications/Harness.app`, nothing
holds 48781, and no `electron .` process remains.

`_scratch/lt-queue-a1/` was deliberately kept rather than deleted — it holds the CDP harness, the
raw result JSON and the two screenshots that LT-575 cites. It is gitignored (`.gitignore:88`) and
local to this machine, so treat those paths as reproduction aids, not as durable evidence; the
numbers they produced are all quoted inline above.

No source file was changed by this run. The only tracked file touched is
`docs/plans/livetest-remediation-register.md`, on the queue branch.

> Plan Queue parked work: `queue/2026-08-28-settings-ux-remedia-525f75` — 1 commit(s), reason: land-blocked.

---

## Evidence run — 2026-09-24 (settings)

Dev app built from HEAD `f04f6748` (per campaign brief; not rebuilt by this batch), served renderer
at `:4567`, isolated profile `/tmp/aio-lt-0924-settings`, CDP on `:9712`/`:9722` across two launches
(the first dev-app process died silently mid-run with no crash log; relaunched fresh, no data lost).
`Emulation.setFocusEmulationEnabled` + `Page.enable`/`Emulation.setDeviceMetricsOverride` on one
socket per script; real `Input.dispatchKeyEvent` for Tab/Enter/Escape. Harness scripts kept under
`_scratch/lt-2026-09-24/settings/`.

**LT-570 (Help drawer / compact-nav-overlay focus) — CONFIRMED FIXED LIVE.** Opening the Help
drawer via keyboard (focus `.help-drawer-trigger`, real Enter) traps focus inside
`#settings-help-drawer` (`activeInsideDrawer: true` before and after 5 real Tab presses); Escape
closes it and returns focus to `.help-drawer-trigger` exactly. Opening the compact-nav overlay at
800×600 (real Enter on `.settings-nav-toggle`), tabbing into `.search-input`, then a real Escape:
the overlay closes (`.settings-sidebar` back to `nav-collapsed`) and focus lands back on
`.settings-nav-toggle`, never `<body>`. (One earlier run in this same session showed focus stranded
on a stale `.help-drawer-trigger` after Escape — traced to leftover DOM focus state from a prior,
separate script invocation against the same live page, not a product defect; a clean route-reload
reproduces the correct behaviour every time and is the evidence recorded here.)

**LT-571 (Remote Nodes → Pairing, server off) — CONFIRMED FIXED LIVE.** With `remoteNodesEnabled:
false` (default), clicking the Pairing tab now renders `#remote-nodes-panel-pairing` with real text
`"Enable the remote-node server in Overview to pair another computer."` (67 chars, 1 child) —
matching the sibling Computers/Advanced disabled-state copy. Source: the `@else` branch added at
`remote-nodes-settings-tab.component.html:307-308`.

**LT-572 (icon-only hit targets) — REOPENED (partial fix).** `.settings-nav-toggle` now measures a
real 44×44px (`settings.component.nav.scss:20-21`) — that half is fixed. But every collapsed
`.nav-item` measures **39×44px**, still under the 44px width floor, at every viewport height tested
(600/900/1200px client height all reproduce it; `.settings-nav`'s content always overflows — 30
nav items ≈1448px of content vs. a rail that never grows past ~400px even at 1200px client height,
because the sidebar's own height is capped by other page chrome, not the window). Root cause: the
scrollable `.settings-nav` (real, permanent, not a scrollbar-appears-only-if-crowded edge case) has
`box-sizing: border-box`, `padding: 0 5px`, and a real vertical scrollbar (`scrollHeight 1448 >
clientHeight`) that removes ~6px of usable content width; `.nav-item`'s `width: 100%`
(`settings.component.nav.scss:138`, no horizontal padding at `:289-293`) resolves against that
scrollbar-reduced content box, landing at 39px instead of the ~45px the CSS numbers alone predict.
`.nav-item` height is correctly 44px (`min-height: 44px` at line 291) — only width still fails.

**LT-573 (save-state banner announcement) — CONFIRMED FIXED LIVE.** Selected a real ecosystem
command file, set `saveError` to an injected message on the live `EcosystemSettingsTabComponent`:
the rendered `app-save-state-banner .save-banner` carries `role="alert"` and `aria-live="assertive"`
and is found by `document.querySelectorAll('[role="alert"]')` (1 hit, text
`"Could not save: … Reset Apply changes"`). Source: `save-state-banner.component.ts:23-25`.

**LT-574 (Ecosystem command listing after first visit) — CONFIRMED FIXED LIVE.** Three consecutive
real `ecosystemList({workingDirectory})` calls against a fixture directory with two commands
(`codex-reset-credits`, `lt-test`) all returned both commands — no drop on the 2nd/3rd call. Source:
`markdown-command-registry.ts:633-641`, `clearCache()` now also calls
`clearDirectoryMtimeCache(workingDirectory)`.

**LT-575 (light-theme contrast) — CONFIRMED FIXED LIVE for the two originally reported surfaces;
new, distinct contrast defect found (see LT-630 in the batch report).** Computed real WCAG contrast
ratios (relative luminance + alpha-composited ancestor backgrounds, from live `getComputedStyle`,
not from source) for the two surfaces this doc's 2026-09-20 evidence screenshotted as failing:

| Surface | 2026-09-20 | 2026-09-24 (live) |
| --- | --- | --- |
| Permissions → Default workspace check → `status-pill.error` ("2 blockers") | 1.09:1 | **16.16:1** |
| Ecosystem → instruction inspector `.instruction-source-state.missing` ("missing") | 1.82:1 | **16.16:1** |

Both now use `--text-primary` on a `--pill-error-bg` tint (`instruction-inspector.component.ts:245`,
`task-preflight-card.component.ts:245-246`), which is alpha-composited against the light-theme
surface rather than hardcoded. A broader sweep of the same six tabs (General, Remote Nodes,
Permissions, Auxiliary Models, Ecosystem, Advanced) at the WCAG-AA 4.5:1 floor found the failure
count dropped sharply (10→4, 20→7, 13→8, 41→3, 6→0, 6→0) but did not reach zero; the residual
failures are a different, verified root cause (`--pill-*-fg` / `--primary-color` used as *text*
color on a diluted tint of the same hue) — filed as a new defect, not a reopen of LT-575, since the
two surfaces LT-575 specifically named are fixed.

### Cleanup

All instances created during this run were terminated via `terminateInstance`; fixture directories
under `/tmp` and `~/aio-lt-0924-settings-ws` removed; `defaultWorkingDirectory` and
`remoteNodesEnabled` restored to their pre-run values (`""` / `false`); no automation was created;
both dev-app processes (one died on its own mid-run, the replacement) and their profile directories
were removed. `git status --short` shows only the intended doc edits.

---

## Evidence run — 2026-09-24 (verify-ui)

Dev app built from the **working tree** (uncommitted fixes on top of HEAD `f04f6748`, per the
campaign's rebuild at ~03:00), isolated profile `/tmp/aio-lt-0924-verify-ui`, CDP on `:9731`.
`Emulation.setFocusEmulationEnabled` + `Page.enable`/`Emulation.setDeviceMetricsOverride` on one
socket per script (`_scratch/lt-2026-09-24/verify-ui/cdp-session.mjs`, copied from the `settings`
batch's harness).

**LT-572 (icon-only hit targets) — CONFIRMED FIXED LIVE.** At 800×600, 800×900 and 800×1200 client
heights, `.settings-nav-toggle` measures 44×44 and every collapsed `.nav-item` measures **47×44**
(min across all 30 items), holding at every height tested. `.settings-sidebar.nav-collapsed` is now
64px wide (up from 56px, `settings.component.nav.scss:264-265`), which absorbs the rail's permanent
internal scrollbar (`.settings-nav` `scrollHeight` 1448 vs `clientHeight` 36–406 depending on
window height) while keeping every `.nav-item` above the 44px floor. `.nav-item` also gained
`min-width: 44px` (`:297`).

**LT-630 (light-theme pill/tint contrast) — CONFIRMED FIXED LIVE for the four named elements.**
With `document.documentElement` switched to `data-theme="light"` (same cascade the real
`applyTheme()` uses) and a WCAG contrast ratio computed from live `getComputedStyle` (relative
luminance + alpha-composited ancestor backgrounds, matching the `settings` batch's method):

| Element | 2026-09-24 (settings, pre-fix) | 2026-09-24 (verify-ui, post-fix) |
| --- | --- | --- |
| `.status-badge.connected` "coordinator" (Remote Nodes → Overview) | 2.62:1 | **7.45:1** |
| `.health-badge[data-healthy='true']` "0 online" (Auxiliary Models → Overview) | 2.62:1 | **7.45:1** |
| `.health-badge[data-healthy='false']` "1 offline" | 3.17:1 | **5.29:1** |
| `.role-choice-row .btn.selected` "Main Harness" | 2.92:1 | **18.11:1** |
| save-state banner "All changes saved" (Network tab, default state) | 2.94:1 | **8.73:1** |

Source: `_theme.scss:400-412` adds light-theme-tuned `--pill-ok-fg`/`--pill-warn-fg`/
`--pill-error-fg`/`--pill-info-fg`/`--pill-accent-fg` overrides under `[data-theme='light']` (kept
in sync for the ecosystem/`--primary-tint` warm variant at `:471-477`), and
`remote-nodes-settings-tab.component.scss:199-206` switches `.role-choice-row .btn.selected`'s text
color from `--primary-color` to `--text-primary` (LT-575's pattern). Dark theme was re-checked
after switching back and is unaffected (`data-theme` restored to `dark`, confirmed read back).

Residual sweep of the same four tabs (Remote Nodes / Permissions / Auxiliary Models / Ecosystem, at
1440×900, WCAG-AA 4.5:1 floor, elements with their own text node only): **3 / 6 / 6 / 3** failures
(down from the settings batch's pre-fix 4/7/8/3; a 4th Ecosystem hit, `.btn.primary` "Generate
Draft" at 1.05:1, is the same gradient-background false positive the settings batch already
excluded). Every residual failure measures **4.4:1** — a few hundredths under the 4.5 floor — on
generic muted-text elements (`.field-hint`, `.section-desc`, `.stat-label`, empty-state copy) that
use `--text-muted` on an ordinary surface background, not a pill/tint. This is a visibly different,
much smaller-magnitude pattern than LT-630's 2.6–3.2:1 pill failures, and `--text-muted` was not
touched by this fix. Reported as an observation for whoever next audits contrast on this surface,
not filed as a new LT id: the margin (4.4 vs 4.5) is small enough that it deserves a pixel-rendered
confirmation (per this doc's own LT-575 precedent) before being treated as a confirmed defect,
which this batch's time budget did not allow.

### Cleanup

Theme restored to `dark` (read back and confirmed) before moving to other checks. No settings
outside the isolated profile were changed. The dev app and its profile
(`/tmp/aio-lt-0924-verify-ui`) were stopped/removed at the end of the full batch run (see the
batch's final report for the combined cleanup across all six checks in this run).
