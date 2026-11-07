# Independent scoring and timing review

VERDICT: FAIL

Task: resumed benchmark scoring repair and native-finality test synchronization.

Range: merge-base(main, HEAD) `7c8922a37c5b26d7fe6fa0eefaf00c6f3f241b87` to HEAD `d6e363ef4e81108cb562380bbd3845a8d2ec6f6f`, including current uncommitted scoring work. The requested scoring surfaces and timing fixture were reviewed; this is not approval of all earlier work in the branch.

Gate 0 evidence:

- Independently ran the benchmark Vitest configuration with `AIO_TEST_SUMMARY=0 CI=1 AIO_TEST_NO_CACHE=1 AIO_TEST_MAX_FORKS=2`, maximum two workers: 212 passed, none failed or skipped. Raw JSON: `benchmark-tests.json`. Reproduction from repository root: `rtk proxy env AIO_TEST_SUMMARY=0 CI=1 AIO_TEST_NO_CACHE=1 AIO_TEST_MAX_FORKS=2 node node_modules/vitest/vitest.mjs run --config benchmarks/plan-execute-ab/vitest.config.ts --maxWorkers=2 --reporter=json --outputFile=<absolute-evidence-path>`.
- Independently ran `rtk proxy env AIO_TEST_SUMMARY=0 CI=1 AIO_TEST_NO_CACHE=1 AIO_TEST_MAX_FORKS=2 npm run test:quiet -- src/main/orchestration/default-loop-native-finality.spec.ts`: exit 0, all nine scenarios passed. Original full log: `_scratch/test-run.pid-80131.log`; receipt: `timing-and-amendment.json`.
- Read the actual coordinator `gates-after-timing/summary.json` and full-suite output. Full suite exit 1: one timeout in `loop-verify-baseline.spec.ts` among 35379 tests. Root typecheck, spec typecheck, lint, maximum-lines check, UI-hint check and both builds exit 0. These are coordinator receipts, not independently rerun full gates. I did not duplicate the full suite or install dependencies, as instructed. A clean full gate therefore has not passed.

Claims vs reality: the coordinator correctly leaves the pilot OPEN. No completion or accepted rescoring claim is supported or made. The README claim that missing test tooling is always unscored has the exception below.

Findings:

1. **Medium, Gates 0.4 / 4.5: Node-wrapped missing dependency tools become failed model scores.** `benchmarks/plan-execute-ab/scorer.ts:27` recognizes missing executables only through null/126/127 exit codes and npm cache messages. The newly selected AIO typecheck command is `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit`. If its dependency entrypoint is absent, Node returns exit 1 with `MODULE_NOT_FOUND`. `scoringCommand` returns normally, `runDamageChecks` records `ok:false`, and `scoreRun` returns `damageOk:false` instead of rejecting as an infrastructure error. An authored tiny fixture with successful frozen dependency setup reproduced exactly this result; no source or dependencies from a real task were copied. Reproduce: `rtk proxy env AIO_TEST_SUMMARY=0 CI=1 AIO_TEST_NO_CACHE=1 AIO_TEST_MAX_FORKS=2 node node_modules/tsx/dist/cli.mjs benchmarks/plan-execute-ab/evidence/2026-10-27-resume/review-resume-final/missing-node-tool.mts`. Raw result and scorer SHA-256 are in `missing-node-tool.receipt.json`. Fix should distinguish a missing dependency tool entrypoint from normal module errors in candidate application code; add a regression for this actual argv form.
2. **Low, resolved during review:** runner help advertised `--setup` although public verification rejects it. The implementer removed that help fragment. I read the current runner help lines and confirmed the fragment is absent. This does not resolve finding 1.

Acceptance criteria:

- Ancestor/global module rejection: traced `assertNoAncestorDependencies` into both setup and score receipt verification; benchmark tests cover ordinary/real/symlink ancestors and inherited global-module lookup. In-worktree default exports deliberately fail closed. No Node filesystem hooks remain in production code.
- Dependency setup: runner captures the setup receipt before coding and passes it into `scoreRun`; public `verify-task` installs each revision, restores hidden tests and invokes the same scorer. Manifest mutation, deletion and missing receipt checks are exercised. Historical installs and real controls were not run due the explicit worktree/copy restriction.
- PATH/NODE_PATH/npx cache: traced the command environment and ran its tests for direct/symlink dependency executables, CJS/ES module fallback, inherited npx cache, and forced summary suppression.
- Cleanup: traced runner setup through its `finally` and public verification through its owned-directory cleanup; setup-failure retry and public missing-tool cleanup tests pass.
- Missing tools remain unscored: **FAIL**, finding 1. Existing direct spawn and npm-shell missing-executable regressions pass but do not cover the bank's Node-wrapped TypeScript command.
- Amendment integrity: bank SHA-256 is `72340e4eced6987fd6272b57632e926780267452d6c4b057c676c1ff5db2d468`, independently computed. `git apply --numstat` reports 134 additions, zero removals. Read the patch and traced hash verification/apply before hidden scoring. Existing original tests remain intact; historical parent/fixed/mutation controls are diagnostic evidence, not freshly accepted real controls.
- Timing fixture integrity: all 22 original assertion sites remain; an additional delayed-startup scenario is present. Read the public invoker path and executing adapter watchdog. Child process, pipe IO, write completion and process termination remain real; parent clock advances only after the real `FINAL_WRITTEN` signal. Timeout/idle values remain 150/25 ms, and real timers restore before termination in `finally`.
- Diff checks: no added TypeScript suppressions or unfinished stubs in the recorded range scan. Exit-related matches are intentional CLI exits and authored failure fixtures, not weakened tests. No new package pins or root harness configuration changes in the scoring repair. No new HTTP endpoint, UI, database migration, or infrastructure configuration is introduced by the reviewed repair.

Escalation: no new test-tampering or credential finding. This is a scoped failed review, not a whole-branch audit. Overall completion remains blocked by the failed full suite, fresh real scoring controls and the existing pilot evidence gaps. A corrected implementation needs another fresh review.

Evidence: `source-and-forensics.json` contains BASE/HEAD, source SHA-256 hashes and mechanical scans; `scoped-range.diff` captures tracked requested paths. New untracked implementation/test files are represented by their source hashes and were read directly. All temporary authored runtime fixtures were removed in `finally`; only this evidence directory was written. No browser, app, paid/local planner/coder/judge, real-task export, branch operation, commit, stash, or external runtime copy was performed.
