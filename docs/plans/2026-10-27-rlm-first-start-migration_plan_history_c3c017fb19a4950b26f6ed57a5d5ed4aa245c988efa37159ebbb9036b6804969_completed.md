## Snapshot of 2026-10-27-rlm-first-start-migration_history.md

# RLM first-start migration follow-up: round history

## Resume round (2026-11-10)

- Worktree started with no changes for this plan. The defect is the duplicate of the already-landed repair in [fresh-profile migration repair](2026-10-27-fresh-profile-migration-race_plan_completed.md) (commits 4dc49f422 / faac6d587 region, in this branch's base).
- Read `src/main/persistence/rlm/rlm-schema.ts` `runMigrations`: cheap pending check, then `BEGIN IMMEDIATE`, re-read pending list and re-verify checksums under the lock, insert per migration, ROLLBACK on error (AggregateError if rollback fails). Real SQL/checksum errors stay visible.
- Regressions already present: `rlm-schema-concurrency.spec.ts` (post-discovery commit by another owner, checksum recheck, SQL failure rollback, SQLite auto-rollback, completion callbacks) and `rlm-schema-native.spec.ts` (two real native connections).
- Checks (worktree): `npm run test:quiet -- rlm-schema-concurrency rlm-schema-native rlm-schema rlm-schema-recovery` = 4 files / 13 tests passed, exit 0. `npm run checks -- "npm run typecheck" "npm run lint"` = both passed on the Windows PC, exit 0.
- No product code changed this round; no new fix was needed. Cold/warm full-desktop checks deferred to `2026-10-27-rlm-first-start-migration_livetest.md`.
- Note: the plan's "LT-708" label collided with an unrelated register row (warm Claude permission request); no register edit made.

## Verifier rounds 1 and 2 (2026-11-11)

- Finding: plan cited register LT-708 as source. Fixed: the plan's Source now names the original observation (mimo livetest lines 346-354) and the correct register entry LT-710, explaining the LT-708 collision.
- Finding: cold/warm desktop checks were in the livetest and plan but absent from the report. Fixed: both are now reported as deferred_checks with the same titles as the livetest. No code changed; earlier test/typecheck/lint results stand.
