# First-start RLM migration failure follow-up

On main: the fix landed earlier under the fresh-profile repair; this plan adds no code.

## Status

On main: yes (this landing commit)
Implemented by an earlier landed repair; verified this round. The first-launch unique migration-name failure is the same defect fixed in [fresh-profile migration repair](2026-10-27-fresh-profile-migration-race_plan_completed.md): `runMigrations` now takes `BEGIN IMMEDIATE`, re-reads pending migrations and checksums under the lock, and keeps real errors visible. Regressions in `rlm-schema-concurrency.spec.ts` and `rlm-schema-native.spec.ts` (two real connections) pass; typecheck and lint pass. No code change was needed here. Open: cold/warm full-desktop startup, deferred to [the livetest](2026-10-27-rlm-first-start-migration_livetest.md). Round evidence: [history](2026-10-27-rlm-first-start-migration_plan_history_c3c017fb19a4950b26f6ed57a5d5ed4aa245c988efa37159ebbb9036b6804969_completed.md).

Source: first observed during [MiMo login persistence live testing](2026-10-14-mimo-usage-login-token-persistence_livetest.md) (lines 346-354), where it was labelled "LT-708" locally. That label was a numbering collision: register LT-708 is the unrelated warm-Claude permission defect. The register entry for this defect is [LT-710](livetest-remediation-register.md#lt-710) (fresh-profile startup migration collision). It is a duplicate of the fix already landed under [fresh-profile migration repair](2026-10-27-fresh-profile-migration-race_plan_completed.md).

## Work items

1. [x] Reproduce: two native connections on the prior source give the exact error; covered by the native regression.
2. [x] Fix at the cause (lock before reading pending list), checksum and real-error handling preserved.
3. [x] Focused tests, typecheck and lint pass. Cold/warm live startup deferred to the livetest.
4. [ ] Independent completion review (coordinator).

The completed 2026-07-19 remediation plan is historical and was left unchanged. This file remains untracked in the root checkout.
