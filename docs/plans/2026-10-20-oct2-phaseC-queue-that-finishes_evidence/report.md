# Phase C partial implementation handoff

Status: IN PROGRESS. **12 of 13 items implemented on the queue branch (24 Oct resume); the remaining open
pieces are cross-branch/live items listed per row below.** Not a whole-plan PASS and not an instruction to
integrate or rename the plan.

Plan: [active plan](../2026-10-20-oct2-phaseC-queue-that-finishes_plan.md).
As-built details: [history](../2026-10-20-oct2-phaseC-queue-that-finishes_history.md).
Installed/OS checks: [live tests](../2026-10-20-oct2-phaseC-queue-that-finishes_livetest.md).

## 24 October resume evidence

- Prerequisites re-verified in source before editing: Phase A's guards/usage-log exist only on its queue
  branch; Phase B's migration 24 likewise; `automation_result` (A15) exists nowhere; the root register is its
  owner's active uncommitted work. Sequencing decision recorded in the history: parallel implementation with
  new modules/extract-first room, following Phase B's precedent and the plan's own Ground rules 4/5
  (migration 25–27 taken in step order; 24 reserved for Phase B).
- Four implementation waves plus Step 7 built Steps 1–8 and the remaining 11.2-queue/12.2/13 items, each
  with RED-first tests. Fresh self-review of the whole diff fixed the diet's missing root-document hash
  guard (RED reproduced: a concurrent edit was clobbered) and hardened three load-sensitive waits that
  flaked under CPU contention (reproduced twice; identical selection then passed 822/822).
