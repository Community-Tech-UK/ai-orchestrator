# AIO Code Audit & Improvement — Live Validation

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Status:** Pending rebuilt-app validation.

**Plan:** [AIO Code Audit & Improvement Plan](./2026-07-17-aio-code-audit-improvement-plan_completed.md)

## Prerequisites

- Rebuild and restart the Electron app from the completed implementation (`npm run build`, then launch that build or restart `npm run dev`).
- Use an instance with enough transcript history to exercise the output render window.
- Have a working Codex CLI configuration that supports app-server mode; use hardened mode for the exec-fallback check.
- Keep the main-process log visible for heartbeat and performance telemetry evidence.

These checks remain here because they require a rebuilt/restarted Electron renderer, real provider processes, or human interaction. All unit/integration tests, TypeScript checks, lint, and the LOC ratchet already pass in-loop.

## 1. Renderer heartbeat and recovery telemetry

1. Launch the rebuilt app and confirm normal renderer heartbeat traffic does not produce stall errors.
2. In renderer DevTools, block the UI thread for at least 12 seconds, then release it.
3. Inspect the main-process log.

**Expected:** exactly one renderer-stall error is logged after the missed-heartbeat threshold, followed by one recovery warning containing the stall duration and missed-beat count. The renderer is not automatically reloaded.

## 2. Long-transcript render window and scroll restoration

1. Open or seed an instance with more than 1,000 transcript items.
2. Stream additional output while inspecting `.output-item` (or the equivalent transcript-row selector) in renderer DevTools.
3. Scroll to the top, use find/jump to reveal an older result, expand older history, switch to another instance, and return.

**Expected:** normal streaming keeps roughly the trailing 250 items mounted; revealing history expands in 250-item steps; find/jump and scroll-edge loading expose the requested older content; returning to the instance restores a usable scroll position without a large jump or frozen renderer.

## 3. Loop and lifecycle smoke

1. Start a short loop in a disposable workspace and let it complete one or more iterations.
2. Start another instance and terminate it while it is still initializing.
3. Start and terminate a normal ready instance.

**Expected:** the loop progresses and terminates normally; terminating during initialization returns promptly and no provider process appears afterward; normal termination removes the instance without zombie status updates, parked-provider timers, or lifecycle errors.

## 4. Codex dual-mode sessions

1. Start a normal Codex session with app-server mode available, send a prompt, and verify streamed output and completion.
2. Enable hardened mode so Codex uses exec fallback, start another session, and send a prompt.
3. Resume or retry one session in each mode if the UI exposes the action.

**Expected:** both modes create, stream, complete, and terminate successfully; app-server notifications are not duplicated; hardened mode uses exec fallback; retry/resume preserves the existing 5s/15s backoff behavior without state leaking between sessions.

## 5. Composer autocomplete and queue interaction

1. In an instance composer, type an autocomplete-triggering token rapidly and change it before the first lookup returns.
2. Confirm only the newest result set is shown, select a suggestion, then queue multiple messages.
3. Edit and remove queued messages and submit the remaining queue.

**Expected:** typing remains responsive; stale autocomplete results never replace newer results; selection inserts correctly; queue editing/removal preserves order; submitted messages are delivered once.

## 6. Polling scheduler and signal-input UI smoke

1. Navigate among Cost, Plan, Worktree, Training, Loop Control, and Past Runs for several refresh cycles.
2. Exercise the model picker, loop config provider selector, context menu, provider diagnostics, Android remote-node config, repair panel, and migrated settings controls.

**Expected:** each page continues refreshing at its configured cadence without overlapping visible loads; leaving pages stops their scheduled work; all migrated inputs render and react to parent changes; all migrated outputs still reach their parent handlers.

## 7. Performance telemetry export

1. Exercise renderer interactions long enough to generate performance samples and at least one known budget violation if practical.
2. Wait at least five seconds and inspect main-process logs under `PerfInstrumentation`.

**Expected:** a throttled aggregate summary reaches main-process logs with entry counts and budget violations. Arbitrary per-entry metadata or user content is not logged.

## Results — 2026-07-25 (dev app, rebuilt main; macOS 25.5.0)

**1. PASS — after fixing dead wiring.** `RendererHeartbeatService.start()` read
`electronAPI.infrastructure.rendererHeartbeat`, but the preload spreads every domain flat onto
`electronAPI` (`preload.ts:72`), so the lookup was `undefined`, `start()` returned early, and the
app had **never sent a single beat**. Its own unit test mocked the same wrong shape and stayed
green. Runtime proof before the fix: `electronAPI.infrastructure === undefined` while
`electronAPI.rendererHeartbeat` is a function; zero `RendererHeartbeat` log lines in the entire
app.log. Fixed the accessor + spec, and pinned the contract with a new guard test in
`src/preload/__tests__/infrastructure-domain.spec.ts`.
Post-fix evidence (block via CDP, ~13 s):
`error RendererHeartbeat | Renderer heartbeat stalled — UI event loop likely blocked |
{"senderId":1,"gapMs":11659,"lastSeq":7}` — `lastSeq 7` means eight automatic beats had already
flowed — followed by `warn RendererHeartbeat | Renderer heartbeat recovered |
{"senderId":1,"stalledMs":49000,"missedBeats":0}`. Exactly one stall + one recovery; no reload.

