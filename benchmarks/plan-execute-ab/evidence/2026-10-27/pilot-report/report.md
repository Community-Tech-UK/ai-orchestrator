# plan/execute A-B benchmark report

Session: /Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-14-local-model-plan-ex-a7a00e/_scratch/lt-local-model-2026-10-27/results/pilot-2026-10-15
Created: 2026-10-27T13:12:51.276Z

## Results per arm

| Arm | Runs | Hidden tests pass | Solved (tests + no damage) | Solved % (95% range) | Avg time | Avg output tokens | Avg Claude tokens | Avg local tokens | Judge W/L/T |
|---|---|---|---|---|---|---|---|---|---|
| A | 10 | 3 | 3 | 30% (11%–60%) | 22.9 min | 84591 | 7345191 | 0 | 0/0/0 |
| D | 10 | 3 | 3 | 30% (11%–60%) | 7.5 min | 10124 | 2539625 | 0 | 8/10/2 |
| G | 10 | 3 | 3 | 30% (11%–60%) | 13.3 min | 21525 | 0 | 0 | 7/12/1 |
| C1 | 2 | 0 | 0 | 0% (0%–66%) | 60.0 min | 0 | 544406 | 277694 | 0/2/2 |

Claude tokens are the volume Opus/Sonnet processed (planner + Claude-billed coder + takeover, including cache reads/writes); local tokens are the local model's coder volume. Hosted-GLM and Codex coder tokens appear in neither column.

## Serving setups (fairness control)

- C1: llama-server-2.60.0-27b-65536

## Uncertainty (95% ranges)

The task is the unit: repeat runs of one task are not independent evidence, so ranges are Wilson score intervals over tasks. Overlapping ranges mean a gap can be noise — the plan's honest limits: 30 tasks can only show large differences, roughly 15–20 points.

| Arm | Solved | 95% range | Hidden tests pass | 95% range |
|---|---|---|---|---|
| A | 30% | 11%–60% | 30% | 11%–60% |
| D | 30% | 11%–60% | 30% | 11%–60% |
| G | 30% | 11%–60% | 30% | 11%–60% |
| C1 | 0% | 0%–66% | 0% | 0%–66% |

### Solved-rate gap vs arm A (percentage points)

| Arm | Gap vs A | 95% range | Reading |
|---|---|---|---|
| D | 0 | -36 to +36 | can be noise at this size |
| G | 0 | -36 to +36 | can be noise at this size |
| C1 | -30 | -60 to +39 | can be noise at this size |

Gaps use Newcombe's interval for two proportions. The arms share tasks, so a paired interval would be tighter when outcomes move together; this form is the conservative side.

## Cost (metered USD)

| Arm | Coder | Plans | Takeover | Total | Solved | Cost per solved |
|---|---|---|---|---|---|---|
| A | $23.04 | — | — | $23.04 | 3 | $7.68 |
| D | $4.98 | $12.41 | — | $17.39 | 3 | $5.80 |
| G | — | — | — | $0.00 | 3 | $0.00 |
| C1 | — | $1.44 | — | $1.44 | 0 | — |

- Shared Opus planners: $12.41 across the session's planned tasks.
- Shared Claude judging: $25.85 (Codex judging runs on ChatGPT plan limits — no metered cost).
- D: includes the Opus planner cost of its tasks (one planner run per task, shared with every plan arm and counted in full, so cost per solved is this workflow standalone)
- G: Codex runs on ChatGPT plan limits: no metered USD cost
- C1: local coder: no metered cost (its logs hold a nominal CLI estimate that is never billed)
- C1: includes the Opus planner cost of its tasks (one planner run per task, shared with every plan arm and counted in full, so cost per solved is this workflow standalone)
- Figures are the CLI-reported total_cost_usd per invocation (what Anthropic billed).
- Plan cost is shared: one Opus planner run per task feeds every plan arm, and each arm is charged its tasks' plans in full — summing arm totals double-counts plans.
- Spend includes runs later quarantined: the money was spent either way.

## Failure modes

| Arm | Looped | Tool-call errors | Hit turn cap | Gave up | Run errors |
|---|---|---|---|---|---|
| A | 0 | 5 | 1 | 2 | 2 |
| D | 0 | 3 | 0 | 0 | 0 |
| G | 0 | 10 | 0 | 0 | 0 |
| C1 | 0 | 1 | 0 | 1 | 2 |

## Judges

- Judge pairs with both judges answering: 22
- Pairs where both judges gave the same verdict: 17
- Judge verdicts that conflict with hidden tests: 0 (tests never overridden)

## Local model speeds

| Model | Measured at | Prompt tok/s | Write tok/s | Source | Gate |
|---|---|---|---|---|---|
| qwen3.8-27b | 2026-10-16T17:20:53.507Z | 894 | 61.7 | wall-clock | n/a |
| qwen3.8-flash-next | 2026-10-23T23:58:39.699Z | 647 | 341.3 | wall-clock | PASS (keep C2) |
| qwen3.8-flash-next | 2026-10-24T00:04:46.319Z | 797 | 21.0 | server-timings | PASS (keep C2) |

- Speed gate (C2 / Flash-Next): PASS — keep C2 — prompt 797 tok/s and write 21.0 tok/s both clear the gate

### Per-run probe speeds

| Arm | Measured runs | Unmeasured runs | Avg prompt tok/s | Avg write tok/s |
|---|---|---|---|---|
| C1 | 2 | 0 | 725 | 4.0 |

## Pre-agreed decision rules

- [not triggered] speed gate (setup): C2 needs 300+ prompt tok/s and 15+ write tok/s on a real 30k-token prompt
  - prompt 797 tok/s and write 21.0 tok/s both clear the gate
- [not triggered] pilot stop rule: stop if the better of C1/C2 is more than 25 points behind A on hidden tests
  - C1/C2 coverage or repeat-run coverage incomplete or unmatched to A — rule not evaluable yet (unless C2 was speed-gated out)
- [not triggered] C1 vs C2: keep C2 in the full run only if it beats C1 clearly (>= 20 points or 2+ tasks)
  - C1/C2 coverage or repeat-run coverage incomplete or unmatched to A — rule not evaluable yet