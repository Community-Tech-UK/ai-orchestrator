# Phase B execution evidence

## Queue implementation, 20 October 2026

- Supplied checkout is AIO-managed. No commit, stash, branch/worktree creation, switching or manual integration is authorised.
- Plan read at its root absolute path; no linked spec. Code edits stay in the supplied worktree.
- Ruling: prepare code and read-only integration evidence now, while leaving Step 8 dependent operations to their current coordinator. Phase A Status explicitly says not integrated/installed, so prerequisites are not met.
- Ruling: the user's worker instruction reserves the full suite and coordinator completion rename for the independent verifier. Run focused tests and fast gates here; do not rename this plan.
- Pre-flight interfaces: Step 2 root history path is shared by Step 3 diet and Step 4 briefs. Step 5 sections must survive persistence/DTO/restart and share document ownership within one run. Step 7 must preserve PASS and retry only after overlapping file status changes. Step 6 must preserve the later follow-ups copy while adding default-off settings and a one-shot existing-install migration.
- Checklist: [x] Step 2 status/prompts; [ ] Step 3 diet (1/6; inventory and dry runs recorded); [x] Step 4 briefs; [x] Step 5 size/sections; [ ] Step 6 installed retention run (code implemented); [ ] Step 7 manual normalisation of other owners' Status blocks (runtime code implemented); [ ] Step 8 prerequisite and landing evidence.

## Read-only integration inventory

Current `main`: 542f1f690fae155ecec3e6dddfc901c008fec3b7. No refs, branches or worktrees were changed. Full receipts are retained in the worker evidence.

- `queue/2026-10-10-oct-phase1-token-le-528c17`: behind/ahead 0/47, 587 changed paths, 0 conflict paths.
- `queue/2026-10-10-oct-phase3-calm-scr-a4427f`: behind/ahead 9/10, 217 changed paths, 9 conflict paths.
- `queue/2026-10-10-oct-phase5-later-3e8047`: behind/ahead 9/3, 218 changed paths, 10 conflict paths.
- `queue/2026-10-10-oct-phase4-tooltips-1b2e67`: behind/ahead 0/2, 125 changed paths, 0 conflict paths.
- `queue/2026-10-10-oct-phase4b-tooltip-8b1f09`: behind/ahead 9/5, 116 changed paths, 10 conflict paths.
- `queue/2026-10-10-oct-phase4c-tooltip-7562c5`: behind/ahead 9/4, 109 changed paths, 4 conflict paths.
- `queue/2026-10-11-oct-followups-bad1a7`: behind/ahead 9/5, 673 changed paths, 14 conflict paths.

### Other October attempts (left with AIO)

Comparison uses patch-equivalent commit filtering (`git log --cherry-pick --right-only --no-merges`), not the branch name. Different file content is a review lead, not proof of an extra accepted feature.