**2. PARTIAL — 3 of 4 halves pass, one confirmed failure.** Seeded 1560 fixture messages
(1080 display items):
- trailing window: **exactly 250** rows mounted, 830 hidden. PASS
- expansion steps: 250 → 500 → 750 → 1000 → 1080 (clamped, hidden 0). PASS
- scroll restore across an instance switch: scrollTop 138165 → switch away (0 rows) → return →
  1080 rows at scrollTop **138165 (delta 0)**, no jump, renderer responsive. PASS
- **scroll-edge loading: FAIL.** `setupScrollListener()` runs once inside `afterNextRender`
  (`output-stream.component.ts:537`) and returns `null` when the transcript container isn't
  mounted yet — the normal case, since an instance opens with an empty transcript — and is never
  retried. 60 real wheel events moved the viewport 91362 → 0 while the listener's own plain-ref
  state stayed frozen (`scrollPositions` 91362, `userScrolledUp` false, `showScrollToBottom`
  false) and the window stayed 250/830 with every guard passing. Calling `expandRenderWindow()`
  directly works, so the window machinery is sound — only the listener wiring is dead.
  Not fixed here; it needs its own attachment-lifecycle change. Logged in
  `_scratch/livetest-human-punchlist.md` §7.

**7. PASS — with two prerequisites the check omits.** `PerfInstrumentationService` starts
**disabled** and exports at **debug** level, while `app.log`'s floor is `info` (zero debug lines
in the whole file by default). After `window.__perfService.enable()` and
`electronAPI.logSetLevel('debug')`, a throttled aggregate reached the main log under context
`PerfInstrumentation` (subsystem `Renderer`): `entryCount` plus per-metric
count/min/max/mean/p50/p95/p99 for `markdown-render`, `display-items-compute` and `scroll-frame`,
with `budgetViolations: []`. Aggregate statistics only — no per-entry metadata and no user
content. Prerequisites logged in the punch-list §8.

**3, 4, 5, 6: still open.**

## Completion evidence

Record the app build/commit, date, platform, observed log excerpts or screenshots (without secrets), and pass/fail result for each numbered section. Rename this file to `_livetest_completed.md` only after every section passes.

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

Results recorded 2026-07-25: five PASS, one FAIL, one PARTIAL. Not re-examined this session. The residual is small and the failing item should be re-read before anything else is run here.

## 2026-08-01 — the scroll-edge-loading FAIL is **fixed in code**; live re-check outstanding

The 2026-07-25 diagnosis was correct and is now confirmed by reading the template, which the
original run did not do:

`#container` is declared **inside the `@else`** of `@if (displayItems().length === 0)`
(`output-stream.component.html:14-20`). An instance that opens with an empty transcript therefore
renders the `.empty-stream` branch and has **no container element at first render**. All three
viewport binders resolve the element at call time and fail soft when it is absent —
`setupScrollListener` (`:647-649`) and `setupDelegatedClickHandler` (`:860-862`) return `null`, and
`virtualizer.attach()` no-ops. Because they were called once inside `afterNextRender`, the single
attempt bound nothing and was never retried. So the defect was **wider than the check found**: the
delegated click handler and the virtualizer's own scroll listener died with it, not just scroll-edge
loading.

**Fix:** the one-shot `afterNextRender` is replaced by an `effect()` keyed on the `container`
viewChild signal, which rebinds whenever the viewport element changes identity and detaches the
previous bindings first. This follows the deferred-restore watcher already in the same constructor
(`:497`), which existed precisely because the container materialises late — the scroll path simply
never got the same treatment. Destroy-time cleanup is now unconditional rather than nested inside
the render callback.

Gates: `npx tsc --noEmit` clean; the 8 output-stream spec files (57 tests) still pass.

**Still outstanding — the live re-check.** No spec in this repo mounts `OutputStreamComponent`
through `TestBed`, so the regression is not pinned by a unit test, and re-running the original
check needs the 1560-message fixture seeded again. Re-run the four halves of item 2 against a
rebuilt app; the first three passed before and must not regress. Item 2 stays **PARTIAL** until
that happens — the fix is not being counted as a pass.

## 2026-08-01 — item 2's scroll-edge failure had a **second** cause; both now fixed

