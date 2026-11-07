# Plan Queue check-copy dependency provisioning

**Status:** source repair implemented and verified. Focused regressions, all eight canonical gates and a genuinely fresh independent completion review pass. Installed acceptance is explicitly deferred to the linked live-test document; no installed batching pass is claimed. No commit or push was made for this repair.

**Origin:** [batched checks live test](2026-11-02-plan-queue-batched-checks_livetest.md), Balanced rerun on 4 November 2026. Defect: [LT-723](livetest-remediation-register.md#lt-723).

## Problem and required behaviour

The installed run `557b9f7f-3127-436c-b6e4-33ed0bf04b68` reached the intended condition: epsilon was being checked while delta and zeta waited together. Preparing the combined check then parked delta with `npm ci` / `/bin/sh: npm: command not found`, before any shared receipt existed. Epsilon and zeta passed separately. The test parent restored Workload from Balanced (3) to its original level 5 and read the value back.

The disposable project uses built-in Node tests, has a package manifest containing scripts but no external dependencies, and has no npm lockfile. A check copy must not install packages when none are needed. Where dependency setup is needed, it must use the same discovered CLI environment as queue checks, and `npm ci` must only be selected for an npm lockfile/shrinkwrap. Preserve actual install errors; do not turn a failed setup into a successful gate.

The executing path is `PlanQueueCheckGroups.run` → `PlanQueueWorktreeService.withCombinedCopy` → `withPlanQueueCombinedCopy` → `provisionPlanQueueCheckCopy` → `provisionWorktreeDependencies` → `provisionNodeModules`. At reproduction, the queue forced `npm ci`, and the shared install fallback launched it with the raw app environment. Individual worker provisioning logs/catches its failure, whereas combined-copy provisioning correctly propagates it. That difference explains why the batch leader parked while the ordinary jobs could pass.

## Scope and preservation

- Fix check-copy install selection and the shared dependency provisioner's need/environment handling. Preserve root dependency cloning, workspace-link isolation, native-binary checks, clean-tree proof, durable copy ownership and cleanup.
- Keep dependency setup for actual dependencies, workspace packages and lifecycle/bootstrap requirements. A scripts-only package whose checks use built-in Node needs no install.
- Keep the parked delta branch and its source/test work intact. Do not force-land it, discard it, manually change queue records, or delete AIO-managed branches/worktrees.
- Do not restart Harness, change real runs/settings, commit or push. The prior explicit temporary Workload permission applies only when continuing the disposable live test, with restoration afterwards.

## Work checklist

- [x] Reproduce the live failure using the actual source runtime and the disposable fixture under a stripped PATH. Evidence: `_scratch/batch-live-provisioning-fix/runtime-red.json` records the exact npm-not-found failure.
- [x] Run the existing focused provisioning and combined-copy tests before editing and retain actual exits/logs: two files, 23 tests passed (`_scratch/test-run.batch-provisioning-before.log`).
- [x] Implement the minimal dependency-need check, correct npm command selection and discovered CLI environment for installs. Source and freshly compiled runtime proofs pass.
- [x] Verify the corrected actual source runtime on the dependency-free fixture under the same stripped PATH before changing test expectations: `runtime-green.json` records success with unchanged manifest and no modules/lock created.
- [x] Add regressions for dependency-free copies with installation enabled, lockfile/shrinkwrap selection, lockless dependency setup, lifecycle/workspace preservation, real install failures and discovered npm PATH. Final focused rerun: four files, 85 tests passed, superseding the earlier three-file/64-test run.
- [x] Run the focused related tests and all eight canonical gates listed below. All exit zero on the same stable source snapshot; full-suite JSON reports 37,470 passed, eight existing skips and zero failures. The initial full-suite invocation rejected an obsolete runner option before executing tests; the corrected invocation passed without source/test changes.
- [x] Obtain a genuinely fresh `task-completion-gate` review with `VERDICT: PASS` and no unresolved actionable findings. The independent verifier reran the 85 focused tests and compiled-runtime smoke, and audited every canonical command/raw result against the unchanged source fingerprints, HEAD and index.
- [x] Update remediation/live evidence and document the genuinely installed-app-only residual with exact steps in the separate live-test document. Close this source plan under the repository's live-test deferral policy; the installed retest and original batching live test remain open.

## Verification

Run the appropriate focused specs for `worktree-deps`, queue combined/base copies and grouping, then:

```sh
npx tsc --noEmit
npm run typecheck:spec
npm run lint
npm run check:ts-max-loc
npm run check:ui-hints
npm run build:main
npm run build:renderer
npm run test:quiet
```

Use the quiet runner with full logs retained locally and actual exit codes. Do not overlap the full suite with active batch test workers. A freshly compiled source-runtime proof is required in-loop; a new installed-app run may need James's rebuild/restart and the existing ordinary fixture parent because this session's supported parent launcher was refused by model-authority validation.

## Installed-app acceptance

Deferred installed-app provisioning acceptance, including rebuild/restart, exact scenario, evidence and Workload restoration: [installed-app retest](2026-11-04-plan-queue-check-copy-provisioning_livetest_completed.md).

## Evidence

- `_scratch/batch-live-20261104/balanced-retry/parent-final.md`
- `_scratch/batch-live-20261104/balanced-retry/observations.json`
- `_scratch/batch-live-20261104/balanced-retry/workload.json`
- `_scratch/batch-live-20261104/balanced-retry/workload-restored.json`
- `_scratch/batch-live-provisioning-fix/runtime-red.json`
- `_scratch/batch-live-provisioning-fix/runtime-green.json`: same fixture and stripped PATH now pass without installation or manifest changes.
- `_scratch/batch-live-provisioning-fix/combined-runtime-green.json`: the actual managed combined-copy runtime merged preserved delta and current main, ran its four focused module tests successfully, removed the temporary copy, restored the worktree/branch sets, and left both delta's branch and main unchanged.
- `_scratch/batch-live-provisioning-fix/install-env-runtime-green.json`: a required custom setup command ran successfully using the discovered CLI environment despite a stripped parent PATH.
- `_scratch/test-run.batch-provisioning-before.log`: existing focused baseline, two files and 23 tests passed.
- `_scratch/test-run.batch-provisioning-focused.log`: after-fix focused regressions, three files and 64 tests passed.
- `_scratch/test-run.batch-provisioning-final-focused.log`: final focused regressions, four files and 85 tests passed.
- `_scratch/batch-live-provisioning-fix/compiled-runtime-green.json`: freshly compiled main-process provisioner passed the original stripped-PATH fixture, with its manifest unchanged and no modules or lockfile created.
- `_scratch/batch-live-provisioning-fix/canonical-test-retry/finish.json`: all eight commands exit zero; `passed: true`, `sourceChanges: []`, and unchanged HEAD/index. Its first seven commands reuse `canonical-01/command-00.log` through `command-06.log` after verifying the identical source snapshot, HEAD and index. The first full-test command failed argument parsing on obsolete `--minWorkers`; the corrected `npm run test:quiet -- --maxWorkers=2` ran the complete suite and passed, without code/test edits.
- `_scratch/test-results.batch-provisioning-canonical-test-retry.json` and `_scratch/test-run.batch-provisioning-canonical-test-retry.log`: JSON success is true with 37,470 passed, eight existing skipped assertions and zero failures; raw footer shows 2,955 passed files and one existing skipped file.
- `_scratch/batch-live-provisioning-fix/fresh-gate/report.md`: independent `VERDICT: PASS`, no actionable findings. The verifier independently reran four focused files/85 tests and the compiled stripped-PATH smoke, inspected all eight command logs and raw full-suite JSON, and matched 7,129 source/package/script fingerprints plus HEAD/index to the canonical evidence. Its documented clean-install/clean-checkout overrides preserve the user's dirty checkout and native dependencies; installed-app acceptance remains explicitly unverified.
- `_scratch/batch-live-provisioning-fix/register-append-proof.json`: complete header/rules/index and current final entry reviewed; unrelated defect narratives were not reviewed. Removing only the added index row and appended LT-723 detail recreates the register's prior bytes exactly.
