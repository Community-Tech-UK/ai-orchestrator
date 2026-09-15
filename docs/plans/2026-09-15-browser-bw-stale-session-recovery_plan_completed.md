# Browser Bitwarden Stale-Session Recovery Implementation Plan

**Status:** Implementation complete and independently reviewed on 2026-09-15. The rebuilt-app
checks remain explicitly deferred in the linked live-test document.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Browser Gateway Bitwarden command non-interactive and recover once, safely and observably, when another CLI process invalidates the gateway's in-memory session.

**Architecture:** `createBwRunner()` is the single Browser Gateway subprocess boundary, so it appends Bitwarden's global `--nointeraction` flag and explicitly closes the child's stdin for every command, including unlock. `CredentialVault` recognises both the historical prompt/readline failure and the canonical non-interactive lock response, requests one structured reauthentication attempt, retries the original command once on success, and throws a redacted `vault_relock_failed:<reason>` code on failure. The `browser.fill_credential`, renderer IPC, and `aio-mcp browser-credentials enrol` paths share this vault and now preserve its safe error code.

**Tech Stack:** TypeScript 5.9, Node.js `child_process.execFile`, Electron main process, Vitest.

**Spec:** James's 2026-09-15 Browser Gateway stale Bitwarden session bug report in the current task.

## Global Constraints

- Work on the existing `main` checkout; do not create a branch or worktree.
- Never print or log a master password, `BW_SESSION`, or Bitwarden item output.
- Preserve unrelated dirty-tree work.
- Use TDD: observe each regression test fail for the intended reason before editing production code.
- Run the canonical project verification checklist and an independent `task-completion-gate` review before committing locally; do not push.

---

### Task 1: Enforce non-interactive subprocess execution

**Files:**
- Modify: `src/main/browser-gateway/browser-bw-runner.ts`
- Test: `src/main/browser-gateway/browser-bw-runner.spec.ts`

**Interfaces:**
- Consumes: `BwRunner.run(args, opts)` and Node's `execFile` child process.
- Produces: the unchanged `BwRunner` result contract, with `--nointeraction` appended exactly once and child stdin closed after spawn.

- [x] **Step 1: Add runner tests that assert every command, including unlock, receives `--nointeraction` exactly once and that the returned child stdin is ended.**
- [x] **Step 2: Run `npm run test:quiet -- src/main/browser-gateway/browser-bw-runner.spec.ts` and confirm the new assertions fail because argv is unchanged and stdin is not ended.**
- [x] **Step 3: Update the injected `execFile` boundary to return a minimal child handle, append `--nointeraction` when absent, and call `child.stdin?.end()` without logging or exposing input.**
- [x] **Step 4: Re-run the runner spec and confirm it passes.**

### Task 2: Propagate one-shot reauthentication outcomes safely

**Files:**
- Modify: `src/main/browser-gateway/browser-credential-vault.ts`
- Modify: `src/main/browser-gateway/browser-unattended-services.ts`
- Test: `src/main/browser-gateway/browser-credential-vault.spec.ts`
- Test: `src/main/browser-gateway/browser-unattended-services.spec.ts`

**Interfaces:**
- Consumes: `UnlockResult` values `empty_password`, `bw_unlock_failed`, and `empty_session` from `unlockBrowserCredentialVault()`.
- Produces: a structured `CredentialVault` reauthentication callback and redacted error codes `vault_relock_failed:empty_password`, `vault_relock_failed:bw_unlock_failed`, or `vault_relock_failed:empty_session`.

- [x] **Step 1: Add vault tests for the historical prompt/readline stderr, the canonical `Vault is locked.` stderr, a code-0 prompt/crash result, one successful re-unlock/retry, a failed re-unlock reason, one-attempt-only behavior, and secret-free errors.**
- [x] **Step 2: Add an unattended-service test proving a failed stale-session re-unlock logs only the structured reason code and returns that code through the shared vault.**
- [x] **Step 3: Run the two focused specs and confirm the new tests fail because reauthentication is boolean-only and prompt/code-0 results are not classified.**
- [x] **Step 4: Change the reauthentication contract to return the structured unlock result, classify both failure shapes regardless of the buggy CLI exit code, throw the distinct redacted reason on failed reauthentication, and retain exactly one retry.**
- [x] **Step 5: Re-run the two focused specs and confirm they pass without secret-bearing output.**

