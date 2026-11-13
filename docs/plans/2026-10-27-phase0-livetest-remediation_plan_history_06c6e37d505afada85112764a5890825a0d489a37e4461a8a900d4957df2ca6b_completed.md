## Snapshot of 2026-10-27-phase0-livetest-remediation_history.md

# Phase 0 remediation: round history

Active history for [the plan](2026-10-27-phase0-livetest-remediation_plan.md). Uncommitted.

## Round 10 November 2026 (resumed by James)

Starting state: worktree branch `queue/2026-10-27-phase0-livetest-rem-ad92f5` sits at main's tip; the code fix (`817a30b80`, 29 files) is already an ancestor. The 3 November report folder and the parked branches holding the register entries no longer exist.

Re-verified in the worktree (all exit 0):
- `npm run test:quiet -- <14 spec files changed by 817a30b80>`: 14 files, 324 tests passed.
- `npm run checks`: typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer (ran on the Windows PC, 1m 34s).
- `npm run generate:ipc`, `generate:aliases`, `generate:architecture`: no tracked output changed. `git diff --check` clean.

Found: `livetest-remediation-register.md` had no LT-820..826 entries, so every register link in the plan dangled. `node scripts/next-lt-id.mjs` gave LT-1018 and no clash exists for 820-826. Rebuilt an index subsection (6 rows; LT-825 stays withdrawn) and 6 detail sections with anchors `#lt-820`..`#lt-826`, using only facts already recorded in the plan. No test reads the register.

Plan edits: added a real `## Status` block; dropped the date from the ledger heading; marked the 3 November report folder as no longer available. Livetest doc: same evidence-pointer fix. Deferred live checks unchanged (LT-822, LT-823, LT-826 full-app).

Not done: full suite and independent gate (verifier's). No browser, desktop or Mac app was used.

Related, out of scope: the oct-phase0 livetest (another branch) files LT-1020, a Close all case that leaves a loop-iteration child alive. LT-826 is the resident process; LT-1020 needs its own look.

## 13 Nov 2026 resume (land blocked: plan changed after the checker passed)

Found: the plan and live-check document already cited LT-1018 and LT-1019, but this branch had neither the two schema fixes nor their register rows (the code sat on `queue/2026-10-27-phase0-livetest-rem-2e58d8`; main already carries the `origin` field but has no regression test and no `waitingSessionCount`). Applied the observability schema field and both regression specs from that branch, added `origin` in the same position main uses (so merging main stays clean), and added the two register rows and detail sections. Checks: `renderer-event-validation.spec.ts` + `cost-handlers.spec.ts` 59 tests pass; `npm run checks` typecheck, typecheck:spec, lint all exit 0.
