## Snapshot of 2026-11-04-pq-a5-measure_history.md

### Verification (4 November 2026, in the worktree)

- Targeted tests: `src/main/plan-queue`, `src/main/ipc`, the shared health-lines spec, the plan-queue store spec and the plan-queue renderer folder: 2,467 tests. The fixture-event tests cover every measure (`plan-queue-health.spec.ts`, `plan-queue-timings.spec.ts`, `plan-queue-health-lines.spec.ts`), and the renderer specs cover the page, the health component and the store.
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer`: all exit 0. I did not run the full `npm run test:quiet` suite (the verifier does).
- Found and fixed on the resume: `recordSessionEnd` called `host.roleOf` outside its best-effort guard. Two existing specs (`plan-queue-pause-landing`, `plan-queue-orphan-checkout`) use a host without `roleOf` and failed with `host.roleOf is not a function`. The lookup now sits inside the guard, with a test in `plan-queue-timings.spec.ts` (writes rows for a worker and a checker only, ignores other roles, does not throw when the lookup throws). Mutation check: replacing the guard with nothing makes that test and the pause-landing spec fail; restored, both pass.
- Mutation checks run on the resume, each restored afterwards: making timing rows visible to decision history fails 3 tests (health, window, check group); letting a failed write throw fails the best-effort test; recording a slot wait for an item that was never blocked fails 2 slot-wait tests. The usage-wait "closed once" guard (`finish` in `plan-queue-usage-wait.ts` deleting the entry before reporting) was mutation-checked on the second resume: removing the delete makes 2 of 13 tests in `plan-queue-timings.spec.ts` fail (a wait is reported twice); restored, all pass.
- Second resume (4 November 2026): the resume carried no specific findings, so I re-ran every gate against the committed work: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer` all exit 0, and the targeted set (`src/main/plan-queue`, `src/main/ipc`, health-lines spec, plan-queue store spec, plan-queue renderer folder) passes: 186 files, 2,467 tests. That run had the shell's `GIT_CONFIG_*` push-guard variables removed, so `plan-queue-push-guard.spec.ts` passed. No code changed. I did not run the full `npm run test:quiet` suite.
- Known failures that are not from this change: `src/main/plan-queue/plan-queue-push-guard.spec.ts › buildQueuePushGuardEnv…` fails only when the shell already carries `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` (this worker session has them, set by the queue's push guard); with those variables removed it passes 9 of 9. The file is not in this change's diff. `plan-queue-pause-control.spec.ts › holds a landing refused by a real hook while paused…` failed once during a 443-second run under machine load and passed twice when run alone (41 of 41). The three `scripts/__tests__` failures from the older installed Vite were not in the targeted set.
- Deferred to the livetest document (real app, real providers, real time): the page in the rebuilt app, a real run leaving timings, a real slot wait under a minute, and the two-weeks-after-Phase-5 comparison.
- Third resume (5 November 2026): the resume said only that nothing had changed since the last failed check, with no findings. Tree clean at `179772ae8`; `npx tsc --noEmit` exits 0; the plan-queue main specs, health-lines spec, store spec and plan-queue renderer specs pass (97 files, 1437 tests, push-guard variables removed). No code changed. Full suite not run (verifier's job).


- Verification round 1 fix (5 November 2026): the first-round pass rate counted items still in flight, against the finished-attempts-only rule. `computeQueueHealth` now builds `checked` from `settled` (landed or parked) in `plan-queue-health.ts`; the fixture test expects 3 of 5 (the still-verifying item `e` is left out). Mutation check: reverting to all items fails that test; restored, the health, timings and health-lines specs pass (22 tests), `npx tsc --noEmit` and `npm run lint` exit 0.
- Not as the step might be read: "rounds spent on items that ended parked" counts the rounds (verdicts) of every parked item. It does not split parked items into code and non-code reasons; the target row "for non-code reasons" therefore needs that split added when the baseline week is read (see the livetest document, check 4).

### Step 2.3: baseline (the programme plan's Evidence table, checked 3 November 2026)

Read-only queries on the live queue database by two independent reviewers; small differences are live drift.

| Measure | Baseline |
|---|---|
| Attempts that landed | 238 of about 615 worked rows (39%); 93 of 283 since 20 Oct (33%) |
| Documents that landed at least once | 218 of 408 distinct documents (53%) |
| Passed but never landed | 96 of 333 passes (29%); this repo 68 of 116 (59%) |
| Passed plans left open | 50 landed plans among the 96 passes, over 6 weeks |
| Hook timeouts sent back to a worker | 7 in 4 days (900,000 ms), since 18 Oct |
| Why passes did not land since 18 Oct (48) | non-markdown overlaps 23; commit hook refused 12 (7 timeouts, 4 `_history.md` guard, 1 test failure); register same-line conflicts 5; stranded base commit 3; other 5 |
| First-round pass | about 40% (upper bound; only the last verdict was kept) |
| Ran out of rounds | 111 (85 match a loose word list such as live, manual, sandbox, credential) |
| Passes with a non-zero gate exit in the checker's report | 40 of 333, 34 of them landed |
| Tokens | documents that never landed used 64% of recorded tokens |
| Documents attempted twice or more | 101 of 407; 24 attempted four or more times |
| Passes landed with deferred checks, rounds on items parked for non-code reasons, free slot to next start | not measured before this change; the first week of data on this build is their baseline |

Comparison with the targets happens two weeks after Phase 5 lands (livetest document, check 4). This is a future action, not part of this change.

> Earlier journal sections moved to `2026-11-04-pq-a5-measure_history.md`.

> Plan Queue parked work: `queue/2026-11-04-pq-a5-measure-9bf437` — 2 commit(s), reason: round-limit.
