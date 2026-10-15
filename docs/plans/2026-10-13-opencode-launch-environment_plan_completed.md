# OpenCode launch environment and actual session startup

Status: Code implementation completed and independently verified on 2026-10-13; packaged-app checks are deferred in the linked live test. Untracked and uncommitted. No branch, worktree or installed/running app replacement was made.

## Goal

Repair actual ComTechSpare MiMo startup after session `ix0iunga7` failed on a rebuilt/restarted Harness. The prior variant-normalization repair is present in the installed archive; it did not verify actual session startup.

## Verified cause and scope

The new failure's logged fingerprint matches `Unable to confirm the selected model for its configured generation budget; refusing startup.` The real factory reproduces it: OpenCode 2 advertises built-in regional MiMo models but not `aio-mimo-comtechspare-f7a6`. Model/account guards correctly reject the mismatch. Native config probes alone still pass and therefore do not prove successful startup.

`listOpenCodeCommandCandidates({})` sees only stale Homebrew and the OpenCode desktop binary. The factory passes an overrides-only environment, without HOME. `buildCliSpawnOptions` cannot discover the user's NVM CLI directories without HOME. Native spawn/config probes instead merge the trusted parent environment first. `listOpenCodeCommandCandidates(process.env)` finds the installed OpenCode 1.19.0 in the NVM directory. A real factory experiment inheriting HOME selects that executable, offers ComTechSpare, confirms its model and reaches ready.

## Tasks

- [x] Re-fetch new session evidence, inspect installed build and executing path, reproduce real factory failure, isolate lookup environment mismatch. A delay and removing mirrored config did not fix the failure; neither experiment is a production change.
- [x] Update `src/main/cli/adapters/opencode-cli-launch.ts` candidate lookup to merge `getSafeEnvForTrustedProcess()` with caller overrides before `buildCliSpawnOptions`, matching `runOpenCodeCapture`'s effective environment. Keep requested overrides and existing install order. Preserve account/model and output-limit checks.
- [x] Verify real factory startup and a tiny tool-free reply on ComTechSpare with default and High thinking. Add candidate-discovery regression coverage for partial environment, explicit overrides and selected install; retain fail-closed startup tests.
- [x] Run relevant focused specs and all canonical checks: application/spec type checks, lint, source-length, main and renderer builds, full quiet suite. Obtain a fresh independent task-completion-gate PASS with no actionable findings, then close this document. Record rebuilt packaged-app checks separately if still required.

## Review focus

Partial environments must inherit HOME/PATH; explicit supplied values still win. Do not expose values from the trusted environment in logs/tests. Validate actual process startup rather than treating debug config as proof of account/model availability. Existing checks must still reject a different account or model. No credentials/config files are changed by this repair.

## Evidence

Installed archive mtime 2026-10-13T17:23:56Z contains the prior mapper; restart at 17:35:04.892Z precedes failure at 17:38:09.553Z. `_scratch/opencode-real-startup.ts` reproduces the real failure (exit 1); `--inherit-home` reaches ready on the correct account (exit 0). Experimental `--delay`, `--strip-mirror` and `--native-alias` still fail and are diagnostic scratch only. These experiments sent no prompts and disabled console/file logger output; only public model identities were printed.

Current verification: source and compiled factory default/High startup and real tool-free replies all exit 0, with modelConfirmed, effortConfirmed and responseIsOK true. Logs: `_scratch/opencode-launch-runtime-default.log`, `-high.log`, `_scratch/opencode-launch-compiled-default.log`, `-high.log`. The original default source startup and real reply were verified before test changes. The High source check was started before those edits and later confirmed the exact reply; both modes were also repeated through compiled code and independently reviewed.

Regression proof: removing just the environment-merge expression makes the new launcher tests fail (exit 1, `_scratch/opencode-launch-regression-red.log`); restoring it passes. Focused related specs passed (`_scratch/test-run.opencode-launch-focused.log`). All application/spec types, lint, source-length, main/renderer builds exit 0 (`_scratch/opencode-launch-*.log`). The initial full result and pinned rerun are recorded below; fresh independent review passed.

Packaged-app checks are deferred in [the plan-owned live test](2026-10-13-opencode-launch-environment_livetest.md).

The initial full suite used Homebrew Node 26.3.0 and failed two SEA build-repeatability tests because that binary lacks the SEA fuse; no assertions or source were changed for this. `.nvmrc` pins installed Node 24.15.0. The two affected tests pass under that pinned runtime (`_scratch/opencode-launch-sea-pinned.log`, exit 0); all six canonical gates and the no-cache full suite passed under the pinned runtime (exit 0, `_scratch/opencode-launch-pinned-*.log` and `_scratch/opencode-launch-full-pinned.log`). The fresh independent completion-gate review repeated all six gates and a no-cache full suite after the parent run and passed.

Independent completion gate: **VERDICT: PASS**, no unresolved actionable findings. Read the full durable report at `_scratch/opencode-launch-fresh-gate.md`. All six independent static/build gates, 181 focused tests and the no-cache full suite exited 0. Full JSON reports success=true, failed tests/suites=0, 31,276 passed and six pre-existing pending tests; no skip was added by this patch. Independent default/High compiled factory prompts confirm the exact account/model, High effort where requested and real `OK` replies. Final source/spec checksum verification confirms that the reviewed code remained unchanged throughout the gate.

## As built

Only production behavior changed: candidate discovery now inherits the same trusted HOME/PATH used by native config probes and actual ACP spawn, before applying explicit caller overrides. User NVM install precedence remains the existing CLI path policy. Three new launcher regressions exercise discovery and override precedence; original probe-fallback and safe-refusal assertions remain. Account/model and generation-budget guards are unchanged. No dependency, credential/config-file, UI, infrastructure, branch/worktree or commit/push changes belong to this repair.

All four code-plan tasks are implemented and verified. Packaged default and High acceptance remains open solely in the linked live-test document and active LT-704 status plan. This completion does not assert that the installed app has been rebuilt with this latest correction or that its UI checks pass.
