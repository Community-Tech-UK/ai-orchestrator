# Provider swap account scope

Status: implemented and independently verified, uncommitted. Production app restart and real provider checks are deferred in the linked live-test document.

## Problem and acceptance

Switching a MiMo/OpenCode session to Codex passes the source provider's `accountProfileId` as Codex's persisted account. Routing then reports a removed Codex account. A provider switch must select a destination account, preserve the conversation, and restore source account bookkeeping on failure. Same-provider respawns must remain pinned. Account origin and allowed-account fences must remain enforced.

## Work

- [x] Reproduce the removed-account error through the real runtime reconciler and account preflight/routing service using synthetic profiles and isolated adapter dependencies.
- [x] Clear the pooled account stamp when changing provider before destination adapter construction; retain policy origin/fences. Restore the source stamp when a provider swap fails, including destination route stamping and construction failures.
- [x] Include the resolved destination account stamp in provider-swap continuity state updates so restore uses the destination account.
- [x] Verify the production path and add regression coverage for MiMo → Codex, pooled → unpooled, rollback, same-provider pinning, and account restrictions.
- [x] Investigate OpenCode startup timeout separately without overwriting existing limiter edits.
- [x] Run focused tests and all canonical project gates, retaining complete local logs and exit status.
- [x] Obtain an independent task-completion-gate review and resolve every actionable finding.
- [x] Record any checks requiring app restart in a live-test document; close this plan only after all agent-runnable checks and fresh review pass.

## Implementation

In `runtime-reconciler.ts`, restore an empty account snapshot inside the provider-swap mutation block before resolving/constructing the destination runtime. Restore `oldAccount` in rollback for either a provider swap or an account handoff. Add `accountProfileId`, `accountRoutingSource`, and `accountSwitches` to the existing provider-swap `updateState` payload. Use a new focused regression file without changing existing test expectations.

## Risks and review focus

Destination account IDs may collide with source IDs; provider swap must still select anew. Legacy/unpooled destinations must not retain source stamps. A destination route may be stamped before adapter construction throws; rollback must restore the complete source stamp. Same-provider model changes and restarts retain existing pinning. Existing account fences and automatic origin restrictions must not be bypassed. Continuity snapshots must not retain a source profile paired with the destination provider.

## Verification evidence

- Pre-fix reproduction: `_scratch/test-run.pid-51031.log` (exit 1); exact removed-Codex-account error from real routing; seven of eight new checks failed before the production change.
- Focused integration regression: 10 passed, exit 0, `_scratch/provider-swap-focused.log`. The preceding focused command covering the surrounding lifecycle/routing/limiter files also exited 0; its result is retained in this session's command output.
- `npx tsc --noEmit`: exit 0, `_scratch/provider-swap-typecheck.log`.
- `npm run typecheck:spec`: exit 0, `_scratch/provider-swap-spec-typecheck.log`.
- `npm run lint`: exit 0, `_scratch/provider-swap-lint.log`.
- `npm run check:ts-max-loc`: exit 0, `_scratch/provider-swap-size.log`.
- `npm run build:main`: exit 0, `_scratch/provider-swap-main-build.log`.
- `npm run build:renderer`: exit 0, `_scratch/provider-swap-renderer-build.log`.
- `npm run verify:exports`: exit 0, `_scratch/provider-swap-exports.log`.
- `npm run test:quiet`: exit 0, 2422 files, 31323 passed, 6 existing skips; `_scratch/provider-swap-full-tests.log`, raw `_scratch/test-run.pid-60402.log`, structured `_scratch/test-results.pid-60402.json`. Completed in 323.8 seconds.
- Independent completion gate: `VERDICT: PASS`, no unresolved actionable findings. Fresh focused tests and every canonical command exited 0. Fresh no-cache full suite: 2422 files, 31325 passed, six baseline skips, zero failed. The two additional tests belong to unrelated concurrent communication work. One documented worker-report acknowledgement timeout occurred after all tests passed; the existing quiet runner classified it under its narrow all-pass rule. Review: `_scratch/provider-swap-completion-review.md`; full review evidence: `_scratch/provider-swap-review-full.log`, `_scratch/test-run.pid-88509.log`, `_scratch/test-results.pid-88509.json`. Source fingerprints stayed unchanged throughout the review.

## OpenCode timeout finding

The existing source correction sets OpenCode's cap to 20, up from the previous fallback 6. This task did not edit the limiter. A privacy-safe diagnostic entry at `~/Library/Application Support/Harness/logs/app.log:7418` records OpenCode `active: 6, limit: 6` at 2026-10-14 07:39:34 UTC. ACP acquires its process-lifetime slot before starting the subprocess, so this was admission saturation, not a MiMo response timeout. Existing release paths cover startup failure, termination and exit; no slot leak was demonstrated. The rebuilt main output includes the existing cap correction.

Deferred production checks: [live checks](2026-10-14-provider-swap-account-scope_livetest.md).
