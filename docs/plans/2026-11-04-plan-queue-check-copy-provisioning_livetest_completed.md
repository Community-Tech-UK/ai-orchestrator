# Plan Queue check-copy provisioning: installed-app retest

> **Found a defect while running these checks?** Record a reproduced defect in
> [the remediation register](livetest-remediation-register.md), with an index row plus observed behaviour,
> root cause, required behaviour and acceptance. Run `node scripts/next-lt-id.mjs` and recheck the index
> immediately before adding a new row; the command does not reserve the identifier. The index row owns
> the defect's status; implementation notes belong in the active fixing plan or owning live-test document.
> Keep per-check evidence here. Do not add work to a closed plan or read the register archive unless an
> index row points there. Before running a campaign, read [the campaign runbook](livetest-campaign-runbook.md).

Plan: [check-copy provisioning fix](2026-11-04-plan-queue-check-copy-provisioning_plan_completed.md).
Defect: [LT-723](livetest-remediation-register.md#lt-723).
Owning broader acceptance: [Plan Queue batching installed-app check](2026-11-02-plan-queue-batched-checks_livetest.md).

**Status:** passed 2026-11-06. Installed shared-copy provisioning passed on 2026-11-05; the remaining
both-member shared receipts and checklist saving passed once [LT-724](livetest-remediation-register.md#lt-724)
was repaired. See [the evidence below](#evidence--2026-11-06-shared-receipts-and-saving-confirmed). The owning
broader document keeps its own on-screen label and hook acceptance.

## Prerequisites

- James rebuilds/reinstalls and restarts the installed Harness with the provisioning fix through the normal
  packaging process. Do not restart his running app. Record the installed build identity, install time and
  restart used before testing. This is the remaining reason the check cannot run against the currently
  installed app: it does not load newly compiled files from this checkout automatically.
- Use the existing ordinary fixture parent, or another ordinary session in
  `/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/batch-live-20261104/project-lcz9h35x`.
  James approved the disposable test, paid worker/checker sessions, queue-managed branches/local commits,
  and a temporary change from Workload 5 to Balanced (3), followed by restoration to 5. Do not push or change
  other runs, settings, accounts or routing. The supported automation launcher was previously refused by
  model-authority validation; do not bypass that restriction.
- Preserve parked delta in its owning run `557b9f7f-3127-436c-b6e4-33ed0bf04b68` on
  `queue/2026-11-04-delta-c7d8a0`. Do not force-land, discard or manually alter its records/branch/worktree.
  Normal Resume can separately test recovery after the rebuild; a lone resumed job cannot prove batching.
- Reuse this fixture and its built-in Node tests. No dependency install, native rebuild, browser or desktop
  control is required. Keep the unchanged baseline test's 75-second low-CPU wait; it gives other workers
  time to finish while the first check holds the slot. Do not weaken or repeatedly run that test manually.

## 1. Shared check copies no longer park a dependency-free project

1. Through the supported settings tools, read `workloadLevel` and save the result. The last verified original
   value was 5. If another operator has changed it, stop rather than overwrite the concurrent choice. Set
   it to 3, read back 3, and record both responses. Workload 5 raises check concurrency to at least four,
   so `verification_slots: 1` alone does not establish the required single effective slot.
2. In the fixture, prepare exactly three new independent, untracked plans named
   `docs/plans/2026-11-04-provisioning-recheck-eta_plan.md`, `...-theta_plan.md` and `...-iota_plan.md`.
   Each creates only its own `src/<name>.mjs` function returning `"<name>:" + value` and its own
   `tests/<name>.test.mjs` using `node:test`/`node:assert/strict` to test `"hello"` and the empty string.
   Each worker runs only its own targeted test and leaves baseline files unchanged. Harness owns
   checkpoints, closure and landing; do not manually commit or create extra branches/worktrees.
3. From the ordinary fixture parent, call `plan_queue_start` once with this simple glob (brace globs matched
   no documents in the previous attempt):

   ```json
   {
     "kind": "plans",
     "glob": "docs/plans/2026-11-04-provisioning-recheck-*_plan.md",
     "worker_slots": 3,
     "verification_slots": 1,
     "check_batch_size": 4,
     "max_rounds": 2,
     "verifier_gates": ["node --test tests/*.test.mjs"],
     "post_merge_gate": []
   }
   ```

   Use existing approved routing. Save the exact response and run identifier. If start fails, restore
   Workload as described below before stopping; do not start an unrelated run.
4. Call `plan_queue_status` for that identifier during execution. Record the first job verifying and both
   other jobs in `awaiting-slot` at the same time. If that never occurs, the test is inconclusive: do not
   claim batching from the configured batch size or successful individual jobs.
5. Observe the next admitted group. Its shared check must reach the configured Node checklist rather than
   park its leader with an install/provisioning error. A scripts-only fixture must not acquire `node_modules`,
   `package-lock.json` or `npm-shrinkwrap.json`, and its tracked baseline files must remain unchanged.
   Each grouped member still receives its own independent checker.
6. Preserve the specific run's receipts and checklist events, using supported evidence surfaces or read-only
   SQLite queries scoped to that exact run. The installed profile's queue database is
   `~/Library/Application Support/harness/loop-mode/loop-mode.db`; open it with `mode=ro` and do not write:

   ```sql
   SELECT item_id, gates_json, worktree_head
   FROM plan_queue_verdicts WHERE run_id = ? ORDER BY at;
   SELECT item_id, at, reason, detail_head
   FROM plan_queue_item_events WHERE run_id = ? ORDER BY at;
   ```

   Grouped members must have different own HEADs, the same `testedTree` and the same `checkGroup`
   identity/base/member list. Confirm independent PASS verdicts and actual checklist-run events.
   Record fixes or fallback honestly; no shared receipts means this acceptance has not passed.
7. Save the end notice and actual checklist/job totals. One solo checklist followed by a green pair should
   give two checklist runs covering three jobs. Do not infer savings from that example if this run has
   retries, fixes or fallback; record the actual result and continue the owning batching procedure.
8. Read-only Git inspection of the disposable repository must show no remaining `combined-gate-checks-*`
   or `base-gate-checks-*` branches/checkouts after their actions finish. Check `git worktree list --porcelain`
   and `git branch --list`; confirm delta's retained branch is still present unless it later passed normal
   recovery. Do not manually remove AIO-managed copies or the parked branch to make the check pass.

**Expected:** the dependency-free combined check runs without invoking unnecessary installation, its temporary
copy is cleaned up, the group produces shared tested-tree receipts and independent reviews, and the broader
batching procedure can continue. Required dependency/lifecycle installs, lockfile selection, discovered npm
environment, real failure propagation, clone isolation and native checks are already agent-runnable
regressions; they are not additional deferred installed scenarios.

## Restoration and evidence

On completion, start failure or any need to stop, read `workloadLevel`. If it is still the test's value 3,
restore the saved original 5 through `set_setting`, then read back 5. If it has changed to another value,
do not overwrite it; record and report the concurrent operator change. Save the original, changed and restored
responses together with timestamps. A settings restoration failure must be reported immediately.

Record the build/restart, exact run settings/identifier, simultaneous waiting snapshots, shared receipts,
checklist/job totals, any fixes, copy cleanup and Workload restoration in a dated evidence section here and
link the evidence from the owning batching document. The preserved delta recovery, if attempted normally,
gets its own observed result rather than being confused with the three-job batching run.

Do not rename this document `_livetest_completed.md` until this check passes with current installed evidence.
The broader batching document stays open until all of its own remaining acceptance passes. After evidence
collection, preserve any still-parked work and let AIO finish managed cleanup before removing the disposable
project; keep only small evidence logs/reports. No installed-app retest has run during preparation of this file.

## Evidence — 2026-11-05, restarted installation confirmed

James reported restarting Harness. Read the installed application's archive without launching or controlling
the app: `/Applications/Harness.app/Contents/Resources/app.asar`, modified at `2026-11-05T00:40:24Z`.
Both `dist/main/plan-queue/plan-queue-check-copies.js` and
`dist/main/workspace/git/worktree-deps.js` match the verified local compiled repair byte for byte.
Exact digests/comparisons are recorded in
`_scratch/batch-live-20261104/installed-retest-20261105/installed-build-proof.json`.
This confirms the installed repair files; it does not establish successful batching.

Prepared exactly the three untracked eta/theta/iota recheck plans specified above in the existing fixture,
without overwriting earlier work. Delta's retained branch and its active plan remain intact. Attempted to
prepare a disabled, same-provider test-parent automation before changing Workload. The supported launcher
again refused it:

> Cannot raise scheduled job model (the effective model tier is unknown or higher) above the calling session.
> Use this session's model, effort and auto-approval limits, or ask the user to change the job in the Automations form.

No new run or worker was started. Workload read back as 5 and was not changed, so no restoration is outstanding.
Cross-session messaging tools were not available through tool discovery; no messaging setting or model
permission was changed. The existing ordinary fixture parent can continue with
`_scratch/batch-live-20261104/installed-retest-20261105/start-test-prompt.txt`, which carries the already-approved
Balanced/restoration steps and records new run evidence separately. This check remains pending.

## Evidence — 2026-11-05, real shared check and later-member recheck

The ordinary fixture parent started run `62cd9771-061f-4c40-bf3a-bf153c83c33a` once, using the exact
eta/theta/iota glob and settings above: three workers, one requested/effective check slot, batch size four,
two maximum rounds, `node --test tests/*.test.mjs` and no post-merge gate. Workload was 3 during the run.
The installed repair-file/restart proof is recorded above. Evidence lives under
`_scratch/batch-live-20261104/installed-retest-20261105/`.

Read the actual `plan_queue_runs.json`, `plan_queue_items.json`, `plan_queue_item_events.json` and
`plan_queue_verdicts.json` rows for this exact run, alongside `parent-final.md`, `observations.json`,
`workload.json` and `workload-restored.json`. The persisted evidence corrects the parent's
“batching still NOT shown” inference: one combined checklist really did run, then its later member reran.

- Theta was verifying while eta and iota were both waiting at `01:14:49Z`, `01:16:25Z` and `01:17:41Z`.
  Theta ran the first solo checklist and landed at `01:18:01.896Z`.
- At `01:18:04.471Z`, eta's checklist event names eta (`b8d0a39e-2ba5-4e77-947f-ac229098e459`)
  and iota (`50d49759-ace7-45f9-b4e7-29225c354bac`) together in group
  `5c57aac4-d2ec-4a28-9fe6-4416e3b93f2d`. Eta's independently accepted PASS receipt has own HEAD
  `b29c41d16ccdc1d603bd9803d494e581b38f4c56`, shared tested tree
  `7c5daffed145db620a0724e205ba6162274c7319`, group base
  `10c1dfaebd1d718858a8ca6026a4219fa7c08531` and both member IDs. Its actual Node output passes
  17 tests, including eta and iota. This directly proves successful installed combined-copy provisioning
  and execution, rather than inferring it merely from absence of an npm error. LT-723's provisioning
  failure is repaired on this installed path.
- Eta landed at `01:20:51.005Z`. Iota entered verification at `01:20:51.707Z`, then started a solo
  checklist at `01:20:52.480Z`. Its final PASS receipt has HEAD
  `93c6941fea05af7b27ef0718bfb210a81b0bb7a2`, tested tree
  `83f70328d726ddf3bb0289710e1ba7f228ef544f` and no `checkGroup`. All three jobs independently
  passed with no findings and landed in round 1; the run completed with zero parked jobs.
- Exactly three checklist events cover three distinct jobs. This did not achieve the expected two
  checklist runs covering three jobs. Register [LT-724](livetest-remediation-register.md#lt-724) records
  the reproduced later-member receipt-reuse defect; repair is tracked in
  [the active receipt-reuse plan](2026-11-05-plan-queue-group-receipt-reuse_plan_completed.md).
- The parent reports unchanged baseline files, six passing focused eta/theta/iota assertions, only the main
  checkout, branches `main` and the preserved delta branch, and delta still at `e5d0446`. These Git/test
  observations are attributed to the parent's report here, not represented as independently rerun by
  this documentation task. No managed copies were manually removed, and delta was not resumed,
  force-landed or discarded. Independent Git cleanup/baseline checks remain to be linked when available.
- Supported-tool responses record 5 to 3 before the run and 3 to 5 after completion, with readback 5
  by `01:24:36Z` and no detected concurrent setting change. No setting was changed by this docs task.

**Closure decision:** leave this document pending. Successful installed provisioning establishes the
LT-723 error is fixed on a real combined check, but steps 6–7 still require both grouped members' own-HEAD/
shared-tree receipts and a saving. Those did not pass. Do not weaken them or close the document because
all jobs landed. The broader batching live test remains open for LT-724 and its other unverified UI/hook
acceptance. The parked delta branch stays preserved for normal recovery or James's explicit direction.


## Evidence follow-up — 2026-11-05, receipt-reuse source repair verified

The [receipt-reuse source repair](2026-11-05-plan-queue-group-receipt-reuse_plan_completed.md) now passes all eight canonical checks on an unchanged
snapshot and a new fresh independent completion review. The first review's late dirty/source-input
finding was reproduced and corrected. The final five-file focused selection passes 134 tests with
no failures/skips; a separate compiled production-flow test uses real Git/SQLite and a real local Node
gate to prove two checklists for three jobs, three separate reviews, own-HEAD/shared-tree receipts,
retained checked base and the actual later landing merge. This is source/runtime evidence, not an
installed-app pass. Canonical full-suite output is 37,968 passed assertions, zero failures and 11
skips outside the task; source/HEAD/index fingerprints remain unchanged. Exact raw logs and review
are under `_scratch/batch-group-reuse-fix/canonical-04/` and `fresh-gate-2/report.md`.

The [new installed sequential-reuse procedure](2026-11-05-plan-queue-group-receipt-reuse_livetest_completed.md) keeps the rebuilt/restarted-app check
pending. Three fresh untracked disposable plans and a guarded ordinary-parent prompt are prepared
under `_scratch/batch-live-20261104/group-reuse-installed-retest/`; none has started. No new paid
session, Workload change or app restart occurred for source verification. Supported Workload readback
is 5. Read-only cleanup/baseline proof in
`_scratch/batch-group-reuse-fix/fixture-preserved-after-gate.json` independently confirms the five
baseline files, only the main checkout, main plus parked delta's unchanged branch/tip, and no modules
or lockfiles. This supplements the earlier attributed parent observations without rewriting them.

**Closure decision:** this live-test document remains pending with its original full acceptance.
Do not infer installed receipt reuse, savings, labels or hook behaviour from source tests. Preserve
delta for ordinary recovery or James's explicit direction; no forced landing or discard occurred.

## Evidence — 2026-11-06, shared receipts and saving confirmed

Full evidence is in [the sequential-reuse retest](2026-11-05-plan-queue-group-receipt-reuse_livetest_completed.md#evidence--2026-11-06-one-shared-check-survived-three-sequential-reviews),
run `617f650a-8705-4e82-a5be-10c5b0000a25`. This closes the two items the 2026-11-05 closure decision left open:

- Step 6: all three members have different own HEADs and the same `testedTree` and `checkGroup`, with three
  independent PASS verdicts and one actual checklist event naming them all.
- Step 7: the end notice reports 1 test run covering 3 jobs, with no fixes, retries or fallback. The procedure's
  example was two runs; a real job held the check place, so all three grouped. The actual count is recorded.

Step 5 passed again on the rebuilt app: the combined check reached the Node checklist, exited zero and created no
`node_modules` or lockfile, and the baseline files are unchanged. Step 8 passed: no combined or base check
branches or checkouts remain, and delta is preserved at `e5d0446`. Workload is restored to 5. Delta's recovery
was not attempted, so nothing is claimed about it.

**Result:** passed.