- Final targeted verification: **109 files / 1,396 tests passed**, exit 0 (`_scratch/test-run.pid-93781.log`,
  worktree `_scratch/`). Static gates all exit 0: `npx tsc --noEmit`, `npm run typecheck:spec`,
  `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, `generate:ipc`,
  `verify:ipc`, `verify:ipc-usage` (`_scratch/phasec-final/gates-1.txt` … `gates-4.txt`). This is not the
  full repository suite; that and a genuinely fresh task-completion-gate pass belong to the verifier.

| Item | Actual status and remaining work |
|---|---|
| 1. History/fingerprint | **Built 24 Oct** (migrations 25/27 tables; event+verdict rows on every transition/round; progress module). Wired and tested. |
| 2. Machine gate receipts | **Built 24 Oct.** Harness runs the gates before the checker; per-gate receipts with timeout flags and base comparison; `not_checked` required in both schemas; a PASS with a red "new" receipt is refused. |
| 3. Capacity/retry/recovery | **Built 24 Oct.** Transient errors wait with back-off; run preflight; worker-turn retry allow-list; `restart-loop` after three restarts without progress. |
| 4. Round memory | **Built 24 Oct.** Earlier-rounds block (≤12,000 chars), no-progress park, same-finding step-back log-only behind `PARK_ON_REPEATED_FINDING=false` (one-week live window in the livetest doc). |
| 5. Plan diet | **Built 24 Oct.** Diet at checkpoint (root history file, hash-guarded on both shared files), pinned criteria + document-change block for the checker, close-small at `_completed` rename, `_history` squash guard. |
| 6. Discovery/triage | **Built 24 Oct.** Copy/ignore skips, 16 KB headers, saved glob + counts + >25 confirmation, triage memory ("Already decided on <date>", "not reached" for cancelled runs), single-path runs skip triage, "Skip all not started". |
| 7. Queue spend | **Built 24 Oct.** Per-call `plan_queue_spend` rows (processed/output split, NULL unpriced, role/round/provider/model/basis); Codex self-estimates labelled estimated; honest labels ("$379.93 known · 17.2M tokens not priced"). |
| 8. Queue page | **Built 24 Oct.** Three tabs, History/N-earlier folding, exhaustive park-reason help, detail folding + path stripping, plain words, bulk previews, receipts and "Passed. Not checked: …" on the card. Live layout check deferred (livetest §6). |
| 9. Scheduled jobs | 9.1–9.3, 9.5–9.7 retained from earlier rounds. **9.4 (quiet result) remains open**: awaits Phase B's A15; `automation_result` exists nowhere yet. |
| 10. Second opinions | Code implemented and tested earlier. Post-K2 premium-per-review measurement remains a live check (livetest §1). |
| 11. Copilot | Labels/tail/loop recycle/compatibility warning earlier; **queue recycle built 24 Oct** at turn boundaries (livetest §3 covers the live check). Remote usage/recycling remains an implementation limitation. |
| 12. Live-check register | Script + AGENTS/runbook + queue prompt pointer done. **12.1 archive move and 12.3 register-header reword remain open**: the root register is its owner's active uncommitted work (LT-707 row written 24 Oct); the plan says wait for that owner or agree the move. 12.4 campaign awaits Phase B + the Windows PC. |
| 13. Full ephemeral usage line | Fields module + reader + Costs panel **built 24 Oct**. The one-line writer hook remains: Phase A's `codex-ephemeral-usage-log.ts` is only on its branch and was deliberately not copied here. |

## Current resume evidence

- Read the root plan and its full as-built history, current branch log/diff and relevant source. No standalone spec is linked.
- Confirmed prerequisite absence in source, not just old status prose: checkout guard, verdict nudge and minimal ephemeral usage-log modules are missing; active-document regexp still omits `_history`; no `automation_result` tool is present. Phase A/B status documents still report unintegrated work. Root `main` is `86970a6b9` (saved-login approval fix), while this branch's merge base is `542f1f690`; that new root commit supplies none of the missing prerequisites. Root register remains its owner's nine additions/zero deletions.
- Initial spec typecheck failed TS18048 in `automation-thread-budget.spec.ts`. The fixture already assigns generation 1; constructing that required numeric property with `Object.assign` preserves object identity and values while allowing the later increment to typecheck. No cast, assertion removal or production type change.
- Initial 116-file run: 1,496 passed/one failed/zero pending. The existing suppressed-admission test expected expiry at 63,001 ms (its final clock advance); actual production expiry is 62,000 ms, correctly derived from run start 2,000 + one minute 60,000. Updated only that exact timestamp, retaining the failure/error/no-send assertions. Raw RED results and initial compiler log are retained.
- Correction focus: two files/16 tests pass. Final uncached focus: **116 files/1,497 passed/zero failed/zero pending**, exit 0; selected and actual file sets match. This includes every changed spec and additional automation/Copilot coverage. It is neither the full suite nor a reproduction of the earlier 393-file selection.
- Final production/spec typechecks, renderer lint, main fast lint, correction-file ESLint, LOC and whitespace checks all exit 0. Alias/IPC generation, both builds and both IPC checks exit 0. All 8,078 tracked files were hashed: only the two intended spec lines changed; production bytes, HEAD and index are unchanged by this resume. Build/check logs retain warnings; no zero-warning claim.
- Earlier scratch directories and raw review reports are absent from both checkouts. Historical notes remain in the history document and [prior handoff](report-before-resume-20261021.md); pending focused15/review15 results cannot be certified or reconstructed from those claims. No fresh independent PASS is asserted here.
- Fresh read-only OS preflight failed to spawn `ps` with `PermissionError: [Errno 1] Operation not permitted`. No live process-tree fixture was started. Older fixture absence remains unknown; no guessed process identity was signalled.

## Receipts, seal and cleanup

Current logs, raw test JSON, exact selection, source integrity and prerequisite receipts:
[resume evidence](resume-20261021/). Machine command receipts:
[commands](../2026-10-20-oct2-phaseC-queue-that-finishes_commands.jsonl).
The sibling `_seal.json` binds current source and retained evidence. Cleanup runs only after these are written;
`resume-20261021/cleanup.json` records its outcome. Only the resume-created ignored `dist/` and disposable
verification helper are selected. Pre-existing `node_modules`, its cache links and `build/` remain untouched.
No database cluster, browser, dependency installation or copied checkout was created.

## Coordinator action

Keep the plan active. When the verifier passes this diff, the remaining open rows need: Phase B's A15 landing
(9.4), the root register owner's commit or an agreed move (12.1/12.3-header), Phase B landings plus the
Windows PC (12.4), and one line in Phase A's `CodexEphemeralUsageLog.finish()` calling
`codexEphemeralUsageFields` (13). Merge note for the integrator: this branch deliberately mirrors sibling
shapes where they overlap (the `_history` regex matches Phase A's exact form; `plan-queue-run-relaxation.ts`
mirrors Phase A's class/API; migrations 25–27 leave version 24 to Phase B) — resolve conflicts keeping both
sides' behaviour, especially Phase A's checkout guard/verdict nudge in `plan-queue-item-flow.ts` and
`plan-queue-coordinator.ts`. Preserve other sessions' root edits. The independent verifier owns the full
suite and a genuinely fresh task-completion-gate pass; the coordinator owns commits, integration and
completion renames. No commit, stash, branch/worktree creation, restart or external action was performed
during this resume.
