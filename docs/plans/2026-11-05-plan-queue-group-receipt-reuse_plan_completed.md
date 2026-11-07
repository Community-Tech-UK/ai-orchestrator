# Preserve grouped check evidence through sequential review and landing

**Status:** source repair implemented and verified; independent completion review PASS.
Installed-app acceptance is deferred to the linked live-test procedure. No commit or push by this task.

Defect: [LT-724](livetest-remediation-register.md#lt-724).

Origin: [installed provisioning retest](2026-11-04-plan-queue-check-copy-provisioning_livetest_completed.md)
and [original batching acceptance](2026-11-02-plan-queue-batched-checks_livetest.md).

## Reproduced problem

Installed run `62cd9771-061f-4c40-bf3a-bf153c83c33a` met the single-slot waiting prerequisite.
Theta ran alone, eta and iota then shared one real checklist, eta passed independent review and landed,
and iota unnecessarily ran a third checklist before its own independent review. The group event and eta's
persisted group receipt prove that batching did occur. The final summary was three checklists for three
jobs, so it did not deliver the intended saving.

At reproduction, the next verification synchronized its checkout to the moved main branch before looking for
machine receipts. This changes its HEAD and base, correctly missing the strict ordinary receipt cache.
The moved-base proof required the current item's independent PASS verdict, which the waiting
member cannot yet possess. Also, checker startup records current main as the reviewed base; any reuse
before synchronization must retain the actual checked base so landing still synchronizes safely.

Evidence: exact run/event/item/verdict rows under
`_scratch/batch-live-20261104/installed-retest-20261105/plan_queue_*.json`.
The installed dependency-provisioning failure did not recur. Workload was restored and read back as 5.
The earlier parked delta branch remains preserved and is outside this repair's mutation scope.

## Required behaviour and scope

- Preserve access to original successful grouped machine receipts before a waiting member is synchronized.
  Keep the ordinary cache's exact checkout/HEAD/base/command key; never make unrelated results reusable.
- Reuse only after fresh commit, checkpoint, command, checkout cleanliness, group history and active member
  checks prove the same round. The current base must descend from the group's tested base and contain
  only other unchanged members' proven landings. Unrelated changes, failed/changed work, holds, pauses,
  cancellations or invalid proof require ordinary fresh verification.
- Accept actual machine receipts as proof for the unreviewed member; never manufacture its independent
  PASS verdict. Every member still receives its own checker and document/source-identity validation.
- Record the actual checked base for that review. Retain mandatory serialized landing synchronization,
  checkpointing, conflict handling and final group revalidation. Do not silently skip a required merge.
- Clear pending evidence ownership on stop/forget/cancellation paths and bound in-memory state. A restart
  may safely rerun missing in-memory evidence; no new persistence format is required for this repair.
- Preserve existing provider/account limits, installed-app state, real runs and the parked delta branch.
  No manual branch/worktree creation, force landing, database writes, commits, push or app restart.

## Work checklist

- [x] Independently inspect the installed run's persisted events and receipts, rather than relying on its summary.
- [x] Run relevant existing tests before editing; reproduce the real Git single-slot review/landing sequence.
- [x] Implement safe pre-sync receipt reuse and preserve the review's checked-base provenance.
- [x] Verify the actual runtime path, then add meaningful regressions without weakening existing checks.
- [x] Cover the sequential three-job saving and reject unrelated base changes, changed/dirty work,
  changed commands/source, departed rounds, hold/pause/cancellation and proof errors.
- [x] Run the focused regression suite with current raw output and machine-readable results.
- [x] Run all canonical project checks: production/spec typechecks, lint, size/UI-hint checks, main/renderer
  builds and the full quiet suite, with actual exits and retained logs.
- [x] Obtain a genuinely fresh independent `task-completion-gate` PASS and resolve every actionable finding.
- [x] Record remediation/evidence; move only genuinely installed-app-only checks into a separate live-test
  document, then close this source plan last. Original batching acceptance remains open until proven live.

## Runtime acceptance

Use real temporary Git repositories and the production item-flow/verification/landing path with scripted
worker/checker boundaries. One slot must check one solo job, then one combined pair. Let the pair's first
member finish review and really land before admitting the second. Assert two checklist executions covering
three distinct jobs; each pair member's review sees its own checked HEAD and the same group/tested tree.
The second member must still synchronize and checkpoint at landing. Independent reviews remain separate.
Unrelated or invalid evidence must cause fresh checks, never a false PASS.

Installed-only acceptance is moved to [the dedicated live test](2026-11-05-plan-queue-group-receipt-reuse_livetest_completed.md).
Source verification does not establish an installed pass or close the originating live-test documents.

## Evidence and current work status — 2026-11-05

Bounded documentation review read the complete owning plan and both live-test documents, the register's
header/rules, matching/current-final entries and relevant rows. The identifier allocator validated the
index; unrelated historical narratives were not reviewed. LT-724 was allocated and rechecked immediately
before adding its index row and detail. An inverse byte comparison proves the register's unrelated content
is unchanged; only the LT-723 status/link row, LT-724 row and appended detail differ. Proof:
`_scratch/batch-live-20261104/installed-retest-20261105/register-lt724-append-proof.json`.

The actual run/event/receipt rows establish theta solo, eta+iota grouped, eta landing and then iota solo.
They supersede the parent's inference that no checklist covered more than one job. Eta's persisted
`checkGroup` and tested tree directly demonstrate installed provisioning success; LT-723's linked
both-member receipt/saving acceptance remains unmet because of LT-724. Both existing live-test documents
stay pending. They retain their original acceptance, not a reduced provisioning-only substitute.

Implementation and tests are owned by the code worker. The runtime and focused evidence below are now
recorded. Full canonical gates and fresh independent review remain unchecked until their actual results
are available and inspected. This plan remains active; source repair is not yet claimed complete and no
new real run, forced landing, delta mutation or application restart is authorized by these notes.

## Source runtime repair and focused verification — 2026-11-05

- The pre-edit focused baseline passed four files and 77 tests, as recorded in
  `_scratch/test-run.group-reuse-baseline.log`. The valid new production-flow reproduction then failed
  for the intended reason: expected two checklist executions, received three. The exact assertion and
  real Git sequence are in `_scratch/test-run.group-reuse-red-valid.log`. Earlier harness errors failed
  before acceptance and were corrected; they are not counted as a product reproduction.
- The production repair keeps bounded pending group ownership and exact cached inputs, validates the
  waiting member before synchronization, separates real machine proof from the later independent PASS,
  and carries the actual checked base into checker startup. The ordinary cache remains exact; failed
  proof falls back to ordinary fresh verification, while unexpected Git errors use the existing park path.
  Landing still synchronizes/checkpoints and revalidates; no fake checker verdict is created. Detailed
  executing-path notes are in `_scratch/batch-group-reuse-fix/implementation.md`.
- The corrected runtime sequence passed in `_scratch/test-run.group-reuse-green-only.log`. Its regression
  uses real temporary Git repositories, the WASM SQLite driver and production item-flow, verification,
  worktree and serialized landing paths; provider creation and command execution boundaries are scripted.
  Thus this is real orchestration/Git/persistence proof, not a claim to have invoked external providers or
  the installed app. It asserts two checklist executions covering three jobs, three separate independent
  checker spawns, distinct persisted verdicts and pair receipts sharing a group/tested tree while retaining
  own HEADs. The later member is reviewed at its original HEAD/checked base, then really receives a changed
  landing checkpoint containing the earlier member. The stored summary is two runs for three jobs.
- Regressions reject unrelated main changes, changed HEAD/commands/document/linked spec, dirty checkout,
  held members, paused/cancelled peer runs, departed rounds and cancelled checks. They permit a completed
  peer run only for its already-landed member, park unexpected Git proof errors, recheck a hold arriving
  during asynchronous proof, and prevent checker admission when HEAD changes during preparation.
- Final focused evidence is `_scratch/test-results.group-reuse-final-focused.json` plus its matching raw
  `_scratch/test-run.group-reuse-final-focused.log`: success true, five passed files, 126 passed tests,
  zero failures and zero skips. The raw log names the actual Git/race/rejection regressions and agrees
  with the JSON. It supersedes earlier focused selections. The code worker separately reports direct
  Electron/spec typechecks and targeted lint passing; the full canonical gate result remains pending.

The parent is running all eight canonical checks and owns the fresh independent completion gate. Neither
is marked passed by these focused results. Both installed live-test documents remain pending, and LT-724
remains open. No new source/tests or real application/settings/database state were changed by this
documentation update.

## Canonical verification and first independent review — 2026-11-05

The first canonical attempt stopped at the spec typecheck (exit 2): a final regression callback used
`this` without its explicit type. That actual failure supersedes the earlier worker-reported spec
typecheck success. The callback now declares `this: PlanQueueCheckGroups`; no assertion was changed.
Original failure evidence remains in `_scratch/batch-group-reuse-fix/canonical-01/command-01.log`.
After the correction, the resumed focused run passed 81 tests in three files with no failures/skips.

The next canonical attempt ran all eight commands with actual exit 0, including the full suite with
37,932 passed tests, eight existing skips and zero failures. Raw command logs and the JSON report are
under `_scratch/batch-group-reuse-fix/canonical-02/` and
`_scratch/test-results.group-reuse-canonical-02.json`. Its wrapper correctly reports `passed: false`:
23 unrelated source paths and the index changed during the run. All nine repair files remained
byte-identical throughout and afterwards, separately checked in `task-source-stability.json`.
A subsequent current-checkout recheck passed the other seven commands, but its wrapper also detected
unrelated changes. Neither run is represented as a frozen whole-checkout verification pass.

The first fresh independent reviewer reran all five focused files (126 tests, no failures or skips),
then reproduced a remaining preparation gap with two additional real-Git probes: changing an uncommitted
working file or the source document immediately after pending-receipt validation still admitted a
checker using the earlier machine receipts. The probes failed their required rejection assertion;
evidence is `_scratch/test-run.group-reuse-freshgate-gap.log` and its matching JSON. The completion
gate therefore fails and this plan remains active. Repair of that gap, relevant verification and a
new fresh-context review are required before closure. Workload was read back as 5; no setting changed.

## Preparation-gap correction and current verification — 2026-11-05

The correction reuses the original group-input validator at receipt consumption and as the last async
prompt operation before checker creation. It checks original HEAD/checkpoint/round, commands, document
and linked-spec identities, clean checkout, group state/ownership and the exact current base tip proven
by the earlier ancestry walk. It preserves the group's source identity rather than recapturing changed
criteria. Invalid inputs withdraw pending ownership/cache evidence and use the existing wait/retry path;
the next admission runs fresh ordinary checks. No independent PASS or new persistence is fabricated.
Arbitrary external file writes cannot be made atomic with checker creation; existing result/tree/source
validation and mandatory serialized landing checks still apply.

The worker reproduced all intended failures before each correction, including the first reviewer's
original probes, late dirty/source/linked-spec/main changes, source recapture at prompt preparation and
changes after checker selection. Final focused evidence is
`_scratch/test-results.group-reuse-race-final-focused.json` and its matching raw log: 134 tests pass in
five files, zero failures/skips, actual exit 0. The eight new cases and both original independent probes
also pass separately. Direct Electron/spec typechecks and targeted lint exit 0; full evidence/sequencing
is in `_scratch/batch-group-reuse-fix/implementation.md` and `race-checks.json`.

Canonical attempt 03 passed the first seven gates but failed 27 subprocess/sandbox assertions in six
other files while their shared sandbox implementation changed; all nine repair files stayed unchanged.
The run was retained as a failure, not reclassified as a pass. After shared-host load settled, all six
failed files passed an isolated uncached rerun (exit 0, `recovery-01/focused-failures.log`). No unrelated
source or tests were edited by this repair to obtain that result.

**Current canonical result:** `_scratch/batch-group-reuse-fix/canonical-04/finish.json` reports
`passed: true`: all eight commands exit 0, no source changes, unchanged HEAD and index throughout.
Raw logs are `command-00.log` through `command-07.log`. Full-suite JSON
`_scratch/test-results.group-reuse-canonical-04.json` reports 37,968 passed assertions, zero failures
and 11 skips in the current checkout, including conditional sandbox skips outside the owned task files.
The source fingerprint was independently compared again after the run with no difference. This current
stable run supersedes earlier failed or mixed-source attempts; they remain available for audit.

A second, genuinely fresh reviewer now owns the completion gate. It has not yet returned a verdict.
The [installed-only procedure](2026-11-05-plan-queue-group-receipt-reuse_livetest_completed.md) is untracked and
pending, and neither originating live-test document is closed. No additional installed run, app restart,
Workload change or mutation of the parked delta was performed by this source verification.


## Source closure and deferred installed acceptance — 2026-11-05

The new independent verifier returned `VERDICT: PASS` with no unresolved actionable findings in
`_scratch/batch-group-reuse-fix/fresh-gate-2/report.md`. It independently ran the full five-file focused
selection (134 tests, zero failures/skips), then exercised the emitted `dist/main` production classes
with real Git/SQLite and a real local Node gate: two actual checklists cover three jobs, three separate
reviews remain, own HEAD/shared group/tested-tree receipts survive, and the later landing really merges
the earlier member. That compiled-runtime check exited 0. Provider creation and reported review verdicts
are scripted; no real provider or installed-app acceptance is claimed from it.

The verifier audited all eight canonical-04 command logs and raw full-suite JSON, independently rehashed
all 7,197 captured source files after review with no differences, and confirmed unchanged HEAD/index.
It inspected all 11 skips outside this task, the prior failures and corrected evidence, test integrity,
security, async/state handling, lifecycle/performance and actual call wiring. No owned test was skipped,
weakened or removed. The earlier High preparation-gap finding is resolved. Root also reread the final
changed validation/preparation implementation and regressions and checked whitespace without findings.

Only the rebuilt/restarted installed-app scenario remains in the dedicated live-test document. The
original batching/provisioning documents remain pending, including their complete receipt/saving and
installed UI/hook acceptance. Three fresh disposable plans and a guarded parent prompt are prepared,
not started, under `_scratch/batch-live-20261104/group-reuse-installed-retest/`. Workload remains 5;
the preserved delta and fixture baseline are unchanged. No app restart, new paid run, real database
write, forced landing, commit or push occurred during source closure. This source plan is renamed last
under the repository's live-test deferral policy.
