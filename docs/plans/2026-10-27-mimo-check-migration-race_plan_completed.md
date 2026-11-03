# MiMo live-test startup failures follow-up

Status: implementation and worker checks complete; ready for queue verification, untracked. Updated 2026-11-03. Full gate and deferred live acceptance remain open. Coordinator owns closure.
Goal: both startup database owners safely migrate one fresh profile, and the normal
dev renderer command bootstraps the managed checkout.
Architecture: retain the existing migration/checksum interface; discover applied/pending
migrations while holding the same cross-connection write lock as execution.
Tech stack: TypeScript, Electron, existing SQLite driver.
Spec: [LT-710 migration race](livetest-remediation-register.md#mimo-cutoff-migration-supplement) and
[LT-720 renderer prebundling](livetest-remediation-register.md#mimo-cutoff-renderer-supplement).
Evidence: [MiMo live test](2026-10-14-mimo-reasoning-cap-cutoff_livetest.md#evidence-run--2026-10-27).

## LT-710 original implementation status — 27 October 2026

The live startup failure and a controlled two-connection reproduction are confirmed. No
application code was changed and no fix is claimed. No action from James is needed.
Review correction 2026-10-27: LT-720 was already assigned to renderer prebundling on
`queue/2026-10-05-livetest-campaign-d-99c0f5`. The initial claim that LT-720 avoided a
collision was false; that migration assignment is withdrawn. This follow-up now uses
existing **LT-710**, the controlled migration-race report on the MiMo saved-session
branch, linked to `2026-10-27-mimo-campaign-startup-migration-race_plan.md`.
The related context-worker report is source-qualified **LT-708** on the OpenCode launch
branch (`2026-10-27-fresh-profile-migration-race_plan.md`); the campaign branch also
records the startup race as **LT-721**. The register lists every known duplicate and
asks the coordinator to consolidate under LT-710. These are repeated observations of
one migration defect. Other workers' documents were preserved.

The historical July remediation plan is already completed; this active follow-up holds the
matching new implementation-status section instead of adding scope to a closed plan.

## Implementation task

Files: `src/main/persistence/rlm/rlm-schema.ts` and its legacy context-column helper; driver interface/implementation only if
needed for an immediate write transaction; a migration-concurrency regression beside the
schema. Callers to verify: `rlm-database.ts`, `context-worker-main.ts`,
`global-pause-bootstrap.ts`. Retain `runMigrations(db, onMigrationApplied?,
onMigrationsComplete?): void`.

- [x] Retain and reverify the two-real-connection temporary-file regression with controlled interleaving
  between pending discovery and transaction entry. The old code must fail on duplicate
  migration 001; the fixed code must allow both owners to finish with one row per migration.
- [x] Verify the existing migration discovery/checksum validation and execution under a write lock
  acquired before discovery. Verify the driver's transaction semantics; a deferred
  transaction created after pending discovery does not solve this. Keep uniqueness,
  checksum failures and migration-body rollback; do not use INSERT OR IGNORE.
- [x] Verify fresh and partially migrated profiles, no pending migrations, checksum
  mismatch, and rollback after a migration-body failure.
- [ ] Build and launch an empty isolated dev app with its real context worker. Require
  Work controls and renderer startup, then a successful normal restart. Compiled
  facade/real-worker fresh/restart checks passed; whole-desktop acceptance remains
  in [the pending live checks](2026-10-27-mimo-check-migration-race_livetest.md).
- [ ] Run all canonical gates and a fresh task-completion-gate review. Only then close
  this plan. Worker-owned canonical static/build/focused gates pass; the current
  queue instruction reserves the full suite and final closure to its verifier.
  No commit, branch, worktree or integration is authorized by this record.

## LT-720 original implementation status — 27 October 2026

Open, reproduced during the same campaign: the default renderer dev-server prebundling
left app-root blank with an Angular partial-compilation/JIT compiler error. Restarting
with `--prebundle=false` restored bootstrap. This links the existing renderer defect
on `queue/2026-10-05-livetest-campaign-d-99c0f5`; it does not create another number.
The earlier "setup failure" categorization was incomplete. No application fix is claimed.

- [x] Establish whether linked dependencies or dev-server cache identity causes the
  unlinked partial library; preserve the normal-command versus no-prebundle comparison.
- [x] Repair the supported normal dev command dependency/linker compatibility without
  an unconditional JIT workaround; verify ordinary served Angular module evaluation
  and the production renderer build.
- [ ] Verify visible first paint and synthetic saved-session reload on the ordinary
  command, retained in [the pending live checks](2026-10-27-mimo-check-migration-race_livetest.md).
- [ ] Run canonical verification and a fresh independent review before closing.

## As-built review correction — 2026-10-27, round 3

The MiMo cut-off branch no longer adds LT-710/LT-720 definitions or index rows.
Its migration observations live under the unique
[migration supplement](livetest-remediation-register.md#mimo-cutoff-migration-supplement)
and its own renderer observation under the unique
[renderer supplement](livetest-remediation-register.md#mimo-cutoff-renderer-supplement).
The original source branches own the numbered definitions. This correction removes
merge collisions without discarding reproduction evidence. The migration and renderer
implementation tasks above remain open; no source fix is claimed. Both real MiMo
accounts were tested and failed quota; current per-check evidence is in the owning live test.


## Reconciliation decisions — 3 November 2026

The assigned checkout already includes the shared migration writer lock, WAL busy
handling and automatic-rollback error preservation. Preserve that implementation;
verify its executing facade/context-worker paths and add coverage only for missing
partial-upgrade/no-pending/SQL-body-failure acceptance. The root shared fresh-profile
plan and campaign follow-up describe the same repairs; neither document's status is
fresh evidence for this checkout. Their existing acceptance is retained.

The renderer repair is absent here: the executing Angular 22.2.1 builder declares
Vite 8.3.0, but resolves Vite 7.3.7 through the repository override. Reuse the
campaign owner's `~8.3.3` override and `renderer-vite-contract.spec.ts` check, verified
against this checkout before changing the manifest. No branch integration, shared
install mutation or coordinator state change is authorized or performed.

The linked register anchors are absent in both current register copies. The source
plan's explicit acceptance, the originating reports and the current campaign repair
notes supply the requirement; no new numbering or duplicate register entry is needed.
No separate spec document was found. The existing root plan is the working ledger;
no copy or new plan is created in the managed checkout. Queue status was queried
through the supported tool; its oversized global result does not establish a new
ownership/landing authority. The worker runs focused tests and static/build checks;
the queue verifier owns the full suite and final verdict, per the current assignment.


## As-built evidence — 3 November 2026

The migration implementation already present at checkout startup was retained:
`rlm-schema.ts:311` acquires the immediate writer lock before history/checksum reads;
`rlm-database.ts:140–150` configures the busy handler/WAL and invokes that runner.
The context-worker entrypoint opens the same profile-local facade, and global-pause
bootstrap opens it before Work-control initialization. The existing checksum and
rollback/error-preservation behavior was not changed. No migration SQL/history or
uniqueness constraint was weakened.

A native controlled comparison loads the old production runner in memory: it fails
at `001_add_optimized_indices` with the migration-name uniqueness error; the compiled
current runner passes the same two-connection interleaving with 75 unique rows.
Concurrent compiled facade/context-worker launches on an empty disposable profile
and its restart both exit 0. Worker ready, stats and shutdown responses are observed;
all migration names/checksums/timestamps remain unchanged on restart. This is real
child-process IPC under Electron as Node, not a full desktop/utility-process result.

Added `rlm-schema-recovery.spec.ts` for partial upgrades, no-pending history/lock
preservation, and SQL-body failure rolling back both DDL and history with subsequent
recovery. The existing real-connection race, checksum and database-full rollback tests
remain unchanged and pass.

Reused the campaign owner's Vite correction (`package.json:141`, `~8.3.3`) and
`renderer-vite-contract.spec.ts`. The regenerated lock is byte-identical to that
owner's lock and selects 8.3.5. A real `npm ci --ignore-scripts` install inside this
checkout replaces the stale shared links; native rebuilding passed. The root install
was preserved and local dependencies are retained for the verifier. Before repair,
the compatibility guard fails on Angular 22.2.1 expecting Vite 8.3.0 but loading 7.3.7.
Ordinary Vite 7 serving exposes 543 unlinked declaration calls; the no-prebundle
comparison exposes none. Repaired ordinary serving fetches 175 modules with zero
failed fetches/bare imports/unlinked declarations and evaluates all 10 Angular entry
URLs without a JIT compiler import. Application bootstrap and normal prebundling
remain unchanged. These CLI checks do not claim visible first paint or session reload.

Initial focused verification passed (7 files / 35 tests), as did worker/import/Work-admission
caller checks (5 files / 94 tests). After the legacy-column correction below, the final
focused run covers the complete RLM schema folder and those callers: 32 files / 208
tests passed, with no failures or pending tests. Both TypeScript checks, Angular and fast lint,
explicit lint of the added specs and changed helper, size/UI-hint checks, normal main build including
its prehook, production renderer build, generators, IPC/export/contracts checks,
build dependency audit, native archive smoke and whitespace checks pass. Generators
produce no tracked drift. The existing renderer bundle warning and unrelated fast
lint warnings are retained; no threshold/suppression was changed. The full suite was
not run by this worker because its current assignment reserves it to the verifier.

Browser Gateway reported windows-pc and its extension healthy. Host access initially
failed explicitly; its session grant request succeeded. The test page still returned
ERR_EMPTY_RESPONSE on Windows and both LAN URLs returned empty replies locally,
while loopback returned HTTP 200. No unavailable-worker or server-down diagnosis is
claimed. The new test tab was closed and dev-server groups exited. The two genuine
remaining desktop/visible-reload requirements are retained with exact steps in
[the pending live-test document](2026-10-27-mimo-check-migration-race_livetest.md).
No Mac interactive browser/desktop fallback was used.

Report, command receipts, raw focused logs, native results, sanitized browser evidence
and source fingerprints are in [the worker evidence](evidence/2026-11-03-mimo-check-migration/report.md).
A second fresh scoped source review returned VERDICT: PASS after the correction below; final queue
acceptance and document closure remain open. The plan and live-test document remain untracked at their root
checkout paths. No document rename, staging, commit, stash or branch/worktree operation
was performed. Task-created runtime/build/cache cleanup follows the evidence seal;
dependencies and small reproducible helpers remain inside the assigned checkout.


## Fresh-review correction — 3 November 2026

The first independent reviewer could read files, but its Git/test/artifact-write
commands were refused by its approval gate. Its result was FAIL, not an independently
reexecuted gate. Its suggested duplicate-column race was checked against current
source: fresh `context_sections` tables already have all three fields, so the claimed
fresh-profile trigger is false. Older persisted tables lacking those fields do have
the same race, and partial-profile upgrade safety is in the original acceptance.
A controlled native two-connection test reproduced `duplicate column name:
pending_summary` before any production edit.

`rlm-schema-context-sections.ts` now acquires `BEGIN IMMEDIATE` before reading the
legacy table's fields and commits the conditional ALTERs together. Failure rolls back
partial schema changes, releases the writer lock and preserves SQL/rollback causes.
The new native `rlm-schema-context-sections.spec.ts` passes the exact previously failing
interleaving, checks both owners finish with unique migration history, and explicitly
proves a second connection can acquire the writer lock after a no-pending run. A
separate native case injects real SQL failure after partial ALTERs, checks rollback of
all added columns, second-connection lock acquisition, and successful same-connection
recovery. The main migration/checksum interface and driver interface remain unchanged.

The review's receipt-path concern is resolved with explicit root-evidence links and
worktree-local copies of the before-change receipts/logs. Its owner-comparison concern
used the wrong source branch; the actual existing campaign ref is readable without
its worktree. `owner-comparison.json` records the exact `git show` commands, source
and local hashes, and byte identity for the renderer lock and regression. No manual
branch integration was performed. The compatibility predicate's literal negative
cases are retained alongside its actual builder-resolution test; no existing test
was weakened. The unrelated renderer bundle warning remains a recorded limitation.

Final focused tests and production typecheck pass. The final spec typecheck, Angular
and main lint, changed-file lint, LOC and UI-hint checks also pass. The normal main
and production renderer rebuilds plus compiled native startup also pass against the
final helper source. A genuinely new reviewer returned `VERDICT: PASS` for read-only
source readiness with no actionable finding. It did not independently rerun commands,
review every runtime artifact or certify the full gate; that remains for the queue
verifier. Its optional suggestions (held-lock contention coverage and rollback-failure
coverage) identify no reproduced remaining defect. Production caller searches confirm
the helper is reached only through createTables in the facade initialization, which
opens a fresh connection and sets busy/WAL before table setup; no ambient transaction
is opened there. These notes do not close the plan or any live acceptance.


Final handover: source-only fresh review is saved as `fresh-review-round2.md` in the
worker evidence directory. The first review and its dispositions remain available.
The final source gate is scoped; full-suite/clean-state queue acceptance and both
live requirements are explicitly unchecked above. The report, seal and receipts are
preserved before removal of task-created compiled output/caches; the cleanup outcome
is recorded separately in `cleanup.json`. Local dependencies and small helpers remain
for the verifier. Nothing is staged, committed, stashed, integrated or renamed.

## Post-merge hook repair — 3 November 2026

New `_scratch/` paths below are relative to the assigned queue checkout:
`/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-27-mimo-check-migratio-fb3d5d`.

The complete recovered queue failure ends with `the pre-commit hook timed out after
900000ms`; its final reported test passed. This is a queue deadline failure, not
evidence of a failing migration assertion. The saved merged-checkout full-suite log
records 36,402 passed and nine skipped tests in 1,177.99 seconds, already longer than
the fifteen-minute hook allowance. `test-staged.js` intentionally includes transitive
dependants, so a database helper can select much of the suite.

Repair scope: increase only the aggregate commit-hook allowance in
`src/main/plan-queue/plan-queue-squash.ts` to a bounded sixty minutes. Preserve test
selection, assertions, individual test deadlines, explicit timeout overrides,
pause/cancellation, process-group cleanup and other command deadlines. Baseline hook
timeout/cleanup integration tests passed before editing. Final hook reproduction,
canonical checks, full-suite verification and a fresh independent review remain
pending. The running coordinator requires a rebuild/restart to use this source
change; no running app, lifecycle metadata, branch or commit is modified by the worker.

Verification environment correction: the recovered shell used Homebrew Node
26.12.1, whose executable lacks the SEA capability required by the two bundled-CLI
repeatability tests. Direct execution reproduced the capability error; Vitest's
source-map handling masked it with a secondary JSON decoding error. The pinned
`.nvmrc` runtime, self-contained Node 24.22.1, passes the capability check and both
repeatability tests. Final suite/static/build runs now explicitly use that runtime.
The first complete hook replay also observed the existing reopened-worker
readiness assertion failing; the isolated pinned-runtime file passed all 41 tests.
The failed full/hook receipts are retained.

The complete hook replay subsequently passed: 45 files / 2,371 tests, exit zero,
451.718 seconds. The replay invokes the real compiled `commitWithHooks` default,
asserts its 3,600,000ms allowance, and substitutes the repository hook command for
the commit-writing command. A disposable index represents the staged changes; it
is removed on completion. All three generator output fingerprints remained equal,
and the actual branch/index were not changed. The replay is hook acceptance, not
a claim that the worker made a commit or landed the branch. Receipt:
`_scratch/postmerge-hook-replay.receipt.json`; complete current replay command log:
`_scratch/postmerge-hook-pinned.log` (the production helper retains an output tail).

Pinned-runtime canonical type/spec checks, both lints, size/UI-hint checks and both
builds pass; receipts are in `_scratch/postmerge-pinned-gates/results.json`. Timeout,
cleanup, landing and pause focused checks passed before the complete replay. The
normal full suite remains running in `_scratch/test-run.postmerge-pinned-full.log`;
its final command exit will be `_scratch/postmerge-full-pinned.receipt.json`. A
current capacity sample measured 15.53 busy cores of 18 and an automatic one-fork
limit. Do not replace the pending full-suite result with a targeted pass. Fresh
independent final review and queue acceptance remain pending.