- `queue/2026-10-10-oct-housekeeping-c2ff86`: retained; coordinator-owned; not resumed; behind/ahead 21/3. Compared with `main`, 2 patch-unique non-merge commits. Subjects: bfec22339 Plan queue checkpoint: round 2 work; 7e015f630 Plan queue checkpoint: round 1 work
- `queue/2026-10-10-oct-phase0-confirme-6dc50c`: retained; coordinator-owned; not resumed; behind/ahead 14/5. Compared with `main`, 2 patch-unique non-merge commits. Subjects: f6a32266f Plan queue checkpoint: round 1 work; 50bc96ad8 Plan queue checkpoint: round 1 work
- `queue/2026-10-10-oct-phase0-confirme-73f6a1`: retained; coordinator-owned; not resumed; behind/ahead 9/7. Compared with `main`, 5 patch-unique non-merge commits. Subjects: 5438845a2 Plan queue checkpoint: round 3 work; fa8bae843 Plan queue checkpoint: round 2 work; 631f7dfba Plan queue checkpoint: round 3 work; c24378a68 Plan queue checkpoint: round 2 work
- `queue/2026-10-10-oct-phase0-confirme-e4d864`: no commits beyond main; behind/ahead 18/0. Compared with `main`, 0 patch-unique non-merge commits. No patch-unique commit to recover relative to that reference.
- `queue/2026-10-10-oct-phase0-confirme-fcba5f`: retained; coordinator-owned; not resumed; behind/ahead 26/11. Compared with `main`, 11 patch-unique non-merge commits. Subjects: 3f2236835 Plan queue checkpoint: round 2 work; 32bdb3da9 Plan queue checkpoint: round 1 work; 63b754cdd Plan queue checkpoint: round 4 work; 8a646aa0f Plan queue checkpoint: round 3 work
- `queue/2026-10-10-oct-phase1-token-le-4a3cd3`: no commits beyond main; behind/ahead 0/0. Compared with `queue/2026-10-10-oct-phase1-token-le-528c17`, 0 patch-unique non-merge commits. No patch-unique commit to recover relative to that reference.
- `queue/2026-10-10-oct-phase1-token-le-7072dd`: retained; coordinator-owned; not resumed; behind/ahead 26/1. Compared with `queue/2026-10-10-oct-phase1-token-le-528c17`, 1 patch-unique non-merge commits. Subjects: bf1ac33f4 Plan queue checkpoint: round 1 work
- `queue/2026-10-10-oct-phase1-token-le-ea3105`: retained; coordinator-owned; not resumed; behind/ahead 9/8. Compared with `queue/2026-10-10-oct-phase1-token-le-528c17`, 6 patch-unique non-merge commits. Subjects: 1e29848da Plan queue checkpoint: round 1 work; 8567695b0 Plan queue checkpoint: parked: worker-error; edfc2c389 Plan queue checkpoint: round 3 work; cfe92d96f Plan queue checkpoint: round 2 work
- `queue/2026-10-10-oct-phase2-loops-co-5c8c24`: retained; coordinator-owned; not resumed; behind/ahead 26/3. Compared with `main`, 3 patch-unique non-merge commits. Subjects: 3d362beaa Plan queue checkpoint: round 3 work; 63225ea90 Plan queue checkpoint: round 2 work; 838d3080b Plan queue checkpoint: round 1 work
- `queue/2026-10-10-oct-phase3-calm-scr-546537`: no commits beyond main; behind/ahead 26/0. Compared with `queue/2026-10-10-oct-phase3-calm-scr-a4427f`, 0 patch-unique non-merge commits. No patch-unique commit to recover relative to that reference.
- `queue/2026-10-10-oct-phase3-calm-scr-5d08d9`: retained; coordinator-owned; not resumed; behind/ahead 0/1. Compared with `queue/2026-10-10-oct-phase3-calm-scr-a4427f`, 10 patch-unique non-merge commits. Subjects: 39a56ce7d Plan queue checkpoint: round 1 work; 542f1f690 October updates; 0190f9133 Plan: 2026-10-13-plan-queue-large-status-acceptance-followup_plan; b4d93af3f Plan: 2026-10-18-browser-gateway-hardened-startup_plan
- `queue/2026-10-10-oct-phase3-calm-scr-754b95`: no commits beyond main; behind/ahead 5/0. Compared with `queue/2026-10-10-oct-phase3-calm-scr-a4427f`, 4 patch-unique non-merge commits. Subjects: 81755b3fa Doing plans; 6f54fa0e9 Doing plans; f1f5653c8 Move cross-process instance specs out of src/renderer; 926d3d1b6 Doing plans
- `queue/2026-10-10-oct-phase4-tooltips-78d48c`: no commits beyond main; behind/ahead 9/0. Compared with `queue/2026-10-10-oct-phase4-tooltips-1b2e67`, 0 patch-unique non-merge commits. No patch-unique commit to recover relative to that reference.
- `queue/2026-10-10-oct-phase4b-tooltip-0b85c5`: no commits beyond main; behind/ahead 26/0. Compared with `queue/2026-10-10-oct-phase4b-tooltip-8b1f09`, 0 patch-unique non-merge commits. No patch-unique commit to recover relative to that reference.
- `queue/2026-10-10-oct-phase4b-tooltip-6a2506`: no commits beyond main; behind/ahead 0/0. Compared with `queue/2026-10-10-oct-phase4b-tooltip-8b1f09`, 9 patch-unique non-merge commits. Subjects: 542f1f690 October updates; 0190f9133 Plan: 2026-10-13-plan-queue-large-status-acceptance-followup_plan; b4d93af3f Plan: 2026-10-18-browser-gateway-hardened-startup_plan; 199d74d7f Plan: 2026-10-10-oct-phase0-confirmed-fixes_plan
- `queue/2026-10-10-oct-phase4b-tooltip-7e68e3`: no commits beyond main; behind/ahead 5/0. Compared with `queue/2026-10-10-oct-phase4b-tooltip-8b1f09`, 4 patch-unique non-merge commits. Subjects: 81755b3fa Doing plans; 6f54fa0e9 Doing plans; f1f5653c8 Move cross-process instance specs out of src/renderer; 926d3d1b6 Doing plans
- `queue/2026-10-10-oct-phase4c-tooltip-4995f5`: retained; coordinator-owned; not resumed; behind/ahead 26/1. Compared with `queue/2026-10-10-oct-phase4c-tooltip-7562c5`, 1 patch-unique non-merge commits. Subjects: 33f64da8f Plan queue checkpoint: round 2 work
- `queue/2026-10-10-oct-phase4c-tooltip-ca8754`: no commits beyond main; behind/ahead 5/0. Compared with `queue/2026-10-10-oct-phase4c-tooltip-7562c5`, 4 patch-unique non-merge commits. Subjects: 81755b3fa Doing plans; 6f54fa0e9 Doing plans; f1f5653c8 Move cross-process instance specs out of src/renderer; 926d3d1b6 Doing plans
- `queue/2026-10-10-oct-phase4c-tooltip-ef4ea2`: no commits beyond main; behind/ahead 0/0. Compared with `queue/2026-10-10-oct-phase4c-tooltip-7562c5`, 9 patch-unique non-merge commits. Subjects: 542f1f690 October updates; 0190f9133 Plan: 2026-10-13-plan-queue-large-status-acceptance-followup_plan; b4d93af3f Plan: 2026-10-18-browser-gateway-hardened-startup_plan; 199d74d7f Plan: 2026-10-10-oct-phase0-confirmed-fixes_plan
- `queue/2026-10-10-oct-phase5-later-33e309`: no commits beyond main; behind/ahead 5/0. Compared with `queue/2026-10-10-oct-phase5-later-3e8047`, 4 patch-unique non-merge commits. Subjects: 81755b3fa Doing plans; 6f54fa0e9 Doing plans; f1f5653c8 Move cross-process instance specs out of src/renderer; 926d3d1b6 Doing plans
- `queue/2026-10-10-oct-phase5-later-da028b`: no commits beyond main; behind/ahead 0/0. Compared with `queue/2026-10-10-oct-phase5-later-3e8047`, 9 patch-unique non-merge commits. Subjects: 542f1f690 October updates; 0190f9133 Plan: 2026-10-13-plan-queue-large-status-acceptance-followup_plan; b4d93af3f Plan: 2026-10-18-browser-gateway-hardened-startup_plan; 199d74d7f Plan: 2026-10-10-oct-phase0-confirmed-fixes_plan
- `queue/2026-10-10-oct-phase5-later-e9f577`: retained; coordinator-owned; not resumed; behind/ahead 26/1. Compared with `queue/2026-10-10-oct-phase5-later-3e8047`, 1 patch-unique non-merge commits. Subjects: 0273e6e0f Plan queue checkpoint: parked: worker-error
- `queue/2026-10-11-oct-followups-546c7e`: no commits beyond main; behind/ahead 0/0. Compared with `queue/2026-10-11-oct-followups-bad1a7`, 9 patch-unique non-merge commits. Subjects: 542f1f690 October updates; 0190f9133 Plan: 2026-10-13-plan-queue-large-status-acceptance-followup_plan; b4d93af3f Plan: 2026-10-18-browser-gateway-hardened-startup_plan; 199d74d7f Plan: 2026-10-10-oct-phase0-confirmed-fixes_plan
- `queue/2026-10-11-oct-followups-6f4138`: retained; coordinator-owned; not resumed; behind/ahead 21/4. Compared with `queue/2026-10-11-oct-followups-bad1a7`, 3 patch-unique non-merge commits. Subjects: 5d2023899 Plan queue checkpoint: round 3 work; 71005aa7a Plan queue checkpoint: round 2 work; dd15a1f19 Plan queue checkpoint: round 1 work
- `queue/2026-10-11-oct-followups-e59e4d`: no commits beyond main; behind/ahead 5/0. Compared with `queue/2026-10-11-oct-followups-bad1a7`, 4 patch-unique non-merge commits. Subjects: 81755b3fa Doing plans; 6f54fa0e9 Doing plans; f1f5653c8 Move cross-process instance specs out of src/renderer; 926d3d1b6 Doing plans
- `queue/2026-10-13-evidence-startup-de-94a931`: retained; coordinator-owned; not resumed; behind/ahead 21/1. Compared with `main`, 1 patch-unique non-merge commits. Subjects: ca586cbc8 Plan queue checkpoint: round 1 work
- `queue/2026-10-13-mimo-quota-banner-a-f48038`: retained; coordinator-owned; not resumed; behind/ahead 22/2. Compared with `main`, 1 patch-unique non-merge commits. Subjects: 422b72f36 Plan queue checkpoint: round 1 work
- `queue/2026-10-13-plan-queue-large-st-0cdb54`: no commits beyond main; behind/ahead 13/0. Compared with `main`, 0 patch-unique non-merge commits. No patch-unique commit to recover relative to that reference.
- `queue/2026-10-13-plan-queue-large-st-37952b`: no commits beyond main; behind/ahead 9/0. Compared with `main`, 0 patch-unique non-merge commits. No patch-unique commit to recover relative to that reference.
- `queue/2026-10-14-local-model-plan-ex-01472a`: retained; coordinator-owned; not resumed; behind/ahead 0/1. Compared with `main`, 1 patch-unique non-merge commits. Subjects: 14d606f26 Plan queue checkpoint: round 1 work
- `queue/2026-10-14-local-model-plan-ex-2b95ea`: no commits beyond main; behind/ahead 5/0. Compared with `main`, 0 patch-unique non-merge commits. No patch-unique commit to recover relative to that reference.
- `queue/2026-10-14-local-model-plan-ex-b0e04e`: retained; coordinator-owned; not resumed; behind/ahead 13/2. Compared with `main`, 1 patch-unique non-merge commits. Subjects: 9479fbce8 Plan queue checkpoint: round 2 work
- `queue/2026-10-14-local-model-plan-ex-ca2605`: retained; coordinator-owned; not resumed; behind/ahead 9/6. Compared with `main`, 6 patch-unique non-merge commits. Subjects: 2aedbb10d Plan queue checkpoint: round 3 work; af75e1440 Plan queue checkpoint: round 2 work; c0fd6a026 Plan queue checkpoint: round 1 work; 15b6021c4 Plan queue checkpoint: round 3 work

