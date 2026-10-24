# Live-test failure remediation follow-up

**Coordinator note (23 Oct) - the queued document path is intentionally stale; do not "fix" it by recreating the old
name.** This plan was renamed from `2026-07-19-livetest-failure-remediation_plan.md` to this `-followup` name because
the old name's `_completed` target is the historical July campaign plan (kept intact; its register anchors must not
move). The queue item still records the old path, so the queue's automatic document close cannot run for it. The
coordinator lands this item's code through the operator landing path and closes THIS document by hand as
`2026-07-19-livetest-failure-remediation-followup_plan_completed.md`. Workers must not recreate the old colliding
path or rename this file back.


On main: no.

Status: active. This follow-up is untracked; the prior July remediation plan is closed.
The LT-707 recovery flow is implemented in the working tree; all verifier findings to date
are fixed and recorded below ("Verification round 1 fixes", "Verification round 2 fixes",
"Post-merge landing gate", "Verification round 4 fixes"). Fresh completion gate on the
recovery flow, James's rebuilt-app run and live acceptance are pending.
Register: [livetest-remediation-register.md](livetest-remediation-register.md)
(LT-707 index row and detail added in the working tree).
Live checks: [live-test document](2026-07-19-livetest-failure-remediation_plan_livetest.md).

## LT-707

- Reproduced read-only on 20 October 2026: 913 post-cutoff Claude rows in the A0 backup,
  338 altered, $4,477.68108546 original versus $3,801.443054555 current.
- Prevention: implemented in the Phase A working tree; regression verification and
  fresh review remain owned by [Phase A](2026-10-20-oct2-phaseA-safety-and-truth_plan.md).
- Existing-history restoration: **implemented in the working tree on 23 October 2026 as a
  separately scoped, atomic and idempotent application maintenance flow with
  isolated-fixture tests. Not run against real history and not authorized to run except by
  James's explicit action in a rebuilt app.** No ad-hoc data writes. As-built below.
- Fresh completion gate on the recovery flow: owed to the independent verifier.
- James-controlled rebuilt-app execution: pending — exact procedure in the
  [live-test document](2026-07-19-livetest-failure-remediation_plan_livetest.md).
- Live acceptance: pending, recorded in Phase A's live-check document.

### As-built (23 October 2026)

Queue worktree `queue/2026-07-19-livetest-failure-re-ffb4df` (base `1ee52cbd8`); changes are
left uncommitted there for the coordinator.

