# Spec Typecheck Gate Repair Plan (2026-07-16)

## Problem

`npx tsc --noEmit -p tsconfig.spec.json` — a step in the canonical verification
checklist — has been silently checking **zero** files. The base `tsconfig.json`
excludes `src/**/*.spec.ts` / `packages/**/*.spec.ts` (so production builds skip
tests), and `tsconfig.spec.json` overrode only `include`, not `exclude`. In
TypeScript config inheritance, an inherited `exclude` beats the child's
`include`, so the spec program was empty and the gate passed on anything —
including a real `TS2554` (3-arg call to a 1-arg function) in
`src/main/ipc/handlers/session-handlers.spec.ts` that shipped undetected until
its runtime failure surfaced on 2026-07-15.

Discovered while fixing the pre-commit test failures for the
provider-agnostic-context-evidence commit (`c7e0ebab`). James approved this
follow-up.

## Fix

1. **Config (done):** add an explicit `exclude` to `tsconfig.spec.json` that
   omits the spec-file patterns, so the spec program actually contains the
   2,264 spec/test files. Keeps `dist`, `apps`, `_scratch`, bench/load
   exclusions.
2. **Error cleanup (this plan):** the newly-working gate surfaces **1,048
   pre-existing type errors across 332 spec files**. Fix all of them.

## Error census (2026-07-16)

- Top codes: TS2345 (268), TS2322 (178), TS2339 (175), TS4111 (120 — dot access
  on index signatures, mostly `process.env.X`), TS2739/2741/2353 (stale fixture
  shapes), TS2493, TS2352, TS2554.
- Top dirs: orchestration (177), src/tests/unit (149), renderer (101),
  browser-gateway (72), cli (69), instance (52), core (47).
- Full listing snapshot: `_scratch/spec-type-errors.txt`.
- Only 2 errors are config-artifacts; the rest are genuine loose typing in
  tests (untyped mocks, stale fixtures, index-signature access).

## Fix contract (applies to every edit)

- **Type-level changes only.** No changes to runtime behavior, assertions,
  fixture *values*, or test intent. If a type error reveals a genuinely wrong
  test (asserting on properties that no longer exist), align the test with the
  current source contract — reading the source first — and note it.
- Prefer precise types over `any`; `as unknown as X` is acceptable for
  intentionally-partial test doubles.
- TS4111: switch to bracket access.
- After editing a file, run its tests (`npx vitest run <file>`) — must pass.

## Execution

- Batch the 332 files into ~10 directory-grouped assignments; run parallel
  subagents in two waves of ~5 (host-load safety).
- Final gates: `npx tsc --noEmit -p tsconfig.spec.json` clean →
  `npm run test:quiet` full suite green → `lint:fast` clean → commit on main →
  push.

## Status

- [x] Root cause confirmed (inherited exclude cancels include)
- [x] `tsconfig.spec.json` exclude override written
- [x] Error census captured
- [x] Wave 1 (groups 1–5) fixed & verified: 625 errors, all touched-file tests
      green (335 + 604 + 328(+1 slow) + 468 + 475 tests). Notable root causes:
      private-member intersections collapsing seam types to `never`
      (cross-model-review), `SqliteDriver.prepareCached` fixture drift,
      `CopilotQuotaProbe.probe()` dropped `{signal}`, legacy 2-generic
      `vi.fn<[A],R>` syntax, TS4111 bracket-access sweeps.
- [x] Wave 2 (groups 6–9, ~423 errors): session interruption left ~172 errors;
      re-censused the live tree and ran a final 3-group wave (58+59+55). All
      touched-file tests green (448 + 369 + 358 + 135 + wave-2 partials).
- [x] Full spec typecheck green: `tsc -p tsconfig.spec.json` exit 0, 0 errors
      over the full 2,264-file spec program. Main tsc 0 errors. lint:fast 0
      errors.
- [x] Full test suite post-fix: 13,841/13,842 on first pass; the single failure
      (`provider-limit-ledger.spec.ts`) was a torn read of a live loop agent's
      concurrent WS2 edit (file pair `MM` mid-run), not campaign scope — passes
      6/6 on re-run with the consistent pair.
- [x] Committed + pushed (surgical pathspec commit to avoid capturing the loop
      agent's in-flight staged work)

## As-built notes

- Total: 1,048 errors fixed across ~290 spec files, plus cascading errors that
  were masked behind the originally-listed ones (TS reports the deepest nested
  mismatch first). All fixes type-level; the only value alignments were
  contract-driven and individually flagged (invalid `severity: 'minor'`→`'low'`;
  removed dead `verify`/`nodeRuns`/`RecoveryPlan.sessionId` fields confirmed
  unread; `CopilotQuotaProbe.probe()` call sites aligned to its 0-arg contract;
  two `acp-cli-adapter` constructor calls gained the required
  `workingDirectory`).
- Recurring root causes worth knowing: intersections that re-declare a class's
  private member collapse the whole seam type to `never`; `let x: T|null`
  mutated only inside a callback narrows to `never`/`null` at later reads
  (definite-assignment or wrapper-object fixes); raw `new Database(':memory:')`
  no longer satisfies `SqliteDriver` (use `defaultDriverFactory`); legacy
  two-generic `vi.fn<[A],R>()`; Zod `.default()` fields are required in output
  types; newer required `Instance` fields (`launchMode`, `providerSessionId`,
  `restartEpoch`, `executionLocation`, `historyThreadId`).

## Follow-up found during the campaign (out of scope here)

`src/tests/**` is not covered by any vitest project glob in `vitest.config.ts`
(only `src/main`, `src/shared`, `src/preload`, `src/worker-agent`, `packages`,
`scripts`). The persistence tests there (e.g. `rlm-verbatim.test.ts`, 23 tests)
are silently skipped by `npm run test` / CI. They pass when run with a manual
config. Decide whether to wire the glob in (may surface long-skipped failures)
— James to decide.

## Concurrency note (2026-07-16)

Live loop agents are committing/pushing to main in parallel (CI/packaged-smoke
workstream) and broad-staging the tree. Mitigations applied: `tsconfig.spec.json`
kept UNSTAGED until the campaign completes so a loop-agent commit can't ship the
reactivated gate red; `_planned` specs unstaged on sight per lifecycle rules.
Re-inspect `git status` and re-unstage immediately before the final commit.
