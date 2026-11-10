## Snapshot of 2026-10-27-mimo-hook-correction_history.md

# MiMo hook correction: round history

Moved out of the plan on 2026-11-10 (older dated sections, verbatim below), plus this round.

## Round 2026-11-10 (resumed worker)

- Branch `queue/2026-10-27-mimo-hook-correctio-3af8ac` is at main with no extra commits; the hand-merged code (`521e709e3`: `scripts/test-staged.js` build step after source selection, regressions in `scripts/__tests__/test-staged.spec.ts`) is an ancestor of HEAD and read in place (`scripts/test-staged.js:88-108`: `npm run build:main` before related tests; build error, signal and non-zero status all propagate).
- `npm run test:quiet -- scripts/__tests__/test-staged.spec.ts scripts/remote-checks/run-staged.spec.ts`: exit 0, 2 files, 61 tests passed.
- `npm run checks` (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer): exit 0, all seven passed on the test Mac.
- No source, test or manifest changes made this round; worktree clean.
- Not run: full default suite and independent completion gate (verifier-owned).

## Earlier plan sections (verbatim)

## As-built progress — 2026-10-27

- [x] Reproduced unconditional build and moved it behind the existing staged-source selection.
- [x] Focused regressions passed after recorded red and test-expectation correction attempts; build errors/signals and test errors propagate.
- [x] Actual documentation-only hook skips build/tests from absent `dist`; actual source hook rebuilds workers and passes related tests. Real staging unchanged in both replays.
- [x] Historical raw duplicates reduced; all unique live observations, command receipts and historical seals preserved. Missing old hook logs are explicitly unrecoverable from hashes.
- [x] Both typechecks, lint, source/UI checks and both production builds pass with pinned runtime and branch-declared dependency set.
- [ ] Full default suite, fresh independent completion gate and final cleanup.

The twelve pre-existing packages absent from the branch lock are temporarily parked for verification, without changing manifests or installing dependencies. They must be restored with matching identities and hashes after review. No dev app or login operation was started because the five live checks were already closed by dated evidence; this correction adds no fresh UI/API-traffic claim.

## Capacity-blocked verification — 2026-10-27

The first full suite exited 1 on one unchanged queue-retirement case; its entire original file passed in isolation without changes. Load then rose beyond 100 after the recorded runner PIDs were gone. Under the campaign's threshold, another full run and fresh independent review were not started. Both remain required and unchecked. All focused, actual-hook, typecheck, lint/source/UI and build results are retained in the owning report. The source fix is not declared complete. Cleanup/restore receipts follow in the report; this plan and the LT-782 plan remain active for coordinator handling.

Cleanup is complete: original packages restored with identity/hash checks, generated builds/helpers removed, local raw outputs compressed and retained by hash. The owning report and cleanup receipt record actual failures and successful cleanup retries. The final resource sample still showed 16.87/18 CPU cores busy. Full-suite PASS and fresh independent gate remain pending. This active plan is not completion-ready.

## Queue worker continuation — 2026-11-03

Status: implementing in the assigned queue worktree; coordinator owns independent verification and closure. This section supersedes historical progress claims only for the current checkout.

- Ruling: the supplied plan has no linked spec. Its four numbered requirements are the acceptance criteria. The current queue instructions reserve the full default suite and independent completion gate for the verifier; this worker will run focused tests, static gates, production builds and actual hook replays, then stop without a completed rename.
- Read the entire root owning report. Its uncommitted live observations and historical receipts are not present in this worktree. Preserve that root report without copying or overwriting it. New portable evidence will live in `docs/plans/2026-11-03-mimo-hook-correction_evidence/` in the worktree; full output stays in ignored worktree scratch, with exact hashes and command exits in portable receipts.
- Current code has no build prerequisite in either pre-commit or staged-test execution. The historical implementation is absent here. Restore it in staged-test execution after source selection while retaining the newer Codex protocol snapshot validation and single related-test subprocess.
- Baseline hook/staged/related suites pass. The unchanged dependency suite fails on installed `glob@13.0.6` versus the lock's `glob@14.0.3`, and a missing nested minimatch. Root and worktree manifests match byte-for-byte, but the linked installation is stale. Preserve its directory and symlink identities inside worktree scratch and install the existing branch lock locally, without lifecycle scripts that alter global Git settings. No manifest change or new dependency is required.
- [x] Implement and reproduce worker build ordering, documentation/generated skips, and failure/signal propagation.
- [x] Replay actual hook paths with disposable indexes and unchanged real staged entries.
- [x] Run focused and canonical worker checks using pinned Node v24.22.1 and branch-declared dependencies.
- [x] Review changes, retain portable report/receipts/seal, and remove owned runtime while leaving dependencies for the verifier.
- [ ] Verifier-owned: full default suite and fresh independent completion gate; coordinator-owned: closure/integration.

> Plan Queue parked work: `queue/2026-10-27-mimo-hook-correctio-7db399` — 1 commit(s), reason: worker-error.

## Resumed queue worker evidence — 2026-11-06

Worker checks pass; the overall task remains active pending the queue verifier's
full default suite and fresh independent completion gate. Coordinator closure,
integration, and completed renames remain pending. No source or test changes were
needed beyond the saved worker checkpoint.

Portable evidence is in the assigned worktree under
`docs/plans/2026-11-06-mimo-hook-correction-proof/`, with a README, command exits,
result excerpts, hashes, named worker-test results, cleanup receipt, and worker-only
seal. This uses `-proof/` because `.gitignore` excludes the previously proposed
`*evidence/` destination. The queue must harvest these untracked portable files;
compressed full outputs remain local and are not claimed integrated.

Both actual hook skip paths left `dist` absent. The actual source hook rebuilt it
and passed four suites / 55 tests; a separate uncached focused run retained named
JSON results for all three real-worker suites / 35 tests. Both typechecks, lint,
source/UI checks, and both builds passed with Node v24.22.1. Existing dependencies
already passed compatibility and were retained; no install, manifest update,
dependency isolation, application launch, branch/worktree change, commit, or
completed rename was performed by the resumed worker.

Staged entries still match HEAD; generated files and existing worker assertions are
unchanged. Temporary build output and indexes are gone. Verification helper mistakes
and their actual failures are retained in `verification-notes.json`; index stat
metadata and an aggregate-only reporter are not treated as source defects. The
owning root live-test report is unchanged. Its earlier evidence directory is absent
from both checkouts, so historical retention figures/seals were not reconstructed or
newly certified. Live checks were not repeated and all their qualifications remain.