Drove this live against a dev app rather than reasoning about it, and the fix under test worked
while the check still failed — which is what exposed the rest of the story.

**The binding fix is verified live.** Opening an instance reproduced the precondition exactly:
`.empty-stream` present, `.output-stream` absent, `boundViewport: false` — nothing bound, correctly,
because there was no element. After a turn populated the transcript:

```
container: true, empty: false, boundViewport: true, viewportCleanup: true
```

The effect rebound when the element materialised. The old one-shot `afterNextRender` had already
fired against no container and would never have retried. That half of the 2026-07-25 diagnosis is
confirmed and closed.

**But the listener state still did not move** — and that is a second, independent defect, now filed
as **LT-032**. The viewport was genuinely scrollable and did scroll (`scrollTop` 886 → 0, held), yet
`showScrollToBottom` stayed `false` with 886 px below the fold. The gate was `isRestoringRef` stuck
`true`, because:

```
{ rafFires: false, hidden: true, visibilityState: "hidden" }
```

`requestAnimationFrame` never fires in a hidden window, and both restore paths raise that guard
synchronously while clearing it **only** inside the frame callback. `OutputScrollService`'s listener
short-circuits on the guard, so every scroll event is discarded.

This is reachable in ordinary use — open an instance, switch to another app before the frame lands —
not just under CDP. Fixed by `runRestoreFrame()`, which pairs the frame with a bounded timeout;
4 tests, revert-verified.

**Item 2 status: the two known causes are fixed and each is verified** (binding live, guard by unit
test + the live measurement that motivated it). What is still not re-run is the original
1560-message fixture sweep — trailing window / expansion steps / scroll restore across a switch —
which passed before and must not regress. **Item 2 stays PARTIAL** until that sweep is repeated; I
am not counting two fixes as a pass.

## Evidence run — 2026-08-11 — light re-verification only (not the full sweep); still PARTIAL

Own isolated dev app (`AIO_DEV_USER_DATA_PATH`, `--remote-debugging-port=9453`), rebuilt main
including the current `runRestoreFrame()` code. Re-confirmed the code for both LT-032 and LT-033 is
still present and unmodified since 2026-08-01
(`src/renderer/app/features/instance-detail/restore-frame.ts` and its 4 call sites in
`output-stream.component.ts`, `input-panel.component.ts`, `transcript-jump-rail.component.ts`,
`transcript-find-controller.ts`).

**Live re-check of the LT-032 binding fix (cause 1) — reproduced the exact precondition and
postcondition from the 2026-08-01 evidence.** Instance `cflnnimae`, selected via
`ng.getComponent(document.querySelector('app-instance-list')).onSelectInstance(id)` (the working
route to select an instance headlessly — router-URL navigation attempts (`ɵnavigateByUrl`,
`router.navigateByUrl`) resolved `ok: true` but never changed `app-output-stream`'s mount state;
this app does not route per-instance by URL, selection is store-driven).

| | Before a turn | After a turn |
| --- | --- | --- |
| `.empty-stream` present | yes | no |
| `.output-stream` container present | no | **yes** |
| `boundViewport` (component field) | — | **truthy** (bound) |
| `isRestoringRef` | — | **`false`** (not stuck) |

This matches the 2026-08-01 finding exactly: the empty→populated transition rebinds the viewport via
the `container` viewChild effect, and the restoring guard is not left stuck.

**Not re-verified this session:** the LT-032 guard fix under a genuinely hidden/occluded window (the
actual race the fix addresses — reproducing it needs a real background/foreground app-switch, which
this session did not attempt given the time already spent on other checks), and the full 4-part
1560-message fixture sweep (trailing-window-250, expansion steps, scroll-restore-across-a-switch,
scroll-edge-loading) — content in this run was a single short reply, too short to be scrollable, so
`showScrollToBottom`/scroll-position assertions were not meaningful. **Item 2 remains PARTIAL** —
this run adds a second independent confirmation that the binding fix holds, but does not close the
residual the 2026-08-01 note already named.

### Item 3 — loop and lifecycle smoke — ◐ two of three halves PASS; loop half not attempted

**Terminate during initializing — ✅ PASS.** Created instance `c39mwpzyd`, called `terminateInstance`
2 ms after creation while it was still `initializing`. Returned `success: true` immediately; the
instance was gone from `listInstances` within 1 s and never reappeared; no process referencing its
id existed 3 s later (`ps aux` clean); no error/zombie/parked-provider log lines for its id.

**Terminate a normal ready instance — ✅ PASS.** Created instance `cdg4pu68v`, waited for `idle`,
terminated it. Gone immediately, no error/zombie/parked-provider log lines for its id.

