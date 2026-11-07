# Plan Queue: batched checks — implementation plan

**Spec:** [2026-11-02-plan-queue-batched-checks_spec_completed.md](2026-11-02-plan-queue-batched-checks_spec_completed.md)

## Status

Implemented and verified 4 November 2026, with only the installed-app check deferred to
[the live-check document](2026-11-02-plan-queue-batched-checks_livetest.md). All eight canonical commands and a fresh
independent task-completion review passed. Changes remain uncommitted. Phase C landed through Harness at
`08f0117897511d7fd9670aad9d5332be45715f99`; both receipt/preparation modules now exist on `main`, and the exact
queue-wide-slot search returns no matches (exit 1). The overlapping local changes were preserved and restored
uncommitted, including a reproduced legacy database-upgrade compatibility repair. No installed app or real database
was changed.

Step 0 baseline: the uncached, one-fork complete plan-queue folder plus both loop-schema specs passed, exit 0
(74 files, 1,081 tests; `_scratch/test-run.pid-95393.log` and matching JSON). Production typecheck passed. The only
subsequent change added the required port-list method to an existing test host; that test and the final spec
typecheck passed. Final full-repository gates and the fresh independent review passed against the combined work.
Preservation and exact command evidence: `_scratch/phasec-promotion-preservation/restoration-report.md`.
James approved Decision 1 on 4 November: skip only the exact duplicate hook test step; keep every other check.

## In plain English

When several finished jobs in one project are waiting to be checked, Harness will put their changes together in one
temporary copy and run the checklist once. If it passes, every job counts as passed on those checks and each job still
gets its own checker. If it fails, every job is checked on its own, so a failure is never blamed on the wrong job.

Decision 1 is approved: the landing commit may skip the hook's repeat test run when the exact same code already
passed the full checklist. Every other hook check remains required.

## Approved decision

**Approved 4 November 2026:** "Yes, skip that exact duplicate test run."

1. **Skip the hook's repeat test run on landing (spec requirement 7).** When a job lands, the repository's commit hook
   runs the related tests again. Recommendation: **yes, but only when the landing commit's code is exactly the code that
   already passed the full checklist** (ignoring only the plan documents being closed). Every other hook step stays,
   including the plan/spec guard. If the code differs at all (for example the first job of a group landing on its own),
   the hook runs its tests as today. James approved this change on 4 November.

## Facts this plan relies on (rechecked 4 November 2026)

- `main` already has per-project-folder check slots in the pump (`src/main/plan-queue/plan-queue-pump.ts`,
  `folderCap`/`folderVerifying`).
- Phase C's receipts and verification modules are now on `main` at the landed commit above.
- `plan-queue-gate-receipts.ts`: `PlanQueueGateRunner.run` runs every gate, caches receipts in memory by
  `[cwd, head, baseSha, commands]`, and compares failures with a base checkout through `withBaseline`. There is no
  separate gate slot; the job holds its admitted check slot throughout.
- `plan-queue-verification.ts` `prepare()` runs the gates for one job and returns ready / wait / fix / park;
  `startVerification` in `plan-queue-item-flow.ts` calls it after syncing the job with the base branch and before
  spawning the checker.
- `PlanQueueWorktreeService.withBaseline` makes a throwaway checkout through
  `creator.createWorktree('plan-queue-base', …)`, provisions dependencies with `npm ci` as the install command,
  and removes it in `finally`. Queue-owned checkouts are exempt from the shared worktree limit; their admitted slots
  bound concurrency. The manager creates a named temporary branch, and its session map is not persisted.
- Stored runs are read by `rowToRun` (`plan-queue-store.ts`), which spreads the kind's **defaults** under the stored
  config. A new config field with a default of 4 would therefore switch batching on for older saved runs unless
  `rowToRun` pins a missing value to 1.
- Landing: `buildAndPromote` in `plan-queue-item-landing.ts` re-syncs and runs `runPostMergeGate` only when
  `verifiedMainCommit !== baseTip`. The landing commit runs the repository hook (`plan-queue-squash.ts`
  `commitWithHooks`), and this repository's hook runs `npm run test:staged` (`scripts/run-git-hook.js`, tested by
  `scripts/__tests__/run-git-hook.spec.ts`).
- File size limits after restoration: `plan-queue-item-flow.ts` is 756 lines against an allowlisted ceiling of
  756; `plan-queue-coordinator.ts` is 763 against 777. New logic goes in new modules; edits to those two files
  are one or two lines at most. Count again after Phase C lands.

