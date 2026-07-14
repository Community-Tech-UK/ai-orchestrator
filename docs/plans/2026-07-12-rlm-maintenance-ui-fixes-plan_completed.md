# RLM Maintenance UI Fixes — Plan (2026-07-12)

Two confirmed renderer bugs in the "Clean up stale RLM sessions" flow. Both root causes
were verified by reading the executing code paths; file:line references below are current
as of this date.

**Scope: exactly the two bugs below. No backup-retention work, no search-index work, no
main-process behaviour changes.** The main-process service is correct; both fixes live in
the renderer store/component plus their specs.

## Affected files

- `src/renderer/app/core/state/rlm-storage-maintenance.store.ts` (both fixes)
- `src/renderer/app/features/loop/rlm-storage-maintenance.component.ts` (defensive template guard)
- `src/renderer/app/core/state/rlm-storage-maintenance.store.spec.ts`
- `src/renderer/app/features/loop/rlm-storage-maintenance.component.spec.ts`

Read all four files in full before editing, plus the shared types in
`src/shared/types/rlm-maintenance.types.ts` (the `RlmMaintenanceResult` union has
`running` / `success` / `failed` variants) and the main-process counterpart
`src/main/rlm/rlm-storage-maintenance.ts` (context only — do not edit it).

---

## Bug A — spinner keeps spinning next to "Complete"

### Root cause (verified)

1. The backend emits a final progress event with stage `'complete'`
   (`src/main/rlm/rlm-storage-maintenance.ts:226`).
2. The store's progress subscription (`rlm-storage-maintenance.store.ts:43-51`) stores that
   event in the `progress` signal and never clears it.
3. The template (`rlm-storage-maintenance.component.ts:75-80`) renders the animated
   `.spinner` whenever `store.progress()` is non-null, with no terminal-stage check. Result:
   a permanently spinning spinner labelled "Complete" sitting above the success panel.

### Behaviour contract after the fix

The progress panel (spinner + stage label) is visible **only while a run is in flight**.
Once a terminal result (success or failed) is displayed, the progress panel is gone — the
result panel is the terminal state's sole representation.

### Changes

1. **Store — clear `progress` whenever a terminal result lands:**
   - In `run()`: after `this.result.set(response.data)`, add `this.progress.set(null)`.
     Also clear it on the error paths of `run()` (when `error` is set instead of a result)
     so a failed IPC call doesn't strand a stale progress panel.
   - In `restoreStatus()`: when the fetched status is `'success'` or `'failed'`, set the
     result **and** clear `progress`. (This is the path that runs when the progress
     listener sees a terminal stage — see store lines 46-49.)
2. **Component — defensive template guard:** render the progress block only when
   `progress.stage !== 'complete' && progress.stage !== 'failed'`. This keeps the UI
   correct even if a future code path forgets to clear the signal.

## Bug B — modal re-opens on every new chat

### Root cause (verified)

1. Main-process `getStatus()` (`src/main/rlm/rlm-storage-maintenance.ts:95-99`) returns
   `lastResult` indefinitely after a run finishes. That is intentional and stays.
2. `restoreStatus()` (`rlm-storage-maintenance.store.ts:127-139`) sets
   `modalOpen.set(true)` whenever *any* status comes back — including an old success.
3. The component is mounted inside `loop-control.component.ts:107`, and `ngOnInit` calls
   `restoreStatus()`. So every newly created chat/loop panel re-opens the modal showing
   the stale success report.

### Behaviour contract after the fix

- On mount, the modal auto-opens **only** when a maintenance run is currently in progress
  (`status === 'running'`) — that restores the live view after a renderer reload mid-run.
- Terminal results never auto-open the modal on mount.
- When a run finishes while the modal is open, the result panel must still replace the
  progress panel (this is the same `restoreStatus()` call, triggered by the progress
  listener) — so the result must still be stored; only the `modalOpen` side effect becomes
  conditional.
- Deliberate behaviour decision: if the user closes the modal mid-run, completion does
  **not** force it back open. The storage warning banner refresh (already wired via
  `refreshHealth()`) reflects the new state.

### Changes

In `restoreStatus()`:

- `status === 'running'` → `busy.set(true)`, `modalOpen.set(true)`. Do not set `result`
  (the running variant isn't rendered by the result panel anyway).
- `status === 'success' | 'failed'` → `result.set(data)`, `progress.set(null)` (Bug A),
  `busy.set(false)`, and **do not touch `modalOpen`**.

## Tests

Update/add in the two spec files (both exist; read them first — one existing test at
`rlm-storage-maintenance.store.spec.ts:76-79` currently asserts `modalOpen() === true`
after `restoreStatus()`; check which status variant it feeds and align it with the new
contract rather than deleting it):

1. Store: `restoreStatus()` with a `running` status → `busy` true, `modalOpen` true.
2. Store: `restoreStatus()` with a `success` result → `result` set, `modalOpen` **false**
   (fresh store), `progress` null, `busy` false.
3. Store: full run — `run()` resolves after a `'complete'` progress event → `progress()`
   is null, `result()` is the success payload.
4. Store: `run()` IPC failure → `error` set, `progress` null.
5. Component: with a success result and no progress, no `.spinner` element exists in the
   DOM; with an in-flight progress event (e.g. stage `'pruning'`), the spinner exists.
6. Component: mount with a persisted terminal status → modal is not rendered.

## Verification

1. Targeted: `npm run test:quiet -- src/renderer/app/core/state/rlm-storage-maintenance.store.spec.ts src/renderer/app/features/loop/rlm-storage-maintenance.component.spec.ts`
2. Full canonical checklist (tsc, tsc spec, lint, ts-max-loc, test:quiet) per AGENTS.md.
3. Live check (requires rebuilt/restarted app — defer via `_livetest.md` per convention):
   - After a completed cleanup, the modal shows the success panel with **no** spinner.
   - Starting a new chat does **not** re-open the modal.
   - Reloading the renderer *during* a run re-opens the modal with live progress.