### Task 3: Verify shared callers, builds, and the rebuilt live gateway

**Files:**
- Modify only if evidence requires it: `src/main/mcp/browser-credentials-cli.ts`
- Test only if its contract changes: `src/main/mcp/browser-credentials-cli.spec.ts`
- Finalise: `docs/plans/2026-09-15-browser-bw-stale-session-recovery_plan.md`

**Interfaces:**
- Consumes: the shared `getBrowserCredentialVault()` singleton used by Browser Gateway fill operations and `aio-mcp browser-credentials enrol`.
- Produces: live successful recovery after external session rotation, without submitting the Jaggaer form.

- [x] **Step 1: Run the relevant runner, vault, unattended-service, fill-operation, and browser-credentials CLI specs through `test:quiet`.**
- [x] **Step 2: Run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, and `npm run test:quiet`, retaining full logs under `_scratch/`.**
- [x] **Step 3: Start a fresh agent with the `task-completion-gate` skill; fix every actionable finding and repeat until it returns `VERDICT: PASS`.** The fresh reviewer returned `VERDICT: PASS` with no task-scoped findings after independently passing 186 focused tests, both TypeScript checks, and lint.
- [x] **Step 4: Record the rebuilt/restarted Harness Windows fill check in the sibling live-test document.** It was not run against the pre-fix process hosting this session.
- [x] **Step 5: Record the rebuilt-app `$AIO_MCP browser-credentials enrol` check in the sibling live-test document.** It was not run against the pre-fix RPC server hosting this session.
- [x] **Step 6: Finalise the as-built evidence, rename this plan `_completed.md`, inspect staged paths, and commit only task-owned completed work locally on `main` without pushing.**

## Verification evidence in progress

- Root cause reproduced through the production `createBwRunner`: a missing or bogus session reached
  the interactive master-password prompt, emitted no canonical locked message, and remained alive
  until the runner timeout. The same runner with `--nointeraction` returned `Vault is locked.` with
  exit code 1 without prompting. The installed `bw` accepted `unlock --passwordenv ... --raw
  --nointeraction` with exit code 0 while its output was discarded.
- The running pre-fix Harness reproduced `$AIO_MCP browser-credentials enrol` failing after roughly
  30 seconds with `bw list failed (exit 1)`, confirming the symptom on the app-owned RPC path.
- The final focused command passed 140 tests across the runner, vault, unattended service, form-fill,
  CLI, and IPC surfaces; full output is retained at `_scratch/test-run.pid-47696.log`.
- `npm run lint` passes. Earlier in this task, both TypeScript checks, LOC, main/renderer builds, and
  the aio-mcp distribution build passed. Current reruns of both TypeScript checks are blocked solely
  by concurrent unrelated work in `src/main/cli/adapters/account-pool/account-adapter-guards.ts:54`;
  the current LOC gate is blocked solely by concurrent unrelated growth in
  `src/shared/types/settings.types.ts`.
- Two full-suite attempts reached 24,512/24,513 and 24,511/24,513 tests. The first isolated failure
  passed 48/48 on immediate rerun. The second attempt's two failures reproduce outside this task and
  are in unrelated settings-tool and context-worker import-budget work. No failure is in a task-owned
  file.
- Restart-only evidence is recorded in
  [2026-09-15-browser-bw-stale-session-recovery_livetest.md](2026-09-15-browser-bw-stale-session-recovery_livetest.md).

## As built

- `createBwRunner()` makes every Browser Gateway Bitwarden subprocess non-interactive and closes
  stdin, including the environment-based unlock invocation.
- The shared credential vault classifies canonical locked output and the historical interactive
  prompt/readline crash even when the CLI reports exit code 0. It performs at most one coordinated
  re-unlock and one retry.
- Re-unlock failure preserves only the redacted `empty_password`, `bw_unlock_failed`, or
  `empty_session` reason through Browser Gateway results, renderer IPC, and CLI remediation.
- The independent completion gate returned `VERDICT: PASS` with no unresolved task-scoped finding.
- Live Windows fill and rebuilt-RPC enrolment are not claimed as verified; they remain open in the
  linked `_livetest.md` because restarting the Harness process would terminate this task session.
