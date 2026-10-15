# Retained worker evidence cleanup plan

Status: completed and verified; untracked. No commits or pushes are authorised.

Source: `/Users/suas/work/communitytech/evidence-dump-cleanup-2026-10-13_prompt.md`.

Goal: remove explicitly regenerable evidence bulk without losing records or live process data, and prevent future workers leaving copied runtimes beside plans.

Architecture: retain the existing Plan Queue prompt builders and call paths. Share one literal cleanup instruction between implementation workers, live-test workers and fix rounds. Add the verifier instruction beside the existing ignored-build-output allowance. This is prompt guidance, not an automatic filesystem deletion feature.

Constraints: keep the current branch/checkout; preserve unrelated dirty-tree work; do not delete tracked files, follow symlinks, change ignore rules, or touch live evidence directories. Keep named reports/seals/receipts and small Markdown/JSON records. James's supplied scope and decision-autonomy rule supersede process-only approval gates.

## Task 1: evidence bulk

- [x] Read Community Tech/work-finding instructions, measure both target trees and save baseline status/tracked-file inventories.
- [x] Inspect process command lines/open files and current Plan Queue status. Skip any directory whose live-use safety cannot be established.
- [x] Inventory then remove only authorised bulk, preserving records; write per-directory CLEANUP.md receipts with byte measurements.
- [x] Re-measure both trees and verify tracked content, ignored rules and unrelated changes were preserved. Record skips explicitly.

## Task 2: standing prompt rule

Files: `src/main/plan-queue/plan-queue-prompts.ts` and adjacent `.spec.ts`.

- [x] Read entire implementation/spec, caller `plan-queue-item-flow.ts`, types, architecture and prompt house style.
- [x] Assert the supplied worker cleanup text in both worker kinds and fix prompts, and the verifier text in both verifier kinds. Run the spec first: new assertions must fail because the cleanup instruction is absent.
- [x] Add one shared worker string to buildWorkerPrompt, buildLivetestWorkerPrompt and buildFixPrompt; add the supplied verifier sentence beside the ignored-output rule. No signature or dispatch changes.
- [x] Run the focused spec and canonical gates: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, `npm run test:quiet`. Retain full logs under `_scratch/evidence-dump-cleanup-2026-10-13/` with real exit codes.
- [x] Obtain fresh-context task-completion-gate review covering this uncommitted diff, acceptance criteria and verification. Fix actionable findings and repeat review.
- [x] Close this plan only if all requirements/gates pass; otherwise retain active status and exact blockers.

## Review focus

- The live-test worker is reached through buildWorkerPrompt; it needs its own assertion.
- Fix rounds run in the same worker session or respawn through a resume prompt; the cleanup rule must be present in the fix prompt itself.
- Verifier instructions must apply to both plan kinds and retain valid structured examples.
- Reports and seals remain available after runtime removal; copied checkouts and dependency trees must not survive outside the worktree.
- Prompt guidance cannot guarantee that a model obeys cleanup; no automatic cleanup capability is claimed.

## Evidence and as-built notes

Completed 13 October 2026. Both requested parts are implemented and verified.

### Evidence cleanup

| Tree | Before du -sh | After du -sh |
|---|---:|---:|
| /Users/suas/work/communitytech/work-finding-evidence | 3.7G | 1.6G |
| /Users/suas/work/communitytech/work-finding/documents/plans/desk-shared-crm-2026-09-18 | 9.0G | 7.9G |

- Removed 39,113 regenerable files: 3,311,033,035 logical bytes. Wrote 18 CLEANUP.md receipts.
- Preserved all 30,557 protected records, two tracked target files and 140 symlinks. Parent and fresh reviewer independently verified record hashes; no mismatches.
- Native read-only process enumeration supplied all live James-owned command lines; inaccessible system/other-user processes were classified by owner/state and executable path. Complete lsof had no warnings or target handles. The paused Work Finding queue item targets the unrelated fifty-card fixture plan. No live directory skipped and no process stopped.
- Both repository statuses match their pre-cleanup baselines, including existing ignore rules and unrelated edits. Rechecked after final verification. Original source prompt remains unchanged and untracked.
- Large JSON records, hashed evidence blobs, stdout receipts and archives outside authorised bulk remain deliberately. Remaining evidence is approximately 9.5G; no APFS free-space recovery claim.
- One explicitly authorised untracked 1,296,272-byte raw.log required clearing its user-immutable flag; recorded in its owning cleanup note.
- First fresh review found a 6,148-byte .DS_Store inside an authorised npm cache. Removed it after fresh process/tracked/symlink checks; reconciled manifest, owning note and totals. A genuinely new reviewer then passed the updated work.
- Temporary native inspection executables removed after verification; source scripts, manifests, hashes and command receipts remain under _scratch.

Cleanup handover and full baseline/status evidence: `_scratch/evidence-cleanup-2026-10-13/completion-handover.json`, `post-cleanup-verification.json`, `review-followup-verification.json` and associated manifests.

### Standing prompt rule and verification

- Exact requested worker instruction is shared by implementation workers, live-test workers and fix prompts. Resume paths inherit it through buildWorkerPrompt. The exact verifier sentence follows the ignored-build-output allowance for both plan kinds.
- Prompt guidance instructs agents to remove their own runtime after writing reports/seals/receipts; it does not implement automatic deletion.
- Five new prompt cases failed before implementation (exit1, `_scratch/test-run.pid-22372.log`) and all18 passed afterwards (exit0, `_scratch/test-run.pid-26145.log`). Fresh reviewer independently reexecuted focused tests and compiled builders, including verifier adjacency. Existing assertions remain intact.
- Final canonical gates all exited0: typecheck, spec typecheck, lint, TypeScript file-size check, main build, renderer build, full quiet suite. Raw logs and real exit receipts: `_scratch/evidence-dump-cleanup-2026-10-13/final/`.
- Final uncached full suite: 2,420 files, 31,273 passed, zero failed, six unchanged preexisting skips (31,279 total). Raw `_scratch/test-run.evidence-cleanup-final.log`; structured `_scratch/test-results.evidence-cleanup-final.json`; wrapper `final/test-full.exit` is0.
- Seven monitored prompt/routing/helper source hashes were unchanged throughout the final run; `final-source-snapshot.json` and `final-source-verification.json` retain the evidence. Scoped git diff --check exited0.
- The original full run failed five tests in preexisting routing/helper work. Those source files changed after that run started; failure output included an export absent from the loaded module that exists in the current file. Exact cache/transform mechanism remains unproven. Current focused tests and stable full rerun pass. No unrelated code or tests were edited for this task. The first failure evidence is retained in `_scratch/test-results.pid-28473.json` and `_scratch/evidence-dump-cleanup-2026-10-13/test-full.log`.
- The running AIO app needs a restart to load the rebuilt prompt wording. Required builder behavior is verified directly in compiled runtime output; no browser/desktop interaction was used.

Final fresh-context task-completion-gate verdict: **PASS**, no unresolved actionable findings. Report: `_scratch/evidence-cleanup-2026-10-13/review2-report.md`. Existing checkout/install preserved; no branch, worktree, commit, push or dependency reinstall created.
