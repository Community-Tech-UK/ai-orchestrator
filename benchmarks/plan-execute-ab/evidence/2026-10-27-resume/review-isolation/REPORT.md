# Fresh independent scoring-repair review

VERDICT: FAIL
Task: historical benchmark dependency isolation, scoring-amendment wiring, and translator cache repair.
Range: current HEAD plus the entire uncommitted benchmark repair; committed translator repair represented by `../2026-10-27-round3/translator-cache-fix.patch`. Exact file SHA-256 and Git blob identities are in `snapshot-before.json` / `snapshot-after.json`. No reviewed repair file changed during this pass.

## Gate 0 evidence

- `npm run test:quiet -- --config benchmarks/plan-execute-ab/vitest.config.ts --maxWorkers=1`: exit 0, all 18 benchmark files / 202 tests pass. Full result: `benchmark-tests-correct-config.log`, receipt: `benchmark-tests-correct-config.receipt.json`. The first command incorrectly filtered the root test configuration, found no test files and exited 1; that raw result is retained as `benchmark-tests.log` / `benchmark-tests.receipt.json` and is not a product test failure.
- `node node_modules/typescript/bin/tsc --noEmit -p benchmarks/plan-execute-ab/tsconfig.json`: exit 0 (`benchmark-tsc.receipt.json`, `benchmark-tsc.log`).
- Changed tracked TypeScript files plus all new scoring source/tests and boundary CJS, using the installed ESLint CLI: exit 0 (`changed-lint.receipt.json`, `changed-lint.log`). The receipt enumerates the exact linted files.
- Root lockfile-exact installation and canonical whole-repository gates are parent-owned. This reviewer did not create a checkout, mutate Git, rerun root installation, use a browser, launch a remote service, invoke a coding model, or claim an overall clean-state repository/pilot pass.
- Smoke tests below ran the actual `prepareScoringDependencies` -> trusted receipt -> `scoreRun` -> `npm test` path, including the same boundary environment used by production scoring.

Claims vs reality: the narrow regression suite passes, but the repaired boundary does not prevent all ancestor dependency resolution, and the executable infrastructure classification remains incomplete. No overall pilot pass is certified. Historical/candidate rescoring evidence and current outcome acceptance remain parent-owned and pending their final guard and per-file Git-blob checks.

## Findings

1. **High, Gate 0 / Gate 4: a native bundler still supplies an undeclared dependency from an installed ancestor and produces a passing score.** `benchmarks/plan-execute-ab/scoring-boundary.cjs:32` installs Node loader hooks, and line 49 replaces selected Node filesystem functions. These cannot intercept the filesystem operations performed by esbuild's native child process. Independent reproduction used a normal frozen npm lock containing only esbuild 0.28.2, no zod; setup completed successfully and returned a trusted receipt. Its test bundled `import { z } from "zod"` with the workspace-owned esbuild, then executed the resulting bundle. esbuild found zod in the parent checkout. `scoreRun` returned `hiddenTests.passed: true`, `damageOk: true`, exit 0 and printed `HOST_DEPENDENCY_LOADED`, despite `workspaceHasZod: false`. This is a false success under the claimed dependency isolation contract, and is relevant to Node-based test/build tools that delegate package resolution to native processes. I did not assert that a particular existing Vite fixture currently takes this path.

   Reproduce: `rtk proxy node --import tsx benchmarks/plan-execute-ab/evidence/2026-10-27-resume/review-isolation/probe-native-scoring.mjs`.

   Raw evidence: `native-scored-outcome.json`, `native-scored-setup/dependencies.json`, `native-scored-setup/dependencies.log`, `native-scored-command/hidden-tests.json`. A second independent lower-level bundle/execute probe is retained as `native-bundler.json`.