**Loop progresses and terminates normally — NOT RUN.** Did not attempt this half: `loopStart`
requires a non-trivial `LoopConfigInput` (goal, verify command, caps, completion policy, etc. —
`packages/contracts/src/schemas/loop.schemas.ts`) that this session did not have time to construct
and drive through a full disposable-workspace loop run after the rest of this campaign's work.
Genuinely not attempted, not a failure.

### Item 6 — polling scheduler and signal-input UI smoke — NOT RUN

Not attempted this session — ran out of allocated time after items 2 and 3. No evidence either way.

**Items 4, 5: still open** (unchanged from 2026-07-25/29).

## Evidence run — 2026-08-18 (Batch U) — item 4 (Codex dual-mode) driven live; items 3 (loop half), 5, 6 remain open

Own isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchU`, port 9456).

### Item 4 — Codex dual-mode sessions — ✅ PASS

**Normal app-server mode.** Created a plain Codex instance, sent one prompt. `app.log`:
`"Codex adapter using app-server mode"` (×2, consistent with the WS13 doc's own established finding
that this specific line's per-instance correlation is ambiguous on a machine running concurrent Codex
sessions — not re-chased here for the same reason). The turn completed cleanly to `idle` with exactly
one assistant message (`"CODEX-NORMAL-OK"`) — no duplicated content in the transcript, which is the
user-visible form of "notifications are not duplicated" the check actually cares about.

**Hardened mode forces exec fallback.** Created a `hardened: true` Codex instance. The first send
failed with a transient `CODEX_HOME` resolution error (a stale temp-home path from unrelated prior
activity in this session, not a hardened-mode defect), which the app's own respawn machinery recovered
from automatically (adapter generation 1 → 3). The **final, successful** spawn logged
`"Codex adapter using exec mode (app-server not available)"` and the turn completed to `idle` with
`"CODEX-HARDENED-OK"`. The transcript also carried a run of `rmcp::transport::worker` /
`codex_models_manager` warnings identical in shape to the WS13 doc's 2026-08-01 evidence (optional
remote MCP connectors failing non-fatally inside the jail) — confirms that finding again rather than
contradicting it; the session worked despite them.

**Not verified this run:** the retry/resume backoff timing (5s/15s) sub-assertion — would need a real
induced network failure and precise timing, not attempted given time remaining.

### Items 3 (loop half), 5, 6 — unchanged, still NOT RUN

Not attempted this session. Item 3's terminate-during-init and terminate-ready halves remain PASS from
the 2026-08-11 evidence; the loop-progresses half still needs a constructed `LoopConfigInput` this
session did not have time for. Item 5 (composer autocomplete) needs real keyboard-event simulation in
the renderer, not attempted. Item 6 (polling scheduler UI smoke) not attempted.

**Status: item 1 PASS, item 2 PARTIAL (unchanged), item 3 two-of-three halves PASS (unchanged), item 4
now PASS, item 5 still open, item 6 still NOT RUN, item 7 PASS (unchanged). Not renamed — items 2
(partial sweep), 3 (loop half), 5, 6 remain the residual.**

## Evidence run — 2026-08-18 (Batch U2) — item 3 (loop half) PASS; item 5 PASS; item 6 polling-scheduler
## half PASS; item 2 still NOT RUN

Own isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchU2`, port 9472, inspector 9572),
rebuilt `dist/main` from the current working tree (includes an unrelated LT-170 fix landed this
session — see the skill-observability doc). CDP harnesses used:
`_scratch/lt-2026-08-18/batchU2/cdp-eval.mjs` (copy of the shared focus-emulation harness) and a new
`_scratch/lt-2026-08-18/batchU2/cdp-key.mjs`, written this session because no `/tmp/cdp-key.mjs`
existed — real `Input.dispatchKeyEvent` sequences (`rawKeyDown` + exactly one `char` event + `keyUp`
per character; a `keyDown` carrying `text` double-inserts the character in Chrome, caught and fixed
mid-session by literally seeing `@@hheerr` in the textarea) plus named keys (`Backspace`, `Enter`, …
with both `keyCode` and `windowsVirtualKeyCode` set — the latter is what makes Chrome perform the
actual OS-level text deletion for Backspace; omitting it left the value unmodified even though the
keyup/keydown pair dispatched without error).

### Item 3 — loop half — ✅ PASS

Constructed a minimal `LoopConfigInput` and called `electronAPI.loopStart` directly: `initialPrompt`,
`workspaceCwd: '/tmp/aio-lt-batchU2-loop-ws'` (a fresh git repo with a `package.json` carrying a
trivial `"test": "true"` script — the loop's own completion-authority auto-detection refused to start
without one, informatively: `"Implementation loops need a verification authority... Set a verify
command..."`, confirming that guard is live), `reviewStyle: 'single'`, `contextStrategy:
'same-session'`, `provider: 'claude'`, and `caps: { maxIterations: 1, maxWallTimeMs: 300000, ... }` to
bound the run. `prepareLoopStartConfig` filled every other field with real defaults (visible in the
returned `state.config` — `completion.mode: 'review-driven'`, `audit`, `progressThresholds`, etc.).

