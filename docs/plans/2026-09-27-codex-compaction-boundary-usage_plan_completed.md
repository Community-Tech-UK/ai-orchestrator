# Codex Compaction Boundary Usage — Follow-up Plan

**Status:** Completed follow-up to
[2026-09-27-codex-compaction-reliability_plan_completed.md](2026-09-27-codex-compaction-reliability_plan_completed.md).

## Evidence

- James supplied a live screenshot showing `Codex compacted its own context (was 13%)`.
- The provider-event ledger for instance `x4cfh31q4` shows Codex-native inline compactions after
  210,939, 205,245, and 202,718 input tokens in a 258,400-token reported window.
- At the first observed boundary, fresh usage fell from 211,011 tokens (81.66%) to 33,095 tokens
  (12.81%) before the boundary output was forwarded.
- `instance-event-forwarding.ts` reads `instance.contextUsage` only when the boundary output arrives,
  so it records the post-compaction 13% sample as `previousUsage`.

## Implementation

- [x] Add a regression test reproducing lifecycle start at 82%, fresh usage at 13%, then boundary output.
- [x] Retain the last non-estimated usage at provider-compaction start, correlated per instance and adapter generation.
- [x] Annotate the boundary with both retained `previousUsage` and current fresh `newUsage`.
- [x] Clear retained usage on boundary, failed completion, instance removal, and adapter-generation replacement.
- [x] Verify focused specs, canonical project gates, and a fresh independent completion review.

## Acceptance

- The reproduced sequence renders `Codex compacted its own context (82% → 13%)`.
- A boundary without an observed start does not claim a potentially reversed `was N%` value.
- Failed/aborted compactions cannot leak a stale pre-compaction reading into a later boundary.
- Existing provider-compaction lifecycle, status, persistence, and policy tests remain green.

## As Built

- `ProviderCompactionUsageTracker` snapshots the last measured usage when the provider reports
  compaction start and consumes that immutable snapshot at the later compaction boundary.
- Snapshots carry the provider adapter generation. A runtime exit or adapter replacement therefore
  cannot leak an abandoned compaction's reading into a later generation, even when the old runtime
  emitted no terminal lifecycle message.
- Boundaries without a correlated start no longer invent `previousUsage` from the current reading.
  Successful correlated boundaries include both the retained pre-compaction value and the fresh
  post-compaction value when it changed.
- Consumption happens before marker persistence, and terminal failures plus instance removal clear
  retained state, so rejected or abandoned boundaries cannot be reused.

## Verification

- Focused compaction/forwarding/controller/formatter specs: 4 files, 77 tests passed.
- Canonical gates passed: TypeScript, spec typecheck, lint, TS LOC ratchet, main build, renderer
  production build, and full quiet suite (2,248 files, 26,858 tests).
- A fresh independent `task-completion-gate` reviewer reran the full suite and all canonical gates,
  exercised the real tracker-to-formatter path as `Codex compacted its own context (82% → 13%)`,
  and returned `VERDICT: PASS` with no actionable findings.
