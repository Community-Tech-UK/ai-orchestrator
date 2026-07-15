# TypeScript LOC Ratchet Remediation Implementation Plan

> **For agentic workers:** Execute inline with characterization-test checkpoints. Keep this document untracked until every canonical gate passes, then record as-built evidence and rename it with `_completed`.

**Goal:** Restore a warning-free `check:ts-max-loc` gate by splitting the context-pressure analyzer below 700 lines and resetting 15 allowlisted ceilings to their current measured sizes.

**Architecture:** Preserve `scripts/analyze-codex-context-pressure.ts` as the public API and CLI entrypoint. Move shared contracts/utilities, diagnostic parsing, provider-capture parsing, rollout parsing, and report rendering into dependency-ordered modules under `scripts/codex-context-pressure/`; update only ratchet numbers for the 15 already-allowlisted dirty files.

**Tech Stack:** TypeScript, Node.js, SQLite, Vitest, tsx

## Global Constraints

- Preserve all unrelated staged and unstaged changes in the dirty checkout.
- Do not commit or push.
- Do not change analyzer CLI flags, exported types/functions, output filenames, schemas, privacy guarantees, ordering, or report text.
- Do not edit the 15 allowlisted production modules; only update their recorded ceilings in `scripts/check-ts-max-loc.ts`.
- Keep every non-test TypeScript source file at or below 700 lines unless it was already allowlisted.

---

### Task 1: Establish characterization and RED evidence

**Files:**

- Read/verify: `scripts/analyze-codex-context-pressure.ts`
- Read/verify: `scripts/__tests__/analyze-codex-context-pressure.spec.ts`
- Read/verify: `scripts/check-ts-max-loc.ts`
- Read/verify: `scripts/__tests__/check-ts-max-loc.spec.ts`

**Interfaces:**

- Consumes: existing analyzer API `analyzeCodexContextPressure(options, dependencies?)` and exported option/result/dependency/summary types.
- Produces: a recorded green characterization suite and red strict LOC gate before structural edits.

- [x] Run `npm run test:quiet -- scripts/__tests__/analyze-codex-context-pressure.spec.ts scripts/__tests__/check-ts-max-loc.spec.ts`; require the existing behavioral tests to pass.
- [x] Run `npm run check:ts-max-loc`; require the known RED result for the 1,153-line analyzer and record all 15 near-limit notices.

### Task 2: Split the context-pressure analyzer without behavioral change

**Files:**

- Modify: `scripts/analyze-codex-context-pressure.ts`
- Create: `scripts/codex-context-pressure/types.ts`
- Create: `scripts/codex-context-pressure/shared.ts`
- Create: `scripts/codex-context-pressure/diagnostic-source.ts`
- Create: `scripts/codex-context-pressure/provider-capture-source.ts`
- Create: `scripts/codex-context-pressure/rollout-source.ts`
- Create: `scripts/codex-context-pressure/report.ts`
- Verify: `scripts/__tests__/analyze-codex-context-pressure.spec.ts`

**Interfaces:**

- `types.ts` produces the existing public contracts plus internal analysis-state/timeline/source types and bounded string unions.
- `shared.ts` produces pure record/number/token/path/line/ordering helpers and shared constants.
- `diagnostic-source.ts` produces `parseDiagnosticLog(path, state)`.
- `provider-capture-source.ts` produces database dependency contracts, `openDefaultDatabase()`, and `parseProviderCaptures(path, instanceId, state, dependencies)`.
- `rollout-source.ts` produces `parseRollout(path, state)` and owns bounded generic-call correlation.
- `report.ts` produces `buildLimitations(summary)` and `buildReport(summary, timeline)`.
- The stable entrypoint re-exports `CodexContextAnalysisDependencies`, `CodexContextAnalysisFiles`, `CodexContextAnalysisOptions`, and `CodexContextAnalysisSummary`, then orchestrates parsing and artifact writes exactly as before.

- [x] Extract the shared contracts and pure helpers, update imports, and run the analyzer spec.
- [x] Extract diagnostic and provider-capture parsing, update imports, and run the analyzer spec.
- [x] Extract rollout parsing and bounded tool correlation, update imports, and run the analyzer spec.
- [x] Extract report/limitation rendering, update imports, and run the analyzer spec.
- [x] Confirm every created production TypeScript file and the stable entrypoint is at or below 700 lines.

### Task 3: Reset stale allowlist ceilings

**Files:**

- Modify: `scripts/check-ts-max-loc.ts`
- Verify: `scripts/__tests__/check-ts-max-loc.spec.ts`

**Interfaces:**

- Consumes: the 15 current measured file sizes emitted by the strict ratchet.
- Produces: updated exact ceilings of 807, 916, 861, 940, 2577, 2722, 1421, 1528, 1543, 794, 3606, 1799, 749, 1554, and 1073 for the named existing allowlist entries.

- [x] Change only the 15 numeric ceilings named in the failing output; do not add the refactored analyzer to the allowlist.
- [x] Run `npm run test:quiet -- scripts/__tests__/check-ts-max-loc.spec.ts`.
- [x] Run `npm run check:ts-max-loc` and require a pass with no near-limit notice and no violation.

### Task 4: Canonical verification and lifecycle closure

**Files:**

- Update/rename after green: `docs/superpowers/plans/2026-07-15-storage-retirement-migration-test-fix-plan.md`
- Update/rename after green: `docs/superpowers/plans/2026-07-15-typescript-loc-ratchet-remediation-plan.md`

- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`.
- [x] Run `npm run test:quiet`.
- [x] Inspect scoped diffs and staged paths; preserve unrelated work and keep active plans uncommitted.
- [x] Record exact as-built evidence, then rename both now-green active plans with `_completed` as the final action.

## As-Built Notes

- Characterization baseline passed: 2 files, 15 tests. The strict LOC gate reproduced the 1,153-line analyzer violation and all 15 stale-ceiling notices.
- Preserved `analyzeCodexContextPressure()` and its four exported contracts at the stable CLI entrypoint.
- Extracted dependency-ordered modules for contracts, shared helpers, diagnostic parsing, provider-capture parsing, rollout parsing, and report rendering.
- Final production-source sizes: entrypoint 177 lines; extracted modules 120–267 lines. The analyzer was not allowlisted.
- Updated only the 15 requested allowlist numbers to their current measured sizes; no underlying allowlisted production module was edited by this task.
- Targeted analyzer/ratchet suite passed: 2 files, 15 tests.
- `npx tsc --noEmit`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npm run lint`: passed.
- `npm run check:ts-max-loc`: passed with 2,331 production files checked, no near-limit notices, and no violations.
- The first full suite run had one non-reproducing spawn-rollback failure outside this diff. The focused 11-test file then passed four consecutive runs total, and the second unchanged full suite passed.
- Final `npm run test:quiet`: passed: 1,359 files, 13,369 tests in 304.9 seconds.
- A separate process advanced `main` to `bcfdd005` and committed five extracted modules during implementation. This agent did not commit or push; the remaining scoped changes and both completed plans were left uncommitted.