## Design decisions (settled here, not questions)

- **Who can be grouped:** jobs in runs with the same project folder, the same base branch and an identical checklist
  (`verifierGates`), where both runs have `checkBatchSize > 1`. The group size is bounded by the starting job's run.
- **Which job starts a group:** the job the pump admits (it holds the check slot, Phase C Step 2.8). It is the
  "leader". Other members stay in `awaiting-slot` while claimed, so the slot count in the pump still sees one check.
- **Member eligibility:** `awaiting-slot`, its run `running`, not waiting for usage, has a live checkout, has no
  receipts for its current HEAD, is not already claimed by another group, and has no "combined check failed" record
  for its current HEAD. Order: oldest first (`createdAt`).
- **After a green combined run** each member is released back to `awaiting-slot` with receipts already seeded for its
  current HEAD. When the pump admits it, Phase C's normal path finds the receipts, runs nothing, and spawns its checker.
  The leader goes straight on to its own checker. This keeps "one slot while the checklist runs" without changing how
  checker sessions use slots.
- **Capacity refusal:** managed queue copies retain the current exemption from the shared worktree limit; admitted check slots bound them. If the creator explicitly refuses capacity, the leader runs alone. Other errors remain visible.
- **Locks:** the leader's item lock is held by `startVerification`. Member locks are taken one at a time, only for
  that member's sync and HEAD read, never while the checklist runs (the copy is built from commits, not from member
  folders). Order is always leader then member, never the reverse. After the run, each member's HEAD is read again under
  its lock; a member whose HEAD moved gets no receipts.
- **Durable records:** group results ride inside the receipts (`checkGroup` on each receipt), which Phase C already
  persists in the verdict rows' `gates_json`. "Combined check failed for this HEAD" and "one checklist run covered these
  jobs" are history events (Phase C's `plan_queue_item_events`). No new table or migration.
- **Known limit, accepted by the spec:** a group member that lands first is landed on code (base + that member) that was
  never fully tested on its own; the full checklist ran on base + all members. The member's own worker and checker
  still checked it, and the hook's related tests still run on its landing commit unless its code exactly matches a
  green tested tree (Decision 1). This is the same trade the spec makes in requirement 6.

## Steps

### Step 0. Precondition: Phase C Step 2 is on `main`

1. Confirm `src/main/plan-queue/plan-queue-gate-receipts.ts` and `plan-queue-verification.ts` exist on `main`, and that
   the queue-wide gate slot is gone (`git grep -n "QueueGateAdmissionWait\|private slot" main -- src/main/plan-queue`
   returns nothing). If not, stop: this plan changes nothing until they exist.
2. Re-read, in full: `plan-queue-gate-receipts.ts`, `plan-queue-verification.ts`, `plan-queue-item-flow.ts`
   (`startVerification`, `toFixing`, `cancelChecks`), `plan-queue-pump.ts`, `plan-queue-worktree.ts`,
   `plan-queue-item-landing.ts`, `plan-queue-squash.ts`, `plan-queue-history-store.ts`, `plan-queue-store.ts`
   (`rowToRun`), `plan-queue-messages.ts`, the plan-queue schemas and tools, and their specs. Update the line references
   in this plan where they moved.
3. Run the plan-queue specs once (`npm run test:quiet -- src/main/plan-queue`) and record the result in this plan, so
   later failures can be told apart from existing ones.

### Step 1. The `checkBatchSize` run setting

1. `packages/contracts/src/schemas/plan-queue.schemas.ts`: add `checkBatchSize: z.number().int().min(1).max(8).optional()`
   to `PlanQueueRunConfigSchema`; defaults `plans: 4`, `livetests: 1` in `DEFAULT_PLAN_QUEUE_CONFIG`.
2. `plan-queue-store.ts` `rowToRun`: after the defaults spread, set `checkBatchSize: stored.checkBatchSize ?? 1`, so an
   older saved run reads as 1, not the kind default.
3. `plan_queue_start`: `check_batch_size` in the JSON `inputSchema` (`src/main/mcp/plan-queue-tools.ts`, beside
   `verification_slots`, described in plain words) and in the Zod tool args schema, mapped to `config.checkBatchSize`.
   Both definitions change together.
4. Read it when a group forms (Step 3), never cached at run start.

