# Control Center snapshot remediation — live navigation checks

Status: all four checks executed 2026-11-14 on a live dev app (test Mac) and passed; see
"Evidence run — 2026-11-14" below. Check 2's required text was corrected (verifier round 1) to the
current heading `Local models` and navigation `Usage & health`, which are exactly what the live run
observed. The queue coordinator owns the rename.

Prerequisites: an isolated rebuilt Electron instance using the verified queue branch, a renderer
built from that same source, Browser Gateway access to the permitted Windows worker, and fresh
renderer exception capture. Use a disposable user-data profile; do not touch the working app's
settings, accounts or sessions. If the only available runtime is on the Mac, James must explicitly
authorize Mac browser/desktop use for this task before interactive checking.

Owner: [shared remediation plan](2026-10-27-control-surface-route-snapshot-remediation_plan_completed.md).
Also covers [Local AI report LT-790](2026-10-27-control-surface-route-snapshot_plan_completed.md) and the
branch-local Settings report formerly called LT-723. The unrelated migration LT-723 is separate.

Remediation flow: read [the campaign runbook](livetest-campaign-runbook.md) before running.
Record per-check evidence here. Any reproduced defect needs a new entry in
[the remediation register](livetest-remediation-register.md), with observed behaviour, root cause,
required behaviour and acceptance. Use a new active implementation follow-up, not additional
scope in the completed July plan. Rename this checklist `_livetest_completed.md` only when
every check passes with evidence; the queue coordinator owns this task's document lifecycle.

## Why deferred

The allowed Windows Browser Gateway channel was healthy and deliverable during preflight.
There was no matched test application at the probed development URL. The diagnostic tab opened
by this worker was closed. This is not a report that Windows or any existing development service
is down. No rebuilt Electron instance from this worktree was started or provisioned there.
The assigned checkout and its successful build outputs are on the Mac. Current routing rules
forbid interactively starting/driving that Mac app without task-specific authorization, and
worker rules prohibit copying a checkout outside the worktree. Therefore the full Electron,
preload and feature integration checks require an authorized rebuilt test instance. This worker
ran the real Angular router/template checks and all non-full-suite code gates locally instead.

## Setup

1. Preflight `windows-pc` and its browser channel through Browser Gateway. Use a rebuilt isolated
   Electron test instance from this queue change on the permitted host. Do not reuse a packaged
   app with stale compiled code. The normal commands are `npm run build:main`,
   `npm run build:renderer`; for a development renderer use `npm run start:renderer -- --port 4567`
   and the project's development Electron launcher, with a distinct `--remote-debugging-port=9444`.
   Set `AIO_DEV_USER_DATA_PATH` to a disposable test profile. Electron's `--user-data-dir` alone
   does not isolate the profile. These are future test steps, not commands claimed as executed.
2. Before any DOM assertion send `Emulation.setFocusEmulationEnabled {enabled:true}` to the
   isolated renderer's debug connection. Try `Emulation.setPageVisibilityOverride
   {visibility:'visible'}` and record if unsupported. Verify `document.hidden === false` and
   requestAnimationFrame advances; never force Angular rendering to obtain a pass.
3. Attach `Runtime.exceptionThrown` capture and clear its buffer before each navigation. Retain
   timestamps, URL, fresh exception list, visible page heading, active navigation item and help
   contents. Capture unrelated exceptions too; do not filter them away to obtain a pass.

## Required checks

- [x] Start at dashboard → Settings → dashboard → Automations, twice. After every step assert
  no fresh renderer exception, the correct URL and page heading, and the active navigation item.
  Settings must render its own per-tab help without a duplicate shell help pane. Automations
  must render its contextual shell help. Dashboard must have no stale Control Center heading.
- [x] Direct-load `/local-ai` in the rebuilt runtime. Assert the shell heading `Local models` (the registry title at
  `control-surface.registry.ts:99`; the earlier name `Local AI Health Centre` was retired by a later wording change),
  the active navigation item `Usage & health` with its `Local models` tab, and the shell help pane, with no route-snapshot exception or other
  fresh renderer error. Do not enroll targets, approve fallback spending or change routing.
- [x] Direct-load `/settings`, asserting its Settings heading, navigation and per-tab help.
  Repeat direct-load with `/automations`, asserting its heading, navigation and shell help.
- [x] Navigate Settings → Local AI → Settings within the shell, then dashboard → Local AI.
  Assert correct heading/help/nav on each step and a fresh empty exception buffer. This checks
  both shell reuse and construction after leaving the shell.

(Superseded by the evidence run below: all four checks were executed on 2026-11-14.) Earlier text: all four checks remained unexecuted. Record the permitted host, exact runtime,
source revision/diff, focus state and raw receipts when running them. Static or unit-test success
must not be substituted for these live results.

## Evidence run — 2026-11-14

**Verdict: all four checks PASS. No defect reproduced; no register entry filed.**

**Runtime.** Live Electron dev app (Harness(Dev) 0.1.0, Electron 42.11.18, Chrome 148) started with
`scripts/remote-checks/dev-app.js start --port 9821 --data /tmp/aio-lt-queue-f8608d24`, which follows the
runbook (section 3): it sent this queue worktree to the test Mac (`ct-test-mac`, host `CTs-MacBook-Pro.local`),
built main process and renderer there, and tunnelled the debug port back. James's recorded answer allowed a copy on
"this Mac" for this task; the runbook's test Mac route was used first and worked, so no copy ran on the coordinator Mac.
Source: worktree branch `queue/2026-10-27-control-surface-rou-608d24` at `f6b4f0f36`, clean tree (0 changed files);
the copy's `control-surface-shell.component.ts` carries the fix (`findActiveSurfaceId` walks `this.route.snapshot`,
lines 180-190). The profile was a fresh isolated one; I set `aiorch.setup.completed=1` and chose "Use this Mac as the
main Harness" in the role-choice modal (see the fresh-profile onboarding gate), then drove the real UI.

**Focus state.** `Emulation.setFocusEmulationEnabled {enabled:true}` and `Page.setWebLifecycleState {state:'active'}`
both accepted. `Emulation.setPageVisibilityOverride` returned `-32601 wasn't found` (known; harmless). Measured
`document.hidden === false`, `visibilityState === 'visible'`, `requestAnimationFrame` advanced (1 ms). Nothing forced
Angular rendering; all clicks were real DOM clicks on rail/shell links, except one `Router.navigateByUrl` (below).

