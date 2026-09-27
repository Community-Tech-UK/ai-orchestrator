# Enhancements Backlog — Live Test

## Final status — 2026-09-27

Open: 0 · Closed here: 17 · Transferred: 7 · Failed: 0

All 24 numbered checks are now accounted for. Check 15's LT-594 fix and check 16's LT-593
dependency were confirmed fixed live on 2026-09-24. Check 3 reproduced a real modal-focus defect;
LT-660 is fixed and regression-tested in the working tree, with the rebuilt-window re-check moved
to AR-006. Checks 17/18 and the reachable-current-contract half of check 24 are also in AR-006.
The duplicate Codex occupancy ladder in check 22 is folded into AR-001, and the explicitly paid
billing checks 20/21 are RES-025. No source check has been dropped or represented as live-passed
without evidence.

## Status — 2026-09-24 (loops batch)
Open: 6 · Closed: 18 · Partial: 3 (counted as open, unchanged) · Needs James: 2 (counted as open)

Re-checked the two defects filed from this doc against a rebuilt dev app (HEAD `f04f6748`):
**LT-593 CONFIRMED FIXED LIVE** (a real Claude Stop mid-turn now settles to `idle` with
`lastTurnOutcome: interrupted` and a system line reading "Interrupted — waiting for input"; the
session accepted and answered a follow-up message immediately afterward) and **LT-594 CONFIRMED
FIXED LIVE** (a real 1-iteration Claude loop run to `completed` kept `app-loop-causal-timeline`
mounted through the terminal phase, reading "Work done / Verify done / Independent review done /
Terminal decision done" and "Next without you: Nothing. The run has finished."). Full evidence:
[Evidence run — 2026-09-24 (loops batch)](#evidence-run--2026-09-24-loops-batch).

Checks 20/21 (billed-token comparisons) were not attempted this run — spend-decision/James-only,
per this campaign's brief. Checks 3, 17/18, 22, 24 are unchanged from 2026-09-21 (no code affecting
them shipped since; see that section below) and were not re-driven.

## Status — 2026-09-21
Open: 8 · Closed: 16 · Partial: 3 (counted as open) · Needs James: 2 (counted as open)

Driven against a real dev app on 2026-09-21 — see
[Evidence run — 2026-09-21](#evidence-run--2026-09-21-plan-queue-worker). 16 checks pass,
3 partially pass (3, 15, 24), 5 were not run (17, 18, 20, 21, 22). Two defects were reproduced
and filed: **LT-593** (P1 — Stop on a busy Claude session terminates it) and **LT-594** (P2 —
the loop causal timeline's terminal readings can never be rendered).

Residual, in the order it is worth clearing:

- **17, 18** — no clean fresh-eyes verdict is obtainable on this host (the `security` angle is
  assigned to antigravity, whose `agy` exits 1; pinning the pair to cursor+copilot got
  "Review cancelled" from both). Needs a working reviewer CLI, *and* the checks need rewriting
  around a completion attempt that does not terminate the run — see the evidence run for the
  exact branches that leave a cached verdict alive.
- **22** — Codex is quota-parked (a codex loop parked live with "auto-resumes in ≤132h 18m"), so
  no turn long enough to cross 70/75/80% occupancy can be started.
- **20, 21** — unchanged: operator approval plus a logged-in provider billing pane.
- **3** — focus lands in the terminate dialog but is not trapped; `aria-modal="true"` claims the
  background is inert while the third Tab reaches it. Needs a decision: add a focus trap, or
  amend the check.
- **15, 24** — partially verified; the unverified halves are LT-594 and an unreachable
  `permission_denial` prompt respectively.

The original 2026-09-08 note, still true of everything that had not been run:
nothing in this document had been run against a real app. Every code-level gate was green
(`tsc`, spec `tsc`, `lint`, `check:ts-max-loc`, `build:main`, `build:renderer`, and the full
suite at 22,438 tests / 2,025 files), but green gates are not the same as a surface behaving
in front of a person, and most of what this plan added is UI.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. A pending or unrun check is
> not automatically a defect, but a *reproduced* one belongs there, not only here.
> Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-03-enhancements-backlog_plan_completed.md](2026-09-03-enhancements-backlog_plan_completed.md)

**Prerequisites:** a rebuilt and restarted app (`npm run build`, or the dev app per
`devapp-without-ng-serve` — `ng serve` can die on a JIT/linker error, so prefer
build + `http-server` on 4567). At least one provider CLI installed. Several checks need a
*fresh profile* (the getting-started bar reads `localStorage`), so have a throwaway
`AIO_DEV_USER_DATA_PATH` ready — and note `dev-app-steals-chrome-native-manifest`: that
variable is machine-global, so isolate it rather than assuming it is scoped.

**Why these cannot run in-loop:** each one needs either a real Electron window (rendered
layout, focus, Escape handling), real `localStorage` persistence across an app restart, a
real IPC round trip to the main process, or a real multi-minute loop run. None of that is
reachable from Vitest with a wasm-mocked `better-sqlite3`.

---

## Open checks

### Terminate confirmation (Decision 16b)

**1. Terminating a session asks first.**
Start a session, then click the close/terminate control on its row.
*Expected:* a modal naming that specific session, saying the work is lost, with
"Keep running" as the default non-destructive way out. The session is still running behind it.
*Then:* confirm, and check the session actually terminates.

**2. Escape and backdrop dismiss without terminating.**
Open the same modal. Press Escape. Then reopen and click the backdrop *outside* the dialog box.
*Expected:* both dismiss, the session survives both times. Clicking *inside* the dialog
(on its padding, not a button) must NOT dismiss it — that is a distinct branch in
`onBackdropClick`.

**3. Focus lands in the dialog.**
Open the modal and, without touching the mouse, press Tab.
*Expected:* focus is already inside the dialog when it opens and stays trapped in it.
This is an `effect()`-driven focus call and is exactly the kind of thing that works in a
test and fails in a real window.

### Getting-started bar (UX5)

**4. Fresh install shows the checklist.**
Launch with a clean profile and no default working directory set.
*Expected:* the bar appears reading "0 of 3 done" (or 1 of 3 if a CLI is genuinely ready),
pending steps listed before done ones, each with its state in words ("To do" / "Done"),
not colour alone.

**5. It does not lie during startup.**
Watch the first second after launch on a fully configured install.
*Expected:* the bar never flashes "0 of 3". It stays hidden until the startup capability
report arrives. This is the check the whole surface's credibility rests on and it is
timing-dependent, so it cannot be proven by a unit test.

**6. Each action goes to the right place.**
Click each pending step's button.
*Expected:* "Check CLI health" → Settings, CLI health section, scrolled to it;
"Open settings" → Settings, General; "New session" → the dashboard.
Confirm the fragment actually scrolls the target into view rather than just changing the URL.

**7. Finishing the steps dismisses the bar, permanently.**
Complete all three, confirm the bar disappears, then **close the only session** and
**restart the app**.
*Expected:* the bar does not come back. This is the regression the persisted
`aio.getting-started.session-started` marker exists for — the earlier version read the live
instance count and reappeared telling you to start a session you had just finished.

**8. A zero-CLI machine is not told it is connected.**
On a machine (or PATH) with no provider CLI at all.
*Expected:* the "Connect a CLI" step reads To do. The shipped bug was that the probe marks
not-on-PATH providers `degraded`, and reading those instead of the `provider.any` aggregate
made this step permanently Done.

### Approval digest banner (N9)

**9. Pending approvals surface.**
Get a real session into a state with a pending permission approval.
*Expected:* the banner appears naming the count and the oldest waiting session, within the
30-second poll or immediately on window focus.

**10. It clears rather than lying.**
Resolve the approvals. Then, separately, break the bridge (run against a build where the
IPC handler is absent).
*Expected:* the banner clears in the first case, and in the second shows nothing at all
rather than a stale or zero count.

### Settings surfaces

**11. Search finds a setting on another tab and opens it.**
Use settings search for a key that lives behind the Advanced toggle on a different tab
(e.g. an `mcp` or `rtk` key — `CATEGORY_TAB` maps `mcp`→Advanced and `rtk`→RTK savings).
*Expected:* it switches tab, expands the Advanced group by clicking
`.settings-tiered-row-list__advanced-toggle`, and scrolls the row into view. That
click-through is a real DOM contract between two components and is the part most likely to
break silently.

**12. Health notices are honest.**
Trigger each of the five notices' conditions in turn.
*Expected:* each appears only when genuinely active, on its declared tab, and the message
describes the real state. Any notice that cannot be made to appear is a finding.

**13. Resetting a provider model override removes it.**
Set a per-provider model override, then reset it.
*Expected:* the key is *deleted* from the stored map, not written as `''`. Verify by
reading the setting back (`$AIO_MCP settings get`, per `settings-cli-write-boundary`) —
an empty string here is a defect, not a reset.

### Loop surfaces

**14. Presets apply to the real form.**
Open the loop config panel and apply each of the four presets.
*Expected:* every field the preset names visibly changes, and the preflight summary
underneath recomputes from the *live* values rather than the preset's own definition.
Change one field by hand afterwards and confirm the summary follows.

**15. The causal timeline explains a real run.**
Run a loop to completion, and separately park one on a provider limit.
*Expected:* the four steps read truthfully for each. Specifically, a `provider-limit` step
with no end time must say it resumes on its own — not that it is stuck.

**16. Queue park does not strand a message.**
Queue messages to a busy session, then cancel a queued message so the queue empties.
*Expected:* the park flag clears and the session drains normally afterwards. The original
bug was that self-heal lived only in `processMessageQueue`, which the real cancel path
never calls, so this must be driven through the actual cancel button.

### Loop completion reuse (Decision 15b) — the highest-value check here

**17. An unchanged tree reuses the previous review; a changed one does not.**
Run a loop with cross-model review enabled to a clean fresh-eyes verdict that does *not*
terminate the run. Then let it declare done again without touching the tree.
*Note:* this check was, until 2026-09-08, unrunnable as a real test on either of
James's machines — the anchor hashed the loop's own `ITERATION_LOG.md`, so the reuse
could never fire, and it would have looked fine here only because both workspaces already
gitignore `.aio-loop-state/`. Fixed; the check is now meaningful on a fresh workspace too.

*Expected:* the second attempt logs
`Fresh-eyes gate: instant ALLOW — clean verdict cached, no production changes since`
and emits `loop:fresh-eyes-review-passed` with `instantAllow: true`, in seconds rather than
minutes. **Then edit any file in the workspace from outside the app** (your editor, not the
agent) and let it declare done again.
*Expected:* a real cross-model review runs. This is the exact hole the fresh-eyes gate
caught — the observed per-attempt delta cannot see that edit, and only the workspace digest
does. It is worth doing by hand precisely because no test can prove the digest is computed
against the tree the user is actually editing.

**18. A park does not preserve a stale verdict.**
Get a loop into the state above (cached clean verdict), let it park on a provider limit or
pause it, edit the tree while it waits, then resume and let it declare done.
*Expected:* a real review runs. `resumeLoop()` now clears the cache; before this session it
did not, and this was reachable in the field on any provider-limit park.

### `server/` narrowing (Decision 18)

**19. Confirm the exclusion is unreachable in the Minecraft repo — then leave it alone.**
This check was originally written as "run a loop against the Minecraft repo and confirm the
server's own churn does not count as work". **That check cannot pass or fail as written**, and
the reason is worth recording rather than deleting.

In `~/work/Minecraft/one-more-floor`, `/server/` has been gitignored since 2026-05-11
(".gitignore:32 — Nothing inside server/ is intended to be tracked"). A git-rooted workspace
takes the `authoritativeRoot` branch in `discoverWorkspaceRepositories`, which sets
`workspaceBefore = null` and makes attempt observation git-only. So no `server/**` path can
reach `iteration.filesChanged` there at all, and the exclusion rule — narrowed or blanket —
never fires for that workspace. There is also no `server/src`; the plugin sources are
Gradle-layout at the repo root.

*What to actually check, once, cheaply:* run a loop in that repo while the server is running,
and confirm from the loop's iteration records that no `server/**` path ever appears in
`filesChanged`. That confirms the reasoning above rather than testing the rule.
*Expected:* zero `server/**` entries.
*If any appear:* the git-only assumption is wrong, this check becomes live again, and the
exclusion list needs re-checking against what actually showed up.

*The narrowing itself is covered by unit tests* (`loop-review-reuse-anchor.spec.ts`, both
directions), because it only matters for a monorepo with a **tracked** `server/` — which is
not a workspace we have. Do not defer that to a live check we cannot run.

### Billed uncached input (G42 / G43) — James-only

Moved here from `grok3_livetest.md` on 2026-09-08. Both gates need operator approval to spend billed provider tokens on a live Loop session. Do not guess numbers. Do not treat `rtk gain` % as billed input.

**20. Continuation card vs reanchor constitution (G42 / T50).**
AIO desktop, Loop panel, this repo. Review-driven, default recycle 0.85. Short throwaway goal so the constitution is the tax. Provider billing pane visible (uncached input per turn, not cache-read).
1. Start a same-session Claude or Codex persist. Note iter 0 uncached input (full constitution expected).
2. Let iter 1+ run on the same thread with no recycle. Note uncached input (continuation card expected; body should be hundreds of tokens, not thousands).
3. Repeat with Gemini (exec-per-message). Every iter should look like iter 0 (full constitution + RTK wrap).
*Expected:* Claude/Codex iter 2 uncached input << iter 0 (T8 card). Gemini iter 2 ≈ iter 0 (T11 / T48). If Claude iter 2 still pays ~iter-0 size, T8 is not firing — file a bug, do not shrink T50 first.

**21. Recycle 0.85 + 8/100k vs 0.6 (G43 / T58).**
Codex resume, review-driven, `resetAtUtilization: 0.85`. Short or reading-only goal.
1. Run ~20 iters. Record recycle count, rounds, uncached input.
2. Repeat with `resetAtUtilization: 0.60` on a fresh session.
3. Compare recycle churn vs uncached input. Ignore `rtk gain`.
*Expected:* 0.85 + ceiling recycles less often than 0.6. If 0.85 shows context-rot (repeated file reads, missed NOTES), prefer T47/T7 prune over dropping the threshold.

**22. Codex 70% steer / 80% interrupt / no mid-turn compact (T62 / L20).**
Rebuild, then a live Codex app-server session that reports occupancy.
1. During an active turn, watch occupancy cross 70% then 75% before the turn goes idle.
2. Let occupancy reach 80% on a later sample.
*Expected:* 70% issues `turn/steer` (synthesis, no new research). 75% while `turnPhase` is running does **not** start `thread/compact/start`. Compact may fire after the turn is idle. 80% interrupts, then compact, then same-thread continuation. The instance still receives the 80% context warning (Codex is not treated as self-managed).
*Why live:* occupancy, `turn/steer`, and compact RPCs need a real Codex app-server.

**23. Loop config / outstanding tooltips (UX21).**
Rebuild. Open Loop Mode config on a session that has at least one recent prompt.
1. Hover a truncated recall chip, the × on that chip, and Default.
2. Open Outstanding with an open item; hover Save / Resolve / Dismiss.
*Expected:* styled `[appTooltip]` (not a native browser title) after the icon delay. Recall chips use the slower overflow delay. Glyph × still has a hover hint, not only `aria-label`.
*Why live:* overlay timing and native-title suppression need a real pointer.

**24. Permission-scope write consequence is visible (UX28).**
Rebuild. Trigger a Claude `permission_denial` prompt (not YOLO).
*Expected:* a visible "Remember this decision" label next to the select. The sentence "Always writes an allow rule to ~/.claude/settings.json" is on the card without hovering. Hovering the select explains duration only.
*Why live:* layout of the inline hint vs the action row needs a real window.

---

## Deliberately not built (do not test for these)

- **A paged tour.** There is none. The "16) a" answer that appeared to request one was a
  mis-numbered answer to Decision 15; James confirmed on 2026-09-07 that no tour was asked for.
- **Per-class notification sounds (N10).** Blocked on Decision 8(d) assets; 8(a) chose one
  sound for everything.
- **Wave 7.** Deferred by answer 7(a).
- **Three UX5 hint predicates** that could not be measured honestly from existing state.

---

## Evidence run — 2026-09-21 (Plan Queue worker)

Run by the Plan Queue worker on branch `queue/2026-09-03-enhancements-backlo-451811`.

**Harness.** `npm run build:main` (exit 0) and `npx ng build --configuration development
--output-path dist/renderer-dev` (exit 0) from the worktree, served on `:14571` by `http-server`
with an SPA fallback (`-P "http://127.0.0.1:14571?"` — without it a reload of any client-side
route returns 404 and the renderer comes up blank, which silently invalidates any
"nothing rendered" observation). Dev app launched as
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-71451811 PORT=14571 npx electron . --remote-debugging-port=9577`.
`Emulation.setFocusEmulationEnabled` + `Emulation.setPageVisibilityOverride` were held open on a
dedicated CDP connection for the whole run (a small holder script kept in the run's disposable
`_scratch/` directory; later launches added `Emulation.setDeviceMetricsOverride` at 1400×1400,
because the loop config panel pushes the composer below a 900px viewport and clicks then land on
`workspace-shell` instead of the control). With the holder attached, `document.hidden` was `false`
and rAF fired throughout — every DOM assertion below is against a renderer that was actually
flushing.

Clicks, key presses and typing were real CDP input events (`Input.dispatchMouseEvent` /
`Input.dispatchKeyEvent`) hit-tested with `elementFromPoint` before dispatch. Where a synthetic
`.click()` was used it was only for setup — opening a panel, arming the loop toggle — never for
the behaviour under assertion.

A **second** dev app (`/tmp/aio-lt-queue-71451811-B`, port 9578) was launched with
`HOME=/tmp/aio-lt-q71-homeB` and a PATH containing only a private `node` symlink plus the system
directories, to get a genuinely zero-CLI machine for check 8.

Result: **16 of 24 checks pass, 3 partially pass, 5 were not run.** Two new defects were
reproduced and filed: **LT-593** (P1 — Stop on a busy Claude session terminates it) and **LT-594**
(P2 — the loop causal timeline's terminal readings are unreachable). Per-check detail below; the
status block at the top of this document has been updated to match.

### Check 1 — Terminating a session asks first · PASS

Created a real `claude` session (`cio363w1j`, "LT71 terminate probe", cwd `/tmp/aio-lt-q71-ws`)
and clicked the row's `.action-btn.terminate` (`aria-label` "Close session — stops the agent and
moves this thread to history").

```
overlayPresent: true          role: "dialog"      aria-modal: "true"
title:      "Close LT71 terminate probe?"
body:       "This stops the agent and closes the session. Any work it has not written to disk is lost.
             The conversation is kept in history."
actions:    [".btn-cancel" → "Keep running", ".btn-confirm danger" → "Close session"]
listInstances(): [{ id: "cio363w1j", status: "idle" }]     ← still running behind the modal
```

The modal names that specific session, states the loss, and offers "Keep running" as the
non-destructive way out. Confirming (real mouse click on `.btn-confirm` at 837,488) then gave
`overlayPresent: false` and `listInstances(): []` — the session really terminated.

### Check 2 — Escape and backdrop dismiss without terminating · PASS

All three branches driven separately against the same session, with `listInstances()` read after
each:

| Action | Overlay after | Session after |
| --- | --- | --- |
| Real `Escape` key (`Input.dispatchKeyEvent`) | gone | `[{id:"cio363w1j", status:"idle"}]` |
| Real click at (502,387) — inside `.confirm-dialog`, on its padding, `elementFromPoint` = `confirm-dialog` | **still open** | unchanged |
| Real click at (40,40) — `elementFromPoint` = `confirm-overlay` | gone | `[{id:"cio363w1j", status:"idle"}]` |

The distinct `onBackdropClick` branch (`event.target !== event.currentTarget`) behaves as
documented. Escape worked even with focus outside the dialog, which is the `document:keydown`
listener doing its job.

### Check 3 — Focus lands in the dialog · PARTIAL — focus lands, but is NOT trapped

Focus placement passes: immediately after the modal opened, `document.activeElement.className`
was `confirm-dialog` without touching the mouse.

Focus **containment** fails. Five real `Tab` presses from that state:

| Tab | `document.activeElement` | inside `.confirm-dialog`? |
| --- | --- | --- |
| 1 | `button.btn-cancel` ("Keep running") | yes |
| 2 | `button.btn-confirm danger` ("Close session") | yes |
| 3 | `a.rail-btn` (app shell behind the modal) | **no** |
| 4 | `a.rail-btn` | no |
| 5 | `a.rail-btn` | no |

The overlay carries `aria-modal="true"`, which tells assistive technology the rest of the page is
inert, while a keyboard user reaches it on the third Tab. The component has no focus trap and
nothing sets `inert`/`aria-hidden` on the background.

Not filed as an LT item: the check's own wording ("focus is already inside the dialog when it
opens **and stays trapped in it**") is the only place this containment requirement is stated, and
the component's own documentation only claims the dialog "takes focus when it opens". This is a
scope question for James rather than a regression against an agreed contract — **the modal
behaves as its code intends and not as this check asks.** Recorded here so the decision is
visible; it needs either a focus trap or an amended check.

### Check 4 — Fresh install shows the checklist · PASS

Clean profile `/tmp/aio-lt-queue-71451811`, no `defaultWorkingDirectory`:

```
aside.getting-started   role="status"  aria-label="Getting started"
counter: "1 of 3 done"
1. data-done=false  "To do"  "Pick a default working directory"  [Open settings]     (working-directory)
2. data-done=false  "To do"  "Start a session"                   [New session]       (first-session)
3. data-done=true   "Done"   "Connect a CLI"                     (no button)         (provider-available)
localStorage["aio.getting-started.session-started"]: null
```

Pending steps precede the done one, each carries its state as a word (`To do` / `Done`) in
`.getting-started__state`, not colour alone. "1 of 3" is the documented outcome for a machine
where a CLI is genuinely ready — `provider.any` was `ready` on this host.

### Check 5 — It does not lie during startup · PASS

Measured on a genuine cold start of the fully-configured profile (all three steps complete). A
sampler was injected into the served `index.html` itself so it runs from the first byte of the
document — before Angular bootstraps — recording every change of state from `requestAnimationFrame`,
a 4 ms interval, and a `MutationObserver` on `documentElement`:

```
{"samples":[{"t":3,"state":"HIDDEN"}], "href":"http://localhost:14571/", "bodyLen":684, "final":null}
```

One state for the whole startup: hidden. The bar never appeared at all, so it never flashed
"0 of 3".

**Control for the same sampler**, cold start of the zero-CLI profile where the bar *should*
appear:

```
{"samples":[{"t":3,"state":"HIDDEN"},{"t":70,"state":"0 of 3 done"}], "bodyLen":968, "final":"0 of 3 done"}
```

so the negative result above is a real negative, not a dead sampler. Note the 3 ms → 70 ms window
in the control is the `reportArrived` guard holding the bar hidden until the startup capability
report lands; it renders the correct counter directly, with no wrong intermediate value.

### Check 6 — Each action goes to the right place · PASS

Driven on the zero-CLI profile, where all three steps are pending and therefore all three buttons
exist. Real mouse clicks:

| Button | URL after | Active nav item | Panel rendered |
| --- | --- | --- | --- |
| "Check CLI health" | `/settings#cli-health` | `CLI Health` | `app-cli-health-settings-tab` ("AI CLI health…") |
| "Open settings" | `/settings#general` | `General` | `app-general-settings-tab` ("Default provider and model…") |
| "New session" | `/` | — | `app-dashboard` |

On the "scrolls the target into view" clause: these fragments are **tab ids**, not scroll anchors.
`SettingsComponent` subscribes to `route.fragment` and calls `activeTab.set(fragment)` when
`isSettingsTab(fragment)` (`settings.component.ts:427-431`); there is no element with
`id="cli-health"` to scroll to. The equivalent assertion — the right panel is actually rendered
and its nav item is active — holds for both settings routes. No defect; the check's wording
predates the tab-fragment design.

### Check 7 — Finishing the steps dismisses the bar, permanently · PASS

1. Starting a session flipped the marker: `localStorage["aio.getting-started.session-started"] = "1"`,
   counter `"2 of 3 done"`.
2. Setting `defaultWorkingDirectory` to `/tmp/aio-lt-q71-ws` completed the third step —
   `aside.getting-started` left the DOM entirely (`barPresent: false`).
3. Terminated the only session through the confirm modal (`listInstances(): []`).
4. Quit and cold-restarted the Electron app on the same profile.

After the restart: `barPresent: false`, `instanceCount: 0`, marker still `"1"`. The bar did not
come back to ask for a session that had just been finished and closed.

### Check 8 — A zero-CLI machine is not told it is connected · PASS

A stripped `PATH` alone is not enough to simulate this: `buildCliSpawnOptions`
(`src/main/cli/cli-environment.ts:199-211`) deliberately appends `$HOME/.nvm/...`,
`$HOME/.local/bin`, `$HOME/.npm-global/bin`, `$HOME/.grok/bin`, `/usr/local/bin`,
`/opt/homebrew/bin` regardless of the process PATH, so the first attempt still found every CLI
(`provider.any: ready`). Re-run with `HOME=/tmp/aio-lt-q71-homeB` as well as the stripped PATH,
having confirmed `/usr/local/bin` and `/opt/homebrew/bin` hold none of `claude`, `codex`,
`copilot`, `cursor-agent`, `agy`, `grok`:

```
provider.any          unavailable
provider.claude       degraded      provider.codex   degraded
provider.antigravity  degraded      provider.copilot degraded
provider.cursor       degraded
```

and the bar read:

```
counter: "0 of 3 done"
1. data-done=false  "To do"  "Connect a CLI"  [Check CLI health]   (provider-available)
2. data-done=false  "To do"  "Pick a default working directory"
3. data-done=false  "To do"  "Start a session"
```

Five `degraded` providers and the step still reads **To do** — the shipped bug (reading the
per-provider statuses instead of the `provider.any` aggregate) is fixed.

### Check 9 — Pending approvals surface · PASS

The digest reads `DurableApprovalStore.listPending()`, and a Claude `deferred_permission` does not
write a row there — the two `create()` call sites are the adjudicator's audit record (created and
immediately resolved, so never pending) and `PrCreationService`'s `pr_create` gate
(`pr-creation-service.ts:391-405`). So a real pending row was produced through that gate:
`allowPrCreation` was opted in for `/tmp/aio-lt-q71-loop` and `vcsCreatePullRequest` was invoked for
a branch that does not exist. **No pull request could result:** the approval row is written *before*
`askApproval`, and `execute()` runs `gh auth status` and `branchExists` before any push — and the
approval was never granted.

(Worth recording for the next run: `askApproval` is `dialog.showMessageBox`, a native modal on the
main process. On a CDP-driven dev app whose window is not visible that modal blocks the main thread
and `/json/list` stops answering, so the app has to be killed. The approval row survives in
`rlm.db`, which is what made the rest of this check possible.)

With that row pending, on a fresh app start:

```json
{"success":true,"data":{"digest":{
  "instances":1,"approvals":1,"oldestAgeMs":492553,
  "oldestInstanceId":"c4u1331yt",
  "title":"Sessions are waiting for approval",
  "body":"1 session is blocked on 1 approval. The oldest has been waiting 8 minutes."}}}
```

and the banner rendered immediately on load (`ngOnInit`'s refresh, well inside the 30 s poll):

```html
<aside class="approval-digest" role="status" aria-live="polite">
  <span class="approval-digest__text">1 session is blocked on 1 approval. The oldest has been waiting 8 minutes.</span>
  <button class="approval-digest__go">Show the oldest</button>
</aside>
```

It names the count, the number of blocked sessions, how long the oldest has waited, and carries the
oldest session's id for the jump button.

### Check 10 — It clears rather than lying · PASS (both halves)

**Resolved.** The pending row was resolved the way `DurableApprovalStore.resolve()` does it
(`status='approved', resolved_at, resolved_by='user'` — applied directly to
`/tmp/aio-lt-queue-71451811/rlm/rlm.db` with the app stopped, since no IPC exposes that write). On
restart: `{"success":true,"data":{"digest":null}}` and `aside.approval-digest` absent.

**Bridge broken.** The row was set back to `pending`, then the digest's `ipcMain.handle`
registration was temporarily gated behind an env flag, `npm run build:main` re-run, and the app
launched twice from the same build:

| Launch | `permissionGetApprovalDigest()` | Banner |
| --- | --- | --- |
| handler present (control) | `{"success":true,"data":{"digest":{…"1 session is blocked on 1 approval. The oldest has been waiting 11 minutes."}}}` | present, with that text |
| `AIO_LT71_DROP_DIGEST_HANDLER=1` | rejects: `Error invoking remote method 'permission:get-approval-digest': No handler registered for 'permission:get-approval-digest'` | **absent** |

In the broken-bridge run, with a genuinely pending approval still in the store and after a forced
`window:focus` refresh, `document.querySelector('aside.approval-digest')` was `null`, and the page
text contained neither "blocked on" nor any "0 session"/"0 approval" string. Nothing at all, rather
than a stale or zero count.

The temporary source gate was reverted (`git checkout --` then byte-compared against a copy taken
before the patch: identical; `git status --short` clean for that file) and `npm run build:main`
re-run from the reverted source, with `grep -c AIO_LT71_DROP_DIGEST_HANDLER dist/main/…` returning
`0`.

### Check 11 — Search finds a setting on another tab and opens it · PASS

First attempt used `broadRootFileThreshold` and proved the tab switch but not the disclosure
click-through: the Advanced tab renders that row outside any `app-settings-tiered-row-list`, so no
toggle was involved. Re-run against a key that really is behind one — `crossModelReviewTimeout`
("Reviewer timeout (seconds)"), `category: 'review'` → Review tab, `type: 'number'` → advanced
tier (`settingTier`, `settings-tiering.ts:37-40`).

From `/settings#general`, typed `Reviewer timeout` into `input.search-input` with real key events.
The jump affordance appeared reading `Jump to "Reviewer timeout (seconds)"`; the target row was
absent from the DOM at that point. Real click on `button.search-jump`, then sampled every 200 ms
for 2 s:

```
t=0 … t=1800  href: "http://localhost:14571/settings#review"
              app-review-settings-tab rendered
              .settings-tiered-row-list__advanced-toggle  aria-expanded: "true"   ← was "false"
              [data-setting-key="crossModelReviewTimeout"] present, top 547 of a 900px viewport, inViewport: true
              .settings-search-landing present t=0…1400, gone by t=1600 (SEARCH_LANDING_MS = 1800)
```

Tab switch, disclosure click-through, scroll-into-view and the landing pulse all real.

### Check 12 — Health notices are honest · PASS (all five)

Each notice's condition was set and then unset through `electronAPI.setSetting`, reading
`.settings-health-notice[data-notice-id]` on the notice's declared tab. All settings were restored
afterwards (verified by re-reading them).

| Notice | Tab | Inactive state | Active state |
| --- | --- | --- | --- |
| `quiet-hours-configured-while-disabled` | general | quiet hours off at the shipped 22/7 window → no notice | start 23 / end 6 with quiet hours off → `Note` · "Quiet hours are set to 23:00–6:00 but quiet hours are switched off…" |
| `cross-model-review-local-no-selector` | review | local review off → no notice | local review on, selector `''` → `Check this` · "Local cross-model review is enabled but no local model is selected…"; setting a selector cleared it |
| `remote-nodes-no-tls-open-bind` | remote-nodes | remote nodes off → no notice | enabled + no TLS + host `0.0.0.0` → `Check this` · "…enrolment tokens and node traffic cross the network unencrypted…"; rebinding to `127.0.0.1` cleared it |
| `auxiliary-local-first-no-endpoints` | auxiliary-models | `cheap-first` and `off` → no notice | `local-first` + Ollama off + `[]` endpoints → `Check this` · "Routing prefers local models, but no local endpoint is configured…"; adding an endpoint cleared it |
| `loop-uses-its-own-context-threshold` | memory | — (active by design) | `Note` · "Loop Mode does not use this threshold. It recycles its own context at 85% utilisation… independently of the 80% warning here." Absent on the display tab, so the per-tab routing holds. |

One false alarm during this check was mine, not the product's: `auxiliaryLlmRoutingMode` was first
set to `'cloud-first'`, which is not in the union (`'off' | 'local-first' | 'cheap-first' |
'manual-only'`), so the write was rejected and the notice correctly stayed up. Re-run with valid
values behaved exactly as specified.

### Check 13 — Resetting a provider model override removes it · PASS

Driven end to end through the real UI on the Orchestration tab
(`loopModelByProvider`, `app-provider-model-override` for Grok):

1. Starting map: `{codex, claude, gemini, grok}`. Real click on "Use default" →
   `{"codex":"gpt-5.6-terra","claude":"sonnet","gemini":"gemini-3-flash-preview"}`,
   `hasOwnProperty('grok') === false`, widget label flipped to "Session default" and the reset
   button became disabled.
2. Re-pinned through the real picker (opened `app-compact-model-picker`, clicked "Grok 4.6" in the
   `cdk-overlay-pane`) → `"grok":"grok-4.6"`, typeof `string`.
3. Real click on "Use default" again → key absent once more.

Verified at both layers each time: the store's `getSettings()` map, and `/tmp/aio-lt-queue-71451811/settings.json`
on disk. At no point did the key exist with an empty-string value. (`$AIO_MCP settings get` was
deliberately not used — it talks to the packaged app and James's real profile, not this dev
profile; the on-disk read is the equivalent for an isolated profile.)

### Check 14 — Presets apply to the real form · PASS

Loop config panel opened on a real session, advanced group expanded. Each preset applied with a
real mouse click on its `.loop-presets__choice`, then every preset-owned field read back from its
actual DOM control:

| Field | safe-implementation | investigate | plan-only | review-until-clean |
| --- | --- | --- | --- | --- |
| `#loop-cfg-cap-iter` | 50 | 15 | 10 | 100 |
| `#loop-cfg-cap-cost` | 20 | 5 | 5 | 40 |
| `#loop-cfg-mode` | review-driven | review-driven | **gated** | review-driven |
| `#loop-cfg-clean-passes` | 2 | 1 | (control hidden in gated mode) | 3 |
| `#loop-cfg-stage` | (hidden) | (hidden) | **PLAN** | (hidden) |
| `#loop-cfg-managed-isolation` | true | true | true | true |
| "Operator-reviewed completion" | false | false | **true** | false |
| "Ask another model to review" | true | false | false | true |
| "Allow destructive ops" | false | false | false | false |
| `.loop-presets__contract` | preset prose | preset prose | preset prose | preset prose |
| `aria-pressed` | on that preset | on that preset | on that preset | on that preset |

Every value matches `LOOP_PRESETS`. Two controls are conditionally rendered and that is by
design, not a miss: `#loop-cfg-stage` only exists under `showGatedChrome()` and
`#loop-cfg-clean-passes` only under review-driven mode.

The summary genuinely recomputes from live values. With `investigate` applied and nothing
overridden the contract was the preset's own prose; ticking "Allow destructive ops" by hand
changed it to:

> Starts by **reviewing**, working in its own isolated checkout. **It is allowed to run destructive
> commands.** It finishes when its own review returns 1 consecutive clean pass. It stops after 15
> iterations or $5, whichever comes first.

— the exact case the design note says the canned prose got wrong. The drawer read
`1 change from this preset` and listed `Allow destructive commands off → on`. "Starts by
reviewing" also confirms the hidden `initialStage: 'REVIEW'` really was applied by the preset.

### Check 15 — The causal timeline explains a real run · PARTIAL — the parked reading is right, the completed reading is unreachable (LT-594)

**Provider-limit park — PASS, and on a genuine limit.** A codex loop started in `/tmp/aio-lt-q71-loop`
parked immediately on the real Codex weekly quota ("Provider limit — auto-resumes in ≤132h 18m").
The timeline read:

```html
<li class="loop-timeline__step" data-state="blocked" data-step-id="work">
  <span class="loop-timeline__step-label">Work</span>
  <span class="loop-timeline__step-state">blocked</span>
  <span class="loop-timeline__step-detail">The provider signalled a usage limit, so the run parked
    instead of paying overage.</span></li>
<li … data-state="pending" data-step-id="verify">Verify · not started</li>
<li … data-state="pending" data-step-id="review">Independent review · not started</li>
<li … data-state="pending" data-step-id="decision">Terminal decision · not started</li>
```

with **"Next without you: It resumes on its own once the provider window reopens."** and the
recovery "Switch provider — Wait for the window to reopen, or move the run to another provider.",
spend meter `$0.00 estimated`, announcement "Blocked at Work. …". That is exactly what this check
singles out: a `provider-limit` step with no end time says it resumes on its own, not that it is
stuck.

**Run to completion — FAIL.** A real Claude loop was run to `completed` (1 iteration, 26 s) with a
page-level sampler recording every distinct timeline state every 400 ms. It captured exactly one
frame — `work:active, verify:pending, review:pending, decision:pending`, "It continues to the next
iteration." — and then `document.querySelector('app-loop-causal-timeline')` returned `null` for the
whole terminal phase.

That is not a sampling miss. `LoopStore.applyState`'s terminal branch
(`loop.store.ts:649-678`) calls `clearActive(state.chatId)` and never re-upserts, so
`LoopControlComponent.active()` is `undefined` from that instant and the `@if (active(); as a)`
block at `loop-control.component.html:62` — the only mount of `<app-loop-causal-timeline>` in the
codebase — stops rendering. `isTerminalLoopStatusPayload` covers every status in the timeline's own
`TERMINAL_STATUSES`, so none of the finished-run readings can ever be shown, including the wired
`cap-reached` / `cost-exceeded` "Raise the cap and continue" recovery. Filed as **LT-594**.

### Check 16 — Queue park does not strand a message · PASS (on codex; blocked on claude by LT-593)

The first two attempts on a **claude** session never reached a parked queue, because Stop
terminated the session instead — reproduced twice and filed as **LT-593** (see "Defects filed from
this run" below). The check was then driven on a **codex** session, which is the same
renderer-owned queue/park code path.

1. Long generation in flight (`status: 'busy'`), messages queued behind it — `.queue-badge` read
   `1`, then `2` after a second send while the turn was still running.
2. Real click on `.btn-interrupt`. Session survived at `status: 'idle'`; queue parked:
   `.queue-parked` present reading *"Sending paused — queued messages will not send until you
   resume."*, two messages listed, `Resume` button offered.
3. Cancelled the queued messages **one at a time** with the real `.queued-cancel-btn` × buttons —
   never pressing Resume. After the first: badge 1, still parked. After the second: queue section
   gone.
4. Queued a fresh message behind a new long turn and let it run out. It drained normally:

```
user      "Write a 1500-word essay on the history of the magnetic compass…"
assistant "The magnetic compass is one of the most consequential instruments…"
user      "QUEUED-C: reply with the single word CEE and nothing else"
assistant "CEE"
```

No park banner reappeared and nothing was stranded, which is the B7 self-heal in
`removeFromQueue` working through the real cancel path (the path `processMessageQueue` never sees).

### Checks 17 and 18 — Loop completion reuse (Decision 15b) · NOT RUN — precondition unreachable here

Both checks start from "a clean fresh-eyes verdict". Three real loop runs were driven in
`/tmp/aio-lt-q71-loop` with cross-model review enabled, listening on
`onLoopFreshEyesReviewStarted/Passed/Blocked/Failed`. **No run produced a clean verdict**, so
`state.freshEyesCleanForWorkState` was never set and the instant-ALLOW branch
(`loop-coordinator-completion-gates.ts:361-385`) was never reachable. `grep -c "instant ALLOW"` over
`app.log` for the whole session: `0`.

What the reviewer actually returned, verbatim from the emitted events:

| Run | Reviewer config | `loop:fresh-eyes-review-*` |
| --- | --- | --- |
| `loop-1789949026857-3cb6db3a` | default `['cursor','antigravity','codex']` | `failed` — "required reviewer/angle coverage was incomplete this attempt (security:failed)"; coverage `correctness/cursor:used`, `security/antigravity:failed — agy exited with code 1`, `local-advisory:skipped` |
| `loop-1789949653517-ddf06a40` | same | identical `security:failed`, same `agy exited with code 1` |
| `loop-1789950038839-5fad450b` | pinned to `['cursor','copilot']` to route around antigravity | `failed` — "cursor: Review cancelled; copilot: Review cancelled"; both required angles `failed` |

`runFreshEyesReviewGate` treats incomplete required coverage as `errored`, not clean
(`loop-coordinator-completion-gates.ts:535-550`, logged as *"Fresh-eyes review: required
reviewer/angle coverage was incomplete - treating as unavailable, not a clean pass"*), which is the
correct fail-closed behaviour — it simply means the precondition cannot be met on this host while
`agy` exits 1 and the pinned pair cancels.

Two further things are worth recording rather than losing:

1. **Even with a healthy reviewer, check 17 as written needs a completion attempt that does not
   terminate the run, and the ordinary paths do not offer one.** In review-driven mode the gate is
   called once, at `consecutiveCleanReviewPasses >= required`, and a non-blocked result falls
   straight through to `status: 'completed'` (`loop-coordinator-completion-gates.ts:194-212`). In
   gated mode a clean fresh-eyes result reaches `decision: 'stop'`
   (`evidence-resolver.ts:536-540`). The only branches that leave a cached clean verdict alive for a
   *second* attempt are `finalAuditMode: 'gate'` with a failing audit
   (`evidence-resolver.ts:511-522`, which returns `decision: 'continue'` after the gate has already
   cached) and an operator pause/park. Reproducing the check therefore needs a run engineered into
   one of those branches; that is worth writing into the check itself.
2. `resumeLoop()` does clear the cache — `clearFreshEyesReuseCache(state)` at
   `loop-coordinator.ts:1422`, which is check 18's fix. Verified by reading the executing path only;
   **not** verified live, because the cache could never be populated.

These are technical prerequisites (a reviewer CLI that works on this machine, plus a run shaped to
attempt completion twice), not a James action.

### Check 19 — `server/` exclusion is unreachable in the Minecraft repo · PASS (verified with the real observer, no loop run)

The loop run the check describes was **not** performed: the Minecraft server is not running (last
`server/logs/latest.log` write 2026-09-20 00:12, no Paper/Spigot JVM in `ps`), and
`~/work/Minecraft/one-more-floor` currently carries 515 uncommitted working-tree entries of James's
own work, which is not a tree to turn an agent loose in for a check whose own text says it "cannot
pass or fail as written".

Instead the **real observation code** was run directly against that repo
(`_scratch/lt-queue-71451811/check19-probe.ts`, under `ELECTRON_RUN_AS_NODE=1 npx electron tsx`),
which is a stronger test of the same claim:

```
discovery: { "authoritativeRoot": true, "coverage": "complete",
             "roots": ["/Users/suas/work/Minecraft/one-more-floor"], "reason": null }
wrote probe files: [ 'server/_lt71-probe.tmp', 'server/logs/_lt71-probe.log', 'server/world/_lt71-probe.dat' ]
observation: { "coverage": "complete", "sources": ["workspace-git"], "reason": null,
               "totalChanges": 0, "serverPathCount": 0, "serverPaths": [], "firstTenChanges": [] }
removed probe files; still present: []
```

`authoritativeRoot: true` is the branch the check's reasoning depends on: it makes
`workspaceBefore = null` in `createAttemptDeltaObserver`
(`loop-attempt-observation.ts:77-83`), so observation is git-only (`sources: ["workspace-git"]`).
Three files were then written under `server/`, `server/logs/` and `server/world/` — exactly the
churn a running server produces — and the real observer reported **zero** changes and **zero**
`server/**` paths. All three probe files were removed afterwards and verified gone; they were
inside `/server/`, which `.gitignore:32` ignores (`git check-ignore -v` confirms for the directory,
a log file and a world file), and `git ls-files server` is empty, so git never saw them either.

Expected result — zero `server/**` entries — confirmed. The exclusion rule cannot fire for that
workspace, exactly as the check's reasoning says.

### Checks 20 and 21 — Billed uncached input (G42 / G43) · NEEDS JAMES

Unchanged from the doc's own framing, and now with a live blocker on top of it:

- Both gates require reading the **provider billing pane** (uncached input per turn, not cache-read)
  while a loop runs. That is a logged-in provider console — an operator/credential boundary — and
  the doc explicitly reserves the spend decision for James.
- Check 21 additionally needs ~20 Codex iterations twice, and Codex is quota-parked: a codex loop
  started during this run parked immediately with *"Provider limit — auto-resumes in ≤132h 18m"*.

### Check 22 — Codex 70% steer / 80% interrupt / no mid-turn compact (T62 / L20) · NOT RUN — external blocker

Needs a live Codex app-server session that reports occupancy crossing 70%, 75% and 80%. The Codex
weekly quota is exhausted (same ≤132h park as above, observed live at 2026-09-21 01:0x), so no
Codex turn long enough to accumulate occupancy can be started. Technical/external prerequisite, not
a James action.

### Check 23 — Loop config / outstanding tooltips (UX21) · PASS

Driven with real `Input.dispatchMouseEvent` pointer moves (park at 5,5 → move onto the target →
dwell), asserting on the same CDP connection so the pointer was still over the control.

**Recall chips.** Recall history for `/tmp/aio-lt-q71-loop` was seeded into
`localStorage['loop:recent-prompts:oq9nd5']` (the service's own FNV-1a bucket for that workspace)
and the app restarted so the service loaded it for real; the chips, their ×, and Default are all
rendered by the real template with real `[appTooltip]` directives.

| Target | Dwell | Result |
| --- | --- | --- |
| Truncated recall chip (`appTooltipVariant="overflow"`) | 350 ms | **no tooltip** — correct, the overflow dwell is 600 ms |
| Same chip | 900 ms | `app-aio-tooltip-panel` present, `class="aio-tooltip"`, `role="tooltip"`, text = the full untruncated entry |
| The chip's `×` glyph | 600 ms | "Removes this prompt from the recent list." — a real hover hint, not only `aria-label="Remove from recent"` |
| `Default` | 600 ms | "Fills the prompt with the canonical default directive." |

`document.querySelectorAll('.recall-row [title]').length === 0` throughout — no native browser
titles anywhere in that row.

**Outstanding.** No real outstanding item existed (all four loop runs reported none, and
`loopListOutstanding` returned `{items: []}`), and `hasOutstanding()` gates the toggle, so one open
`open-question` item was seeded into `LoopStore`'s `outstandingItems` signal in the panel's own
`chatId` + `workspaceCwd` scope. Everything below is the real component, real template and real
tooltip directive over that item.

| Target | Dwell | Tooltip |
| --- | --- | --- |
| `Save answer` (disabled, no draft typed) | 600 ms | "Saves your answer. The item stays open until you resolve or dismiss it." |
| `Answered` (the `o-resolve` action for an `open-question`) | 600 ms | "Saves the answer if any, then marks the question answered." |
| `Dismiss` | 600 ms | "Sets the item aside. It is not going to be done." |

All three are `class="aio-tooltip"` `role="tooltip"` overlays. The panel carries exactly one native
`title` — `<span class="o-time" title="21/09/2026, 01:41:15">1s ago</span>`, the full timestamp
behind a relative time, which is not one of the controls this check names.

### Check 24 — Permission-scope write consequence is visible (UX28) · PARTIAL — two of three clauses verified

A real non-YOLO Claude session was driven into a permission prompt (`uname -a` via the Bash tool).

**Verified:**

- The `Remember this decision` label is rendered as a visible `<label class="scope-label">` beside
  the select (not only as the select's accessible name), with options `Once / Session / Always`.
- Hovering the select for 600 ms gives the styled tooltip *"How long this allow or deny is
  remembered: once, this session, or always."* — duration only, with no mention of writing to
  settings.

**Not verified — the write-hint sentence.** `<span class="scope-write-hint">Always writes an allow
rule to ~/.claude/settings.json</span>` is gated on `isPermissionDenial(request)`, i.e.
`permissionMetadata.type === 'permission_denial'`
(`user-action-request.component.html:258-260`, `user-action-request.component.ts:375-377`). The
prompt AIO's non-YOLO flow actually raises is `deferred_permission`, so the sentence is correctly
absent there.

An attempt to force the other type by adding a **project-local** deny rule in the throwaway
workspace (`/tmp/aio-lt-q71-ws/.claude/settings.json` → `{"permissions":{"deny":["Bash(uname:*)"]}}`
— James's own `~/.claude/settings.json` was not touched) made the Claude CLI refuse the call, but
produced no prompt at all. `app.log` shows why:

```
[APPROVAL_TRACE] tool_result_error_received
  contentPreview: "Permission to use Bash with command uname -a has been denied."
  isPermissionDenial: false
```

None of the seventeen substrings in `isPermissionDenialContent`
(`claude-cli-permission-details.ts:37-54`) nor its `claude requested permission…` regex matches that
wording, so no `permission_denial` request is emitted and the model simply narrates the refusal.
The deny rule was removed afterwards.

Whether an explicit `deny` rule *should* raise a prompt offering "Always" is a product question
(offering to override a rule the user deliberately wrote is arguably wrong), so this is recorded as
an observation rather than filed as a defect. It does mean the third clause of this check has no
reachable path today and needs either a known way to produce `permission_denial` or an amended
check.

### Defects filed from this run

**LT-593 (P1) — Stop on a busy Claude session terminates it instead of interrupting it.**
Reproduced 2/2. A real mouse click on `.btn-interrupt` while a Claude turn was running produced
`Interrupt requested: unresolved`, then `Your message was restored to the input — restart the
instance to send it.`, status `terminated`, queue cleared. `app.log` for `clw1in6rd` shows
`Interrupt requested` → `Interrupt settled in place via adapter status; disarming force-abort net`
→ `Adapter exit event code 0` → `Suppressing auto-respawn: owner flow is probing native resume` →
`Instance exited unexpectedly newStatus terminated`, with the identical five lines for `i3xzmut31`.
Root cause traced: `noteInterruptSettled()` clears the interrupt bookkeeping but leaves
`autoRespawnSuppressedUntil` set, and the LT-023 deferred-retry branch cannot fire for a
suppression-blocked exit because `wouldAutoRespawnIfNotRecent` includes `!autoRespawnSuppressed`.
Codex behaves correctly through the same UI. Full write-up in
`docs/plans/livetest-remediation-register.md` under `## LT-593`.

**LT-594 (P2) — the loop causal timeline's terminal readings are unreachable.** See check 15.
Full write-up under `## LT-594` in the same register.

### Cleanup

- Every setting changed during the run was restored and re-read to confirm:
  `crossModelReviewProviders`, `auxiliaryLlm*`, `remoteNodes*`, `crossModelReviewLocal*`,
  `notificationQuietHours*`, `loopModelByProvider`. (All of them live in the disposable dev profile,
  not in James's.)
- The temporary project-local `deny` rule at `/tmp/aio-lt-q71-ws/.claude/settings.json` was deleted.
  James's `~/.claude/settings.json` was never touched.
- The three check-19 probe files under `~/work/Minecraft/one-more-floor/server/` were removed and
  verified gone; that repo's `git status` is unchanged.
- The temporary `AIO_LT71_DROP_DIGEST_HANDLER` gate in `security-handlers.ts` was reverted and
  `npm run build:main` re-run from the reverted source.
- Dev apps stopped, `/tmp/aio-lt-queue-71451811*`, `/tmp/aio-lt-q71-*` workspaces removed.

> Plan Queue parked work: `queue/2026-09-03-enhancements-backlo-451811` — 1 commit(s), reason: land-blocked.

---

## Evidence run — 2026-09-24 (loops batch)

Batch id `loops`, HEAD `f04f6748`. Dev app launched isolated:
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-loops npx electron . --remote-debugging-port=9713`, shared
renderer on `:4567`. Focus/visibility emulation sent on every CDP connection first
(`_scratch/lt-2026-08-11/cdp-eval.mjs`). Scope: re-check the two defects filed from this doc only
(LT-593, LT-594); checks 20/21 skipped as a spend decision per this campaign's brief; checks 3,
17/18, 22, 24 not re-driven (no shipped change touches them since 2026-09-21).

### LT-593 — Stop on a busy Claude session terminates instead of interrupting — CONFIRMED FIXED LIVE

Created a fresh chat (`provider: claude`, `yolo: true`, cwd `/tmp/aio-lt-0924-loops-work/repo1` — a
disposable scratch git repo created for this campaign, never a real project). Sent a multi-tool-call
task, confirmed genuinely busy for the entire interrupt window (polled every 300ms; the `.btn-stop`
control was present continuously for 3.5s before the click, i.e. the turn had not naturally finished),
then called `.click()` on the real `button.btn-send.btn-stop` in `app-input-panel` (the chat-detail
route's Stop control; wired to `chat-detail.component.ts:onInterrupt()` →
`instanceStore.interruptInstance()`, the same underlying IPC the 2026-09-21 repro used via a
differently-named `.btn-interrupt` control elsewhere in the app).

Result, read from `ChatStore.selectedDetail()` and the transcript:

- `currentInstance.status` stayed `idle` for the full 15s post-click trace (`_scratch/lt-2026-09-24/
  loops/full-interrupt-test.js` output) — **never `terminated`**.
- `currentInstance.lastTurnOutcome: "interrupted"`.
- Transcript gained three system lines: `Interrupt requested: unresolved` →
  `Interrupt cancelling: unresolved` → `Interrupted — waiting for input` — the new settle message
  from `noteInterruptSettled()`, not the old "Your message was restored to the input — restart the
  instance to send it."
- A follow-up message sent immediately after (`reply with the single word ALIVE`) was answered
  normally (`"ALIVE"`, `status: idle`) with no restart needed — the session stayed usable.

Read the fix at `src/main/instance/lifecycle/interrupt-respawn-handler.ts:580-596`:
`noteInterruptSettled()` now clears `instance.autoRespawnSuppressedUntil = undefined` (previously left
set), with a comment explaining exactly the regression this closes ("Some resident CLIs exit just
after reporting idle; that later exit must use recovery."). That is precisely the root cause recorded
in the register (`wouldAutoRespawnIfNotRecent` gated on `!autoRespawnSuppressed`, which stayed true
forever without this clear).

Two runs of the interrupt (an earlier one on the same instance, id `c6zmp8j1w`, mid a 20-file-write
task) both settled the same way; app.log shows `InterruptRespawn: Interrupt requested` at
`1790211583795` with `status: busy` (confirming the interrupt was genuinely accepted mid-turn), and no
further `terminated`/exit lines follow for that instance anywhere in the log.

### LT-594 — loop causal timeline terminal readings are unreachable — CONFIRMED FIXED LIVE

Started a real 1-iteration Claude loop in the same scratch repo (`caps.maxIterations: 1`,
`completion.verifyCommand: 'true'`, task: create `loopdone.txt` containing `DONE`). Polled
`document.querySelector('app-loop-causal-timeline')` and its `innerText` every 3s
(`_scratch/lt-2026-09-24/loops/poll-loop-terminal.js`):

- t=0s (running): `Work in progress / Verify not started / … / Next without you: It continues to the
  next iteration.`
- t=3s through t=117s (after the run reached `completed`): `app-loop-causal-timeline` **stayed
  mounted** and read `Work done / Verify done / Independent review done / Terminal decision done —
  Next without you: Nothing. The run has finished.` — it never returned to `null` the way the
  2026-09-21 repro found.

Read the fix at `src/renderer/app/features/loop/loop-control.component.ts:150-161`: `causalTimeline()`
now falls back to the terminal `summary()` (`status`, `endedAt`, `totalIterations`, `totalCostCents`,
`endReason`) when `active()` is `undefined`, and a second `<app-loop-causal-timeline>` mount was added
inside the `@if (summary(); as s)` terminal-summary block
(`loop-control.component.html:398-402`), alongside the original mount under `@if (active(); as a)`
(`:117-121`) used while the run is still live. That is exactly the gap the register recorded:
`LoopStore.applyState`'s terminal branch still calls `clearActive()`
(`loop.store.ts:634-677`, read and confirmed unchanged — the fix is in the *component*, not the
store), but the component no longer depends solely on `active()` to find something to render.

**Not separately exercised live:** the `cap-reached`/`cost-exceeded` "Raise the cap and continue"
recovery affordance specifically — this run reached `completed` cleanly rather than hitting the
iteration cap, because the trivial task finished inside 1 iteration. It shares the same
`causalTimeline()`/mount fix verified above (both are `TERMINAL_STATUSES`), so this is extrapolation
from the fixed code path, not a second independent live observation of that exact banner. Cheap to
close with a follow-up run that deliberately hits the cap, if that matters more precisely.

### Cleanup

Both scratch chats and their instances were left to be torn down in this batch's final cleanup along
with the dev app, profile and `/tmp/aio-lt-0924-loops-work` scratch repo. No James-owned settings,
repos or profiles were touched.

---

## Final reconciliation — 2026-09-27

### Check 3 — LT-660 fixed and transferred for rebuilt-window confirmation

The existing real-window evidence proved that focus escaped behind an `aria-modal="true"` dialog
on the third Tab. A new component regression reproduced the missing interception before production
code changed. `TerminateConfirmDialogComponent` now uses the existing shared focus trap, preserves
initial focus on the dialog, cycles its two actions, and tears down/restores focus on close or
destroy. The regression plus shared trap suite pass **21/21**, and renderer TypeScript passes.
Because the Harness UI is a hard-denied Computer Use target in this session, the final rebuilt-app
Tab/Shift+Tab/restore observation is [AR-006](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-006--enhancements-backlog-rebuilt-app-closure-campaign), not falsely marked live-passed here.

### Checks 17/18 — transferred once, not duplicated

The unchanged-tree reuse and changed-after-park invalidation assertions need one healthy real
reviewer pair and a non-terminal completion/gate fixture. They are preserved together in AR-006,
including the exact cache-hit log/event and both invalidation branches.

### Checks 20/21 — transferred behind the existing spend boundary

Both provider-billing comparisons are now one bounded James-authorised campaign in
[RES-025](2026-09-27-livetest-human-external-residuals_livetest.md#res-025--provider-billed-input-comparison-campaign). It retains the provider billing-pane requirement,
approved spend ceiling and the 0.85-versus-0.60 control; internal token estimates are explicitly not
accepted as evidence.

### Check 22 — folded into the owning Codex occupancy campaign

AR-001 now includes the source's 70% steer, 75% no-mid-turn-compact and 80%
interrupt→compact→same-thread-continuation assertions alongside the already-owned 60%/75% context
evidence ladder. This avoids paying for two long Codex pressure campaigns.

### Check 24 — reachable behavior passed; legacy request class preserved precisely

The real current `deferred_permission` path passed its visible label/options and duration-tooltip
clauses. It correctly omits the settings-write claim because that path resumes the hook bridge and
does not write a Claude allow rule. The write sentence belongs only to `permission_denial`; an
explicit project deny produced no override prompt, which is the safer behavior. AR-006 retains one
bounded check for a genuine current `permission_denial`: if the provider still emits that class,
the sentence must render; if it no longer does, the obsolete clause is retired with runtime
evidence rather than manufacturing a prompt or overriding a user-authored deny.

With those seven checks transferred to the two consolidated residual documents, this source has no
remaining open item and is ready for the `_livetest_completed.md` state.
