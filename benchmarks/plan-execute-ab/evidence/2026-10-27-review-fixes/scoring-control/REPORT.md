# Diagnostic scoring control, 27 October 2026

Status: the amended AIO-01 ordering control is demonstrated. Global task scoring is not repaired, and no archived agent patches have been rescored.

The historical live-test document called the defect LT-711. The current remediation register corrects that identifier to LT-1002. The new test title deliberately contains neither identifier. Historical receipts and the exploratory first amendment retain their original wording.

## Root cause and executing path

At parent `f04f674859b220b86eeb52662129072008573af9`:

- `src/main/history/history-manager.ts:140-157`: construction starts real asynchronous identity backfill, then orphan recovery, and exposes the resulting `startupTasks` promise. Auto-import is skipped by the existing Vitest environment guard.
- `history-manager.ts:745-804,1647-1693`: loading a legacy entry creates a history identity in memory; startup persists it through a compressed temporary-file write and rename, saves the index, then runs orphan recovery.
- `history-manager.ts:703-704`: `clearAll` immediately enters `createSafetyBackup` without waiting for startup.
- `history-manager.ts:1696-1697,1709`: backup calls `fs.promises.readdir` before its first suspension, then eventually calls `fs.promises.cp`.
- `history-manager.ts:706-724`: clearing deletes conversation files and saves the empty index. A startup write can land after deletion and orphan recovery can restore the entry.
- `src/main/ipc/handlers/session-handlers.ts:520-528`: the registered history-clear handler awaits `history.clearAll()`. `src/main/ipc/ipc-main-handler.ts:297-302` registers these session handlers. This is an application path, not a test-only method.

Fixed commit `8b9721bf3c55e69259b6be4880b3acff91b68b16` changes clearAll to await `this.startupTasks` before creating the backup. The exact source hashes are in `source-seal-v2.json`.

The archived fixed spec at `src/main/history/history-manager.spec.ts:238-267` holds the real startup temp-file write, calls clearAll, drains ten Promise.resolve turns, checks that cp has not run, then releases startup. The parent has already entered backup, but it is waiting on a real asynchronous directory read. Draining only promise callbacks cannot establish whether that disk operation has finished. The negative assertion can therefore pass on broken code. After release, the final file-presence check depends on disk ordering. The retained 27 October receipt with both versions passing remains valid historical evidence; this investigation does not replace it.

## Amendment and controls

Use `held-back-ordering-amendment-v2.patch`. It only adds a new test to the archived fixed spec. The entire historical spec, including the original startup-race test and every assertion, remains unchanged and recoverable. `source-seal-v2.json` verifies this preservation and seals original, amended, and source hashes.

The new test:

1. Holds the actual startup temporary-file write at the same real filesystem boundary.
2. Places a test-only thenable observation bridge on the public startupTasks property. The bridge delegates to the original pending startup promise; it does not complete, replace, or skip the real startup work.
3. Observes a directory read while startup is held. Orphan recovery cannot yet run, so that read is backup entry.
4. Waits for a positive event: either clearAll awaits startup, or backup enters too early. Arbitrary microtask delays cannot make this race finish successfully without an actual startup wait.
5. Retains the early-entry violation flag, checks copy only occurs after the real startup promise settles, verifies the copied index and compressed conversation contain the same migrated identity, and checks active disk and in-memory history are empty.
6. Releases and awaits both startup and clearing in finally before restoring spies, including on assertion failure.

No sleeps, timers, fixed microtask counts, suppressed errors, or modified production code are used by the amended test. The separate mutation fixture deliberately adds only `await Promise.resolve()` to the broken parent. Its patch is retained as `microtask-only-bogus-fix.patch`.