- `src/main/core/system/cost-entries-a0-restore.ts` — the maintenance flow.
  `restoreCostEntriesA0Backup` restores only affected Claude rows (alias models or
  attribution-tagged Claude, at/after the install's Claude per-turn boundary) from
  `cost_entries_a0_backup`, writing back only the fields the old repair rewrote. Correctly
  differenced cumulative-era rows, Copilot/Cursor ("reseller") corrections and rows booked
  after the repair are never touched; non-alias rows are classified with provider evidence
  frozen at the `a0-cost-deltas` repair time and ambiguous classifications fail closed (see
  the round-2 fixes below). Each row about to be written is snapshotted into
  `cost_entries_a0_restore_backup` first, so `rollbackCostEntriesA0Restore` can undo the run;
  snapshot, writes and the `a0-cost-restore` marker commit in one transaction.
  `inspectCostEntriesA0Restore` reports read-only before/after totals over the whole checked
  scope plus the count of rows that fail closed (`unverifiedRows`). The boundary resolves
  from the install's first Claude purpose receipt: the audited install's documented start
  (17 Oct 2026 08:31:19 BST, epoch 1792222279000) is recognised exactly by its recorded
  first receipt, other installs get the 1,000 ms booking/receipt margin — the same rule
  Phase A's prevention resolves (see the integration note below). Missing attribution
  evidence fails closed (`missing-cutoff`). The flow is deliberately never invoked at startup.
- `src/main/core/system/cost-entries-a0-restore.spec.ts` — isolated in-memory fixtures that
  reproduce the LT-707 damage with the pre-fix repair, then assert: narrow restoration of only
  the affected rows (backup originals intact, reseller corrections and newer bookings
  preserved, totals verified before and after), idempotence (second run writes nothing),
  rollback and re-restore, atomic failure (snapshot, writes and marker roll back together,
  then a clean retry), inclusive cutoff boundary behaviour, boundary resolution (audited
  fingerprint and generic margin), attribution-evidence parsing and the missing-evidence
  refusal.
- IPC: `cost:history-restore-status`, `cost:history-restore-apply`,
  `cost:history-restore-rollback` — contracts channel entries, trusted-sender-gated handlers
  in `src/main/ipc/handlers/cost-history-restore-handlers.ts` (registered from
  `ipc-main-handler.ts`), preload domain `src/preload/domains/cost-history-restore.preload.ts`;
  `src/preload/generated/channels.ts` regenerated with `npm run generate:ipc`. Apply and undo
  reload the live `CostTracker` cache after their database write (see the round-1 fixes
  below) so cost surfaces serve the restored values without a restart.
- Renderer: `CostHistoryRestoreComponent` on the Costs page (read-only status preview,
  confirm step before applying, outcome messages, "Undo last restoration") driven through
  `CostIpcService`; component spec included, and `cost-page.component.spec.ts`'s IPC mock
  gained the three maintenance methods.
- Register: LT-707 index row and detail section added; prevention recorded there as Phase
  A-owned, recovery as this work.

### Verification round 1 fixes (23 October 2026)

The independent verifier rejected round 1 with three findings. All three are fixed in the
same worktree; each fix is test-covered in-loop.

1. **CostTracker cache staleness (high)** — apply and undo mutated only the raw database,
   while `getSummary`/`getEntries`/`getBudgetStatus` serve an in-memory window, so cost
   summaries, history and budgets stayed wrong until restart (and re-attaching via
   `setDatabase` would have flushed the stale cache over the repair). Fix:
   `CostTracker.reloadFromDatabase()` — a read-only rehydrate that replaces the cached
   window from the database and never writes (contrast `setDatabase`, which flushes first) —
   called synchronously after `restoreStoredCostEntriesA0Backup` and
   `rollbackCostEntriesA0Restore` in `cost-history-restore-handlers.ts`. Coverage:
   `cost-history-restore-handlers.spec.ts` drives apply and undo through the real handlers
   against an isolated damaged-history fixture and asserts the tracker total equals the
   database total after each action (and that the database keeps the repaired/rolled-back
   values — the guard against a flushing reload); `cost-tracker.spec.ts` locks the read-only
   property directly.
2. **Spec typecheck red (high)** — `npm run typecheck:spec` failed with three TS2493 errors
   (no-arg `vi.fn` mocks indexed at `mock.calls[n][0]`): `low-disk-space-watcher.spec.ts`
   (x2) and `scratch-sweep-scheduler.spec.ts`. Inherited from the base, not introduced here,
   but the gate must be green. Fix: type the `notify` mocks with their real
   `NotificationInput` parameter. Gate now exits 0.
3. **Environment-blocked suite gate (high)** — the full-suite run in the verifier's
   environment hit two environment blockers, not restoration regressions: (a)
   `dependency-compatibility.spec.ts` rejected the shared root install because the root
   checkout's `package.json` had drifted in `scripts` only while `package-lock.json` matched
   byte for byte; (b) `sea-build-repeatability.spec.ts` spawned the verifier's Homebrew
   Node 26.3.0, which lacks the Node SEA fuse (`scripts/sea-build-support.ts`) that the SEA
   build scripts require (`.nvmrc` pins v24.15.0). Fixes: (a) `manifestDrift` now compares
   `package-lock.json` byte for byte and `package.json` only on the fields npm resolves the
   dependency graph from (`MANIFEST_RESOLUTION_FIELDS`) — scripts and other metadata cannot
   change the installed graph, while dependency-field drift and unparseable JSON still fail
   closed (contract-cases added to the linked-worktree test); (b) the SEA suite skips when
   `canBuildSeaWithNode()` is false, mirroring the build scripts' own fail-fast capability
   gate — verified under the verifier's exact Homebrew Node (2 skipped) and under nvm
   v24.22.0 (2 ran and passed).

Targeted evidence (23 October 2026, this worktree, round 1): the 9 touched/related test
files pass (84 tests: restore flow, restore handlers, tracker, cost handlers, both storage
specs, dependency-compat, SEA repeatability + support); `npx tsc --noEmit` 0 errors;
`npm run typecheck:spec` exit 0; `npm run lint` clean; `npm run check:ts-max-loc` exit 0
(pre-existing tolerance notes only); `npm run build:main` and `npm run build:renderer`
succeed. The full suite was reserved for the verifier's completion gate in that round.

### Verification round 2 fixes (23 October 2026)

The independent verifier rejected round 2 with three findings. All three are fixed in the
same worktree; each fix is test-covered in-loop.

1. **Provider evidence not frozen at the repair time (high)** — `readA0AttributionEvidence`
   classified each (instance, model) key by the latest attribution record in the log, so
   receipts written *after* the `a0-cost-deltas` repair could reclassify rows the repair had
   already written (provider switching preserves instance ids). A post-repair Claude receipt
   over Copilot-corrected rows made recovery restore their backup originals, undoing the
   reseller correction. Fix: classification is now frozen at the repair's own completion time
   (`readA0RepairCompletedAt` reads the `a0-cost-deltas` marker). Only records placed at or
   before that time count; later receipts are ignored and cannot change history. A key fails
   closed — absent from the frozen map, so its rows are never written — when its pre-repair
   tags conflict, when a tag cannot be placed in time (missing timestamp), or when the repair
   marker is missing entirely (alias models keep the repair's deterministic short-circuit and
   still restore). Fail-closed rows are disclosed: `inspectCostEntriesA0Restore` reports
   `unverifiedRows` and the Costs card renders "N rows cannot be identified as affected
   Claude rows with confidence, so they stay as they are." only when N > 0. Coverage in
   `cost-entries-a0-restore.spec.ts`: the verifier's smoke (pre-repair Copilot rows + later
   Claude receipt → reseller corrections preserved, nothing written), the reverse (pre-repair
   Claude + later Copilot receipt → rows still restored), conflicting pre-repair tags and
   unplaceable tags (both refused, counted), missing repair marker (alias rows restore,
   evidence keys fail closed), and a unit-level freeze matrix over the evidence reader.
