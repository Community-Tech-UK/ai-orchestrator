# CI shard worker-RPC flake

> **Status:** completed 2026-09-20. All four tasks implemented and independently gate-reviewed; the reviewer specifically confirmed the new `worker_rpc_timeout_after_pass` classification cannot mask a real failure (it requires a parseable JSON report with zero failures *and* a passing Vitest log summary, and falls back to `crash` otherwise). No live check is deferred — CI shard behaviour is observed on the next run.
>
> Linked from the 2026-09-08 `Form fixes` CI failure on `main`
> ([run 34226905153](https://github.com/Community-Tech-UK/ai-orchestrator/actions/runs/34226905153)).

## Problem

Pushes to `main` keep going red on `Test (shard 1/4)` even when the product
change is unrelated. Two failure classes have been involved:

1. **Real timing flakes** on heavy specs (`rlm-process-ownership`,
   `loop-coordinator-memory`, `history-manager`, `local-ai-incident-service`).
   Those have already been given CI-sized timeouts / wait budgets.
2. **This run's class:** Vitest fork-pool IPC. Shard 1/4 ran 508 files / 5604
   tests, all passed, 1 skipped, then exited 1 on
   `[vitest-worker]: Timeout calling "onTaskUpdate"` (birpc's 60s ACK).
   `run-tests-quiet.js` then printed "no usable JSON report" even though Vitest
   wrote `_scratch/test-results.pid-*.json`.

`onTaskUpdate` is the worker reporting an already-finished test to the parent.
When the parent is busy (JSON reporter + several forks on a 4-core runner) the
ACK misses 60s and Vitest treats that as an unhandled error. It is not a failed
assertion.

## Change

1. Classify "JSON report exists, 0 failed tests, Vitest summary all-passed,
   exactly one unhandled error and it is a worker RPC timeout" as a pass, with
   an explicit note. Do not hide real failures or missing reports.
2. Fix the wrapper's lie: a present JSON report with 0 failures must not be
   described as "no usable JSON report".
3. Pin `AIO_TEST_MAX_FORKS=2` on the CI test job so the parent can keep up
   with worker ACKs (unpinned idle 4-core sizes to 3).
4. Document the flake class in `docs/testing.md`.

## Out of scope

- Generic "retry the shard" on any failure (hides real regressions, doubles
  wall clock).
- Increasing shard count (same total minutes, more `npm ci`; revisit only if
  the RPC timeout still fires after the pin).

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.
