# Browser Bitwarden Stale-Session Recovery Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the exception, concurrency, repeated-stale, and malformed-output gaps found by the fresh completion audit of commit `623651f4`.

**Status:** Implemented and automated verification complete. The third genuinely fresh completion
gate returned `VERDICT: PASS` with no findings. The two checks that require rebuilding and
restarting Harness remain in the sibling `_livetest.md` document.

**Architecture:** `CredentialVault` will associate a stale response with the exact session used for that command, normalize all recovery failures to a safe structured code, and reject stale or malformed successful output before mutation. The shared unattended service will coordinate recovery by stale-session identity so delayed callers reuse or join a newer recovery instead of rotating it again.

**Tech Stack:** TypeScript 5.9, Electron main process, Vitest.

**Spec:** Fresh completion-gate findings reported by James's 2026-09-15 follow-up request; predecessor: [2026-09-15-browser-bw-stale-session-recovery_plan_completed.md](2026-09-15-browser-bw-stale-session-recovery_plan_completed.md).

## Global Constraints

- Work in the existing `main` checkout; do not create a branch or worktree.
- Never log or return Bitwarden stderr, item output, the master password, or session tokens.
- Preserve unrelated dirty-tree work and commit only task-owned paths locally; do not push.
- Add each regression test first, observe the intended failure, then implement the smallest production change.
- The live fill and CLI enrol checks remain restart-only in the sibling `_livetest.md`.

---

### Task 1: Normalize every recovery failure

**Files:**
- Modify: `src/main/browser-gateway/browser-credential-vault.ts`
- Test: `src/main/browser-gateway/browser-credential-vault.spec.ts`

**Interfaces:**
- Consumes: the stale command's session identity and `CredentialVaultReauthenticationResult`.
- Produces: only `vault_relock_failed:empty_password`, `vault_relock_failed:bw_unlock_failed`, or `vault_relock_failed:empty_session` for any failed recovery.

- [x] **Step 1:** Add tests proving a rejected reauthentication promise cannot expose its message and a still-stale retry returns `vault_relock_failed:bw_unlock_failed` after exactly one recovery attempt.
- [x] **Step 2:** Run the focused vault spec and verify both tests fail for the reported reasons.
- [x] **Step 3:** Catch reauthentication rejection without reading its message and centralize construction of the safe recovery error.
- [x] **Step 4:** Map a stale retry to the same safe recovery error while keeping the retry count bounded at one.
- [x] **Step 5:** Re-run the vault spec and verify it passes.

### Task 2: Make concurrent stale recovery generation-safe

**Files:**
- Modify: `src/main/browser-gateway/browser-credential-vault.ts`
- Modify: `src/main/browser-gateway/browser-unattended-services.ts`
- Test: `src/main/browser-gateway/browser-credential-vault.spec.ts`
- Test: `src/main/browser-gateway/browser-unattended-services.spec.ts`

**Interfaces:**
- Consumes: `reauthenticate(staleSession)` where `staleSession` is the token used by the rejected command and remains main-process-only.
- Produces: one unlock for one stale session generation; overlapping or delayed callers join/reuse the newer session.

- [x] **Step 1:** Add deterministic delayed-concurrency tests for both successful and failed recovery after two commands use the old token.
- [x] **Step 2:** Run the focused service/vault specs and verify the tests expose a rotated retry and two unlocks respectively.
- [x] **Step 3:** Pass the failed command's session identity into reauthentication and make the shared callback join/reuse the recovery result or a newer current token without clearing it.
- [x] **Step 4:** Re-run the focused specs and verify both callers succeed with one unlock, while delayed callers share one structured failed result.

### Task 3: Fail closed on stale or malformed stdout

**Files:**
- Modify: `src/main/browser-gateway/browser-credential-vault.ts`
- Test: `src/main/browser-gateway/browser-credential-vault.spec.ts`

**Interfaces:**
- Consumes: `BwCommandResult.stdout`, `stderr`, exit code, and command-specific folder-list JSON.
- Produces: stale stdout recovery or a safe parse error before any create/edit operation.

- [x] **Step 1:** Add tests for an exit-code-0 prompt/readline shape in stdout and malformed exit-code-0 `list folders` output.
- [x] **Step 2:** Run the vault spec and verify stale stdout skips reauthentication while malformed output reaches folder creation.
- [x] **Step 3:** Inspect stale signatures in stderr and non-JSON stdout, and replace permissive folder-list parsing with strict array validation.
- [x] **Step 4:** Re-run the vault spec and verify both failures are closed without secret-bearing output or mutations.

### Task 4: Keep explicit vault lock authoritative

**Files:**
- Modify: `src/main/browser-gateway/browser-unattended-services.ts`
- Test: `src/main/browser-gateway/browser-unattended-services.spec.ts`

**Interfaces:**
- Consumes: an explicit `lockBrowserCredentialVault()` while `bw unlock` is still in flight.
- Produces: the later Lock wins; the pending unlock cannot reinstall its session token.

- [x] **Step 1:** Add a deterministic test that pauses `bw unlock`, explicitly locks the vault,
  then completes the pending unlock.
- [x] **Step 2:** Run the focused service spec and verify the pending unlock currently restores the
  token after Lock.
- [x] **Step 3:** Associate each unlock with the explicit-lock generation and reject token
  installation when a newer Lock has occurred.
- [x] **Step 4:** Re-run the focused test and confirm the vault stays locked with a redacted
  `empty_session` result.

### Task 5: Cancel recovery when Lock occurs before the stale result