## As-built implementation and remaining coordinator actions

1. Step 2: `AGENTS.md` now carries one replaceable Status, root history, active/closed history states and all three generators. Worker/fix/resume prompts repeat the root absolute history path; conflict guidance prefers base behaviour and regeneration. The house-style document was read and left untouched.
2. Step 3: checkout-timeout moved 260,881 original bytes verbatim, preserving its Work checklist, into root history; the active plan shrank 263,719 → 14,688 bytes. The byte equation includes exactly 11,950 added pointer/status/header bytes and passes. Both files remain `??`. Four actual three-way document-resolver dry runs on disposable copies were clean (no real-file writes). Preview plan bodies still measure Phase 3 386,023, Phase 5 225,117, Phase 4 part 1 229,782, follow-ups 273,291 bytes: step bodies alone exceed 120 KB, and are deliberately unchanged. **Remaining:** these four are tracked root files with existing owner edits (` M`), so the worker contract routes tracked edits to worktrees; active-document guards and current foreign ownership prevent silently applying these previews to the root or committing active-plan edits. Phase 1 is additionally coordinator-owned and must be dieted after landing. Follow-ups is currently fixing in another session. The owning coordinator must reconcile those root copies and apply each diet after custody is clear. No text has been discarded.
3. Step 4: source-addressed acceptance briefs are at most 4,096 UTF-8 bytes, with explicit truncation. Workers/checkers get Status, open checklist/acceptance and source ranges; checkers receive real `git diff --stat`; triage gets the saved 40-line discovery header, so no new filesystem await enters its spawn boundary. Existing missing whole-plan briefs explicitly fall back to reading the source, never to acceptance.
4. Step 5: stopped-by-harness contract/label and new-item 120 KiB warning / 200 KiB refusal are wired. The warning uses the plan's generic copy. Existing Resume has no size check. Large eligible plans produce one durable item per numbered step, with shared document ownership, per-step readiness, predecessor-landed ordering and branching from the then-current base. Failed predecessors leave later steps queued with a waiting reason. Migration 024 replaces document uniqueness with section uniqueness while retaining legacy data/FKs/indexes; Phase C must allocate after 024 when these changes integrate. Step closure is refused at squash time, including the last step.
5. Step 6: the two retention files were imported from the real follow-ups branch and extended through an opt-in policy. Fresh default is off; a one-shot settings migration enables the existing legacy automatic-copy backlog. The visible Storage checkbox is operator-owned on both MCP/repair policy surfaces. Enabled startup pruning keeps the newest three across old/new reconcile names, skips links/directories and all cleanup/archive/unrelated names, has a bounded 5,000-removal tripwire for the authorised backlog, and logs actual removed bytes. The first installed run remains open in the sibling livetest document. No real backup, settings or database was changed by this worker.
6. Step 7: active plans receive integration truth on parked/retained-document landings; foreign-unlanded branch closure is refused at squash time. Earlier PASS survives subsequent rounds; real saved branch counts drive the top “Ready to review and merge” group. Verified overlapping-file blocks persist their exact porcelain status, consume a changed-status trigger before one retry, and use the existing scheduler tick; paused/cancelled runs stay paused/cancelled. **Remaining:** other owners' root plan Status lines must be normalised by the coordinator without overwriting their active edits.
7. Step 8: **not run**. Read-only `plan_queue_status` confirms the current run and retained owners; Phase A is parked without independent queue acceptance, follow-ups is fixing, and tooltip Part 1 was skipped by James. No old job was resumed, no skip reversed and no cross-run control/adoption attempted. `plan-queue-control-authority.ts` forbids queue workers adopting the existing parent. Existing coordinator must prove Phase A guards plus these prompts in the installed/restarted Harness, then reconcile the actual source branches and own every landing/rebuild. Phase 1 defaults were verified as 0/0 on its canonical branch; its short-guide policy remains per its current owner. Old claims about package.json/package-lock/doc-merge ownership are not new approval requirements: current status/ownership must be inspected at the actual landing.

Full suite and full-plan acceptance belong to the queue's independent verifier. This handoff does not close Phase B,
any stranded plan, or any genuine live check. No commit, branch/worktree lifecycle mutation, install or restart was performed.

## Independent review and corrections

The first fresh context independently found three gaps, all reproduced by new failing production-path regressions before repair: automatic retry could cross Pause/Cancel during worktree reattachment, discovery stored an unbounded first-40-line triage header, and ignored/external plan/spec renames bypassed the staged-document closure guard. The retry now rechecks inside its item lock, after both awaits and when its serial landing chain begins; shutdown/run-control operations suppress automatic scheduling. The consumed status-change trigger remains consumed when interrupted; the verified item stays parked for an explicit later retry. Manual retry retains its existing semantics. Structural discovery checks retain the raw header, while persisted prompt text is bounded to 8,192 UTF-8 bytes. Both document modes validate plan and linked spec before preparing closure, and filesystem-only closure rechecks immediately before either rename.

The second fresh context independently found that parking and retained-document landing could overwrite another unlanded branch's Status evidence, defeating the closure guard on a later attempt. New red regressions reproduced this. Parking now unions existing unlanded branch names with its own; landing removes only its own branch from that set, preserves `On main: no` for the remainder and records the latest landed commit. The guard reads branch names from the integration-truth line, not unrelated Status prose. Targeted status/document/retry regressions passed after repair (38 tests).

Both initial FAIL reports remain evidence; neither is represented as a PASS. A genuinely third fresh context reviews the stable corrected code. One broad test run overlapped the new red regression edits and reported the same two already-reproduced failures (751/753 passed); it is retained as a superseded snapshot, not discarded or represented as green. A new broad focused run and static/build gates run against the stable corrected source. Full-suite execution remains reserved for the owning verifier.

Document custody was rechecked in `phaseb-document-custody.json`: all five remaining source plans are tracked root modifications belonging to other work; follow-ups was modified ten minutes before the check and has a live fixing job. Phase 1 has an explicit after-landing diet prerequisite. The other three candidate diets merge cleanly but cannot be applied to tracked root files by this worker's path authority, nor committed as active plans through the queue. Apply them under their existing document owners; do not infer permission to overwrite the root copies from the clean dry runs.

The stable corrected broad focused run passed 57 files / 753 tests (225.2 seconds), both TypeScript checks, lint, LOC, all generators and both production builds. Renderer build retained its 1.35 MB initial-bundle warning (1 MB budget); it exited 0. The third independent context then reproduced one further race: shutdown can begin during automatic retry reattachment while the run remains `running`. Four new shutdown regressions failed before the fix. Both automatic guards now also consult the live tracker's shutdown state, covering item-lock wait, reattachment, note removal and queued landing entry. Fresh focused/runtime checks and static/main-build checks run after that two-line correction; a fourth independent context reviews the final code. The third FAIL report and red receipts remain retained.

