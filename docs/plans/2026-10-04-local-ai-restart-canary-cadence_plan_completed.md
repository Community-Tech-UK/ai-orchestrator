# Local AI Guard: keep canary cadence across restarts — plan

Status: COMPLETED (2026-10-04). Live check: case A/B of check 6 in
[2026-10-03-aux-llm-lmstudio-dual-gpu_livetest.md](2026-10-03-aux-llm-lmstudio-dual-gpu_livetest.md). Follow-up to
[2026-10-03-aux-llm-lmstudio-dual-gpu_plan_completed.md](2026-10-03-aux-llm-lmstudio-dual-gpu_plan_completed.md).

## Problem

After James rebuilt and restarted Harness (2026-10-04 10:45), the Health Centre showed the
LM Studio target green on every layer but "Checking", with "Routing roles: None currently
eligible", and every auxiliary call fell back (`health-checking`).

Root cause (verified from `local_ai_health_samples` and the code):

- The engine trusts canary (`inference`) evidence for `canary.intervalMs + freshnessLimitMs`
  (`layerFreshnessLimitMs`, 10 + 2 = 12 minutes here). Stale required evidence keeps a target
  in `checking` with no routable roles.
- `LocalAiHealthScheduler.scheduleTarget` always scheduled the first functional check a full
  interval after start or worker reconnect.
- The last canary before the restart ran at 10:33:48, so the persisted evidence went stale at
  10:45:48 and the next canary was not due until about 10:55:42. Local routing was off for
  that whole gap. This happens after any restart more than about two minutes after the last
  canary, and was not caused by the 2026-10-03 change.

## Fix

- `initialFunctionalDelayMs(lastCanaryAt, intervalMs, now)` in `local-ai-health-engine.ts`:
  with persisted canary evidence, the first canary is due one interval after the last one, or
  immediately if that is past. With no canary evidence the normal interval applies (nothing
  can go stale, and lightweight evidence alone can make the target healthy).
- `scheduleTarget` uses it for the first functional check.

## Also done live (windows-pc, no code)

Overnight, two concurrent ~96k-token compression calls failed with LM Studio
`failed to decode, ret = 1` (KV cache exhausted): the 35B shared one 131072-token context
across 4 parallel slots. `load-models.mjs` now loads `qwen/qwen3.6-35b-a3b` at 229376 context
with `maxParallelPredictions: 2` (LM Studio estimate 28.6 GiB; 28.4 GB used on the 5090 after
reload). Applied through the logon task (LastTaskResult 0). Backup: `load-models.mjs.bak2`.

## Verification

- [x] New scheduler specs: first canary runs immediately when overdue and on the persisted
      cadence when due later, for a coordinator target on `start()` and for a worker target
      connecting before or after `start()` (the incident's path); all fail with the old
      full-interval behaviour (mutation-checked).
- [x] `initialFunctionalDelayMs` table test covers overdue, partial, just-ran, future (clock
      skew, capped at one interval), missing and non-finite timestamps; removing the cap fails it.
- [x] Local AI Guard specs (17 files, 350 tests), `tsc --noEmit`, `typecheck:spec`, `lint`,
      `check:ts-max-loc`, eslint on the changed files, `build:main`. (One intermediate tsc run
      failed only in another session's in-flight `src/main/mcp` file; the final runs are clean.)
- [x] Fresh-eyes completion gate: pass 1 FAIL (worker-reconnect path and clamp branches
      untested, both added); pass 2 FAIL (livetest check 6 unreachable, rewritten as cases A/B);
      pass 3 FAIL (livetest prerequisite still said 131072, corrected); pass 4 VERDICT PASS, no
      actionable findings.
- Live evidence of the bug's self-recovery: canary at 10:55:42, local dispatches resumed 10:59.
  The fix itself needs a rebuild and restart to observe (check 6 in
  `2026-10-03-aux-llm-lmstudio-dual-gpu_livetest.md`).
