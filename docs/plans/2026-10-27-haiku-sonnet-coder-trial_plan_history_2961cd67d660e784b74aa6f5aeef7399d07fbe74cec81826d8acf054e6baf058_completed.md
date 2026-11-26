## Snapshot of 2026-10-27-haiku-sonnet-coder-trial_history.md


## Round 5 (resume after usage limit), 26 Nov 2026

Read-only reconciliation; no model calls, no queue changes.
- Branch `queue/2026-10-27-haiku-sonnet-coder-f40630` is the stale parked copy. Its code (effort control, LT-722 triage repair, outcome report, reconcile and judge-retry scripts) already landed on main in 339d21c9c via the livetest item; no code was changed here. Focused tests in this worktree: 4 files, 17 tests passed (`npm run test:quiet -- scripts/__tests__/coder-trial-*.spec.ts scripts/__tests__/queue-coder-outcomes-report.spec.ts src/main/plan-queue/plan-queue-effort.spec.ts`, exit 0).
- Installed `plan_queue_start` / `set-routing` schemas now accept `effort`, so rule 4 of the 20 Nov decision no longer blocks Test 2.
- Census: 42 `*_plan.md` in docs/plans; `plan_queue_status` shows six live runs holding queued or awaiting-slot items on them (keep-working-while-mac-away, codex-device-login-handoff, livetest-existing-blockers, expanded-livetest-blockers, oct-phase3-calm-screen and others). No unowned set of 12+ documents exists, so the split was not started and no ownership was touched.
- Plan and livetest documents reconciled to the 20 Nov decision: steps 6, 7, LT-722, score recovery and fairness closed; livetest checks 1 and 2 marked dropped; check 3 rewritten as the single live check.
- Still open: steps 8 to 12, complete applied-history validation, full-suite gate (verifier's), step-up account fence readback.

## Round 6 (verification round 1 fixes), 26 Nov 2026

- Finding 3 (plan and livetest committed on the branch): `git rm` in the worktree removed `..._plan.md` and `..._livetest.md` from the index and worktree (staged deletion only, no commit). Root-checkout copies remain untracked (`git status --short` there shows `??` for plan, livetest, history). The report stays tracked, as on main.
- Findings 1 and 2: not code. Needs approval for more benchmark/judge calls, a fairness decision on the seven-batch run, an eligible Test 2 batch, and a protocol-equivalent scoring workspace for 12ST-03|H|2. Left open, nothing worked around.
- Focused tests re-run: 4 files, 17 tests passed (exit 0).

## Round 7 (verification round 2 fixes), 26 Nov 2026

- Finding 1 (report stale): rewrote the tracked `..._report.md` to the 20 Nov decision: Test 1 closed as it stands, missing cell and second judge dropped, concurrency deviation accepted, no further approval needed. Citations re-read against the worktree: `recordVerdict` plan-queue-item-flow.ts:602-606, pending verdict deleted at :623, `verdict_json` plan-queue-store.ts:362, step-up reset plan-queue-step-up.ts:54, spend skips plan-queue-spend.ts:17,23. The old 504/514 citations were wrong. Livetest "Prerequisites" paragraph and plan Status lines that still asked for approval were corrected.
- Finding 2 (environment): no unowned plan documents for the Test 2 split. Not worked around; no run started.


   byte-identical and its receipt records the delivered script/test hashes. Source readback disproved one review
   premise: all saved judge pairs do contain explicit repeat identities. Independent full-suite execution is still
   reserved for the queue verifier; the review contexts' shell restrictions do not substitute for that execution.
7. The third fresh source-review context returned `Scoped reconciliation review: PASS, no actionable findings`.
   Its report is `2026-10-27-haiku-sonnet-coder-trial_evidence/fresh-review-3.md`. It read the final source and
   receipts but could not execute shell checks; this is not independent full-gate execution or whole-experiment
   acceptance. The final focused handoff run passed eleven Node tests. Original experiment gaps remain open.

Current ruling after verification round 1: the earlier reconciliation-only delivery did not satisfy the entire
experiment. Round 2 adds queue effort control, triage discovery and a read-only outcome snapshot script; these
local prerequisites must pass their own verification and are not human-only deferrals. Original experiment
steps 6–12 remain open. New benchmark/judge calls, live routing and a real-plan campaign still have no current
authority; the saved readiness answer explicitly preserves these boundaries. Missing evidence is not completion.
Only actual external runtime checks are recorded in the [live checklist](2026-10-27-haiku-sonnet-coder-trial_livetest.md).
Offline preparation, missing authority and environmental blockers remain in this active plan; they are not deferrals.
No separate linked spec exists. This root plan remains untracked at its original path and filename; independent
queue verification and any completion rename remain the coordinator's responsibility.

> Plan Queue parked work: `queue/2026-10-27-haiku-sonnet-coder-9a5d45` — 1 commit(s), reason: worker-error.


