# Git push checks repair plan

Status: completed and verified. Changes remain uncommitted; no commits or pushes authorised.

Goal: remove the three reproduced renderer-to-main import violations and six lint warnings shown during James's push, without weakening architecture checks or existing test assertions.

Architecture: both offending suites exercise real main-process objects together with renderer services. Relocate them intact to `src/tests/renderer-integration/`, outside production renderer boundaries. Explicitly include that directory in the renderer Vitest project and exclude it from the main project so Angular setup and single execution are preserved. Keep application behavior unchanged.

## Constraints and review focus

- Work in the current checkout; preserve unrelated dirty documentation. No branches, worktrees, commits, pushes, browser or desktop control.
- Read complete affected files before editing. Reproduce architecture/lint checks first.
- Preserve every test body, fake-timer cleanup, and Angular TestBed setup.
- Keep Set listener dispatch snapshot semantics in lint cleanup.
- Do not suppress lint, skip tests, relax import boundaries or increase file-size ceilings.
- Reviewer must inspect the uncommitted task diff as well as relevant HEAD context; the task is not committed.

## Implementation and verification

- [x] Reproduce `npm run verify:architecture` (three violations; exit 1) and `npm run lint:fast` (six warnings; exit 0).
- [x] Run both original renderer suites before relocating; retain baseline results.
- [x] Move `update-batcher.service.spec.ts` and `history-preview-session.service.spec.ts` into `src/tests/renderer-integration/`, rebase imports to the same modules, and update `vitest.config.ts` include/exclude ownership and `angular.json` lint coverage.
- [x] Remove the six reported lint warnings with equivalent expressions and remove the unused type import.
- [x] Verify relocated suites and lint-related suites; confirm test bodies unchanged and collection occurs exactly once under renderer.
- [x] Run the actual pre-push hook locally (no push), covering exports, provider parity, IPC/contracts, architecture, lint, production/spec typechecks, main/worker/renderer builds. Run enforcing file-size check and full quiet suite. Retain exit status and full logs under ignored `_scratch/`.
- [x] Obtain an independent fresh-agent task-completion-gate review, fix actionable findings and repeat until PASS.
- [x] Record final evidence, rename this plan `_completed`, and report each requested item accurately. Leave changes uncommitted.

## Evidence so far

- Original suites: exit 0, 108 tests; `_scratch/test-results.push-baseline.json`.
- Relocated suites plus existing pool config guard: exit 0, 118 tests; `_scratch/test-results.push-relocated.json`. A byte comparison against HEAD proves only relative import paths changed in the relocated suites.
- Vitest list: exit 0; exactly 108 relocated tests collected once, all under renderer; `_scratch/git-push-checks.collection.json`.
- Six lint-related suites: exit 0, 137 tests; `_scratch/test-results.lint-push.json`. Fast lint: zero warnings/errors.
- Architecture check: exit 0, all boundaries/cwd/inventory checks pass. Enforcing file-size check: exit 0; `_scratch/git-push-checks.file-size.log`; existing tolerated size advisories unchanged.
- Actual pre-push hook: exit 0. Exports, provider parity, IPC/contracts, architecture, lint, production + Electron + spec typechecks, main/worker/renderer builds all passed; `_scratch/git-push-checks.pre-push.log`. Full quiet suite: exit 0, 2420 files / 31273 tests passed in 217 seconds; `_scratch/test-results.push-full.json` and `_scratch/test-run.push-full.log`.

- Fresh review cycle complete: first reviewer identified routine lint coverage loss; correction implemented and second fresh reviewer returned PASS with no actionable findings.

## Fresh-review correction

The first fresh reviewer found that `angular.json` lintFilePatterns only covered `src/renderer/`, leaving relocated suites outside routine lint despite unchanged ESLint rules. Added `src/tests/renderer-integration/**/*.ts` to the existing Angular lint target, retained all rules, proved both suites appear in the actual lint JSON report, reran the push hook, and obtained another fresh completion-gate PASS. This is a required coverage-preservation correction, not a rule relaxation.

- Coverage correction verified: actual `npx ng lint --format=json` exit 0; both integration suites appear in the report with zero errors/warnings (`_scratch/git-push-checks.lint-coverage.log`).
- Final actual pre-push hook after correction: exit 0, all gates including builds pass (`_scratch/git-push-checks.pre-push-final.log`).
- First independent full suite: exit 0, 2420 files / 31273 passing tests + 6 existing skips (`_scratch/test-results.push-review.json`). First gate FAIL was limited to the now-fixed lint-coverage gap. Second fresh-context completion review passed.

## Final as-built verification

- Independent final gate: **VERDICT: PASS**, no unresolved actionable findings; `_scratch/git-push-checks.review-final.md`.
- Final reviewer independently ran production/spec typechecks, both linters, architecture, collection, and the uncached full suite. All exited 0. Full suite: 2420 files / 31276 passing tests, zero failures, 6 existing pending tests; `_scratch/test-results.push-review-final.json`. The three additional tests versus earlier runs belong solely to unrelated concurrent OpenCode launch work, which was preserved and excluded from this repair.
- Both relocated suites are collected and executed exactly once with 97 and 11 passing tests; normalized whole-file comparison retains every assertion and imports resolve to original targets. Actual routine Angular lint includes both suites with zero diagnostics.
- Final real pre-push hook exited 0 after the lint-coverage correction, including all typechecks and main/worker/renderer builds; `_scratch/git-push-checks.pre-push-final.log`.
- Existing file-size advisories remain within permitted tolerance; no ceilings or checks were relaxed.
- No live checks deferred: this repair affects test placement and equivalent syntax only; actual CLI hooks and checks were verified. No browser or desktop use, branches/worktrees, dependency changes, commits or pushes.
- All authored source/config changes and this completed plan remain unstaged. James must include both relocated test files when committing the repair before pushing.