| Control | Result | Evidence |
| --- | --- | --- |
| Original archived parent, repeat 1 | 39 passed, 1 failed: file returned after deletion | parent-original-1.receipt.json |
| Original archived parent, repeat 2 | 38 passed, 2 failed: both historical race assertions | parent-original-2.receipt.json |
| Original fixed, both repeats | 40 passed | fixed-original-1/2.receipt.json |
| V2 amended parent, repeat 1 | 38 passed, 3 failed; new test fails for backup-entry instead of startup-wait | parent-amended-v2-1.receipt.json |
| V2 amended parent, repeat 2 | 39 passed, 2 failed; same intended new-test failure | parent-amended-v2-2.receipt.json |
| V2 amended fixed, both repeats | 41 passed | fixed-amended-v2-1/2.receipt.json |
| V2 amended parent with only a meaningless promise delay | 40 passed, only the new ordering test fails | microtask-only-parent-amended-v2-1.receipt.json |

The parent's other failures are manifestations of the same known startup race. They were retained and investigated rather than dismissed. The mutation run isolates the new test's discriminatory result: all forty archived tests passed, while the new control rejected the bogus delay.

The first amendment is retained as exploratory V1 evidence. It observed only the immediate directory read and could miss an arbitrary promise delay. Do not use V1 for rescoring. All V2 runs preserve complete JSON runner output and verbatim failure stacks alongside command, exit status, hashes, and test counts. `summary-v2.json` consolidates the final control receipts.

## Environment and limits

Node v26.12.1 and owned Vitest 3.2.7 were used. The runner was installed inside owned scratch with install scripts disabled. Each historical export had its own node_modules directory containing read-only package links; the assigned checkout and root dependency directories were never modified. Archived Vitest config, aliases, zone setup, and jsdom environment were retained. The direct compatible Vitest CLI bypasses the archived quiet wrapper's package-subpath loader error. Every listed control ran real assertions; a loader error was not counted as a task or model failure.

This is a unit-runtime control, not a clean historical-manifest installation. Other packages came from the existing checkout. `dependency-context.json` records exact resolved package versions and hashes. In particular, the archived manifest requests MSAL ^5.4.2 while the available installed graph differs. The historical scoring receipts also report MSAL/type declaration errors and a Vitest poolOptions type error; these are separate damage-check/environment failures, not results of this amended ordering test. No new full historical typecheck, native dependency rebuild, app build, full repository suite, browser/UI test, model call, or cloud call was run here. No claims about those gates follow from these unit-test controls.

## Exact rescore contract

For any recovered AIO-01 patch, export its declared parent, apply that agent patch, overlay the original fixed held-back spec from `8b9721bf3c55e69259b6be4880b3acff91b68b16`, then apply `held-back-ordering-amendment-v2.patch`. Use the same pinned Vitest3.2.7 CLI, archived config/setup, and dependency arrangement as the controls. Record the candidate patch hash, resulting source/spec hashes, exact command, runner JSON, exit code, and failure stacks. The direct command is the command array in any V2 receipt; adjust only the explicit workspace and output paths. Establish separate dependency/typecheck damage gates with a sound historical dependency graph before accepting a solved score.

Keep the original score and records immutable; write an explicitly versioned amended score. Missing archived patches cannot be reconstructed from printed score summaries, so they remain unrescored. The task bank and runner were not changed by this investigation.

## Reproduction after cleanup

The retained `run-control-v2.py` is the exact executed harness. Its relative-root calculation expects it at `_scratch/lt-scoring-review/run-control.py`. Recreate only that owned scratch folder; copy `tooling-package.json` and `tooling-package-lock.json` to its `tooling/package.json` and `tooling/package-lock.json`, then run `npm ci --ignore-scripts --no-audit --no-fund` there. Copy the harness to the stated scratch location. To preserve this evidence, change only its EVIDENCE assignment to `EVIDENCE = SCRATCH / 'reproduction-evidence'` before running it from the repository root with `rtk proxy python3 _scratch/lt-scoring-review/run-control.py`. The replay exports parent/fixed/mutation fixtures without creating Git branches or worktrees. It expects a fresh scratch directory and retains fixture sources until explicitly cleaned.

The executed full baseline harness is also retained as `run-control.py`, along with the lockfile, installation receipt, source seals, patches, and raw control results. Owned exported trees and the temporary installation are removed only after evidence is written; `cleanup.receipt.json` records that removal. These control results require independent review before adoption.
