# RLM Maintenance UI Fixes — Live Test

Source plan: [2026-07-12-rlm-maintenance-ui-fixes-plan_completed.md](./2026-07-12-rlm-maintenance-ui-fixes-plan_completed.md)

## Prerequisites

- Rebuild and restart the Electron app from the completed implementation (`npm run build`, then launch the rebuilt app), or run a fresh development instance with `npm run dev`.
- Use a disposable local profile whose RLM database is above the warning threshold and contains maintenance-eligible stale session stores.
- Keep one stale store available for the reload-during-run check; perform that check before the completed-cleanup check if the dataset has only one eligible store.
- No feature flags or non-default settings are required.

These checks are deferred because they require a restarted Electron renderer, real renderer lifecycle events, and a maintenance run against an on-disk RLM database. The store and component behavior is covered in-loop by automated tests.

## 1. Terminal success replaces progress

1. Open a chat showing the **RLM storage needs maintenance** warning.
2. Select **Review cleanup**.
3. Select **Back up, prune & compact** and wait for the run to finish.
4. Inspect the terminal modal state.

Expected result: the modal shows **Cleanup completed and verified**. No spinner, progress row, or **Complete** progress label is visible.

## 2. A new chat does not reopen a terminal result

1. Complete check 1 and close the maintenance modal.
2. Create a new chat.
3. Wait for the new loop-control panel to finish mounting.

Expected result: the maintenance modal does not open. A persisted success or failure result remains available to the store but does not trigger the modal.

## 3. Renderer reload restores an active run

1. Start another maintenance run from **Review cleanup**.
2. While an in-flight stage such as **Backing up**, **Pruning**, or **Compacting** is visible, reload the renderer with **Command+R**.
3. Wait for the renderer to remount.

Expected result: the maintenance modal opens automatically, shows the current live progress stage and spinner, and remains non-dismissible until the run reaches a terminal state.

## Evidence run — 2026-07-12

**Status: PARTIAL; Check 3 failed in the packaged app.** Two disposable profile runs used an APFS
copy of the real pre-cleanup database. The warning and modal appeared, maintenance entered a
live stage with a spinner, and both runs completed successfully, compacting approximately
11.32 GB to 1.75 GB with verified backups.

During the in-flight reload check, the renderer remounted with no selected instance even though
the live Codex instance still existed in the main process. Consequently no `app-loop-control` or
`app-rlm-storage-maintenance` component mounted, and the active maintenance modal did not reopen.
The main-process operation completed safely, but the required restored modal/spinner was absent.
Keep this document pending until the maintenance UI is mounted independently of selected-instance
state (or selection is restored before status recovery) and the packaged check is rerun.

## Evidence review — 2026-07-13

**Status remains PARTIAL; Check 3 is still structurally blocked.** The current renderer continues
to mount `app-rlm-storage-maintenance` through `app-loop-control`, and loop control is only mounted
inside the selected-instance/chat detail path. After a renderer reload with no selected instance,
the component responsible for recovering and displaying the active maintenance run therefore still
does not exist. The disposable production-clone evidence above remains valid for Checks 1 and 2,
but the failed reload-recovery result has not been fixed and cannot be marked complete. No additional
cleanup was started against the production profile.

## Fix implemented — 2026-07-16

The structural block behind Check 3 was fixed by mounting the maintenance modal independently of
selected-instance state, rather than only through `app-loop-control`.

- `rlm-storage-maintenance.component.ts` — the component's two surfaces are now gated by inputs
  `showWarning` (the inline storage-health banner) and `showModal` (the dialog overlay), both
  defaulting to `true`. Focus-return capture moved into the dialog `@ViewChild` setter so it works
  regardless of which host opened the modal (and covers the reload-recovery path).
- `app.component.html` / `app.component.ts` — the app shell now mounts one always-present
  `<app-rlm-storage-maintenance [showWarning]="false" />`. This shell instance owns the modal + the
  `restoreStatus()` reload recovery, so an in-flight run's dialog survives a renderer reload even
  with no selected instance.
- `loop-control.component.ts` — its instance now sets `[showModal]="false"`, keeping only the
  contextual inline warning banner (still passing `loopRunId`) and avoiding a duplicate overlay.