**Files:**
- Modify: `src/main/browser-gateway/browser-credential-vault.ts`
- Modify: `src/main/browser-gateway/browser-unattended-services.ts`
- Test: `src/main/browser-gateway/browser-unattended-services.spec.ts`

**Interfaces:**
- Consumes: the explicit-lock generation captured before each original `bw` command.
- Produces: no recovery attempt when a public Lock supersedes an in-flight command before its
  stale response arrives.

- [x] **Step 1:** Add a deterministic test that pauses the original stale command, explicitly
  locks the vault, then releases the stale result.
- [x] **Step 2:** Verify the pre-fix path performs an unlock and returns the wrong recovery reason.
- [x] **Step 3:** Carry the command-start generation into reauthentication and reject a superseded
  command with safe `empty_session` before invoking unlock.
- [x] **Step 4:** Re-run the vault/service specs and confirm 56 tests pass, with zero post-Lock
  unlocks in the regression case.

### Task 6: Correct the restart-only verification and close the follow-up

**Files:**
- Modify: `docs/plans/2026-09-15-browser-bw-stale-session-recovery_livetest.md`
- Finalize: `docs/plans/2026-09-15-browser-bw-stale-session-recovery-followup_plan.md`

- [x] **Step 1:** Make the CLI live check invalidate and non-interactively unlock Bitwarden again immediately before enrol; remove the claim that authorization listing proves the vault binding.
- [x] **Step 2:** Re-run all focused credential tests, both TypeScript checks, lint, LOC, main/renderer builds, and the quiet full suite with retained logs after the final review fix.
- [x] **Step 3:** Obtain another genuinely fresh `task-completion-gate` review; fix findings and repeat until `VERDICT: PASS`.
- [x] **Step 4:** Record as-built evidence, point the live-test document at the completed plan,
  rename this plan `_completed.md`, and inspect the exact commit pathspec.

## Verification Evidence — 2026-09-15

- Focused Browser credential surface: 15 files, 296 tests passed; retained log
  `_scratch/test-run.pid-57604.log`.
- Final vault/service regression specs after strict folder validation: 2 files, 54 tests passed;
  retained log `_scratch/test-run.pid-56938.log`.
- `npx tsc --noEmit`: passed; log `_scratch/bw-followup-tsc-final.log`.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed; log
  `_scratch/bw-followup-tsc-spec-final.log`.
- `npm run lint`: passed; log `_scratch/bw-followup-lint-final.log`.
- `npm run check:ts-max-loc`: passed; log `_scratch/bw-followup-loc-final.log`.
- `npm run build:main`: passed; log `_scratch/bw-followup-build-main-final.log`.
- `npm run build:renderer`: passed; log `_scratch/bw-followup-build-renderer-final.log`.
- `npm run build:aio-mcp-dist`: passed; log `_scratch/bw-followup-build-aio-mcp-final.log`.
- Final isolated `npm run test:quiet`: 2,082 files and 24,731 tests passed in 215.3s;
  retained log `_scratch/test-run.pid-32325.log`. Two earlier runs under concurrent high system
  load each exposed a different unrelated flaky test; both failing files passed alone before the
  final clean full-suite run.
- `gitleaks` found no leaks in the task diff or either follow-up/live-test document.

### Post-review Lock-generation rerun

- Red reproduction: the pending unlock returned `{unlocked:true}` after explicit Lock; retained log
  `_scratch/test-run.pid-30975.log`.
- Focused service spec after the fix: 14 tests passed; retained log
  `_scratch/test-run.pid-31485.log`.
- Full Browser credential surface: 15 files, 297 tests passed; retained log
  `_scratch/test-run.pid-31931.log`.
- Both TypeScript checks, lint, LOC, `build:main`, `build:renderer`, and
  `build:aio-mcp-dist` passed; retained logs use the `_scratch/bw-followup-*-post-lock.log`
  names.
- Final isolated `npm run test:quiet`: 2,082 files and 24,736 tests passed in 223.1s;
  retained log `_scratch/test-run.pid-34168.log`.

### Post-review command-start generation rerun

- Red reproduction: explicit Lock while the original stale command was paused still allowed a
  post-Lock unlock and produced the wrong recovery reason; retained log
  `_scratch/test-run.pid-35519.log`.
- Vault/service specs after the fix: 56 tests passed; retained log
  `_scratch/test-run.pid-37659.log`.
- Full Browser credential surface: 15 files, 298 tests passed; retained log
  `_scratch/test-run.pid-38085.log`.
- Both TypeScript checks, lint, LOC, `build:main`, `build:renderer`, and
  `build:aio-mcp-dist` passed; retained logs use the
  `_scratch/bw-followup-*-post-command-lock.log` names.
- Final isolated `npm run test:quiet`: 2,082 files and 24,742 tests passed in 204.0s;
  retained log `_scratch/test-run.pid-35673.log`.
- `git diff --check` and redacted `gitleaks` task-diff scan passed.

## As Built

- `CredentialVault` captures the BW session and explicit-lock generation used by each command,
  recognizes stale output on both safe channels, normalizes every failed recovery, and retries at
  most once.
- The shared unattended service coordinates delayed callers by stale-session identity, never
  rotates a newer recovered token, and gives public Lock authority over commands and unlocks that
  began earlier.
- Successful folder-list output is schema-checked before any create/edit mutation.
- Browser fill, renderer IPC, and the privileged CLI/RPC paths share the same vault and preserve
  the safe structured reasons.
- The final independent security/deep-audit completion gate reported no critical findings,
  warnings, or suggestions and ended `VERDICT: PASS`.