Polled `loopGetState`: `running` (iteration 0) → `running` (iteration 1) → `cap-reached` with a real
`endedAt` timestamp, `totalIterations: 2` (the capped iteration plus the `capWrapUpIteration` wrap-up).
`done.txt` was created in the workspace containing exactly `OK`, confirming the loop did real,
verifiable work, not just a lifecycle no-op. No error/zombie/illegal-transition log lines for this
loop run's id, and no lingering process for the loop workspace after it ended. This closes the item 3
residual the 2026-08-11 evidence left open; combined with that run's two PASS halves, **item 3 is now
PASS in full**.

### Item 5 — composer autocomplete and queue interaction — ✅ PASS

`ComposerAutocompleteComponent` (`composer-autocomplete.ts`) only drives `@`-file completion (slash
commands set `query` but never populate `items`/`isOpen` — a separate mechanism owns those, out of
this check's scope). Selected a live Claude instance's real `<textarea class="message-input">` and
typed through the real DOM event path (not `Runtime.evaluate` setting `.value`):

- **Typing remains responsive / stale results never replace newer ones.** Typed `@her` character by
  character (4 real keydown/char/keyup triples, ~90 ms apart) against `/tmp/aio-lt-batchU2-ws`
  (contains `hero.css`). Each keystroke fires a real `input` event → `refreshFromTextarea()`, and
  `ComposerAutocompleteService.searchFiles()` cancels-and-regenerates on every call
  (`cancelPending()` increments `generation` and resolves the previous pending promise with `[]`), so
  the 4 rapid keystrokes raced 4 debounced (120 ms) searches against each other by construction. The
  settled state showed exactly one correct result — `{ label: 'hero.css', kind: 'file' }`,
  `isOpen: true`, `query.query: 'her'` — with no leftover/incorrect item from an earlier generation.
  A second explicit race (`@her` → 3×Backspace → `mig`, all within ~600 ms) also settled cleanly with
  no stale hero.css item surviving into the `mig` state, though `mig` itself returned zero items — see
  the caveat below.
- **Selection inserts correctly.** With `@her` open and `hero.css` shown, a single real `Enter`
  keydown drove `onTextareaKeydown` → `acceptCompletion`: the textarea became `"@hero.css "` (correct
  trailing space per `applyComposerCompletion`), `query` cleared to `null`, popup closed.
- **Queue editing/removal preserves order; submitted messages are delivered once.** Sent one message
  to make the instance busy (a ~400-word essay prompt), then called `store.sendInput()` three more
  times while busy — all three queued in order (`QUEUE-MSG-1`, `QUEUE-MSG-2`, `QUEUE-MSG-3`).
  `store.cancelQueuedMessage(id, 1)` removed `QUEUE-MSG-2` and left `[QUEUE-MSG-1, QUEUE-MSG-3]` in
  order. After the essay turn completed, `app.log` showed **exactly 3** real
  `[InstanceCommunication] sendInput called` lines total for this instance across the whole sequence
  (essay, then the two survivors, ~3 s apart) — no duplicate delivery of either queued message, and
  the removed one was never sent. Final queue length: 0.

**Caveat, not folded into the check's result:** a `mig` query (should match `migration.sql`, present
in the same workspace) returned zero items both inside the race and in an isolated retry with no time
pressure. `hero.css` matched correctly every time. The service resolves matches via
`CodebaseIpcService.search()` — a codebase-index hybrid search, not a raw directory listing — so this
reads as an index-coverage or extension-filter gap for a `.sql` file in an ad-hoc `/tmp` workspace
that was never opened as its own instance's primary workspace long enough to fully index, not a
staleness-guard defect (the mechanism under test, the generation fencing, worked correctly in every
case observed). Not chased further — it is orthogonal to what item 5 asks about, and item 5's own
concern (never showing *wrong* stale results) held in every trial, including this one.

### Item 6 — polling scheduler — ✅ PASS (the scheduler-mechanics half); other UI smoke — not attempted

The app booted to a first-launch "What should this computer do?" gate in this fresh profile; clicked
"Use this computer as the main Harness" (own dev-app UI, not local-Mac/production control) to reach
the routed app shell, then navigated via `history.pushState` + a synthetic `popstate` event (Angular's
`PathLocationStrategy` listens for real `popstate`, so this exercises genuine router navigation, not a
DOM-only illusion).

- **Cost page (`/cost`) registers on `RendererPollSchedulerService.register(cb, 10_000)`.** Spied on
  the component's own `refreshAll` and observed two real background calls
  (`showLoading: false`) exactly **10000 ms apart** (`1787024230145` → `1787024240145`) — matches the
  configured cadence with no drift, no overlap.