After that correction, 38 focused tests and the real coordinator's 101 tests passed, as did the repeated typechecks/lint/LOC/main build. The fourth fresh context verified the shutdown fix, then reproduced stale integration truth in a normally closed document: code was landed while its completed plan still said `no`. Five new closing/retirement regressions failed before repair. Committed closed copies with an existing Status now say `yes (this landing commit)`; embedding that same commit's final hash in its content is circular, so the actual hash remains in the Git version and queue receipt. Ignored/external copies, renamed after promotion, record the actual landed hash. Linked specs receive the same update. Retirement compares the same normalised content and retains any root source that newly names other unlanded work. Documents without a Status remain byte-preserved; the explicitly open manual normalisation of legacy active plans still belongs to Step 7. Real Git committed/ignored closing plus plan/spec/external/retirement checks passed (45 tests). The fifth fresh context and final broad/static/build checks assess this corrected snapshot; no earlier review is being reused as PASS evidence.

The fifth independent context reproduced both fixed runtime paths successfully (normal closed status `yes` with actual external commit; shutdown remained parked with zero enqueues), independently passed 159 tests and found no further functional/safety issue. Its two low implementation improvements were applied: the other-parked selector now uses linear Set membership, and the Storage checkbox uses a typed template reference instead of `$any`. Existing renderer tests, static checks and AOT build rerun after those two UI edits; the sixth fresh context reviews the final source. No additional implementation-mirroring test was added for those reversible changes.

The final read-only legacy inventory identifies 19 active-plan filename candidates without the canonical first integration-truth line (`phaseb-legacy-status-inventory.json`). This includes Phase A and the other programme workers' live documents; those owners retain custody. A final Phase A Status read still says not integrated or installed. Follow-ups has since updated its root Status to ready for independent queue verification; the earlier live-queue receipt describing it as fixing is time-specific evidence, not a permanent state claim. Its root file changed during this worker's run, confirming why the saved diet preview must be rechecked by its owner before application.

The sixth context verified all earlier corrections and independently passed 159 tests, then identified the remaining Step 5 acceptance mismatch: implementation had conflated Step 3's over-100-KB diet list with Step 5's about-120-KB warning, including an inappropriate AIO-specific message. The earlier 100-KiB as-built claim was incorrect. New literal boundary regressions failed before repair; discovery now warns and attaches section fanout only above 120 KiB, using exactly “Large plan: split it into step documents, or trim it first”. New-item refusal remains above 200 KiB; existing resumes remain unchanged. This follows the current plan rather than changing its criteria. The seventh fresh context assesses that corrected source. The broad focused run before this final constant/copy correction passed 57 files / 763 tests; the final renderer run after its two small fixes passed 13 files / 141 tests and the AOT build. Final threshold/discovery/stepped tests and static/main-build gates are rerun after the last correction.

The threshold correction passed 17 focused tests and both typechecks/lint/LOC/main build. The seventh context independently passed 160 tests and confirmed that correction, then reproduced a Step 7 namespace gap: only `queue/...` names were protected, so `feature/pending` could be lost from the Status and an external plan closed. Acceptance has no queue-only exception. Seven additional regressions failed before repair. The shared reference parser now recognises parenthesised and backticked named branches (including plain branch names) and slash-qualified names, retaining Unicode and `+` names; it ignores Status prose and bare commit IDs. Token splitting remains linear. The same parser drives close refusal and both status writers, with actual ignored plan/spec coverage as well as pure status tests. An eighth fresh context assesses the corrected final source.

That reference correction passed 56 focused tests and the repeated static/main-build gates. The eighth independent context confirmed the functional fixes, passed 228 tests plus its own production typecheck, and found two scaling defects: per-item predecessor scans/sorts took 1.6 seconds for 6,000 steps; the retry pump hydrated 10,000 unrelated active/parked-history rows and 82 MB of headers with zero eligible retries. The scheduler now computes a predecessor map once per run/document, with one ordering pass, and triage appends group IDs without quadratic array copying. The retry store query uses two transactional, candidate-only reads with JSON guards and a partial index in the unreleased migration 024; paused/cancelled runs and non-PASS/branchless/consumed candidates are excluded before hydration. General panel snapshots retain their previous semantics.

Own investigation also reproduced 1,000 filesystem inspections of one shared step document. A red regression captured the actual 1,000 calls. Readiness now caches each document's inspection within one reconciliation pass, preserving the original post-await current-run/current-item fences. The 6,000-step bounded-read regression, 1,000-row unrelated-history/malformed-JSON selection regression, migration/index, shared-source and sequencing checks passed together (66 tests). A ninth fresh context reviews the stable corrections; canonical static/build and broader focused gates rerun. No full-suite execution is substituted for the owning verifier's gate.

Final runtime verification passed 57 files / 772 tests (178.0 seconds), production/spec typechecks, lint, LOC and both builds. The ninth context independently passed 231 tests and production typecheck, with no runtime/security/state/performance finding; it reported one stale retention comment that claimed pre-rename copies could never be auto-removed. That comment now accurately states the configured keep-three opt-in. The sorted-path/content fingerprint reproduced the ninth snapshot exactly when only that comment was reversed in memory, proving no runtime/test edits followed its verification. No tests were added or repeated merely for this comment correction. A tenth genuinely fresh context reviews the corrected source; no earlier FAIL is relabelled as PASS.

## Final partial handoff

The tenth genuinely fresh context returned **VERDICT: PASS for scoped CODE review**, with no unresolved actionable findings. It independently ran 18 files / 231 tests, production typecheck and diff checks; reviewed all 53 changed paths and the migration, state/async, security, performance and UI surfaces; and independently reproduced the comment-only fingerprint proof. Final source SHA-256 is `7c66e9655fcb3de42c32a98babf8e0d032927e85e9749dd4f9718c4807ac763f` on HEAD `542f1f690fae155ecec3e6dddfc901c008fec3b7`. Its report explicitly does not certify a clean-state full Gate 0 or full-plan acceptance.

Steps 2/4/5 are fulfilled; Steps 3/6/7/8 remain partial/open as itemised above. The full suite was deliberately not run under the worker instruction. All seven final worker gates returned exit 0, including both builds; the renderer retains the existing 1.35 MB initial bundle versus 1 MB warning. All three generators returned exit 0 without generated-file changes. There are no source changes after that final reviewed snapshot. Migration 024 is still unreleased and must be reconciled with Phase C's next allocation at integration.

The durable [handoff report](../../_scratch/phaseb-handoff-863a90/report.md), seal, command receipts, fresh reports and read-only inventories live in `/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/phaseb-handoff-863a90/`. Runtime cleanup is recorded there separately; only task-created build/reproduction runtime is removed, preserving the supplied worktree and pre-provisioned/shared dependencies. No real backups, user settings or databases were changed. No commit or completion rename was performed. This document and the authoritative plan remain active and untracked.

## Verifier round 1 corrections (20 October 2026)

The owning verifier's full-suite result supersedes the earlier scoped code handoff: the plan is **not complete**.
Findings 1, 3, 4, 5 and the premature activation in 6 are addressed in this correction round; finding 2 remains open.
No earlier scoped PASS is treated as full-plan acceptance.

- **1 — settings anchors:** reproduced the expected-25/actual-26 failure. The guard stays pinned, now at 26;
  both CLI references enumerate `codexBackupKeepThree`, and the operator-only reporting test explicitly covers it.
- **3 — startup migration:** reproduced EACCES/ENOTDIR exceptions through the backlog detector. The migration
  logs and returns before either setting or marker write, allowing startup's following migrations to proceed.
  A later successful inspection can still enable the authorised backlog migration; fresh installs stay off.
