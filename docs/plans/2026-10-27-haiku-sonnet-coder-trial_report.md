# Haiku/Sonnet coding trial: report

Status: Test 1 CLOSED as it stands (James's 20 November 2026 decision). Test 2 (the matched Sonnet-low vs Sonnet-default split in the live queue) NOT RUN: no unowned plan documents exist to split. Source: [active plan](2026-10-27-haiku-sonnet-coder-trial_plan.md); the live check is in the `_livetest.md` beside it. Updated 26 Nov 2026.

Earlier saved evidence (round-by-round receipts, the reconcile replay) lives in the coordinator checkout at `/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-27-haiku-sonnet-coder-trial_evidence/`. It is not copied into this branch.

## Decisions that govern this report (James, 20 November 2026)

1. Test 1 is closed as it stands. The one missing cell (`12ST-03|H|2`, Haiku high) and the Codex second judge are dropped, not pending. The missing cell cannot change the ranking, and the pinned runtime and saved session are gone, so a re-run would be a different experiment. Hidden tests decide solves; the judges only compared quality where both sides passed, and the second judge's failure is a stated limitation.
2. The seven-batch concurrency deviation is accepted. All seven settings ran at the same time on one machine, so each faced the same load. Recorded minutes are not reliable absolute speeds; the comparison between settings stands.
3. The agent picks the Test 2 batch and decides fairness; no further approval from James is needed.

## Test 1 result

Sonnet low is the candidate to take into Test 2, with Opus high as the stronger worker. Overlapping ranges mean quality is too close to call on ten tasks; the case for Sonnet low is cost and speed at equal solves.

| Setting | Scored | Solves | Task-weighted rate, 95% range | Recorded minutes/run | Logged coding USD | USD/solve |
|---|---:|---:|---|---:|---:|---:|
| Opus, no plan | 30/30 | 9 | 30.0% (10.8–60.3%) | 34.3 | $68.35 | $7.59 |
| Haiku high | 29/30 | 9 | 30.0% (10.8–60.3%) | 39.9 | $27.08 | $3.01 |
| Haiku max | 30/30 | 8 | 26.7% (9.0–57.3%) | 43.1 | $117.49 | $14.69 |
| Sonnet low | 30/30 | 9 | 30.0% (10.8–60.3%) | 4.8 | $9.90 | $1.10 |
| Sonnet medium | 30/30 | 9 | 30.0% (10.8–60.3%) | 17.6 | $15.03 | $1.67 |
| Sonnet high | 30/30 | 9 | 30.0% (10.8–60.3%) | 20.9 | $19.39 | $2.15 |
| Sonnet max | 30/30 | 6 | 20.0% (5.7–51.0%) | 40.6 | $151.78 | $25.30 |

A solve requires hidden-test success and no damage. Repeats are averaged within each task; the range uses ten task units, not thirty independent tasks. Haiku high has 29 of 30 cells scored (the dropped cell above). Minutes were measured with seven batches running together, so read them as relative, not absolute.

Available session-log cost is at least $427.27, covering coding, Claude judging and quarantine. 34 Claude invocation segments have no final cost (18 coder, 8 judge, 8 quarantined), and Codex judge usage is unknown. Costs are metered-equivalent lower bounds, not invoices. Historical frozen-plan cost ($12.41) is separate.

## What is built (on main in commit 339d21c9c)

1. **Queue thinking-level control.** `plan_queue_start` and `plan_queue_control set-routing` accept `effort`, so Test 2 can set Sonnet to low for one run and leave the default on the other.
2. **LT-722 triage repair.** Three real triage runs applied on the test Mac (3 of 3).
3. **Outcome report** (`scripts/queue-coder-outcomes-report.mjs`) and **reconcile** (`scripts/coder-trial-reconcile.mjs`), plus the offline judge-retry preparation and import (`scripts/coder-trial-judge-retry.mjs`). Tests: `scripts/__tests__/coder-trial-judge-retry.spec.ts`, `coder-trial-reconcile.spec.ts`, `queue-coder-outcomes-report.spec.ts`.
4. **Honest history reporting.** The outcome report field is `earliestAvailableReportPass`: the earliest accepted report call that is still available, not a proven first check. `firstCheckPass`, `totalRounds` and complete cost stay `null` when the archive cannot show them.

Why history cannot be rebuilt from today's data (read from the executing path): `recordVerdict` only puts a pending verdict in memory (`src/main/plan-queue/plan-queue-item-flow.ts:602-606`); `finishVerification` deletes that pending entry when the checker stops (`plan-queue-item-flow.ts:614-623`, delete at line 623) and can discard it on pause or user close. The item row keeps only the latest verdict (`verdict_json`, `src/main/plan-queue/plan-queue-store.ts:362`). Step-up resets `round` and `erroredRounds` (`src/main/plan-queue/plan-queue-step-up.ts:54`). `plan-queue-spend.ts:17,23` skips events with no queue attribution or no usage, without a durable count. So applied-verdict history, first-check pass and total rounds are only as good as the archived reports.

## Test 2: not run

Prerequisites are met (effort control on main; the installed tool schemas accept `effort`). What is missing is documents: on 26 November all 42 `*_plan.md` files in `docs/plans/` are owned by queued or running queue items (six live runs), so none is free to put into either arm. The 20 November rules require at least 12 unowned small or medium documents that need no person or outside service; fewer than that and the result would be too small to call, and the worker will not take documents from another run. The protocol (sort by size, pair neighbours, seed-recorded coin flip, both arms started together, every chosen document counted) is in the livetest doc, check 3. Nothing is substituted or approximated here.

## Reproduction

```sh
npm run test:quiet -- scripts/__tests__/coder-trial-judge-retry.spec.ts scripts/__tests__/queue-coder-outcomes-report.spec.ts scripts/__tests__/coder-trial-reconcile.spec.ts src/main/plan-queue/plan-queue-effort.spec.ts
npm run audit:queue-coder-outcomes -- --run <armA-id> --run <armB-id> --json   # after Test 2 runs
```
