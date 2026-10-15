# MiMo multi-account implementation review

VERDICT: FAIL

The implementation is present, but the plan is not fully satisfied. Seven material defects were independently reviewed and reproduced. The original plan has already been renamed `docs/plans/2026-10-10-mimo-multi-account_plan_completed.md`; its completed status is contradicted by these agent-testable failures. All eight checks in `docs/plans/2026-10-10-mimo-multi-account_livetest.md` remain pending.

## Scope and limits

Range: HEAD `04b6db59b3ce27120605180abb21f4eddc48586c` to the current working tree, including relevant untracked files. The change is uncommitted and the checkout contains unrelated work; a merge-base-to-HEAD diff would omit this implementation. No production files, plan/spec states, commits, branches, worktrees, dependencies or running applications were changed. Verification uses the existing installed dependencies; a clean install was not performed in this shared checkout. No real-account or browser/desktop verification was performed.

## Findings

### 1. New accounts cannot sign in

Severity: high. Confidence: 99/100.

The supplied sign-in command rejects a new MiMo account as “unknown provider”. The account definition is available only when a session starts, and is absent from the sign-in command. This affects the local and Windows setup instructions.

Phase: 3, 5. Source: `src/main/providers/provider-login-launcher.ts:339; src/renderer/app/features/settings/provider-accounts-machines.ts:47`.

Evidence: Real installed OpenCode 1.18.35 in isolated temporary state: child exit 1, Unknown provider "aio-mimo-placeholder".

### 2. Switching back reports the wrong account

Severity: high. Confidence: 99/100.

Switching A to B and then back to A reports success, but the running session stays on B. The adapter keeps the initial selected value and incorrectly skips the second switch.

Phase: 4. Source: `src/main/cli/adapters/acp-cli-adapter.ts:1208; src/main/cli/adapters/acp-session-config-options.ts:108`.

Evidence: Actual ACP adapter with a scripted process: expected A; actual B; only the A-to-B write was sent.

### 3. Interrupted work can be lost after switching

Severity: high. Confidence: 99/100.

The account-switch notice starts its own model turn. If that turn lasts more than ten seconds, the handoff returns and the interrupted message is sent while the notice is still running. That message is refused and only logged, although the switch is reported successful.

Phase: 4. Source: `src/main/instance/lifecycle/runtime-reconciler-account-handoff.ts:157; src/main/instance/lifecycle/runtime-change-notices.ts:215; src/main/providers/account-pool/account-failover-coordinator.ts:332`.

Evidence: Actual ACP adapter, with only the notice timeout scaled to 50ms: resend rejected because previous turn is still running; one prompt reached the process.

### 4. Fresh sessions lose startup protection

Severity: high. Confidence: 99/100.

With no cached model details, spawn preparation waits on the same startup lock that the spawn already holds. It continues only after the thirty-second safety release, then starts without owning the protection against overlapping OpenCode database startup. Windows workers begin with an empty cache.

Phase: 2, 5. Source: `src/main/cli/adapters/acp-cli-adapter.ts:557; src/main/cli/adapters/opencode-adapter-factory.ts:158; src/main/providers/opencode-region-model-metadata.ts:111`.

Evidence: Production lock implementation with maximum hold scaled to 150ms: nested acquisition waited until timeout; another caller acquired before outer release. Executing factory-to-adapter call path traced.

### 5. MiMo setup blocks other OpenCode models

Severity: high. Confidence: 99/100.

Once a MiMo pool exists, a Zen or other non-MiMo session is also subjected to MiMo authentication. An unsigned-in MiMo account can prevent unrelated OpenCode models from starting.

Phase: 2. Source: `src/main/instance/lifecycle/account-route-preflight.ts:108; src/shared/types/provider-account.types.ts:27`.

Evidence: Real preflight and routing service with opencode/big-pickle: profile-unauthenticated, No enabled MiMo account is signed in.

### 6. The promised 90% steering does not work

Severity: high. Confidence: 99/100.

The quota reader produces MiMo plan and monthly figures, but the selector only receives five-hour and weekly figures. MiMo allowance is discarded, so even an account at 100% remains eligible under the configured 90% threshold.

Phase: 6. Source: `src/main/providers/account-pool/account-quota-evidence.ts:23; src/main/providers/account-pool/provider-account-selector.ts:128`.