**Tests (fail first):** schema spec accepts 1-8 and refuses 0 and 9; store spec: a stored config without the field
reads as 1 for a plans run; tools spec: `check_batch_size: 3` reaches the run config.

### Step 2. Receipts that can describe a combined run

1. `PlanQueueGateReceipt` and `PlanQueueGateRunSchema`: add `testedTree` (the git tree hash the checklist actually ran
   on; for a solo run, `HEAD^{tree}`) and optional `checkGroup: { id, baseTip, memberItemIds }`. Both optional in the
   Zod schema, because verdict rows written before this change lack them.
2. Split `PlanQueueGateRunner.run` into two internal steps with unchanged solo behaviour: execute the commands in a
   folder, then compare failures with the base. The group path needs to remove its copy between the two (Step 5).
3. Add `PlanQueueGateRunner.seed(input, receipts)`: store receipts under the same cache key a later `run()` for that
   member will compute, so the member's normal preparation is a cache hit.

**Tests:** gate-receipts spec: a solo run records `testedTree`; seeded receipts are returned by `run()` without
executing any command; the existing receipt, timeout and base-comparison tests still pass unchanged.

### Step 3. Forming a group (new `plan-queue-check-groups.ts`)

1. `PlanQueueCheckGroups.reserve(leader, run)` claims plausible members synchronously before the pump can admit
   another slot. `run()` validates their live HEAD, cached receipts and common base under item locks. The flow host
   exposes the store; the grouping service does not reach into the coordinator.
2. Claimed members get the detail "Waiting to be checked together with <leader document>".
3. `isClaimed(itemId)` is exposed on the flow; the pump's `awaiting-slot` loop skips claimed items beside its
   `isWaitingForUsage` check (one condition in `plan-queue-pump.ts`).
4. Every exit path releases claims: success, fall-back, abort, error, and `cancelChecks`.

**Tests:** check-groups spec: two waiting jobs in one folder with batch size 4 form one group; jobs in two folders
never do; a job whose run has a different checklist or base branch is not taken; a job with a "combined check failed"
event for its current HEAD is not taken; batch size 1 forms nothing. Pump spec: a claimed job is not admitted.

### Step 4. The combined copy (`plan-queue-worktree.ts`)

1. `withCombinedCopy(repoRoot, baseTip, members, action)`, built like `withBaseline`: `creator.createWorktree` with its
   own owner tag and a managed named branch at `baseTip`, `npm ci` provisioning, clean-tree check and removal in `finally`. Never the root
   checkout and never a hand-made `git worktree add`.
2. Before building: for each member, test mergeability with the base without touching its folder
   (`git merge-tree --write-tree`). A member that conflicts with the base is released and checked alone later (its own
   `startVerification` sends it to fixing as today). A member behind the base tip is synced with `syncItemWithBase`
   under its lock, then checkpointed, exactly as `startVerification` does.
3. In the copy, merge each member's HEAD in job order (`--no-ff --no-verify --no-edit`, same git environment as
   checkpoints, through the git write queue). A merge that conflicts is aborted and that member is left out. If fewer
   than two jobs (leader included) remain, the copy is removed and the leader runs alone.
4. Phase C had no durable cleanup sweep for temporary base copies. `plan-queue-check-copies.ts` now owns one path for
   both base and combined copies: persist ownership before creation, and recover only proven dead-owner copies before
   startup reconciliation. Live, foreign and unrecognised checkouts remain untouched.

**Tests:** worktree spec: the copy is removed after a green run, a red run, and an abort; a member that conflicts with
an earlier member is left out and the rest still merge; a crash-left copy is removed at the next start.

### Step 5. One run, shared results or fall-back

Wire it in `PlanQueueVerification.prepare` (a few lines; the logic lives in `plan-queue-check-groups.ts`):