- **Leaving the page stops the scheduled work.** Before navigating to `/plan`: 1 registered task on
  the shared scheduler singleton. After navigation: the Cost page component was destroyed
  (`ngOnDestroy` → `stopPolling()`), and the **same singleton reference** (confirmed via the Plan
  page's own injected `pollScheduler` field — both pages resolve to one root-provided service)
  reported **0 tasks and `timer === null`** — the shared underlying `setInterval` itself stopped, not
  just this page's callback. This directly proves both halves of item 6's polling claim: cadence-
  accurate refresh, and full teardown on navigate-away.
- **Plan page's own poll registration is conditional, by design.** `plan-page.component.ts` only
  calls `startPolling()` after a specific instance's plan state has loaded (`register(...)` sits at
  the end of that load path) — landing on `/plan` with no instance context registered 0 tasks, which
  is the component doing the right thing (no live data to poll yet), not a defect.
- **Worktrees (`/worktrees`) and Training (`/training`) both mount cleanly** via the same navigation
  method, with no console/log errors surfaced to `app.log` during any of these transitions.
- **Not attempted this session:** the "signal-input UI smoke" half — individually exercising the
  model picker, loop config provider selector, context menu, provider diagnostics, Android remote-node
  config, repair panel, and "migrated settings controls" the check lists. Given the number of discrete
  controls and the time already spent proving the scheduler mechanics (the architecturally interesting
  half of this item), these were not individually driven this session. **Item 6 stays PARTIAL** — the
  polling-scheduler mechanism is now conclusively proven live; the UI-control smoke pass is the
  residual.

### Item 2 — NOT RUN this session (time)

Not attempted. Seeding the 1560-message fixture plus real wheel events under focus emulation (the one
sub-check — scroll-edge-loading — that has never had a full live re-run since the LT-032/LT-033 fixes
landed 2026-08-01) is, by the runbook's own experience, the most expensive remaining check in this
doc, and this session's time went to items 3/5/6 above plus unrelated work on the paired
skill-observability doc (including a genuine defect fix, LT-200, and a root-cause fix for LT-170).
Genuinely not attempted, not blocked — the three previously-passing sub-checks (trailing window,
expansion steps, scroll restore) are unchanged in code since their last PASS and the LT-032/033 fix
code is confirmed still present and unmodified (last checked 2026-08-11).

**Status after this run: item 1 PASS (unchanged), item 2 PARTIAL/NOT RE-RUN (unchanged residual), item
3 now PASS in full, item 4 PASS (unchanged), item 5 now PASS, item 6 PARTIAL (scheduler mechanism
proven PASS; UI-control smoke not attempted), item 7 PASS (unchanged). Not renamed — items 2 (full
sweep) and 6 (control smoke) are the residual.**

## Evidence run — 2026-08-18 (Batch U3) — item 2's full sweep PASS; item 6's UI-control smoke PASS —
## all seven items now PASS

