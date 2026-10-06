# Plan Queue autonomous decisions and stale questions

Status: completed locally on 2026-10-04 after independent verification. James authorized implementation and cleanup. Installed-app adoption remains deferred in the [companion livetest](2026-10-04-plan-queue-autonomous-decisions_livetest.md). Work stayed in the existing checkout; no commit, push, branch/worktree creation, install or app restart was performed.

## Intended behavior

Routine technical choices are resolved from repository evidence and existing user instructions. New triage classifies questions as technical choices, missing human authority or missing human information. Legacy/unclassified questions and unknown worker input/permission waits remain manual until investigated. Automatic decisions are recorded as agent decisions and do not confer authority, relax security, or drop unverified requirements.

Pre-start queue entries are reconciled with the current document lifecycle before triage, scheduling and recovery. A missing active document with an exact completed sibling is retired as superseded, never marked as a verified PASS. A missing document without a completed replacement is an actionable error, not a fabricated question or success. Existing work on branches is preserved.

## Investigation

- The live run `2e00ad73-009c-4e60-84db-7a798eca12bd` had 38 questions, 19 parked items, 5 landed items, and no active worker.
- 33 questions referenced documents closed on 2026-09-27; their remaining checks had separate consolidated owners.
- Before this fix, triage instructed agents to ask about review/dependencies, missing planning files bypassed triage, and stored items were not reconciled after document closure.
- Parent messages and worker prompts previously attributed every readiness decision to James. The queue lacked a technical-decision provenance contract.

## Tasks and acceptance

- [x] Retire the obsolete idle live run using supported stranded-run cancellation. Read back zero questions and preserve all 19 parked records and branches.
- [x] Add optional decision metadata to readiness questions: technical recommendation with reason/evidence, human authority, or missing human input. Preserve legacy unclassified questions. Validate option identity and recommendations.
- [x] Automatically select only validated technical recommendations, persist agent provenance and forward the recorded decision to the worker. Human and unclassified questions remain pending; caller authority stays intact.
- [x] Give triage and workers explicit autonomy instructions and safe partial-work guidance. Investigate missing specs/dependencies rather than immediately asking James. Do not auto-approve worker permission waits.
- [x] Reconcile pre-start items during normal scheduling and recovery, safely retire completed replacements, preserve git-owned work, and report missing documents as errors. Re-read state after asynchronous filesystem checks to avoid racing cancellation/answers.
- [x] Cover technical auto-answer, human/legacy boundaries, recovery, stale replacements, active-vs-completed precedence, missing documents, and concurrency with focused regression tests. Verify actual coordinator behavior before adjusting obsolete tests.
- [x] Run `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, and `npm run test:quiet`, retaining logs locally.
- [x] Run the fresh-agent task-completion gate; fix every actionable finding and repeat with a fresh reviewer until PASS.
- [x] Update as-built evidence and rename this document `_plan_completed.md` only after the required checks pass. Any genuine installed-app restart check must be explicitly deferred in a companion livetest document.

## Cleanup evidence

Supported `plan_queue_control(cancel)` returned `{ done: true }`. A subsequent full `plan_queue_status` read returned `cancelled`, zero question objects, 38 skipped, 19 parked, and 5 landed; all preexisting parked item IDs and branch names were retained. No branch discard or app restart was performed.

## As built and verification

- Contracts validate optional classified decisions, unique options and existing non-skip technical recommendations. The readiness helper revalidates persisted metadata before selecting anything.
- Technical choices retain bounded original question, selected option, reason and evidence with neutral automatic provenance. Workers receive the answer inside escaped data delimiters. Human/legacy questions, worker permission waits and existing caller/role restrictions remain unchanged.
- Real plans with missing linked specs go to autonomous triage. Unplanned specs without an implementation plan are skipped with an explicit planning prerequisite and their source left open; their required planning rename would otherwise invalidate the queue's original path. No spec is falsely completed.
- Normal scheduling and boot recovery reconcile untouched pre-start entries. Exact completed replacements retire entries without a PASS; missing/nonfile/permission errors park as technical failures. Active sources take precedence. Current rows/run status are re-read after filesystem awaits, preserving cancellation and worker starts. Git-owned work is preserved.
- Supported live cancellation returned success; both implementer and independent reviewer then read the boot-wired loop database in read-only mode and verified cancelled, zero questions, 38 skipped, 19 parked and 5 landed. All 19 exact parked branches still exist in Git. Source checks remain recorded in their owning documents.

Regression evidence: before implementation, four coordinator regressions failed (`_scratch/test-run.pid-62913.log`) and 15 schema/prompt/MCP regressions failed (`_scratch/test-run.pid-34743.log`). Advisory review then caught lost question context and the unplanned-spec lifecycle mismatch; both were fixed before final verification.

Final focused verification on pinned Node24.15.0 passed 105 tests across five scoped files, exit0 (`_scratch/plan-queue-autonomy/final-focused.log`, raw `_scratch/test-run.pid-78089.log`). All six non-test canonical gates passed locally. Earlier broad attempts were accurately recorded as failed: ambient Node26 caused two SEA failures, and concurrent ledger edits caused transient typecheck/full-suite failures. No unrelated file was changed or test suppressed; the current concurrent ledger file independently passed17/17 before the final gate.

The genuinely fresh `task-completion-gate` reviewer returned **VERDICT: PASS**, no unresolved actionable findings. It independently ran every canonical gate with pinned Node24.15.0; all seven exited0. The unfiltered full suite passed **2,345 files / 29,509 tests**, zero failures, with six existing skips (29,515 total). Evidence:

- Independent report: `_scratch/plan-queue-autonomy/review1/report.md`.
- Exact commands, exit codes and logs: `_scratch/plan-queue-autonomy/review1/gates.json`.
- Full output: `_scratch/plan-queue-autonomy/review1/full-tests.log`, raw `_scratch/test-run.pid-87087.log`, structured `_scratch/test-results.pid-87087.json`.
- Compiled-runtime smoke: `_scratch/plan-queue-autonomy/review1/compiled-smoke.log`, including manual input/permission waits, worker-start/FS race, duplicate triage protection and 5,000 real documents reconciled without unintended transitions.
- Read-only live cleanup and retained branches: `_scratch/plan-queue-autonomy/review1/live-cleanup.json` and `retained-branches.json`.
- Candidate integrity: all 12 source/test hashes match `_scratch/plan-queue-autonomy/task-hashes.json`; the reviewer preserved the same unrelated dirty paths. No dependency/config changes or clean install were required/performed in this shared checkout.

A later live MCP status refresh was rejected before execution with `SOURCE_MESSAGE_MISSING` by the separately tracked installed evidence-source issue. Read-only SQLite verification confirmed the cleanup without bypassing authorization or issuing a retry mutation.

The only remaining checks require installing/restarting the daily-driver application and observing its loaded tools and panel. They are recorded solely in [the companion livetest](2026-10-04-plan-queue-autonomous-decisions_livetest.md), not claimed verified here. Checkout builds and compiled-runtime tests do not prove adoption by the running installed app.