1. If the leader has no receipts for its HEAD and a group forms, run the checklist once in the combined copy under the
   leader's abort controller, with Phase C's per-check time limit and output handling. Remove the copy, then run the
   base comparison (Phase C's cache by base SHA is shared with solo runs). If the base comparison cannot get a work
   folder, treat each failure as new (safe: it only causes the fall-back).
2. Record one history event on the leader, `checklist-run`, listing the covered job ids (also for solo runs, with one id).
3. **All green or only base failures:** re-read each member's HEAD under its lock. Seed receipts for each member whose
   HEAD is unchanged, keyed by its own HEAD, with `testedTree` = the combined tree and `checkGroup` filled. Release
   members to `awaiting-slot` with no detail; the leader continues to its checker. The checker prompt already says
   "Do not re-run a green check unless you change files" (Phase C).
4. **Any new failure:** seed nothing. Record a `check-group-failed` event with the HEAD for every member and the
   leader, release members with the detail "The combined check failed; checking each job on its own.", and let the
   leader run its own checklist alone in the same slot. Never split the group in halves.
5. Abort (pause, cancel, shutdown) releases every claim and leaves no receipts.
6. A fix round changes HEAD, so receipts stop applying and the next round runs again (alone or in a new group). No code
   needed beyond Phase C's HEAD-keyed cache; covered by a test.

**Tests (the spec's list):** two jobs waiting with batch size 4: one checklist run, both get receipts tied to their own
HEAD, two checkers spawn, one check slot used during the run. A new failure sends every member to its own run (two jobs
→ three runs in total); a failure also present on the base does not. A fix round after a combined pass runs the checks
again. A member whose HEAD changed during the run gets no receipts. On Lightest, only one checklist run, combined or
not, runs machine-wide (pump + workload level). Batch size 1 and older saved runs run exactly as today (same calls, same
order).

### Step 6. Landing after a green group (new `plan-queue-group-landing.ts`)

1. `groupCoversMovedBase(item, run, baseTip)`: true only when the item's PASS verdict receipts carry a `checkGroup`,
   every commit in `git rev-list --first-parent <group.baseTip>..<baseTip>` is the `landedCommit` of another member of
   that group, and no member has left the group's round (sent to fixing, set aside, cancelled or skipped since).
2. `plan-queue-item-landing.ts` `buildAndPromote`: still sync and checkpoint as today; skip only `runPostMergeGate` when
   that function returns true. One call-site change.

**Tests:** landing spec: a second member landing right after the first from the same green group skips the post-merge
check; another job landing in between brings it back; a member sent back to fixing brings it back for the others.

### Step 7. What James sees

1. Job card (renderer presenter `plan-queue-item-display.ts` and the item list): when the item's verdict receipts carry
   a `checkGroup`, show "Checked together with N other jobs" (real plurals). The fall-back text is the stored detail
   from Step 5.4 and needs no new code.
2. Run summary: count `checklist-run` events for the run (new read in `plan-queue-history-store.ts`) and report
   "3 test runs covered 10 jobs" in `buildRunSummaryMessage` and on the run card. Add an optional `checks` field to
   `PlanQueueRunDtoSchema` where `spend` is attached; optional because it crosses IPC.
3. Follow `docs/screen-and-wording-guide.md` and section 6 when reviewing; tooltips through `appTooltip`.

**Tests:** item-display spec for the label; messages spec for the summary line; run-list spec renders it; a run with no
checklist runs shows nothing.

### Step 8. Hook test step on landing (approved by James)

1. `plan-queue-squash.ts` freezes `git write-tree`, then compares that immutable tree with the complete green
   checklist's `testedTree` using recursive `git diff-tree --quiet` and exact literal exclusions for this landing's
   completed documents and closure JSON. History source paths are not exempt. Matching evidence sets the covered
   flag and the frozen index tree in the hook environment; inherited proof flags are cleared first.
2. Immediately before `test:staged`, `scripts/run-git-hook.js` rechecks the actual index against that frozen proof.
   Only a match skips the test step. Earlier generators that stage different bytes cause tests to run. The plan/spec
   guard and every other hook step still run. Other repositories ignore these variables.

**Tests:** `run-git-hook.spec.ts`: with the variable set, `test:staged` is not run and every other command is; without
it, unchanged. Squash spec: identical code sets the variable; any code difference does not.

### Step 9. Verification and completion

1. All eight canonical checks from `AGENTS.md`, with `npm run test:quiet` for the full suite.
2. Fresh independent completion review (`task-completion-gate` skill) until `VERDICT: PASS`.
3. Deferred installed-app busy-project check: see [the live-check instructions](2026-11-02-plan-queue-batched-checks_livetest.md).
4. Then update both documents' status, rename this plan `_plan_completed.md` and the spec `_spec_completed.md`, and
   point the spec's link at the completed name. Commit only when James asks.

## Checklist

- [x] Step 0: Phase C Step 2 on `main`; baseline test run recorded
- [x] Step 1: `checkBatchSize` setting, older runs read as 1 (91 focused tests pass, `_scratch/test-run.batch-step1-green.log`; 14 new assertions failed first)
- [x] Step 2: receipt fields, runner split, seeding
- [x] Step 3: group formation and claims
- [x] Step 4: combined copy, conflicts, cleanup
- [x] Step 5: shared results and fall-back
- [x] Step 6: landing after a green group
- [x] Step 7: job card and run summary
- [x] Step 8: approved exact-duplicate hook test skip
- [x] Step 9: all canonical checks and independent review passed; installed-app-only check recorded as deferred

## As built and verification (4 November 2026)

- Grouping reserves followers synchronously before another pump admission, then validates each member under its own
  lock. The admitted-check operation moved into `plan-queue-start-verification.ts` to keep the existing flow file
  below its ratchet; no file-size ceiling was raised.
- Receipts keep the actual tested tree, each member's own HEAD and shared group metadata. New failures fall back to
  individual checks without blaming a member; aborts release claims and roll back any partial seeding. Failed-HEAD
  and round-history queries use complete durable history, rather than the recent-events window.
- Managed temporary copies use named branches because that is the creator's supported ownership/cleanup contract.
  Both base and combined copies share the new durable dead-owner cleanup path. Queue-owned copies retain their
  existing shared-limit exemption; admitted machine/folder check slots still bound execution.
- Passing-group landing proofs include ancestry, exact landed-member commits, round and run-status checks, unchanged
  code and a recheck after sync/checkpoint. Serial landing and normal sync/checkpoint remain in place.
- Cross-run groups count one execution per participating run; covered jobs are deduplicated across retries. Bulk panel
  snapshots still use two SQL reads in one transaction. Rendered group labels and summaries have real plurals and no
  internal identifiers. Renderer wording review, section 6: All clear.
- James's approved hook change ignores only explicit completed evidence, including its exact closure JSON. A frozen
  immutable comparison and an index recheck after generators prevent a staged-code race. Other hook checks remain.
- Focused regression evidence includes the real pump/flow/checker path, Lightest admission, two jobs falling back to
  three job checklist runs, existing-base failures, changed HEADs, cancellation rollback, real Git conflict/cleanup and
  landing cases, rendered components, and legacy database upgrades. All 34 task-scoped spec files passed independently
  in the full suite. Existing tests and failure assertions were retained.

All eight canonical commands passed with actual exit 0 in a fresh independent context:

| Command | Exit |
| --- | ---: |
| `npx tsc --noEmit` | 0 |
| `npm run typecheck:spec` | 0 |
| `npm run lint` | 0 |
| `npm run check:ts-max-loc` | 0 |
| `npm run check:ui-hints` | 0 |
| `npm run build:main` | 0 |
| `npm run build:renderer` | 0 |
| `npm run test:quiet` | 0 |

Authoritative evidence: `_scratch/batch-fresh-canonical-01/finish.json`, the per-command raw logs beside it,
`_scratch/test-results.batch-fresh-canonical-01.json`, and `_scratch/test-run.batch-fresh-canonical-01.log`.
The uncached full suite passed 37,421 tests with eight unchanged existing skips and zero failures. No task spec was
skipped. The independent review returned `VERDICT: PASS`, with no unresolved actionable findings, in
`_scratch/batch-fresh-gate-report.md`. Source byte/mode hashes, HEAD and index were unchanged throughout that run.
The existing dirty checkout was verified as instructed; no artificial commit, branch, checkout or native rebuild
was made to manufacture a clean tree.

The first full run exposed three installed-dependency failures in unchanged contract tests. The local installation
was restored to existing locked versions with archive integrity checks, without changing manifests or tests. Actual
Vite/Glob/native CSS operations and the isolated dependency tests passed before independent full verification.
Active native binaries stayed unchanged; obsolete out-of-lock packages and replacement backups were removed only
following the independent PASS. Evidence remains in `_scratch/batch-install-repair/`, including `cleanup.json`.

Overlapping local work and original recovery evidence were preserved. The necessary legacy migration compatibility
repair preserves history31/spend32 and local port40/base-conflicts41 identities, with additive history repair42;
no real user database was opened for writing or migrated. Batching itself uses the existing history/verdict tables.
No installed app restart, provider session, browser check, commit or push is claimed.

The sole deferred check is recorded in [the installed-app live-check document](2026-11-02-plan-queue-batched-checks_livetest.md).
