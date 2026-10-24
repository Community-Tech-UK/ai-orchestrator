# PhaseDStep9: worker PreCompact hook packaging

Status: narrow fix implemented and focused/type/lint/LOC/main/worker-JS checks passed. This is implementation evidence, not an independent completion-gate verdict. The main owner retains final gates, root documentation and seal cleanup.

## Scope and root cause

Work stayed in the supplied AIO checkout. Production changes are limited to:

- `build-worker-agent.ts`: reads the canonical `src/main/cli/hooks/precompact-role-hook.mjs` bytes and embeds their base64 through the immutable esbuild define `__AIO_WORKER_PRECOMPACT_HOOK_BASE64__`. The JS bundle consumed by the existing SEA builder therefore carries those same bytes.
- `src/main/cli/hooks/hook-path-resolver.ts`: retains the Electron development/packaged file route first. Only a worker build with the embedded constant can use the asset-free fallback. A closed role is put into argv[2], then Node imports the canonical MJS from a data URL. A base64 bootstrap avoids internal double quotes in the shell argument. Unknown runtime roles return no command before interpolation.

Tests changed: existing `hook-path-resolver.spec.ts` gains desktop file-path/missing-asset coverage and uses owned scratch directories; new `precompact-worker-bundle.integration.spec.ts` compiles the real resolver/overlay, runs the resulting command under actual Node, and checks output and runtime selection.

The canonical MJS, PreToolUse handling, factory, updater, SEA builder, cohort/billing/price/worker-closure code and LOC ceilings were not edited. No duplicated role prompt was introduced.

## Runtime investigation and pre-fix reproduction

Read the full resolver, hook MJS, hook tests, worker JS/SEA build scripts, worker entrypoint, LocalInstanceManager, worker policy helper and policy tests, adapter factory, Claude argv builder/overlay/types, related factory/RPC tests, architecture/testing notes and main/preload build scripts.

Actual path: `LocalInstanceManager.spawn` spreads `workerSpawnPolicyOptions` into its lazy `createCliAdapter` call; `createClaudeAdapter` carries `machineSession`; the adapter argv builder calls `buildClaudeSettingsOverlay`, which calls `buildPreCompactOverlay` and the resolver. This path already existed and was retained.

Pre-fix, an esbuild-compiled real overlay/resolver with Electron app metadata absent, run under plain Node from a fresh directory containing only the bundle, returned only `precomputeCompactionEnabled: false` for plan-queue, loop and automation. No PreCompact command survived. The existing worker JS contained neither the canonical base64 nor a role block. Receipt: `worker-hook-repro.json`. The original resolver caught `app.isPackaged` access with no app and returned undefined; neither worker build script delivered the hook asset. Desktop `electron-builder.json` already copies all hook MJS files through extraResources.

Reproduction and immediate post-fix CLI smoke used `rtk proxy node --input-type=module` stdin scripts with esbuild and scoped Electron/logger stubs. All output/temp locations were under this checkout. The smoke then executed the generated commands through the actual shell/Node, with an unrelated scratch cwd and unavailable Node PATH. Receipt: `worker-hook-smoke.json`.

## Observed post-fix behavior

- Queue worker: exit 0, empty stderr, canonical stdout byte match (324 bytes).
- Loop: exit 0, empty stderr, canonical stdout byte match (370 bytes).
- Automation: exit 0, empty stderr, canonical stdout byte match (361 bytes).
- Immediate smoke supplied 294,912 bytes of malformed stdin for each role. The integration test additionally holds stdin open and confirms no output before EOF, then verifies the canonical output.
- Windows-form commands were 3,810–3,818 characters on this Node path. The regression test also reserves 260 characters for an executable path and 100 for shell overhead below the 8,191-character budget. It verifies the quote shape and executes the decoded Windows payload using actual Node. Native cmd.exe execution was not performed.
- Ordinary Node uses its actual executable, so no Node PATH entry is needed for this fallback. The SEA check is lazy, inside the worker-only branch; unavailable SEA APIs and simulated SEA use external `node`. Windows executable paths containing percent, exclamation or quote characters also use external `node` to avoid shell expansion.
- The real compiled overlay now contains the role commands. Existing permission-hook coexistence and the existing real factory/adapter/RPC regression tests are included in the focused run.

## Commands and results

All top-level commands ran from the supplied checkout. Test-runner model summaries and their endpoint/settings discovery were disabled with `AIO_TEST_SUMMARY=0`.

```sh
rtk proxy env AIO_TEST_SUMMARY=0 AIO_TEST_OUT_SUFFIX=worker-hook-focused-final npm run test:quiet -- src/main/cli/hooks/__tests__/hook-path-resolver.spec.ts src/main/cli/hooks/__tests__/precompact-role-hook.spec.ts src/main/cli/hooks/__tests__/precompact-worker-bundle.integration.spec.ts src/main/cli/adapters/claude-precompact-overlay.spec.ts src/worker-agent/local-instance-manager.spawn-policy.spec.ts src/worker-agent/__tests__/remote-claude-trial-execution.spec.ts
```

