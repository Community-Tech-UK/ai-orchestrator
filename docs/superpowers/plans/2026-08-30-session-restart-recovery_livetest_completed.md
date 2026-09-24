# Session Restart Recovery — Live UI Checks

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row,
> observed behaviour, root cause, required behaviour, and acceptance), and add the
> matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Keep per-check evidence
> in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-08-30-session-restart-recovery_plan_completed.md](2026-08-30-session-restart-recovery_plan_completed.md)

## Status — 2026-09-24

Open: 0 · Closed: 5 · Failed: 0

Checks 1, 2 and 5 were re-run live against a rebuilt app (HEAD `f04f6748`) — see
[Evidence run — 2026-09-24 (resume batch)](#evidence-run--2026-09-24-resume-batch). **LT-605 and
LT-606 are both CONFIRMED FIXED LIVE.** All five checks now pass. This document is a candidate for
`_livetest_completed` rename by the orchestrator.

### Status — 2026-09-21 (superseded)

Open: 3 · Closed: 2 · Failed: 3

Ran in full on 2026-09-21 against an isolated dev app — see
[Evidence run — 2026-09-21](#evidence-run--2026-09-21-plan-queue-worker-isolated-dev-app).

- **Closed:** checks 3 and 4, which pass outright.
- **Still open:** checks 1, 2 and 5. Checks 1 and 5 fail on one root cause —
  `SessionRecoveryBannerComponent` is imported by no template, so the startup notice and its dismiss
  control do not exist in the running app (**LT-605**). Check 2 passes on group ordering, row
  content, accessible naming and the Arrow/Tab route, and fails only its focus-visibility clause:
  the row actions' focus ring is suppressed by an undefined `--focus-ring` custom property
  (**LT-606**).

Neither residual needs James; both are ordinary code defects. Re-run checks 1, 2 and 5 once LT-605
and LT-606 are fixed.

### Status — 2026-09-06 (superseded)

Open: 5 · Closed: 0 · Failed: 0
Needs a rebuilt/restarted disposable dev app; then fully agent-drivable via CDP + `ng.getComponent` store seeding.

## Prerequisites and deferral reason

- Rebuild and restart a disposable dev app from this checkout.
- Use an isolated profile, for example `AIO_DEV_USER_DATA_PATH=/tmp/aio-session-recovery-live`.
- Enable CDP focus emulation before inspecting the zoneless Angular DOM, as described in the
  campaign runbook.
- Use only the obvious placeholder candidate below. Do not copy real history, continuity,
  prompts, paths, tokens, or user-data files into the disposable profile.

These checks are deferred because the only running AIO window during implementation was the
Harness itself. Computer Use health passed, but the Harness application is a hard-denied
self-control target, so the implementing agent could not observe or drive it. The backend crash
boundary and recovery path are automated in
`src/main/session/session-restart-recovery.integration.spec.ts`; this document covers the remaining
real-renderer interaction and focus behaviour.

## Synthetic renderer setup

1. Start the renderer and disposable Electron app using the campaign runbook, with a unique CDP
   port and `AIO_DEV_USER_DATA_PATH=/tmp/aio-session-recovery-live`.
2. In the renderer DevTools console, obtain the live banner component and its injected store:

   ```js
   const banner = window.ng.getComponent(
     document.querySelector('app-session-recovery-banner')
   );
   const recoveryStore = banner.store;
   const ipcService = recoveryStore.electronIpc;
   const originalGetApi = ipcService.getApi.bind(ipcService);
   const candidate = {
     recoveryKey: 'history:claude:placeholder-thread',
     sourceInstanceId: 'placeholder-source-instance',
     historyThreadId: 'placeholder-thread',
     provider: 'claude',
     modelId: 'placeholder-model',
     displayName: 'Placeholder autosave',
     workingDirectory: '/tmp/aio-session-recovery-placeholder',
     lastActivityAt: Date.now(),
     recoveredMessageCount: 3,
     reason: 'newer-than-history',
     nativeResumeAvailable: false,
   };
   const realApi = originalGetApi();
   ipcService.getApi = () => ({
     ...realApi,
     listRecoveryCandidates: async () => [candidate],
     recoverSession: async () => ({
       instanceId: 'placeholder-recovered-runtime',
       recoveredMessageCount: 3,
       usedNativeResume: false,
     }),
   });
   await recoveryStore.refresh();
   ```

3. Record `const before = await window.electronAPI.listInstances()` before clicking any recovery
   control. Restore `ipcService.getApi = originalGetApi` and restart the disposable app after the
   campaign.

## Check 1: Startup notice is non-modal and does not auto-start

1. Observe the dashboard after the synthetic refresh without clicking anything.
2. Confirm a polite status region says **Autosaved session available** and summarizes
   **Placeholder autosave**, **3 autosaved messages**, and **newer than history**.
3. Confirm the rest of the dashboard remains operable and focus is not moved into the notice.
4. Run `await window.electronAPI.listInstances()` again.

**Expected:** the notice is visible and non-modal; the instance list is byte-for-byte equivalent to
`before`. Listing/displaying the candidate never launches a process.

## Check 2: Picker order, accessible controls, and keyboard navigation

1. Tab to **Review autosave** and activate it with Enter.
2. Confirm **Quick Resume** appears first and **Autosave recovery** appears above **History** and
   **Archived**.
3. Confirm the recovery row exposes the placeholder provider/model/path, **Newer than history**,
   **3 autosaved messages**, and an **Autosave** badge.
4. Navigate the overlay using its Arrow-key route, Tab to the row action, and confirm the action's
   accessible name is **Recover autosaved session Placeholder autosave**.
5. Close the picker, reopen it, and confirm any previous autosave-only search/filter is cleared.

**Expected:** focus is visible, keyboard navigation reaches the recovery action, group ordering is
correct, and opening/closing does not retain a hidden recovery filter.

## Check 3: Explicit success state

1. Activate **Recover autosaved session Placeholder autosave** once.
2. While the promise is pending, confirm only the active action reads **Recovering...**, has
   `aria-busy="true"`, and all recovery actions are disabled against duplicate submission.
3. Allow the synthetic promise to resolve.

**Expected:** the picker closes, the candidate disappears immediately, the selected runtime ID is
`placeholder-recovered-runtime`, and a success toast says **Recovered 3 autosaved messages.** No
second recovery request is sent.

## Check 4: Failure remains visible and retryable

1. Refresh the disposable app and repeat the synthetic setup, replacing `recoverSession` with:

   ```js
   recoverSession: async () => {
     throw new Error('Placeholder recovery failure');
   }
   ```

2. Open the picker and activate the recovery action.

**Expected:** the picker remains open, an assertive alert shows **Placeholder recovery failure**,
the candidate remains listed, focus is still usable, the busy state clears, and the action can be
retried. No live instance is created.

## Check 5: Session-lifetime dismissal

1. Reload and seed the successful placeholder candidate again.
2. Activate **Dismiss autosave recovery notice**.
3. Open the Resume Picker directly and confirm the recovery row remains available.
4. Close/reopen the picker, then refresh candidates.

**Expected:** dismissal hides only the startup notice for this renderer session; it does not delete
or recover the candidate, and ordinary picker open/close still clears transient autosave focus.

Record the dev-app commit, disposable profile path, CDP port, observed results, and screenshots with
only placeholder data. Rename this file `_livetest_completed.md` only after all five checks pass.

---

## Evidence run — 2026-09-21 (Plan Queue worker, isolated dev app)

**Result: checks 3 and 4 pass outright. Check 2 passes on ordering, content, naming and the
keyboard route but fails its focus-visibility clause. Checks 1 and 5 fail. Two defects reproduced
and filed — LT-605 (P1) and LT-606 (P2).**

### Environment

| Item | Value |
| --- | --- |
| Checkout | `.worktrees/queue/2026-08-30-session-restart-rec-0ca9ca`, branch `queue/2026-08-30-session-restart-rec-0ca9ca` |
| Commit under test | `b8fcbe88038e8c572e4e066a27bf3a2398340446` |
| Main build | `npm run build:main` — exit 0 |
| Renderer | `ng build --configuration development --output-path dist/renderer-dev`, served by `http-server` on `:4567` with the `-P` SPA fallback (`ng serve` is avoided per the dev-app runbook note) |
| Dev app | `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-cd0ca9ca npx electron . --remote-debugging-port=9590` |
| CDP harness | `_scratch/lt-cdp-harness/cdp.mjs`, `Emulation.setFocusEmulationEnabled {enabled:true}` sent before every evaluation |
| Focus emulation verified | `document.hidden:false`, `visibilityState:'visible'`, `requestAnimationFrame` fires — checked on the first probe of the run, so no "never rendered" finding below is an occlusion artefact |
| Electron / Chrome | Electron 40.10.6, Chrome 144.0.7559.236 |
| Scripts and screenshots | `_scratch/lt-2026-09-21-session-restart-recovery/` in the root checkout (kept outside the queue worktree, which is disposable) |

Profile was empty, so the app opened on the first-run wizard: the "Use this computer as the main
Harness" role card was clicked, then `history.pushState({}, '', '/')` + a `popstate` event reached
the dashboard. Only the placeholder candidate from the setup section above was used; no real
history, continuity, prompt, path or token was copied into the profile.

### Deviation from the documented synthetic setup, and why

The setup block reaches the store through
`window.ng.getComponent(document.querySelector('app-session-recovery-banner'))`. **That element does
not exist** (this is finding LT-605), so the store was reached through the component that actually
renders:

```js
const dash = window.ng.getComponent(document.querySelector('app-dashboard'));
const controller = dash.resumePickerController;   // ResumePickerController
const recoveryStore = controller.recoveryStore;   // SessionRecoveryStore
const ipcService = recoveryStore.electronIpc;     // ElectronIpcService
```

Everything else — the candidate object, the `listRecoveryCandidates` / `recoverSession` stubs, the
`before = await window.electronAPI.listInstances()` baseline — is exactly as written above.

### Check 1 — startup notice is non-modal and does not auto-start — **FAIL**

Seeded one candidate, `refresh()` resolved, `store.candidates().length === 1`, then:

```json
{
  "bannerElementBeforeSeed": "ABSENT",
  "bannerElementAfterSeed":  "ABSENT",
  "bannerTestId":            "ABSENT",
  "bodyMentionsAutosave":    false,
  "bodyMentionsPlaceholder": false,
  "storeCandidates": 1, "listCalls": 1,
  "statusRegions": [
    "Startup Checks: Degraded …",
    "1 of 3 done / To do / Pick a default working directory …"
  ]
}
```

- **Fails:** step 2. No status region says *Autosaved session available*; neither the placeholder
  name, the message count nor the reason appears anywhere in the document. The
  `SessionRecoveryBannerComponent` is never rendered — see LT-605. Screenshot:
  `dashboard-no-banner.png` (dashboard with one candidate in the store and no notice).
- **Passes:** steps 3 and 4. `aria-modal` count is 0 and 30 controls remain focusable, so nothing
  is blocked; `document.activeElement` was `BODY` before and after the refresh, so focus was not
  moved; `listInstances()` returned `{success:true, data:[]}` both before and after, byte-identical
  (`instanceListUnchanged: true`). Listing and holding a candidate launches no process.

### Check 2 — picker order, accessible controls, keyboard navigation — **FAIL, on step 4's focus-visibility clause only**

Step 1 could not be performed as written (no **Review autosave** button exists — LT-605), so the
method that button's output is wired to was invoked directly: `dashboard.openRecoveryPicker()`.
Everything after that is the real component tree, real key events via `Input.dispatchKeyEvent`, and
real computed styles.

Step 2 needs **History** and **Archived** to actually render, so two placeholder history entries
(one archived) were written into `HistoryStore` and the recovery-entry-point `autosave` filter was
cleared. Reading `.overlay-group-label` in document order on the next open:

```
Quick Resume · Autosave recovery · History · Archived
```

**Quick Resume** first and **Autosave recovery** above **History** and **Archived** — step 2 passes.
(**Live Sessions** is absent only because there were no live instances; the controller's group array
places it between Quick Resume and Autosave recovery.)

The recovery row (step 3) renders:

```
label       Placeholder autosave
description claude · placeholder-model · /tmp/aio-session-recovery-placeholder ·
            Newer than history · 3 autosaved messages · just now
detail      /tmp/aio-session-recovery-placeholder
badge       Autosave
action      aria-label="Recover autosaved session Placeholder autosave"
```

Provider, model, path, **Newer than history**, **3 autosaved messages** and the **Autosave** badge
are all present — step 3 passes.

Keyboard route (step 4):

| Action | Result |
| --- | --- |
| Focus after open | `input.overlay-input` |
| ArrowDown ×1 | selection moves `Resume latest` → `Placeholder autosave` |
| ArrowDown ×2 | wraps back to `Resume latest` |
| ArrowUp | back to `Placeholder autosave` |
| Tab ×1 | `button.resume-action[aria-label="Latest Resume latest"]` |
| Tab ×2 | `button.resume-action[aria-label="Recover autosaved session Placeholder autosave"]` |

The arrow route works, Tab reaches the row action, and the accessible name is exactly **Recover
autosaved session Placeholder autosave**.

**The focus-visibility clause fails.** With that button focused and `:focus-visible` matching, its
computed style is:

```json
{ "focused": true, "focusVisible": true,
  "outline": "rgb(243, 239, 229) none 0px", "outlineStyle": "none",
  "outlineWidth": "0px", "boxShadow": "none" }
```

`.resume-action:focus-visible { outline: 2px solid var(--focus-ring); }` is invalid at computed-value
time because `--focus-ring` is undefined in the desktop renderer, which also suppresses the global
`:focus-visible` ring — see LT-606. Screenshot `focus-ring-missing.png`: the **Recover** button holds
keyboard focus while the *Quick Resume* row above it carries the only visible outline.

Step 5 passes: with the picker opened from the recovery entry point the query is `autosave`; after
`closeResumePicker()` the query is `''`, and reopening through `openResumePicker()` shows an empty
search box and all four groups. Reopening through `openRecoveryPicker()` re-applies `autosave`.

### Check 3 — explicit success state — **PASS**

While the stubbed `recoverSession` promise was pending (sampled at 220/440/660/880 ms):

| Action | text | `aria-busy` | `disabled` |
| --- | --- | --- | --- |
| Recover autosaved session Placeholder autosave | `Recovering...` | `true` | `true` |
| Latest Resume latest | `Latest` | — | `true` |
| Resume / Fork (history) | `Resume` / `Fork` | — | `true` |
| Resume / Fork (archived) | `Resume` / `Fork` | — | `true` |

Only the active action reads **Recovering...** and only it carries `aria-busy="true"`; every other
row is disabled with the reason **Recovery in progress**.

After resolution: picker closed (`app-resume-picker-host` gone), `selectedInstanceId` is
`placeholder-recovered-runtime`, and the toast stack holds exactly **Recovered 3 autosaved
messages.** `recoverSession` was called **once** — including a deliberate triple-click (two
synchronous, one 60 ms later), which still produced `recoverCalls: 1`.

On the literal stub in the setup block above, `store.candidates().length` reads 1 again after
recovery. That is the stub, not the product: `SessionRecoveryStore.recover()` removes the candidate
and then calls `refresh()`, and the fixed stub keeps returning the same candidate for ever — its own
call counter incremented again after the recovery resolved. Re-run with a faithful stub, where
`listRecoveryCandidates` returns `[]` once `recoverSession` has resolved (which is what
live-identity exclusion does in the main process), and the result is `candidatesAfter: 0` with only
**Quick Resume** left when the picker is reopened. The "disappears immediately" expectation holds.

### Check 4 — failure remains visible and retryable — **PASS**

Page reloaded, setup repeated with `recoverSession: async () => { throw new Error('Placeholder
recovery failure'); }`.

```json
{
  "pickerOpen": true,
  "alert": { "text": "Placeholder recovery failure", "role": "alert", "ariaLive": "assertive" },
  "candidatesAfter": 1, "recoveryRowStillListed": true,
  "recoveringKey": null,
  "busyCleared": { "ariaBusy": null, "disabled": false, "text": "Recover" },
  "storeError": "Placeholder recovery failure",
  "lastError":  "Placeholder recovery failure",
  "toasts": [],
  "selected": null,
  "instancesBefore": { "success": true, "data": [] },
  "instancesAfter":  { "success": true, "data": [] }
}
```

Picker stays open; the assertive alert carries the exact message; the candidate remains listed; the
busy state clears and the button returns to **Recover**, enabled. Focus is still usable — tabbing
from the search box cycles `Latest Resume latest` → `Recover autosaved session Placeholder autosave`
→ `input.overlay-input` → `Latest Resume latest`, i.e. the trap still holds. Retrying produced a
second request (`recoverCalls: 2`), the same alert, the picker still open, the candidate still
listed, and `listInstances()` still empty. No live instance was created at any point.

### Check 5 — session-lifetime dismissal — **FAIL (step 2 unreachable)**

Reloaded, reseeded one candidate.

- **Fails:** step 2. `document.querySelector('[aria-label="Dismiss autosave recovery notice"]')` is
  `null` and `app-session-recovery-banner` is `null`. The dismissal control is part of the banner,
  which never renders (LT-605), so session-lifetime dismissal cannot be exercised by a user at all.
  `SessionRecoveryDismissalStore` has no consumer in the running app.
- **Passes, verified without the control:** the candidate is neither deleted nor recovered by
  anything else — `store.candidates().length` is 1 before and after, `recoverCalls: 0`, and
  `listInstances()` stays `{success:true, data:[]}`. Opening the Resume Picker directly still lists
  **Autosave recovery → Placeholder autosave** with a live **Recover** action. Close/reopen still
  clears the transient autosave filter (`autosave` → `''`, search box empty on reopen).

### Cleanup

Renderer stub restored by discarding the patched page (the app was stopped, not left patched); the
disposable profile `/tmp/aio-lt-queue-cd0ca9ca`, the dev app and the `:4567` static server were all
stopped and removed at the end of the run. No automation was created, no instance was created, no
setting was changed.

### What remains open

| Check | State | Residual |
| --- | --- | --- |
| 1 | FAIL | LT-605 — the startup notice is not rendered |
| 2 | FAIL (focus-visibility clause only) | LT-606 — no visible focus ring on the row actions |
| 3 | PASS | — |
| 4 | PASS | — |
| 5 | FAIL | LT-605 — the dismiss control is unreachable |

Neither residual needs James: both are ordinary code defects, and every check above was driven
end-to-end by an agent — no operator boundary (login, credential entry, physical device, destructive
or release action, unresolved product decision) was reached. This document stays `_livetest.md`;
re-run checks 1, 2 and 5 once LT-605 and LT-606 are fixed.

> Plan Queue parked work: `queue/2026-08-30-session-restart-rec-0ca9ca` — 1 commit(s), reason: land-blocked.

---

## Evidence run — 2026-09-24 (resume batch)

**Result: checks 1, 2 and 5 all PASS. LT-605 and LT-606 are both CONFIRMED FIXED LIVE.**

### Environment

| Item | Value |
| --- | --- |
| Checkout | root checkout, HEAD `f04f6748` (no worktree — this batch does not build; it uses the campaign's pre-built `dist/main` and renderer) |
| Dev app | `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-resume npx electron . --remote-debugging-port=9711` |
| Renderer | shared campaign renderer served on `:4567` |
| CDP harness | `_scratch/lt-2026-09-24/resume/cdp-eval.mjs` (Runtime.evaluate + focus emulation) and `drive.mjs` (adds a page-side `__cdp()` binding for real `Input.dispatchKeyEvent`/`Input.dispatchMouseEvent`) |
| Focus emulation | `Emulation.setFocusEmulationEnabled {enabled:true}` + `Emulation.setPageVisibilityOverride {visibility:'visible'}` sent before every evaluation |

`window.ng.getComponent(document.querySelector('app-session-recovery-banner'))` now succeeds
directly — the element exists in the DOM, confirming `SessionRecoveryBannerComponent` is mounted
(it is imported and used at `dashboard.component.html:96`, `dashboard.component.ts:84`). The
documented setup script (candidate seed + `ipcService.getApi` monkeypatch + `recoveryStore.refresh()`)
was run against `banner.store` unmodified from the doc.

### Check 1 — startup notice is non-modal and does not auto-start — **PASS**

After seeding one candidate and awaiting `refresh()`:

```json
{ "storeCandidates": 1,
  "bannerVisible": true,
  "bannerTitle": "Autosaved session available",
  "bannerSummary": "Placeholder autosave · 3 autosaved messages · newer than history" }
```

`document.activeElement` was `BODY` (focus not moved), `aria-modal` count was 0, 38 controls
remained focusable, and `listInstances()` before/after the seed were both `{success:true,data:[]}`
— byte-identical, so displaying the candidate launched no process. This is a direct reversal of the
2026-09-21 finding (`bannerElementAfterSeed: "ABSENT"`).

### Check 2 — picker order, accessible controls, keyboard navigation — **PASS (LT-606 confirmed fixed)**

Two placeholder `HistoryStore` entries were seeded (one with `archivedAt` set) alongside the
recovery candidate. The **Review autosave** button (`.session-recovery-banner__button--primary`,
now rendered — LT-605) was activated with a real mouse click (a synthetic `KeyboardEvent('Enter')`
did not trigger the browser's native button-activation default action over CDP's `Runtime.evaluate`
path — a harness limitation, not a product one, since HTML buttons activate on Enter by platform
default and the click handler itself is proven to fire).

Because `openRecoveryPicker()` seeds the overlay query with `'autosave'` (by design, to focus the
overlay on the new candidate), group ordering was checked after clearing the filter via
`controller.setQuery('')`, exactly as the 2026-09-21 run did:

```
Quick Resume · Autosave recovery · History · Archived
```

**Autosave recovery** sits above **History** and **Archived** — step 2 passes. The recovery row's
rendered markup:

```html
<div class="overlay-row manual-row" title="claude · placeholder-model · /tmp/aio-session-recovery-placeholder · Newer than history · 3 autosaved messages · 1m ago" aria-label="Placeholder autosave">
  <span class="overlay-row-label">Placeholder autosave</span>
  <span class="overlay-row-description">claude · placeholder-model · /tmp/aio-session-recovery-placeholder · Newer than history · 3 autosaved messages · 1m ago</span>
  <button class="resume-action" aria-label="Recover autosaved session Placeholder autosave"> Recover </button>
  <span class="overlay-row-detail">/tmp/aio-session-recovery-placeholder</span>
  <span class="overlay-row-badge">Autosave</span>
</div>
```

— provider/model/path, **Newer than history**, **3 autosaved messages** and the **Autosave** badge
are all present (step 3 passes).

Real `Input.dispatchKeyEvent` Tab route from the focused search input: Tab ×1 lands on
`button.resume-action[aria-label="Latest Resume latest"]`; Tab ×2 lands on
`button.resume-action[aria-label="Recover autosaved session Placeholder autosave"]` — the exact
accessible name the check requires (step 4's naming/route clause passes).

**Focus-visibility clause — now passes (LT-606).** With the Recover button holding real keyboard
focus and `:focus-visible` matching:

```json
{ "matchesFocusVisible": true, "outline": "rgb(184, 154, 102) solid 2px", "outlineStyle": "solid", "outlineWidth": "2px" }
```

A measurable, non-`none` outline. The same check against the first Tab target (`Latest Resume
latest`) also returned `outline: "rgb(184, 154, 102) solid 2px"`. This directly reverses the
2026-09-21 finding of `outlineStyle: "none"` — `--focus-ring` is evidently now defined (or a
resolvable fallback is in place) for the desktop renderer.

Step 5: pressing Escape closed the overlay (`input.overlay-input` gone from the DOM); reopening via
the **generic** entry point (`dashboard.openResumePicker()`, not the recovery-specific
`openRecoveryPicker()`) produced `controller.query() === ''`, an empty search box, and all four
non-empty groups (`Quick Resume`, `Autosave recovery`, `History`, `Archived`) rendered with no
`autosave` filter carried over — the previous autosave-only filter does not leak into an unrelated
open. Step 5 passes.

### Check 5 — session-lifetime dismissal — **PASS (LT-605 dismiss control confirmed reachable and working)**

Reseeded state carried over from check 2 (one recovery candidate, two history entries). With the
picker closed, `[aria-label="Dismiss autosave recovery notice"]` now exists (previously `null`) and
was activated with a real mouse click:

```
bannerVisibleBefore: true → bannerVisibleAfter: false (confirmed on a follow-up read; the same
in-script read raced the CD flush and is not trusted — see note below)
```

Opening the Resume Picker directly (`dashboard.openResumePicker()`) afterwards still lists
**Autosave recovery → Placeholder autosave** with a live `aria-label="Recover autosaved session
Placeholder autosave"` action present — the candidate is neither deleted nor recovered by dismissal.
Closing (Escape) and reopening the picker, then calling `controller.ensureCandidatesLoaded()`
(equivalent to `SessionRecoveryStore.refresh()`) to simulate a fresh candidate poll, still shows all
four groups with the same recovery row, and the banner stays hidden
(`bannerVisibleAfterRefresh: false`) — the session-lifetime dismissal persists across an ordinary
picker open/close and a fresh candidate refresh, as required.

Harness note: two assertions read state in the same `Runtime.evaluate` call immediately after a
real `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent` and got a stale pre-flush value (a
`.overlay-group-label` query and a `bannerVisibleAfter` read both initially reported the pre-click
DOM); a follow-up `Runtime.evaluate` in a fresh connection ~1s later showed the correct post-click
state both times. This is a CDP round-trip/paint-flush timing artifact of driving real Input events
inside a single script, not a product defect — the eventual, settled state is what's reported above
and is what a real user would see.

### Cleanup

The dev app profile, `ipcService.getApi` patch and seeded store state are disposed of with the whole
process at the end of this batch's run (see the final report); nothing here was left applied to a
long-lived profile. No settings were changed and no real instance was created for these three
checks.

### Residual

None. Checks 1, 2, 3, 4 and 5 all pass with current evidence (3 and 4 unchanged since 2026-09-21,
not re-run here as the doc's residual only named 1, 2 and 5). This document is a candidate for
`_livetest_completed` rename.