Evidence: Synthetic 100%-exhausted MiMo snapshot: evidence null; authenticated account selected despite threshold 90.

### 7. Missing profile shows another account’s allowance

Severity: high. Confidence: 99/100.

A second account with no Chrome profile silently reads Default, which normally holds the first account’s console sign-in. Those figures are attributed to the second account. The approved decision requires no allowance figures when no profile is named.

Phase: 6. Source: `src/main/providers/account-pool/account-quota-probes.ts:130`.

Evidence: Synthetic reader and network responses: account second; readerUsedDefault true; ok true; used 95. No real credentials read.

## Phase checklist

| Phase | Area | Actual status |
| --- | --- | --- |
| 1 | Types, schema, settings and store | Implemented paths; focused checks pass. |
| 2 | Spawn wiring | Present, with startup-lock and other-backend routing defects. |
| 3 | Login, binding and doctor | Binding/doctor present; new-account sign-in command fails. |
| 4 | Limits, failover and live switching | Present, with switch-back and interrupted-work delivery defects. |
| 5 | Windows PC | Worker plumbing builds; sign-in and cold-start defects apply. Deployment and real Windows session remain unverified. |
| 6 | Allowance per account | Present, with incorrect profile attribution and missing threshold steering. |
| 7 | Settings screen and account display | Component checks pass; real visual and session-display checks remain pending. |
| 8 | Documentation and verification | Documentation exists. Current automated results are recorded below; all eight documented live checks remain pending. |

## Automated verification

- typecheck: exit 0; full log `_scratch/mimo-completion-review/typecheck.log`.
- typecheck-spec: exit 0; full log `_scratch/mimo-completion-review/typecheck-spec.log`.
- lint: exit 0; full log `_scratch/mimo-completion-review/lint.log`.
- ts-max-loc: exit 0; full log `_scratch/mimo-completion-review/ts-max-loc.log`.
- build-main: exit 0; full log `_scratch/mimo-completion-review/build-main.log`.
- build-renderer: exit 0; full log `_scratch/mimo-completion-review/build-renderer.log`.
- provider-parity: exit 0; full log `_scratch/mimo-completion-review/provider-parity.log`.
- contracts: exit 0; full log `_scratch/mimo-completion-review/contracts.log`.
- build-worker: exit 0; full log `_scratch/mimo-completion-review/build-worker.log`.
- full-tests: interrupted by reviewer (exit 130), incomplete, no pass claim; full log `_scratch/mimo-completion-review/full-tests.log`.

The full suite was stopped with SIGINT after slow progress on a busy host; its wrapper reported no usable JSON report and exit 130. This is not an assertion failure diagnosis and not a completed verification run. The completion verdict is FAIL because of seven separately reproduced functional defects, irrespective of the unfinished full suite.

Independent focused account review: 8 files / 83 tests passed. Independent focused routing review: 5 files / 50 tests passed. These checks omit the reproduced failures above.

## Reproduction and evidence

- `_scratch/mimo-completion-review/routing-reproductions.mts` and `.log`
- `_scratch/mimo-completion-review/custom-provider-login-reproduction.ts`
- `_scratch/mimo-completion-review/account-quota-reproduction.ts`
- `_scratch/mimo-completion-review/accounts-review-evidence.txt`
- `_scratch/mimo-completion-review/results.json` and per-check logs
- `_scratch/test-run.mimo-review-full.log` and matching JSON report

Commands (all placeholder-only or scripted):

```sh
rtk proxy node --import tsx _scratch/mimo-completion-review/routing-reproductions.mts
rtk proxy node --import tsx _scratch/mimo-completion-review/custom-provider-login-reproduction.ts
rtk proxy node --import tsx _scratch/mimo-completion-review/account-quota-reproduction.ts
```

## Required next work

Fix all seven defects and add meaningful boundary tests, rerun applicable focused and full verification, and obtain another fresh review before closing the plan. Then perform the eight already-recorded live checks against real accounts and the rebuilt Windows worker. No fix or deployment has been undertaken in this review.

Escalation: credential and state-handling surfaces warrant further review during remediation. No test skips, new type/lint suppressions, new TODO stubs or dependency changes were found in the scoped added lines. Four mechanical skip-scan matches were scripted fake-process `proc.exit()` calls, not test skipping.