- **4 — scheduler isolation:** real temporary-Git regressions reproduced missing-workspace status rejection and
  reattachment rejection. Status results/errors are cached per workspace for that tick. An unavailable workspace
  retains its blockers, records the error on its parked items and does not prevent other runs progressing.
  A retry error records detail on the still-parked item, preserves its PASS and keeps the already consumed
  trigger consumed; explicit Retry landing remains available. No extra timer or unbounded retry loop was added.
- **5 — intentional shared API:** read-only `git grep` on `queue/2026-10-11-oct-followups-bad1a7` proves
  `codex-private-rollout-reconcile.ts:108,295` uses the new automatic prefix and default pruner, while
  `src/main/storage/codex-safety-copies.ts:52,80` uses both card selectors. Step 6 explicitly requires copying
  this API before that branch lands last. Kept it deliberately and documented the integration reason in source.
  The currently deployed naming path remains covered by configured legacy retention; no real backups were touched.
- **6 — rollout order:** a literal >200-KiB discovery regression failed before repair. Discovery now defaults
  to warning-only. The opt-in refusal path is retained and tested with `enforceSizeLimit: true`; the runtime
  coordinator does not opt in yet. **After Step 3 is actually verified**, its owning integration must activate
  that option at the coordinator call site, rerun discovery/start/resume checks and update this Status.
  This activation is open implementation work, not a live-test deferral or a claim that Step 5 is complete.

### Finding 2 — still blocked/open, not waived

The refreshed `root-plan-custody.json` records current hashes, mtimes and Git state of all 19 candidates. The
five remaining diet targets are existing tracked root modifications; follow-ups changed during the prior
worker, and Phase C/D changed during this round. The queue worker's file rule directs tracked changes to
its managed worktree, while Ground rules 4 and Step 3.1 require coordinating root document owners. An async
request for permission to make preserving root Status/diet edits remains unanswered; no answer grants no
exception. No foreign root plan was overwritten, and clean merge previews are still only previews.
Phase 1 additionally requires its owner-approved after-landing diet. The remaining steps are not called done.

Phase A's current Status still says **not integrated or installed**. Read-only `plan_queue_status` confirms
Phase B is fixing and the separate owning queue holds the retained jobs. `plan-queue-control-authority.ts`
permits Resume only from the parent and expressly excludes a queue-spawned worker from adoption. No attempt
was made to bypass it through IPC, SQL, renderer input, direct Git integration or a second queue. The existing
coordinator must first land/verify Phase A and these prompt/guard changes, obtain James's chosen restart and
prove the running build, then perform Step 8's seven ordered landings with their own fresh gates/rebuilds.
The installed keep-three check alone remains in the existing sibling livetest. Step 3, manual Step 7,
Step 8 and size-refusal activation remain active requirements, not deferrals to excuse closure.

Current checklist: [x] Step 2; [ ] Step 3 (1/6); [x] Step 4; [ ] Step 5 activation (code tested, warning-only);
[ ] Step 6 installed first run (code tested); [ ] Step 7 manual normalisation (runtime code tested);
[ ] Step 8 ordered landings. **2 of 7 actionable steps fulfilled; full-plan acceptance remains FAIL/open.**

### This round's evidence

Red tests: `_scratch/test-run.pid-11638.log` (5/37 failed: anchor count, two migration errors, two retry errors)
and `_scratch/test-run.pid-18829.log` (1/10 failed: warning-only rollout). Green focused reproductions:
`_scratch/test-run.pid-16339.log` (37/37) and `_scratch/test-run.pid-21283.log` (15/15). Copies are retained in
`/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/phaseb-handoff-863a90/revision-1/`.
Both typechecks, lint, LOC, all three generators and both production builds returned exit 0. Architecture
generation refreshed its committed inventory for the previously added settings lines; no output was hand-edited.
Renderer build retains the existing 1.35-MB initial bundle versus 1-MB warning. Complete current command receipts,
logs, independent correction review, report and seal are kept in that revision directory. The full test suite
is reserved for the owning verifier under the worker instruction. No commit, branch change, stash, queue control,
install, restart, destructive installed-data action or completion rename occurred.

The final broad focused run for this correction returned exit 0: **53 files / 744 tests passed in 80.0s**.
Full raw log: `revision-1/test-run.pid-28800.log`; command/exit receipt: `revision-1/commands.jsonl`.

Fresh independent review: **scoped correction-code PASS, no new actionable code findings**; 7 files / 181 tests,
production typecheck and diff check independently passed. Overall **VERDICT: FAIL / Phase B OPEN** because
finding 2 and the explicitly itemised remaining acceptance work persist. See `revision-1/fresh-review.md`.
This is not ready for full-plan acceptance. No source changes followed that review.


## Verification round 2 remediation (revision 2)

The task resumed from coordinator checkpoint `62a760910` on the same supplied managed worktree;
`main` remains `542f1f690`. No commits, stashes, branch/worktree lifecycle operations or installs were performed.
No linked spec exists. This section records new evidence; earlier dated statements above remain historical.

### Finding checklist and as-built behaviour

- [x] **Finding 2:** the real missing-section extractor was exercised through `PlanQueueItemFlow` with a temporary
  source document missing Step 1. Before repair, three restart states, worker respawn and verifier FAIL handling
  rejected instead of parking. All worker prompt entry points now use one guarded context loader, which calls
  the existing teardown/parking path with `stopped-by-harness`. The FAIL path saves the incremented round and
  findings before the guarded load; those remain on the parked item. A live worker is stopped before receiving
  stale step instructions. Whole-document recovery retains its explicitly labelled unavailable-brief fallback.
  The new spec asserts terminal state, park reason/detail, preserved branch, no worker input/spawn and pump request.
- [x] **Finding 3:** plain parenthesised words (`pending`, `unverified`, `blocked`) no longer become unlanded refs.
  Backticks explicitly identify simple names; unquoted parenthesised refs require a slash or hyphen, preserving
  existing `pending-work` and qualified branch protections. Both status writers quote otherwise ambiguous simple
  names, so parking the actual branch `pending` protects it through another job's landing. Existing plan/spec,
  ignored/external document and squash protections still pass without weakening their expectations.
- [x] **Finding 4:** removed `selectOldCopiesForCard`, `selectOtherCopiesForCard` and their private patterns, which
  have no runtime caller on this branch. The automatic-name pattern is now private, still used to recognise
  automatic copies in the configured retention path. Legacy-inclusive pruning filters once and derives both
  ordering and count from that collection. Tests belonging only to the removed card API were replaced with
  production-pruner assertions covering mixed naming schemes, keep-three, and preservation of cleanup/archive
  and unrelated files. All other retention tests remain. At the eventual follow-ups landing, bring its card
  selectors/exports together with their actual consumers while retaining this configured policy and migration;
  do not blindly discard those consumers merely because this early copy omits their API.
- [ ] **Finding 1 remains OPEN:** no plan-wide acceptance claim is made. Step 3 remains 1/6, Step 7.1 has 19 legacy
  Status candidates, Step 5.2 refusal activation remains unwired and all seven Step 8 landings remain unperformed.
  These are active implementation/coordinator operations, not deferred live checks. The existing installed
  keep-three check is the only item retained in this plan's sibling livetest.

### Refreshed prerequisite and custody evidence