2. **High, Gate 0 / Gate 4: a missing local executable is still recorded as a model failure when npm discovers the blocked host copy.** `benchmarks/plan-execute-ab/scorer.ts:28` recognizes only null/126/127 or `SCORING_BOUNDARY_UNAVAILABLE`. npm prepends ancestor `node_modules/.bin` paths during scripts. In an empty frozen dependency fixture, `npm test` with `oxlint --version` finds the host oxlint wrapper. The boundary at `scoring-boundary.cjs:38` blocks its entry with `ERR_SCORING_EXTERNAL_DEPENDENCY`, Node exits 1, and `scoreRun` returns an ordinary failed hidden-test score instead of throwing an unscored infrastructure error. The test executable never ran. The same bootstrap result occurs for host esbuild and tsx. Distinguish an ancestor executable bootstrap failure from an actual test/source import failure; treating every external import error as infrastructure would also misclassify genuine model errors.

   Reproduce: `rtk proxy node --import tsx benchmarks/plan-execute-ab/evidence/2026-10-27-resume/review-isolation/probe-scoring.mjs`.

   Raw evidence: `host-tool-score.json`, `host-tool-scoring/hidden-tests.json`, `npm-oxlint.json`, `npm-esbuild.json`, `npm-tsx.json`.

## Acceptance criteria and other gate checks

- Frozen install before coder and trusted receipt retained: traced `runner.ts:125` -> `prepareScoringDependencies`; the same object reaches `scoreRun` at line 246. New setup tests reject deleted manifests/receipt and changed manifests. This prevents the prior all-manifests-removal bypass on the runner path.
- Model cleanup: read the entire modified runArm path; local load ownership is set only after load succeeds, unload is in `finally`, outer workspace cleanup covers setup/planner/coder/scoring failure. New success/rejected/returned-failure load cases and setup-retry tests pass.
- CJS/ESM/TypeScript ancestor import rejection: covered by the passing scorer specs. Independent `node:fs/promises` and stream read probes reject host reads (`fs-promise.json`, `readstream.json`). This evidence supports those specific APIs; it does not establish a native subprocess boundary.
- Global npm bootstrap and workspace modules: passing scorer fixture. Both coder kinds and takeover pass `scoringEnvironment` into the actual agent invocation builders, which pass the environment to `spawn`. No actual model invocation was performed in this review, so tool-child environment behavior inside external CLI versions is not independently certified.
- Missing direct/nonexistent npm executable: passing scorer tests. Ancestor executable case fails as finding 2.
- Scoring amendment: patch contains additions to the original historical hidden spec, the scorer checks SHA-256 before `git apply`, and the actual scoring-path amendment test passes. Bank hash matches the patch: `72340e4eced6987fd6272b57632e926780267452d6c4b057c676c1ff5db2d468` (`integrity.json`). Historical control outcomes are not certified by this review.
- Translator cache repair: read actual normalizeBody and its caller path plus the committed patch. Array blocks retain their boundaries/cache metadata; string content normalizes to equivalent text blocks. Both added regression cases pass in the complete benchmark suite. The changed translator behavior introduces no network/logging/credential sink.
- Diff integrity: existing test changes add coverage; no weakened assertions, deleted/skipped tests, new test exits that force success, root compiler/lint/CI configuration changes, suppressions, or unfinished stubs were found in repair scope. Fixture `process.exit(3)` intentionally verifies an amendment failure is observed. New dependency manifests or lockfile changes are not part of the source repair. The task-bank command change retains the TypeScript program and adds the documented heap ceiling.
- Security/state/performance: no new secret values, raw credential logging, shell-string execution, endpoints, subscriptions or unbounded retries were introduced in reviewed repair code. Dependency command output is retained locally; these are arbitrary tool logs, not an environment dump. Scoring commands remain bounded by timeouts. New source files remain below the repository source-size ceiling. Existing shared command-runner descendant-process timeout behavior was not changed by this repair and is not certified as a process sandbox.
- Documentation mismatch: README claims missing executables remain unscored and ancestor dependencies cannot satisfy tools; findings 1 and 2 contradict those claims until repaired.

Escalation: the dependency execution boundary is security-sensitive and the complete repair exceeds the skill's broad diff-size heuristic once new files are included. This scoped pass already fails on independently reproduced behavior; no full-repository health verdict is issued. No new reviewer or agents were started, as instructed.

All actionable findings were sent together to the parent and repair implementer after collecting this pass. Fixes require another fresh review and current verification before any completion claim. Review-owned probe workspaces were removed; source, test, task documents and Git state were untouched.