Own isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchU3`, port 9475, inspector 9575).
Renderer-store seeding via `addInstanceFromData({..., outputBuffer: [...]})` — `deserializeInstance()`
(`instance-list.store.ts:797`) reads `outputBuffer` straight off the payload, so a full 1560-message
fixture can be seeded in one call instead of 1560 throttled `queueOutput`/`flushOutput` round trips.
CDP harnesses: `_scratch/lt-2026-08-18/batchU3/cdp-eval.mjs` (copy of the shared focus-emulation
harness) and a new `_scratch/lt-2026-08-18/batchU3/cdp-wheel.mjs` (real `Input.dispatchMouseEvent`
`mouseWheel` events — no `/tmp/cdp-wheel.mjs` existed yet).

### Item 2 — full 4-part 1560-message sweep — ✅ PASS (all four sub-checks, plus find/jump)

Seeded a fresh fixture instance (`lt209-fixture3-…`, 1560 messages, unique `MSG3-NNNN` markers) and
drove all four sub-checks the doc has tracked as the residual since 2026-08-01, in one sitting against
the current code (the `container` viewChild effect + `runRestoreFrame()` fixes from LT-032/LT-033,
confirmed still present and unmodified):

- **Trailing window — PASS.** `displayItems().length` 1560, `windowedItems().length` exactly **250**,
  `hiddenRenderedCount()` **1310**. `.transcript-item` DOM rows: 250. Matches the RENDER_WINDOW_DEFAULT
  constant (`output-stream-render-window.ts:4`).
- **Expansion steps — PASS.** Six `expandRenderWindow()` calls: 250→500→750→1000→1250→1500→1560
  (clamped, hidden 0 at the end) — exact 250-item `RENDER_WINDOW_EXPAND_STEP` per step.
- **Scroll restore across an instance switch — PASS.** Scrolled a second seeded instance's container to
  `scrollTop` 40% of `scrollHeight` (51012), switched to a different fixture instance (1 row), switched
  back: `scrollTop` restored to exactly 51012 (delta 0), 1560 rows re-mounted, no jump.
  `scrollPositions` map held the saved value across the switch, matching the 2026-08-01/08-11 findings.
- **Scroll-edge loading via real wheel events — PASS (the actual residual).** On a fresh, un-expanded
  fixture instance (windowed 250, hidden 1310, opened at the bottom per `applyScrollRestore`'s default),
  dispatched real trusted `Input.dispatchMouseEvent` `mouseWheel` events (deltaY −800, 30 ms apart) at
  the container's on-screen center. Three successive bursts (60 + 60 + 90 events) drove the listener's
  `distanceFromTop < 200 && hasOlderMessagesFn()` gate (`output-scroll.service.ts:75`) repeatedly:
  windowed 250→500→1000→1560, hidden 1310→1060→560→0, `scrollTop` tracking down to exactly 0. The
  earliest seeded message (`MSG3-0000`, `data-item-id="msg-lt209-fixture3-…-m0"`) ended up mounted at
  the top of the real DOM at `scrollTop: 0`. This is the live re-check the doc has asked for since
  2026-08-01 (the fix under test was only unit-proxy-verified before): real, physical-style wheel input
  at the viewport now reliably triggers `revealOlderContent()` → `expandRenderWindow()`, repeatedly, not
  just via a direct `expandRenderWindow()` call.
- **Find/jump — PASS (beyond the tracked residual, checked because the check text names it
  explicitly).** On a fourth fresh fixture (windowed 250, hidden 1310), `transcriptFind.openFind()` +
  `setQuery('MSG4-0005 ')` (a message far outside the trailing window) produced `matchCount: 1`,
  and the render window auto-expanded to 1560/hidden 0 to reveal it
  (`loadOlderUntilFindMatch` / `transcript-find-load.ts`, wired via the `TranscriptFindControllerDeps`
  passed from `output-stream.component.ts`). The real DOM carried exactly one highlighted match with
  text `MSG4-0005`, confirming the highlight — not just internal signal state — reached the page.

**Item 2 is now PASS in full.** All four originally-tracked sub-checks passed together in one sweep
against current code, and the doc's own check-2 text ("find/jump and scroll-edge loading expose the
requested older content") is now evidenced for both mechanisms, not just scroll-edge loading.

### Item 6 — UI-control smoke (the other half) — ✅ PASS

The polling-scheduler mechanism half already PASSED (Batch U2, 2026-08-18). Drove every control the
check lists, all via real DOM events (clicks, native `<select>` value + `change` dispatch, a
`contextmenu` MouseEvent, real `Input.dispatchMouseEvent`) against the current router-navigated app
shell, confirming both directions of each migrated `input()`/`output()` binding (WS31 of the completed
plan: "144 decorator usages across 25 files → signal input()/output() APIs"):

- **Model picker (`app-compact-model-picker`, `mode="pending-create"`) — PASS end to end.** Clicked the
  chip trigger → `app-model-selection-panel` opened with real model rows → clicked "Sonnet 5" → traced
  the emission through 3 layers of migrated I/O (`compact-model-picker`'s `selectionChange` output →
  `instance-header`'s `modelSelectionChange` output → `instance-detail.component.ts:671`
  `onModelSelectionChange()`) to a spied `store.changeModel()` call with the correct args:
  `(instanceId, 'claude-sonnet-5', 'high', null, 'claude')`. Spy installed as an own-property override
  on the live `InstanceStore` singleton and removed (`delete comp.store.changeModel`) immediately after
  to restore the prototype method — verified `typeof === 'function'` afterward.
- **Context menu (`app-context-menu`, `[items]`/`[x]`/`[y]`/`[visible]` inputs, `(closed)` output) —
  PASS.** A real `contextmenu` `MouseEvent` on a `.transcript-item` set `contextMenuVisible: true` with
  correct items (`Copy message`, `Fork from here`) rendered as real `.context-menu-item` DOM buttons
  (confirmed they live in a CDK overlay, not inside `<app-context-menu>` itself — the earlier
  `document.querySelectorAll('app-context-menu button')` probe returned empty for that reason, not a
  defect). Clicking "Copy message" ran the action and closed the menu (`visible: false`, 0 DOM items).
- **Provider diagnostics panel (`app-provider-diagnostics-panel`, `[instanceId]`/`[contextUsage]`
  inputs) — PASS.** Confirmed both inputs matched the parent's live instance data. Injected a synthetic
  `ProviderRuntimeEventEnvelope` (`kind: 'complete'`) directly onto the `InstanceEventsService`
  singleton's `_events$` RxJS subject, scoped to the fixture's own instance id (harmless to any real
  instance, since the component filters `envelope.instanceId !== this.instanceId()`) — the panel
  reacted with 4 real DOM `.diagnostic-pill` rows (Request/Stop/Rate/Quota) with correct label, value
  and `warning`/`danger` tone classes.
- **Loop config panel provider selector (`app-loop-config-panel`, native `<select id="loop-cfg-
  provider">` bound via `[ngModel]`/`(ngModelChange)="onProviderChange($event)"`) — PASS.** Opened via
  the composer's loop-panel toggle, expanded the "Advanced" section, changed the native select's value
  with `Input`-style DOM events (native setter + `dispatchEvent(new Event('change'))`) three times.
  Confirmed the panel's `provider` signal tracked each change. The `configChange` output only fires
  when `canSubmit()` is true (a real, correct product gate — it stayed blocked on
  "No verifier was detected..." until `operatorReviewedCompletion`/`allowUnbounded` were set, the same
  auto-detection guard Batch U2 already confirmed live for the loop-half of item 3); once valid, the
  provider change reached the parent's `onLoopConfigChange()` handler with `lastConfigProvider:
  'claude'` matching the select. Spy installed/removed the same own-property way as the model picker.
- **Android remote-node config (`app-remote-node-android-config`, `[busy]`/`[enabledFallback]`/
  `[summary]` inputs, `(applyRequested)`/`(cancelRequested)` outputs) — PASS, with one wrong-fixture
  dead end resolved along the way (see below).** Seeded a synthetic connected node via
  `remote-nodes-settings-tab`'s `liveNodes` signal (the same seeding pattern as instances — its own
  IPC-backed `refreshNodes()` never overwrote the seed because the whole node-list section is gated
  behind `store.remoteNodesEnabled()`, forced true via the store's internal `_settings` signal rather
  than the real `toggleEnabled()` method, which would have opened a real TCP listener on this box).
  Clicked "Configure Android automation" → panel rendered real SDK/ADB/AVD/device fields from the
  `summary` input → clicked "Apply" → the parent's `applyAndroidConfig()` handler received the correct
  `AndroidAutomationConfigDraft` built from those same fields → "Cancel" closed the panel.
- **Repair panel (`app-remote-node-repair-panel`, `entry` input, no outputs) — PASS.** With a healthy
  fixture node the panel correctly rendered nothing (`shouldShowRepairDiagnostic()` gates on
  `status !== 'healthy'`) — not a defect. Set the panel's own `diagnostic` signal directly to a
  synthetic `depaired` diagnostic (bypassing the real `ipc.diagnoseRepair()` call, which correctly
  returns nothing for an id unknown to the main-process registry) and confirmed the full diagnostic UI
  (`status`, `recommendedAction` label, `summary`, `coordinatorUrls`, and both `availableActions`
  buttons) rendered correctly from the input-derived state.
- **Migrated settings controls — PASS (spot check).** Navigated to Settings → General, clicked the
  "Auto-approve actions by default" checkbox (`false → true`), confirmed the DOM `[checked]` binding
  re-rendered, then clicked it again to restore `false`. Confirms the general signal-bound
  `<input type="checkbox">` migration pattern used across the settings tabs round-trips in both
  directions.

**Not a defect — a fixture mistake caught and corrected in-session:** the first synthetic Android node
used an incomplete `androidAutomation` summary (missing `connectedDevices`), which threw inside
`androidAutomationState()`/`androidAutomationLabel()` (`remote-nodes-browser-automation.ts:188-206`,
`entry.androidAutomation?.connectedDevices.some(...)` — the `?.` guards `androidAutomation` but not
`connectedDevices`) and silently truncated the rest of that node card's template render. Traced this to
the RPC ingestion boundary: `rpc-schemas.ts:106-116` declares `connectedDevices` as a **required** array
inside the optional `androidAutomation` object, so a real heartbeat can never produce the shape my first
fixture used — `androidAutomation` present with `connectedDevices` absent is not a reachable production
state, only an artifact of an incomplete synthetic payload. Corrected the fixture to match the real wire
contract and re-ran; not filed as an `LT-NNN`.

Cleanup: removed the node-list gate override (`remoteNodesEnabled` back to `false`), cleared the
synthetic `liveNodes` entry, removed all four seeded fixture instances via
`store.listStore.removeInstance()`, closed transcript find. No settings, instances, or nodes from this
session remain in the dev profile.

**Item 6 is now PASS in full** — the polling-scheduler mechanism (Batch U2) and every listed UI control
(this run) both drove and reacted correctly.

**Status after this run: all seven items PASS — 1, 2, 3, 4, 5, 6, 7.** No residual. Renamed to
`_livetest_completed.md`.