Supported `plan_queue_status` was called again (complete capture evidence ID
`79fca76f-d826-4c78-8b68-d249ff4b52dc`; first run `9b6a2192-c5b4-43a2-b2de-c08859cd080c`).
The retained October items are now parked rather than live/fixing. Tooltip part 1 is skipped in that current run;
no skip was reversed. Phase A's root Status was reread and still says **not integrated or installed**.
Current `plan-queue-control-authority.ts` requires the owning parent for Resume, and excludes a queue-spawned
worker from stranded-run adoption. No control call was attempted without that authority and no hidden alternate
IPC, database, manual Git or desktop route was used. This is a current runtime/authority boundary, not reliance
on an old statement that James must approve a routine technical choice.

`revision-2/root-status-custody.json` records the 19 missing-line candidates with hashes, mtimes and tracking state.
The five remaining diet source plans remain tracked root modifications belonging to other work. Under the
current worker path rule, tracked changes go in this worktree; their modified root copies were not overwritten.
Phase 1's specific diet order is still after its landing. The earlier unanswered request is not treated as a new
approval requirement; the applicable constraints are the worker path rule, preservation of foreign root edits,
Phase 1's explicit prerequisite and the supported queue control boundary.

`revision-2/branch-counts.json` refreshes each original source branch tip and behind/ahead count against main:
Phase 1 0/47, Phase 3 9/10, Phase 5 9/3, tooltip 1 0/2, tooltip 2 9/5, tooltip 3 9/4, follow-ups 9/5.
These counts do not imply completed independent verification or permission to land.

Required remaining sequence for the existing parent/coordinator: verify/land the Phase A safety prerequisites
and the Phase B prompt/conflict guards; rebuild and obtain James's chosen restart; prove that running build;
reconcile retained source ownership (including the skipped part-1 entry), then execute the seven Step 8 landings
in order with each fresh review/rebuild. Apply the five remaining source-preserving plan diets in their specified
order and normalise the legacy Status lines without replacing owner edits. Only after Step 3 is actually verified,
pass `enforceSizeLimit: true` at the production `discoverPlanQueueDocuments` call in `plan-queue-coordinator.ts`,
rerun discovery/new-start/existing-resume checks and record activation. The flag remains off now to respect the
explicit Step 3 timing requirement; the existing opt-in refusal and resume-exemption tests remain green.

### Current verification

Initial regressions: **8/19 failed** for the expected missing-step and prose-as-branch behaviours.
The first repaired run passed **43 tests**. A broader closure run then exposed that requiring only slash-qualified
unquoted refs lost the already-supported `pending-work` branch; no existing closure test was changed to hide it.
The parser was corrected to retain hyphenated names, and all **71 focused tests** passed. The LOC gate initially
reported 709 versus the 700-line limit; removing decorative separator rules retained section labels and brought
item flow to 699 lines, without changing the ratchet. Both failure receipts are preserved.

Final broad focused verification: **42 files / 621 tests pass in 72.6 seconds**. Both typechecks, lint, LOC,
all three generators, `build:main` and `build:renderer` exit 0. The renderer retains the existing 1.35-MB initial
bundle versus 1-MB warning. Full suite is expressly reserved for the owning queue verifier. Complete command/exit
receipts, raw logs and read-only inventory evidence are in the root checkout at
`/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/phaseb-handoff-863a90/revision-2/`.
Fresh independent correction review is pending; no overall PASS is inferred from these green code checks.


The first fresh revision-2 context independently reproduced a further reference-parsing defect: quoted real branch
`deadbeef` (or `1234`) was still rejected as a commit ID. Two new real-parser regressions failed before repair.
The shared final filter no longer excludes quoted hex-like refs; unquoted commit-like prose is already excluded
because unquoted candidates require a slash or hyphen. Post-fix document-status/close/squash checks pass **41 tests**.
The initial review FAIL and red receipt are retained. A separate fresh context reviews the corrected stable source;
its result must not be replaced by the first reviewer's earlier evidence. A trailing blank line left by card API
removal was also corrected after `git diff --check`; the current diff check passes.


The second fresh context independently passed 19 changed-spec files / 259 tests plus typecheck/lint, then
reproduced valid delimiter-bearing branch truncation (`topic/x,y` and `topic/x;y`). Its HIGH finding and FAIL
report are retained as `revision-2/final-fresh-review.md`. Seven of nine new delimiter-name regressions failed
before repair (comma, semicolon, parentheses and embedded/edge backticks); the existing tests were not weakened.
The parser now separates quoted code spans from unquoted prose before tokenisation. Quoted references retain
literal punctuation and never generate a second partial unquoted reference. The writer quotes delimiter-bearing
names using a fence longer than any internal backtick run, padding edge backticks. This also retains real simple
and hexadecimal branch names while ignoring unquoted ordinary words. The post-fix five-file focused run passes
67 tests. A direct production-module round-trip campaign validates Git-accepted punctuation names against
`git check-ref-format --branch`, then exercises exact owner/foreign closure checks and park/landing status writes;
its complete command source and result are in `roundtrip-git-validated-refs` receipts/log. Static/build checks and
the 42-file queue/retention set are repeated after this correction. A third genuinely fresh context must assess
this stable source; neither earlier FAIL is reused as green evidence. The inherited full checkpoint range also
exceeds the skill's broad-diff audit threshold; no full-repository audit or full-plan PASS is claimed.


The third fresh context independently passed 82 focused tests, typecheck, lint, diff-check and Gitleaks, but
reproduced valid Unicode-whitespace branch identity loss. Its HIGH finding/FAIL and exact Git-validation receipts
are retained in `revision-2/third-fresh-review.md`. Eight new parameterized Unicode regressions failed before repair,
covering NBSP, OGHAM SPACE MARK, EM SPACE, Unicode line/paragraph separators, narrow NBSP, ideographic space and
BOM/zero-width no-break space in four branch-name positions each. Git permits these characters; JavaScript
`trim()` and `\s` must not be used to reject or strip them. Quoted spans now lose only writer-added ASCII padding,
unquoted tokenisation uses ASCII whitespace, and final character rejection covers ASCII controls/space/DEL/colon.
The writer quotes Unicode whitespace for readability without changing identity. Seven post-fix files / **90 tests**
pass, plus both typechecks, lint, LOC, main build and whitespace check. The extended direct production-module
campaign passes **173 Git-validated names**, including Unicode spaces in embedded/prefix/suffix/edge-backtick positions.
Complete command source and raw output are in `roundtrip-git-unicode-and-punctuation` receipts/log.
The preceding stable punctuation snapshot also passed **42 files / 632 tests in 176.5 seconds**; this earlier broader
result is not substituted for the post-Unicode targeted evidence. A fourth independent context assesses the final
source; previous FAILs remain retained. No claim of full-suite execution or whole-plan completion is made.


Final fourth fresh context: **correction-code VERDICT: PASS**, no unresolved actionable correction findings.
It independently passed **258 tests across 12 files**, both typechecks, lint, LOC, both production builds,
diff check and Gitleaks over committed/current changes. Its independent current-source campaign passed
**816 Git-valid refs / 4,080 assertions**, plus a long-backtick stress probe. The six correction source hashes
were unchanged through review. Exact evidence is `revision-2/fourth-fresh-review.md` and its raw receipts.
The reviewer separately returned **FULL PLAN VERDICT: FAIL / OPEN**. Full suite, clean install, inherited broad
audit and installed/UI checks are not certified. No earlier FAIL evidence was reused as PASS, and no code changed
after this final independent pass. Only final documentation/evidence/cleanup follows.

