# OpenCode effort variant startup repair

Status: Implemented and verified, with independent `VERDICT: PASS`. Changes remain uncommitted; no branch or worktree was created.

## Goal and evidence

Restore MiMo account startup on OpenCode 2 without weakening native budget or permission checks. Session `iy7gzg722` in `~/work/12steps` selected OpenCode 2, then failed during the effective config probe. A real native probe using copied Amsterdam metadata reproduces `Unsupported native numeric limit`: valid low/medium/high variants contain only `reasoningEffort`, but `mapVariants` requires at least one numeric completion cap. The normalizer processes all models in an account provider, so unrelated models can also trigger the rejection.

## Implementation

- [x] Trace session logs, installed binaries, factory, config projection, generation budget and callers; reproduce with the installed CLI and a credential-free account definition.
- [x] Update `src/main/cli/adapters/opencode-v2-config.ts`: retain every named effort-only variant as a safe empty numeric projection; validate explicit completion limits with `openCodePositive`; retain supported numeric aliases. Malformed variant rows still fail closed. Arbitrary native settings are excluded. When both aliases exist, use the tighter cap; both are validated. A Map preserves special variant keys without mutating object prototypes.
- [x] Verify the real native baseline/prepared/final configuration flow before updating tests. Cover effort-only and mixed variants, malformed/invalid caps, unrelated model variants, private field exclusion, and downstream clamp/verification. Existing rejection of valid effort-only variants is replaced with regression coverage; explicit invalid limits remain rejected.
- [x] Run focused specs, both type checks, lint, source length check, main/renderer builds and the full quiet suite. Preserve logs under ignored `_scratch`. Fresh independent `task-completion-gate` review returned `VERDICT: PASS` with no unresolved actionable findings.

Deferred packaged-app checks: [2026-10-13-opencode-effort-variant-startup_livetest.md](2026-10-13-opencode-effort-variant-startup_livetest.md).

## Risks and safeguards

Do not drop effort-only variant names: the generation-budget code uses those names to clamp every native variant. Preserve tighter explicit caps and keep rejecting invalid numeric values. Keep raw config, credentials and native diagnostics out of logs and fixtures. Use installed OpenCode through non-interactive shell only; no local browser or desktop control. Preserve other sessions' dirty files.

## Verification record

Pre-fix native reproduction: OpenCode 2.0.18 returns valid document-array configuration, normalization throws `Unsupported native numeric limit`; OpenCode 1.19.0 accepts the equivalent account overlay. Real native variants are low/medium/high with `settings.reasoningEffort` and no completion cap. No raw native config was saved.

Post-fix real native flow: `rtk proxy npx tsx _scratch/opencode-effort-variant-runtime.ts` exits 0 twice. Both OpenCode 2.0.18 and 1.19.0 accept copied Amsterdam account metadata, baseline settings, prepared overlay, final settings, all three variants capped at 16384, generation-budget assertion and permission-policy assertion. These checks send no model prompt and do not alter saved configuration. Focused quiet suite exits 0: 5 files / 159 tests, `_scratch/test-run.pid-49901.log`.

First canonical types, spec-types, lint, source-length, main build and renderer build all exited 0 (`_scratch/opencode-variant-*.log`). The first full suite (`_scratch/test-run.pid-7869.log`) hit 14 failures in existing dirty evidence-maintenance work: its old service called `listReferencedEvidenceBlobRefs` while its fixture omitted that method. Another session changed those files during this run; the current service uses `listEvidenceBlobReferenceScanPage`, and its current 19-test focused file passes (`_scratch/test-run.opencode-unrelated-triage.log`). No evidence-maintenance files were edited by this task. The stale full run was explicitly interrupted with exit 130 and is not passing evidence. All canonical gates were rerun successfully against the updated checkout.

Final current verification, all exit 0:

| Command | Evidence |
| --- | --- |
| `rtk proxy npx tsc --noEmit` | `_scratch/opencode-current-types.log` |
| `rtk proxy npm run typecheck:spec` | `_scratch/opencode-current-spec-types.log` |
| `rtk proxy npm run lint` | `_scratch/opencode-current-lint.log` |
| `rtk proxy npm run check:ts-max-loc` | `_scratch/opencode-current-source-length.log` |
| `rtk proxy npm run build:main` | `_scratch/opencode-current-main-build.log` |
| `rtk proxy npm run build:renderer` | `_scratch/opencode-current-renderer-build.log` |
| Full `rtk proxy npm run test:quiet`, fresh cache, suffix `opencode-final`, failure-model summary disabled | `_scratch/opencode-current-full-suite.log`, `_scratch/test-run.opencode-final.log`, `_scratch/test-results.opencode-final.json`: 2416 files / 31153 passed / 0 failed / 6 existing skips, 334.2s; JSON `success: true` |

Fresh reviewer independently passed the focused 159-test suite, both type checks, lint, real native script and built-code normalization/budget smoke. Review returned `VERDICT: PASS` with no unresolved actionable findings after independently inspecting the current full-suite and build artifacts. Additional independent checks covered both aliases simultaneously, empty lists, special variant keys, legacy object identity, 10,000 variants (19ms), scoped secrets scan and `git diff --check`. No dependency changes; no clean reinstall/reset was performed in this shared dirty checkout. Dependency-compatibility checks passed in the full suite.

As built: named OpenCode 2 variants without explicit numeric limits inherit the model limit and remain visible to the scoped budget clamp. Both supported aliases are validated, with the tighter value retained; malformed rows and invalid limits still fail closed. Neither native credentials/private settings nor raw error values were added to diagnostics or fixtures. The installed Harness archive was rechecked and still contains the pre-fix mapper; it was not replaced or relaunched by this task.