2. **Deferred live-check expected whole-scope dollars from a changed-row summary (medium)** —
   the live-check's step 3 required "Restored 338 rows ($3801.44 → $4477.68)", reusing step
   2's sums over all 913 checked rows, but `restoreCostEntriesA0Backup` accumulates
   `beforeUsd`/`afterUsd` only over the rows a run changes and the component renders those
   directly. Fix: the summary semantics are kept (changed-row totals, now documented on
   `CostRestoreSummary`/`CostRestoreRollbackSummary`) and the live-check is aligned: step 3
   states the contract, requires a read-only query summing only the differing rows before the
   click, and pins the invariants (338 rows; $B − $A equals the step-1 reduction
   $676.238030905). Integration coverage now pins the same contract: the component spec's
   apply mock returns changed-row totals deliberately different from the preview's
   whole-scope pair (a message borrowing the wrong pair fails the test), the handlers spec
   asserts apply/undo dollars equal the single changed row's totals (0.15 → 0.45) and not
   the scope's (1.7 → 2), and the restore spec's existing pairs now carry the contract
   comment.
3. **Full-suite gate red on an inherited flaky fixture (high)** — `npm run test:quiet`
   exited 1 in the verifier's run: `default-loop-native-finality.spec.ts` 'partial-zero'
   failed `expect(finalWritten).toBe(true)` while a focused rerun of the same 8 tests passed
   (timing sensitivity, not a restoration regression; the spec is inherited unchanged from
   the base). Root cause: the fixture child wrote its final result and its FINAL_WRITTEN
   marker through async write callbacks while the parent SIGKILLs at its 150 ms timeout, so
   a child process starved under parallel test load could be killed before its writes
   completed. Fix (fixture only, no production code): the child's final result and marker are
   synchronous writes in one turn — SIGKILL can only land before or after both — and the
   timeout kill window is 1,000 ms (adapter config and the iteration payload together). The
   child's 25 ms inter-write delay, the pause structure, `activeTimeoutMs: 25`, the SIGKILL
   assertion and the partial-capture semantics under test are unchanged. Evidence: focused
   8/8 twice (11.1 s / 10.9 s), and a full `npm run test:quiet` run green (see below).