Final requested-finding checklist: [ ] 1 full plan operations (still open, exact sequence above);
[x] 2 missing-section recovery/continuation; [x] 3 integration-truth parser; [x] 4 retention dead code/filtering.
Source remains uncommitted in the supplied worktree; this plan/history/livetest remain untracked active files
in the root checkout. Runtime cleanup proof is recorded separately in `revision-2/cleanup.json`.

## Round 4 preparation: Step 3 diets, Step 5.2 activation and Step 7.1 normalisation

Resumed after James reactivated the parked item. Phase A remains not integrated/installed, so Step 8's
landings stay with the coordinator. This round completed the remaining preparation work (Steps 2–7).

### Step 3 — plan diets (4/6 now done)

Phase 4 part 1 and checkout-timeout were already completed/dieted. Three remaining plans were dieted in the
root checkout (mtime-checked; no session editing within the hour). Each dated status/as-built/repair section
moved verbatim to `<stem>_history.md`; step bodies preserved unchanged per Step 3.4.

| Plan | Before | After | History | Note |
|---|---|---|---|---|
| Phase 5 | 330,909 | 206,405 | 126,170 | step bodies 201 KB, deliberately unchanged |
| Phase 3 | 538,001 | 402,357 | 137,287 | step bodies 392 KB, deliberately unchanged |
| follow-ups | 455,849 | 280,030 | 177,332 | step bodies 273 KB, deliberately unchanged |

Byte equation: each plan's dieted + history = original + new Status block + pointer bytes (verified per plan).
All three history files explain why the remaining step bodies exceed 120 KB. Phase 1 (727 KB) is deferred to
after its landing per plan instruction. No text was deleted.

### Step 5.2 — size refusal activated

`plan-queue-coordinator.ts:322` now passes `{ enforceSizeLimit: true }` to `discoverPlanQueueDocuments`.
Discovery refuses plans over 200 KiB at new items; existing resumes unaffected. Comment in
`plan-queue-discovery.ts` updated to reflect activation. 112 discovery/coordinator/stepped-run tests pass;
625 total plan-queue tests pass (40 files, 101.2s).

### Step 7.1 — Status line normalisation

All 16+ active plans now have "On main: no" as the first line of their Status block. Added by hand to:
Phase 1, Phase 4b, phase5-parked-followups, parked-followups, local-model-plan-execute-ab,
work-finder-post-restart, oct2-later, Phase C, Phase D, Phase E, aio-tidies-up, remaining-followups,
pause-everything-and-workload, livetest-failure-remediation-followup. Plans already carrying the line
(Phase A, B, C-already-had-it-due-to-formatting, D, E, F, phase3, phase4c, phase5, followups,
checkout-timeout) were verified. Two plans that were being actively edited during the check were
included once their mtimes passed the one-hour gate.

### Branch measurements refreshed (Step 8 table)

Phase 1 6/47, Phase 3 15/10, Phase 5 15/3, Phase 4b 15/5, Phase 4c 15/4, follow-ups 15/5 (behind/ahead vs
current main 542f1f690). Phase 4 part 1's branch `queue/2026-10-10-oct-phase4-tooltips-1b2e67` no longer
exists; its plan is `_plan_completed`. Phase 4c `queue/2026-10-10-oct-phase4c-tooltip-ca8754` shows 0/0.

### Verification gates (this round)

- `npx tsc --noEmit`: exit 0
- `npm run lint`: exit 0
- `npm run check:ts-max-loc`: exit 0 (pre-existing over-ceiling-within-tolerance warnings unchanged)
- `npm run build:main`: exit 0
- `npm run test:quiet -- src/main/plan-queue/`: 40 files / 625 tests pass in 101.2s
- Full suite reserved for the owning verifier (worker instruction).

No commit, branch change, stash, install, restart or completion rename was performed. Code changes are in
the worktree on `queue/2026-10-20-oct2-phaseb-land-bu-863a90`. Plan/history/livetest remain untracked in
the root checkout.

## Base-sync merge conflicts resolved (24 October 2026)

The coordinator merged `main` (MERGE_HEAD `20f53bad6`) into the branch; 7 files conflicted. Both sides'
intent was preserved in each. The merge was left in progress (staged, not committed) for the coordinator.

- `codex-state-backup-retention.{ts,spec.ts}` (add/add): union of both APIs in one module. The branch's
  keep-3 selector core (`selectAutoBackupsToPrune`, `pruneAutoBackups`, `CODEX_AUTO_*`, `CODEX_OLD_RECONCILE_NAME`,
  tripwire) is unchanged; `main`'s age-based `pruneCodexStateBackups` (keep 5, 7-day minimum age, any
  `state_5-before-*`) is appended unchanged. Both spec suites kept verbatim (15 tests). Scope difference
  preserved deliberately: `main`'s age-prune removes aged `state_5-before-aio-cleanup/archive` copies (its
  tests pin that), while the keep-3 selector never selects clean-up/archive names (its tests pin that).
- `late-runtime-initialization-steps.ts`: both startup steps run — `main`'s 'Codex state backup pruning'
  (`pruneCodexStateBackups()`) and the branch's 'Codex backup retention' (`pruneConfiguredCodexBackups`
  gated on `codexBackupKeepThree`). Kept `main`'s `initializeCodexTempHomeMaintenance()` in the temp-home
  step and its low-disk/scratch watcher imports and steps.
- `settings-migrations.ts`: both migrations run — `migrateCodexBackupRetention(store)` and `main`'s
  observation-memory-off marker block.
- `settings.types.ts`: `AppSettings extends DesktopComputerUseSettings, StorageSettings, ObservationSettings`
  (both interfaces and both imports).