- `rlm-storage-maintenance.store.ts` — `openPreview()` remembers the initiating `loopRunId`, and
  `run()` falls back to it, so a run started from the shell-mounted modal (which has no `loopRunId`
  of its own) still resumes the correct initiating loop.
- Unit/component specs updated: store test for the remembered `loopRunId`; component tests for the
  two surface modes (banner-only and modal-only). All targeted specs pass, plus `tsc`, `tsc -p
  tsconfig.spec.json`, and lint are clean for the changed files.

## Evidence run — 2026-07-16

**Status: PASS. All three checks verified end to end against a disposable local profile; the fix
resolves the Check 3 structural block.**

Harness (never the production `harness` profile): an APFS copy-on-write clone of the dev
`harness-dev` profile was placed at a disposable path, and its RLM database was inflated to a valid
**10.37 GiB** SQLite file (`page_count 2,718,613 × 4 KiB`, between the 10 GiB warning and 12 GiB
hard-limit thresholds → health level `warning`) holding live content plus nine stale,
non-protected, non-`codebase-auto` session stores (eligible for pruning). A second dev Electron
instance was run against that disposable profile (isolated userData, its own single-instance
identity, reusing the dev renderer server) and driven over the Chrome DevTools Protocol. James's
real `harness-dev` profile was cloned read-only and never written to; the production `harness`
profile was never touched. The two small, dev-only startup shims used to launch the isolated
instance (`AIO_DEV_USER_DATA_PATH` userData override + single-instance-lock bypass, both guarded to
unpackaged builds) were reverted after the run, so the committed change set is exactly the RLM UI
fix. The disposable profile was deleted afterward.

Throughout every check the renderer had **no selected instance** (`app-loop-control` count = 0) and
only the shell-mounted `app-rlm-storage-maintenance` was present (count = 1) — i.e. the exact
condition that previously lost the modal. The modal was opened via the store's `openPreview()`,
which is the identical call the inline banner's **Review cleanup** button makes; a live provider
instance for the banner itself was unavailable in the disposable harness without spawning provider
CLIs, and the banner/`loop-control` mounting path is covered by the component unit tests.

**Check 1 — terminal success replaces progress: PASS.** With no instance selected, opening the
preview showed the dialog with `canRun = true` and 9 eligible stores. Starting **Back up, prune &
compact** drove a real maintenance run: the in-flight frame showed the spinner and the live stage
"Backing up — Creating and verifying a database and content backup", and the dialog was
non-dismissible (no close/× control). On completion the modal showed **Cleanup completed and
verified** with **no** spinner and **no** progress row (no residual "Complete" progress label). The
success payload confirmed real work: `storesDeleted 9`, a verified 10.37 GiB backup written to the
disposable `rlm/backups`, one old backup pruned, database vacuumed, `databaseHealthy true`.

**Check 2 — a new mount does not reopen a terminal result: PASS.** With the terminal success
persisted in the main process (`getMaintenanceStatus` → `success`), the renderer was reloaded so the
maintenance component remounted and its `ngOnInit` ran `restoreStatus()`. The modal did **not**
reopen (`modal-backdrop` absent); the store received the terminal result (`result.status ===
'success'`) without opening the modal. (This exercises the same `restoreStatus()` terminal-status
path a freshly mounted loop-control panel would hit for a new chat.)

**Check 3 — renderer reload restores an active run: PASS.** With no instance selected, a second
maintenance run was started and, while the main process reported status `running` and the dialog
showed the in-flight "Backing up" spinner, the renderer was reloaded (the Command+R renderer
reload, issued via the DevTools protocol). After the remount — still with `app-loop-control` count =
0 — the shell-mounted modal **auto-reopened**, showing the live stage "Backing up — RLM storage
maintenance is in progress" with the spinner, and remained non-dismissible (no close/× control). The
run then reached a successful terminal state. This is precisely the scenario recorded as
structurally blocked on 2026-07-12 and 2026-07-13, now working.

Screenshots and the driver scripts from this run are under `_scratch/livetest/` (gitignored scratch;
not part of the change set).