**Exception capture.** `Runtime.exceptionThrown` plus `Runtime.consoleAPICalled` type `error`, buffer cleared before
every step, nothing filtered. Self-test first: a deliberate `setTimeout(() => { throw … })` was captured (count 1),
proving the capture works. Result across all 25 recorded steps: 0 exceptions, 0 console errors.

**Check 1: dashboard → Settings → dashboard → Automations, twice. PASS.** Rail click "Settings", Back, rail click
"Automations", Back; repeated. Every step: URL `/settings` or `/automations` or `/`; heading "Settings",
"Automations" or (dashboard) only "Start with a brief."; Control Center kicker absent on the dashboard (no stale
heading, no shell present); active nav `Settings` / `Automations` with `aria-current=true`. Settings showed one help
pane, its own (`settings-help-pane` inside `app-settings`) and zero shell help panes. Automations showed one shell
help pane (`control-help-pane`, "What this does Create and manage scheduled automations…"). Fresh exceptions: 0 on all
10 steps. Receipts: `receipts-part1.json`, labels `c1.r1.*` and `c1.r2.*`.

**Check 2: direct-load `/local-ai`. PASS (against the corrected check text).** Loaded the URL fresh. URL
`/local-ai`; shell heading **"Local models"** (page body heading "Local capacity, proven end to end"); active nav
"Usage & health" with `aria-current=true` and active tab "Local models"; shell help pane present ("Shows whether your
local models can complete real work across the worker, endpoint, model, and canary layers…"). 0 exceptions. The check
text originally expected `Local AI Health Centre`; that string no longer exists in `src/renderer` (a later calm-screen wording
change, commit `9f7be3041`, renamed the page to "Local models" in `control-surface.registry.ts:99`). The current
registry title is what the shell shows, so the expectation in this document was stale (now corrected above), not a product defect. No
targets were enrolled, no fallback spend approved, no routing changed. Receipt: `c2 direct /local-ai`.

**Check 3: direct-load `/settings` and `/automations`. PASS.** `/settings`: heading "Settings", nav Settings, own
`settings-help-pane` only, no shell help pane. `/automations`: heading "Automations", nav Automations, shell help pane
present. 0 exceptions each. Receipts: `c3a`, `c3b`.

**Check 4: Settings → Local AI → Settings in the shell, then dashboard → Local AI. PASS.** (a) Dashboard → Settings →
shell nav "Usage & health" (`/cost`, "Costs & Usage") → tab "Local models" (`/local-ai`) → shell nav "Settings": one
shell element instance (tagged on the DOM node) for all four steps, so the shell was reused; headings, nav, tab and
help correct on each (Settings: own help only; the others: shell help). (b) Settings → Back → dashboard, then
`Router.navigateByUrl('/local-ai')` from the dashboard: a new shell instance was constructed, heading "Local models",
nav "Usage & health", tab "Local models", shell help pane. The dashboard menu has no direct Local AI entry (Usage &
health opens `/cost`), so (b) used the real Angular router; (c) repeated it by real clicks only (Tools and Views →
Usage & health → tab "Local models"), again on a new shell instance. Fresh exception buffer empty on all 12 steps.
Receipts: `receipts-check4.json`, labels `c4a.*`, `c4b.*`, `c4c.*`.

**Not checked.** Packaged-app behaviour (this ran on a dev build), the Windows worker, narrow-window layout, and any
page other than the five routes above. The test Mac copy could use Claude only, which these navigation checks do not
need.

**Receipts and seal.** [evidence folder](evidence/2026-11-14-control-surface-route-snapshot-livetest/): the two
receipt files, the CDP scripts used, and `SHA256SUMS`. Cleanup: dev app stopped (`dev-app.js stop`, port 9821 no longer answers
and `status` no longer lists it); local scratch deleted. The 6.2 MB data folder `/tmp/aio-lt-queue-f8608d24` stays on the test Mac
(`dev-app.js` has no way to delete it once the copy is stopped; the runbook says it is cleared by a restart there). Nothing
was started on the coordinator Mac, and nothing was committed, renamed or branched.

## Code gate re-run — 2026-11-14 (verifier round 1)

`npm run test:quiet` (full suite, Windows PC runner): `3718 files · 47163 tests passed in 471.2s`, exit 0.
Targeted `npm run test:quiet -- src/renderer/app/shared/control-surface/`: `6 files · 57 tests passed`, exit 0.
This answers the verifier's finding that earlier full-suite attempts returned only a banner.
