# Grouped check receipts through sequential reviews: installed-app retest

> **Found a defect while running these checks?** Record a reproduced defect in
> [the remediation register](livetest-remediation-register.md), with an index row plus observed
> behaviour, root cause, required behaviour and acceptance. Run `node scripts/next-lt-id.mjs` and
> recheck immediately before adding a row; the command does not reserve an identifier. The index
> row owns status; implementation notes belong in an active fixing plan or owning live-test doc.
> Keep per-check evidence here. Do not add work to a completed plan or read the register archive
> unless an index row points there. Read [the campaign runbook](livetest-campaign-runbook.md) first.

Plan: [verified source repair](2026-11-05-plan-queue-group-receipt-reuse_plan_completed.md).
Defect: [LT-724](livetest-remediation-register.md#lt-724).

**Status:** passed 2026-11-06 on the rebuilt installed app; see
[the evidence below](#evidence--2026-11-06-one-shared-check-survived-three-sequential-reviews). The run
took a different shape from the procedure's example (one group of three, not one solo job plus a pair).
This document does not replace the remaining acceptance in
[the original batching check](2026-11-02-plan-queue-batched-checks_livetest.md) or
[the provisioning check](2026-11-04-plan-queue-check-copy-provisioning_livetest_completed.md).

## Prerequisites and limits

- Source verification and a fresh independent completion-review PASS are recorded in the linked plan. James then
  rebuilds/reinstalls and restarts Harness through the normal packaging process. Never restart his
  live app. Record the build/restart and compare the installed archive's compiled repair files with
  the verified build; compilation in this checkout alone does not update the installed app.
- Reuse the existing ordinary fixture parent and disposable repository at
  `/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/batch-live-20261104/project-lcz9h35x`.
  James already approved paid worker/checker sessions, queue-owned temporary branches/local commits,
  and Workload 5 to Balanced (3) followed by restoration. Do not push or alter routing/accounts.
  A supported launcher refusal is not permission to bypass its model-authority check.
- Preserve the parked delta branch `queue/2026-11-04-delta-c7d8a0`, tip
  `e5d0446cdbcbfc597b5a363ba594b1f4699fa211`, and its owning run
  `557b9f7f-3127-436c-b6e4-33ed0bf04b68`. Do not resume, force-land, discard or manually edit its
  records, branch or checkout during this test. A later normal recovery is a separate check.
- Keep the five baseline files unchanged, including the baseline test's low-CPU 75-second wait.
  No dependency install, native rebuild, browser or desktop control is required. Existing completed
  fixture jobs and retained plan copies must stay intact until evidence and parked work are safe.

## Procedure

1. Read and save `workloadLevel` through the supported settings tool. The last confirmed value was
   5. If another operator changed it, do not overwrite their choice. Once the ordinary parent can
   start the test, set the value to 3 and read back 3. Level 5 raises the effective check-slot limit,
   so requesting one slot alone is insufficient. Restore as described below on every exit path.
2. Prepare exactly three fresh, untracked independent plans in the fixture:
   `docs/plans/2026-11-05-group-reuse-kappa_plan.md`, `...-lambda_plan.md`, `...-mu_plan.md`.
   Each creates only its own `src/<name>.mjs` function returning `"<name>:" + value` and its own
   `tests/<name>.test.mjs`, using Node's built-in test/assert modules to test `"hello"` and an empty
   string. Each worker runs only its own focused test. Harness owns checkpointing, review, closure
   and landing; no manual commits or extra branches/worktrees.
3. Call `plan_queue_start` once from that ordinary parent with:

   ```json
   {
     "kind": "plans",
     "glob": "docs/plans/2026-11-05-group-reuse-*_plan.md",
     "worker_slots": 3,
     "verification_slots": 1,
     "check_batch_size": 4,
     "max_rounds": 2,
     "verifier_gates": ["node --test tests/*.test.mjs"],
     "post_merge_gate": []
   }
   ```

   Save the exact response/run identifier. Use the simple glob; prior brace globs matched nothing.
4. Save `plan_queue_status` snapshots proving one job is verifying while both others await the
   slot together. Without that observed prerequisite, report an inconclusive batching run.
5. Observe the solo job finish, then the paired checklist. Preserve the actual checklist event
   naming both members. Let the pair's first member finish its own independent review and land
   before the later member starts its independent review. If the ordering differs, record it
   honestly; it does not establish the repaired sequential-landing case.
6. Read receipts and events through supported tools or a read-only SQLite connection (`mode=ro`)
   scoped to the exact run in the installed profile's `loop-mode/loop-mode.db`. Do not write it.
   Assert two actual checklist events cover three distinct jobs, with no redundant singleton
   checklist for the later pair member. All three independent verdicts must be genuine PASSes.
   The pair's receipts must have different own HEADs, the same `testedTree`, and the same
   `checkGroup` identity/base/member list. A together label or all jobs landing is insufficient.
7. Inspect the later member's final Git checkpoint: it must include the earlier member's landing
   while its review receipt retains the original own HEAD and checked group base. Record the
   review/landing ordering and original receipt versus final checkpoint. This proves reuse did
   not skip mandatory synchronization/checkpointing. Do not manufacture a conflict or force land.
8. Record the end notice and summary. With the intended green solo-plus-pair ordering and no fix
   rounds, expect two checklists for three jobs. Record any retries/fixes/fallback as they occurred;
   they can make savings inconclusive and must not be edited out.
9. Read-only Git inspection must show no remaining combined/base check copies or owned temporary
   branches after their actions complete. Confirm delta's branch/tip is unchanged, the five baseline
   files match fixture baseline `5f8a1805155707c047592e06189f27c4fc4ab769`, and no `node_modules`,
   `package-lock.json` or `npm-shrinkwrap.json` was created. Do not manually delete AIO copies.

## Restoration, evidence and closure

At completion, start failure or any stop, read `workloadLevel`. If it remains the test's 3, restore
the saved original 5 and read back 5. If another operator changed it meanwhile, preserve that choice
and report it; do not overwrite it. Report a restoration failure immediately. Save responses and
timestamps with the exact run settings, waiting snapshots, events/receipts, Git comparisons and
cleanup under `_scratch/batch-live-20261104/group-reuse-installed-retest/`.

Append a dated evidence section here and link it from both originating live-test docs. This check
passes only when the sequential reuse, distinct independent reviews, own-HEAD/shared-tree receipts,
observed savings, mandatory landing sync and cleanup/restoration all pass in the rebuilt installed
app. Do not rename it completed before that evidence exists. The original batching doc additionally
requires installed summary/card labels and hook behaviour; keep it open until its full acceptance
passes. The preserved parked delta prevents deleting the disposable fixture until its work has a
safe ordinary recovery or James explicitly directs disposal.


## Preparation evidence — 2026-11-05

The source repair passed all eight canonical gates on an unchanged snapshot and a new independent
completion review, including real compiled-runtime proof. Source evidence is in the linked completed
plan and `_scratch/batch-group-reuse-fix/fresh-gate-2/report.md`; it does not satisfy this installed check.
Prepared the three new untracked plans specified above in the reused fixture. `setup.json` and the
guarded `start-test-prompt.txt` are under `_scratch/batch-live-20261104/group-reuse-installed-retest/`.
No new queue run, setting change or app restart occurred. The earlier installed build predates the
final repair; record fresh installed archive/restart proof before starting. Workload read back as 5.

Read-only fixture proof at `_scratch/batch-group-reuse-fix/fixture-preserved-after-gate.json` confirms
all five baseline files unchanged, only the main checkout, main plus the preserved delta branch,
delta still at its original tip, and no modules/lockfile. Keep that parked work safe and retain the
fixture for this continuation. Installed sequential receipt reuse remains unverified.

Read-only installed-archive comparison after source closure confirms the remaining prerequisite:
the archive modified at `2026-11-05T18:25:04Z` matches four of the six compiled repair modules, but
`plan-queue-check-groups.js` and `plan-queue-verification.js` differ from the verified final build.
These contain the preparation-gap correction, so the installed app has not yet been validated with
that final correction. Exact byte digests and comparisons are in
`_scratch/batch-live-20261104/group-reuse-installed-retest/installed-build-proof-before-rebuild.json`.
No app was launched or restarted to read the archive. Confirm both new archive bytes and the user's
restart after rebuilding before starting the prepared test.

## Evidence — 2026-11-06, rebuilt app confirmed; parent launcher refused

Harness resumed this session after an app restart. Read the installed archive without launching or
controlling the app: its modification time is `2026-11-06T09:31:18Z`, and all six compiled repair
modules now match the current local build byte for byte. Proof:
`_scratch/batch-live-20261104/group-reuse-installed-retest/installed-build-proof-after-restart-20261106.json`.
The previous two-module mismatch is resolved. Other queue changes have landed since the source review,
so this is a current installed/build comparison, not a claim that the entire checkout is unchanged
from the earlier canonical snapshot. The final receipt/source confirmation methods remain wired into
preparation and checker prompting. An uncached rerun of the current five focused files passed 152
tests, no failures/skips, actual exit 0; raw/JSON evidence uses suffix `group-reuse-restart-20261106`.

Tried the supported ordinary-parent automation launcher once, explicitly on the current Codex provider
and disabled before any setting change. It refused creation at model-authority validation:

> Cannot raise scheduled job model (the effective model tier is unknown or higher) above the calling session.

Exact result is `launcher-blocked-after-restart-20261106.json` in the new evidence directory. No
automation, worker, checker or test run was created. No model permission, account, routing or other
setting was changed to bypass that refusal. Tool discovery did not expose a session-message sender.
The three prepared plans are still untracked. Workload read back 5 before and after the attempt;
there is no outstanding restoration.

The guarded `start-test-prompt.txt` now records the satisfied build/restart/test prerequisites. Give it
to the existing ordinary fixture parent to run exactly this approved test. The remaining blocker is
starting that ordinary parent through an allowed route, not another rebuild. This live test and both
originating documents remain pending: no current installed grouping, receipt reuse, savings or final
cleanup result is inferred from the source tests or the successful archive comparison.

## Evidence — 2026-11-06, one shared check survived three sequential reviews

Run `617f650a-8705-4e82-a5be-10c5b0000a25`, on the installed build confirmed above after James's restart.
Settings: three workers, one check slot, batch size four, two maximum rounds, the Node checklist and no
post-merge gate. Sources: the fixture parent's `parent-final.md`, then independent read-only inspection of
that run's rows and of the fixture's Git. Rows are under `_scratch/batch-live-20261104/group-reuse-installed-retest/rows/`; all 17 recomputed conditions, plus
the commit identities in case the unreachable commits are pruned, are in `independent-inspection.json`.
The parent could not see receipts or waiting states through `plan_queue_status`, so its "not proven" items
are settled here from the rows.

| Requirement | Result | Evidence |
| --- | --- | --- |
| Jobs wait together | Passed | All three `awaiting-slot` from `10:30:55Z`. Lambda then verified from `11:18:30.639Z` while mu and kappa still waited. Shown by events, not status snapshots. |
| Sequential reuse, no redundant checklist | Passed | Exactly one `checklist-run` event in the run (`11:18:31.485Z`), naming all three jobs. Mu and kappa entered verification and ran no checklist. |
| Separate independent reviews | Passed | Three checker sessions: `x3ig81bgi`, `x3ycrmyqh`, `x64fm3yp3`. Three PASS verdicts, no findings, round 1, no fixes. |
| Review follows the earlier landing | Passed | Lambda landed `11:21:49.177Z`, mu's review began `11:21:55.044Z`. Mu landed `11:23:26.120Z`, kappa's review began `11:31:49.065Z`. |
| Own HEAD, shared tree and group | Passed | Own HEADs `0f36601` lambda, `9fe825a` mu, `599bf4a` kappa. All share tested tree `4fcd743`, group `3d3c1625-425c-4037-958e-b0910d394f1f`, base `365788a` and the three-member list. |
| Mandatory landing sync | Passed | Mu's final checkpoint `c30cdcd` merges lambda's landing `d42fcc9`; kappa's `954a1c3` merges mu's landing `620661d`. Both receipts retain the original own HEAD and group base. |
| Observed saving | Passed | End notice: "1 test run covered 3 jobs." No retry, fix or fallback. |
| Tested code equals landed code | Passed | No `src`, `tests` or `package.json` difference between tested tree and final main `8cd6c53`; only the six closure documents differ. |
| Cleanup | Passed | Only the main checkout; branches are `main` and parked delta; no `combined-gate-checks-*` or `base-gate-checks-*` refs; five baseline files match `5f8a180`; no modules or lockfile. |
| Restoration and parked work | Passed | Workload 5 to 3 at `10:29:24Z`, back to 5 at `11:34:04Z`, and read back 5 again during this inspection. Delta still at `e5d0446`. |

**Difference from the procedure:** steps 5, 6 and 8 describe one solo job then a pair, giving two checklists.
That did not happen, and this is not presented as if it had. A real Harness job (`b9076d5a`, run `559b90e4`)
held the machine's only checklist place from `10:29:45.480Z` until it parked at `11:16:55.924Z`, so all three
fixture jobs were ready before any check began. Lambda's slot-wait event records 94,711 ms from a free slot to
its start, which lands on that exact parking moment. Three waiting jobs fit within batch size four, so
`plan-queue-check-groups.ts` correctly took them as one group. This exercises the repair more strictly than a
pair: reuse had to survive two later members and two landings rather than one. This document's closure
conditions are all met; none of them requires the solo job.

**Timing notes, neither a defect:** the 47-minute wait is explained above. Kappa then waited 504,736 ms after
mu freed the slot. Mu's landing recorded load 37.48, above the run's limit of 30, and kappa's recorded 16.54, so
the overload pause in `plan-queue-pump.ts` is the likely cause. That is inference: load was not recorded during
the wait.

**Not covered here:** this run does not establish the original batching document's on-screen labels or hook
behaviour, which stay open there. This run added three hidden `.aio-retained-*` plan copies, twelve in the fixture in
all, the same pattern as earlier runs; they were left alone. The disposable fixture stays until delta has an ordinary recovery or James directs disposal.

**Result:** passed. No new defect was found.