Targeted evidence (23 October 2026, this worktree, round 2): the 6 touched test files pass
(103 tests: restore flow incl. the new freeze regressions, restore handlers, cost tracker,
cost-history restore component, cost page, native finality — 8/8 in two focused runs);
`npx tsc --noEmit` 0 errors; `npm run typecheck:spec` exit 0; `npm run lint` clean;
`npm run check:ts-max-loc` exit 0 (pre-existing tolerance notes only);
`npm run check:ui-hints` clean; `npm run build:main` and `npm run build:renderer` succeed;
`npm run generate:architecture` refreshes the inventory (its only drift was a line count
from the main merge). The full suite — owed as finding 3's own evidence, not reserved for
the verifier this round — passes: `npm run test:quiet` 2,743 files / 34,931 tests green in
405.9 s, exit 0 (run log `_scratch/test-run.pid-42625.log` in the worktree).

### Post-merge landing gate (23 October 2026)

The landing `git commit` (repository pre-commit hook) refused after the base merge with 22
failures across four real-worker fixture specs (`cli-worker-failed-usage.spec.ts`,
`cli-worker-resident-cost.spec.ts`, `cli-worker-cancelled-usage.spec.ts`,
`claude-direct-failed-usage.spec.ts`) — every one
`Cannot find module '.../dist/main/cli/spawn-worker/cli-spawn-worker-main.js'` or
a consequence of the worker never starting. Cause: the squash's staged set pulls those specs
into `test:staged`, and they intentionally spawn the compiled `build:main` worker artifact
(their documented precondition is "Run after build:main"; the oct-phase0 plan records the
identical 22-failure signature as environmental in a never-built worktree). This worktree
had no `dist/` output at hook time. Fix (environment only, no code change): `npm run
build:main` in the worktree, producing `dist/main/cli/spawn-worker/cli-spawn-worker-main.js`.
Re-run evidence: the five dist-dependent spec files pass (5 files / 63 tests), and the
hook's `test:staged` step re-run over the landing squash's exact staged-source selection
(21 files, computed with `test-staged.js`'s own filter) is green — 586 test files / 9,814
tests; the full pre-commit hook body (`node scripts/run-git-hook.js pre-commit`) is green
(lint:fast, generate:aliases, generate:ipc, generate:architecture, check:ts-max-loc).
`npx tsc --noEmit` 0 errors; `npm run typecheck:spec` exit 0; `npm run lint` clean.
`npm run generate:architecture` refreshes the tracked inventory (its only drift was the
register's line count after the base merge); generators are otherwise idempotent. Standing
precondition for this gate in any worktree: run `npm run build:main` before the suite (the
AGENTS.md canonical checklist already orders it before `test:quiet`).

### Verification round 4 fixes (23 October 2026)

The independent verifier rejected round 4 with three findings (its round-4 list, formerly at
the top of this file). All three are fixed in the same worktree; each fix is test-covered
in-loop and no production-code change was needed for finding 1.

1. **Fixture cleanup flaked the full-suite gate (high)** — `provider-runtime-diagnostics.spec.ts`
   intermittently failed at its `fixtures.cleanup()` (the timeout test's `finally`) with
   `AggregateError: Fixture process cleanup failed` thrown from `ProcessFixtureRegistry.cleanup`.
   Root cause, reproduced deterministically before fixing: the timeout fixture writes its PID
   receipt with a non-atomic `writeFileSync`, so the probe's 75 ms SIGTERM can kill the fixture
   between `open` (which truncates) and `write`, leaving an empty receipt. `Number('')` is `0`,
   so `isFixtureProcessAlive(0)` threw `Invalid fixture PID: 0` (garbage parses give the same
   throw with `NaN`), and cleanup's catch — which only filters ENOENT/ESRCH — collected it into
   the AggregateError. Under full-suite load the fixture's node startup lands in that window
   more often, matching the intermittent-only signature; focused runs were always green.
   Fix (fixture only, no production code): `parsePidReceipt` in
   `src/tests/fixtures/process-fixture.ts` accepts only content that unambiguously names one
   process (trimmed digits, safe integer > 1, not the runner's own pid), and both `waitForExit`
   and `cleanup` skip anything else as unidentifiable — a corrupt receipt cannot name a process
   to wait on or kill, and failing the test would kill nothing (captured roots are already
   stopped before receipts are read). The named fixture now writes its receipt atomically
   (write a temp file, rename), so a probe SIGTERM leaves no receipt or a complete one.
   Coverage in `process-fixture.spec.ts`: five corrupt-receipt shapes (empty, whitespace-only,
   non-numeric, truncated, out-of-range) that fail on the pre-fix code with exactly the
   reproduced `Invalid fixture PID: 0`/`NaN` now resolve for both `waitForExit` and `cleanup`,
   and a valid receipt naming a live non-root process is still SIGKILLed. The other thirteen
   registry-consuming specs were re-run against the change.
2. **Status colours below the 4.5:1 minimum on the Costs page (medium)** — `#b25000`/`#1c7c3c`
   at 12px on the dark Costs page background `#07100e` measured 3.71:1 / 3.67:1. Fix: the card
   paints from the theme's accessible status foreground tokens (`--pill-warn-fg`,
   `--pill-ok-fg`, and `--pill-error-fg` for the outcome message's new `error` class) instead
   of hard-coded hexes. Both themes verified (WCAG relative-luminance ratio, text on the
   Costs page's `--bg-primary`) and locked in the component spec: dark (the pill tokens alias
   the base status colours) warn `#d9a13d` 8.37:1, ok `#4aa06f` 6.01:1, error `#d05f4e`
   4.98:1; light (the LT-630 pill foregrounds) warn `#92400e` 6.79:1, ok `#14532d` 8.73:1,
   error `#b91c1c` 6.20:1; the high-contrast theme as extra: 5.46–12.58:1. The spec asserts
   for each pair that its exact `_theme.scss` declaration still exists (so a theme edit fails
   there first) and the ratio stays ≥ 4.5:1, plus a source assertion that the component uses
   the tokens and no longer contains the old hexes.
3. **Result messages not announced (medium)** — the outcome messages were plain `<p>` text
   behind `@if (message(); as text)` driven only by signals, so there was no live region and
   the element arrived with its content. Fix: one persistent message region on the card (the
   `save-state-banner` idiom) that is always in the DOM and takes `role="status"` +
   `aria-live="polite"` for success/no-op outcomes and `role="alert"` +
   `aria-live="assertive"` for failures (rolled-back restore, missing-boundary refusal,
   rolled-back undo, IPC/status-read errors); text updates in the standing region announce.
   Coverage in `cost-history-restore.component.spec.ts`: the region exists, empty and polite,
   before any outcome; successful restore and undo announce as polite status; rolled-back
   restore, the missing-boundary refusal, undo failure and failed status reads announce as
   assertive alerts.

Targeted evidence (23 October 2026, this worktree, round 4): 512 tests across 20 spec files
pass — the fixture registry spec (10, including the five reproduced corrupt-receipt cases),
`provider-runtime-diagnostics.spec.ts` (77/77 standalone and in three runs under four-way
CPU load), the cost restore component (24), the Costs page (33) and cost tracker (31), the
LT-707 restore flow and its handlers (21 in 2 files), and every other registry-consuming
spec (`serve-review`, `plan-queue-process`, `codex-exec-input-receipt`,
`worker-node-executor.posix-cleanup`, `worker-rpc-dispatcher.node-ops`,
`worker-node-exec-policy`, `base-cli-stdin-write`, `codex-exec-native-outcome`, three codex
`.native` adapter specs, `loop-coordinator-cancel-preflight-verify`,
`loop-completion-detector` — 337 tests). `npx tsc --noEmit` 0 errors; `npm run typecheck:spec`
exit 0; `npm run lint` clean; `npm run check:ts-max-loc` exit 0 (pre-existing tolerance notes
only); `npm run check:ui-hints` clean; `npm run build:main` and `npm run build:renderer`
succeed; `npm run generate:ipc` and `npm run generate:architecture` are idempotent. `build:main`'s
documented prebuild refreshed the committed Codex protocol snapshot
(`app-server-protocol.gen.ts`) to the installed codex-cli 0.164.0 — committed generator
output kept current, unrelated to this work. The full suite stays the verifier's completion
gate (reserved per the queue rules); finding 1's evidence is the focused and load runs above.

### Integration notes

- Phase A's branch already carries an LT-707 register entry and regenerates
  `src/preload/generated/channels.ts`. On merge: reconcile the register (same defect) and run
  `npm run generate:ipc` once both channel additions are present.
- The recovery flow and Phase A's prevention each resolve the Claude per-turn boundary with
  the same rule in their own module. If the rule ever changes, change both (or extract one
  shared helper).

### Not done here

No execution against James's history, no ad-hoc data writes, no install or restart of
Harness, no automatic restoration at startup, and no claim that restoration or live
acceptance is complete.

> Plan Queue parked work: `queue/2026-07-19-livetest-failure-re-ffb4df` — 4 commit(s), reason: land-blocked.