Exit 0: **6 files, 51 tests passed in 61.3s**. Log: `_scratch/test-run.worker-hook-focused-final.log`; JSON: `_scratch/test-results.worker-hook-focused-final.json`.

Two earlier harness runs failed before the new integration assertions: esbuild rejected the DOM TextEncoder/Uint8Array invariant; then the fixture used an invalid relative alias and in-process esbuild hit Zone message-port teardown. Compilation now runs in a plain Node subprocess with scoped stubs. Those failures were not treated as verification. Logs: `_scratch/test-run.worker-hook-focused.log`, `_scratch/test-run.worker-hook-integration.log`.

```sh
rtk proxy npx --no-install tsc --noEmit > _scratch/oct2-phaseD-round2/worker-hook-tsc.log 2>&1
rtk proxy npm run typecheck:spec > _scratch/oct2-phaseD-round2/worker-hook-typecheck-spec.log 2>&1
rtk proxy npm run lint > _scratch/oct2-phaseD-round2/worker-hook-lint.log 2>&1
rtk proxy npm run check:ts-max-loc > _scratch/oct2-phaseD-round2/worker-hook-loc.log 2>&1
rtk proxy npm run build:main > _scratch/oct2-phaseD-round2/worker-hook-build-main.log 2>&1
```

- Main TypeScript noEmit: exit 0.
- Spec TypeScript: exit 0, using the required 8 GiB wrapper.
- Lint: exit 0, all files pass.
- LOC: exit 0; 3,648 production files checked; existing tolerance notices only. No ceiling changes.
- Main build: exit 0; preload bundle built successfully.
- Worker JS build: exit 0. Exact command:

```sh
rtk proxy npm run build:worker-agent > _scratch/oct2-phaseD-round2/worker-hook-build-worker.log 2>&1
```

- Built JS contains the exact base64 of all 2,023 canonical MJS bytes; SHA-256 `cb5e78a0238224d47240671fa0b8ae68f8c2f44ea9a00d233e268fe1a85b80c5`. Final worker bundle: 4,551,851 bytes. This is the JS input selected by the unchanged SEA build script.
- The artifact check ran via `rtk proxy node --input-type=module` and `spawnSync(process.execPath, [absoluteWorkerBundle, '--self-check', '--config', explicitAbsentScratchConfig], {cwd: freshOwnedScratchDirectory, ...})`, with isolated PATH/TMPDIR/session-policy-directory values. Actual Node v26.3.0: exit 0, stdout `Worker self-check ok`, stderr empty. No production config was read. Receipt: `worker-hook-build-receipt.json`. The scratch directory was removed after recording the receipt.
- `rtk git diff --check -- build-worker-agent.ts src/main/cli/hooks/hook-path-resolver.ts src/main/cli/hooks/__tests__/hook-path-resolver.spec.ts`: exit 0.

## Limits and handoff

SEA remains dependent on an external Node available on PATH for command hooks. The worker executable is not invoked with `-e`; no new CLI flag, hook runtime or updater behavior was added. No universal standalone/no-Node hook capability is claimed. Existing broader worker-factory dependency/runtime constraints are outside this fix; the bundle self-check proves startup loading, while the focused factory test substitutes process I/O/login/discovery and does not spawn a provider. Source-only worker execution without the worker build define retains fail-soft behavior when no Electron hook file is available.

The full suite, GUI/browser, provider/service probes, production settings reads, dependency installs, native SEA packaging and deploy were not run. No commits, stash, branches or worktrees were created. Renderer source was untouched; renderer/full final verification belongs to the main owner. No independent PASS is claimed.

## Preservation and cleanup

Baseline hashing checked 297 pre-existing dirty/untracked files; only the two existing owned hook resolver/test files changed. All other hashed work was preserved. Receipt: `worker-hook-preservation.json`.

Reproduction, smoke and integration fixture directories were removed in finally/afterAll. A directory scan found no owned `worker-hook-repro-*`, `worker-hook-smoke-*`, `hook-path-resolver-*` or `precompact-worker-*` or `worker-hook-selfcheck-*` directories remaining. Logs and JSON receipts are retained for the main owner's cleanup. No root plan/history document was edited or copied.

## Requested-item checklist

- [x] Trace actual worker factory/options/argv/overlay delivery; reproduce the missing Node command before editing.
- [x] Embed only the canonical MJS and execute its same role blocks through the worker fallback.
- [x] Keep desktop paths, main missing-asset fallback and PreToolUse coexistence.
- [x] Verify role byte equality, stdin drain, unknown roles, quoting, Windows length budget and lazy SEA runtime selection offline.
- [x] Run focused tests, both requested typechecks, lint, LOC, main build and worker JS build; inspect embedded bytes and isolated worker self-check.
- [x] Preserve unrelated work and root documents; remove owned disposable fixtures and retain evidence.
- [ ] Main owner's final gates/root-doc lifecycle/seal cleanup and independent completion review: intentionally left to the main owner, as requested.