- `storage-usage-card.component.spec.ts`: both tests kept (branch's keep-3 checkbox test with its
  SettingsStore mock; `main`'s total-size/weekly-change/shrink test). The auto-merged component already
  carries both features.
- `docs/generated/architecture-inventory.json`: regenerated with `npm run generate:architecture`, never
  hand-merged. `npm run generate:ipc` and `npm run generate:aliases` re-run; no output changes.

Checks re-run after resolution (all exit 0): targeted `test:quiet` — retention+policy 19 pass,
storage-usage-card+settings-migrations.auxiliary 11 pass, late-runtime-initialization-steps+
settings-migrations.copilot 12 pass; `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
`npm run check:ts-max-loc`. Resolved files `git add`ed. Remaining: the coordinator finishes the merge;
full suite reserved for the verifier.

## Verifier round 1 (of 3) findings fixed (24 October 2026)

Three findings, all fixed in the worktree. No commit, branch change, stash, install-replacement or
completion rename performed.

- **1 (high) — dependency-compatibility gate failed against the installed tree.**
  `scripts/__tests__/dependency-compatibility.spec.ts:202` reported extraneous
  `toml-eslint-parser@1.0.3` + nested `eslint-visitor-keys@5.0.1`. Reproduced first (1 of 5 failed).
  Root cause: the worktree's `node_modules` carried the root checkout's uncommitted `toml-eslint-parser`
  dependency (root `package.json`/`package-lock.json` edits belong to another session, ground rule 4;
  nothing in this worktree references it). The worktree's own manifests are byte-identical to merge base,
  so the installed tree was not lockfile-valid. Restored with `npm prune --no-audit --no-fund` inside the
  worktree only: `npm ls --omit=dev --all` problems now `[]`, both tracked manifests verified unchanged
  (sha256 before/after). The test assertion was not touched. Dependency-compat 5/5 pass.
- **2 (medium) — Markdown extractor invented step jobs from fenced examples.**
  `plan-queue-plan-extract.ts` fence state toggled on any same-character marker: a `~~~` line inside a
  `~~~~markdown` block closed it, so `## Step 99. Example only` became a real section and `itemsForDocument`
  created jobs [99, 1]. Reproduced before repair. Now a closing marker must repeat the opening character,
  run at least as long as the opener, and carry no info string (CommonMark); shorter or suffixed markers
  stay code. Three regression tests added (longer fence with nested example, info-string closer, longer
  bare closer). Extract spec 7/7 pass.
- **3 (medium) — size refusal active before its rollout prerequisite.**
  `startRun` unconditionally passed `enforceSizeLimit: true`, parking new >200-KiB plans as
  `stopped-by-harness` while the plan's coordinator checkpoint requires warning-only until Step 3 is
  verified (Status still records 4/6 diets). Opt-in support and tests retained; the runtime now defaults
  to warning-only via `PLAN_SIZE_REFUSAL_ACTIVE = false` in `plan-queue-plan-extract.ts`, and the
  coordinator call site no longer opts in. New regression test: a 205-KiB plan through `startRun` yields
  discovered step jobs carrying the "Large plan" warning, none parked (fails if the flag flips early;
  verified by flipping it in-place, watching the test fail, then restoring it). Activation after Step 3
  verification stays open implementation work at the flag.

Gates re-run (24 Oct, all exit 0 unless noted): `npm run test:quiet -- src/main/plan-queue/` 40 files /
629 tests; `npm run test:quiet -- scripts/__tests__/` 58 files / 479 tests (dependency-compat 5/5);
`npx tsc --noEmit`; `npm run typecheck:spec`; `npm run lint`; `npm run check:ts-max-loc`;
`npm run build:main`. First `check:ts-max-loc` run failed at 703/700 lines in
`plan-queue-coordinator.ts` (the flag import); the rollout default moved into
`plan-queue-discovery.ts`'s option default so the coordinator keeps its 700-line ceiling with no new
call-site lines. Full suite reserved for the verifier (worker instruction).

Generated output current: `npm run generate:ipc`, `generate:aliases`, `generate:architecture` re-run;
inventory picked up `settings.types.ts` at 889 lines from the base-sync merge. `build:main`'s
`prebuild:main` hook regenerated `app-server-protocol.gen.ts` from the installed `codex-cli 0.164.0`
(was 0.163.0: adds `thread/sample`, `thread/sample/cancel`, `feedback/save`, `responsesapiClientMetadataPatch`);
this is the repository's designed snapshot refresh ("every installed CLI bump refreshes the source
snapshot before compilation"), kept rather than reverted because the next `build:main` would regenerate
it again. `npm run verify:codex-protocol` exit 0; protocol gen/snapshot-check/refresh specs 17 pass.

Runtime created this round: none beyond the existing worktree install (no database clusters, browser
binaries or copied source trees). `npm prune` only removed the extraneous packages from the existing
install; no install was copied into the plan folder or outside the worktree. The plan, history and
livetest documents remain active and untracked in the root checkout.

## Verifier round 2 (of 3) finding fixed (24 October 2026)

One high finding, fixed in the worktree. No commit, branch change, stash, install-replacement or
completion rename performed.

- **1 (high) — combined startup backup pruners deleted clean-up/archive backups promised to stay and
  kept those deletions out of the keep-3 accounting.** Reproduced first with an isolated fixture in the
  verifier's shape (two older `state_5-before-aio-cleanup-*` / `state_5-before-aio-archive-*` files plus
  six `state_5-before-rollout-reconcile-*` copies) run through the two real functions in startup order:
  five files and 35 bytes disappeared while the `Codex backup keep-3 run` entry said removed=2 and
  bytesFreed=14 (transient spec removed after the fix; verifier evidence
  `/tmp/phaseb-verifier-HLcl42/retention-probe.log` matched). Root cause had two parts: (a) the
  keep-5/week-age safety net `pruneCodexStateBackups` matched every `state_5-before-*.sqlite`, including
  the clean-up and archive backups the Storage card promises stay ("Clean-up and archive backups stay",
  `storage-usage-card.component.html`) and the livetest requires to remain with links; (b) startup ran
  that net before `pruneConfiguredCodexBackups`, so both pruners deleted in one run and the keep-3 entry
  could only account for its own deletions — the livetest requires that entry to agree with the
  before/after filesystem observation. Fixes: (a) the safety net's selector now excludes
  `state_5-before-aio-cleanup-*` and `state_5-before-aio-archive-*`, lists with `lstatSync` so links and
  non-regular files stay, and reports `{ removed, failed, bytesFreed }` instead of a bare count (its log
  carries the bytes too); (b) startup runs exactly one pruner per run through the new
  `pruneCodexBackupsAtStartup(keepThree, directory)` in `codex-backup-retention-policy.ts`: the
  configured keep-3 policy supersedes the safety net when on (it is stricter for every recognised
  reconcile copy the net manages, so running both only adds deletions the keep-3 entry cannot cover),
  and the safety net alone runs when the setting is off. The two former startup steps
  ('Codex state backup pruning' + 'Codex backup retention') are now one 'Codex backup pruning' step
  passing `codexBackupKeepThree === true`. Unrecognised `state_5-before-*` names age out only while the
  setting is off — the conservative direction, matching the prune tripwires' leave-unknown-files rule.

Regression coverage: `codex-state-backup-retention.spec.ts` rewritten around the new contract
(clean-up/archive never removed whatever their age and count; the old test that expected an archive copy
to be deleted now expects it kept; links left alone; recent copies still kept beyond the keep count;
result shape with bytesFreed). `codex-backup-retention-policy.spec.ts` gains a combined startup suite on
the verifier's fixture: keep-3 on removes exactly the three surplus reconcile copies, keeps clean-up and
archive copies, and the `Codex backup keep-3 run` entry equals the measured filesystem delta while the
safety net logs nothing; keep-3 off runs the safety net alone (keep 5, week age) with the same
protections and delta agreement; links and non-regular files stay in the combined path.
`src/main/app/late-runtime-codex-backup-step.spec.ts` pins the wiring: the 'Codex backup pruning' startup
step calls `pruneCodexBackupsAtStartup` with the configured setting.

Checks re-run (24 Oct, all exit 0): targeted `test:quiet` — `src/main/app/` + `src/main/cli/adapters/codex/`
80 files / 2199 tests (retention + policy suites 24 of them); `npx tsc --noEmit`; `npm run typecheck:spec`;
`npm run lint`; `npm run check:ts-max-loc`; `npm run build:main`; `npm run generate:ipc`,
`generate:aliases`, `generate:architecture` re-run with no output changes. Full suite reserved for the
verifier (worker instruction). The installed keep-3 first-run check stays in the plan's livetest document.

Follow-ups landing note: that branch's `codex-state-backup-retention.ts` defines the same
`CODEX_CLEANUP_NAME` / `CODEX_ARCHIVE_NAME` constants (its card selectors); main's copy now carries them
too, in the same shape, used by the safety net's protection. When the follow-ups branch lands, keep this
startup reconciliation (single deletion actor per run, protected clean-up/archive/link files) alongside
the card selectors and automatic-name producer the Step 6 as-built note already reserves.

Runtime created this round: none beyond the existing worktree install (temp fixtures under the OS tmp
dir were removed by the specs' own cleanup). The plan, history and livetest documents remain active and
untracked in the root checkout.
