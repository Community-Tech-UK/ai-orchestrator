# Codex Resume Interruption Recovery Implementation Plan

> **For agentic workers:** Execute inline in this session. Do not delegate. Follow red-green TDD for every production behavior change.

**Status:** Completed

**Goal:** Prevent false Codex runtime-loss recovery from corrupting active turns, make native app-server resume lightweight, and recover safely when an interrupted rollout contains a custom tool call without its output.

**Architecture:** Runtime liveness probing will require both the adapter's `residentSession` capability and a current local PID matching the stored instance PID, instead of assuming every startup PID names a persistent OS process. ACP's existing long-lived stdio transport will advertise that truthful process lifetime while keeping live interrupt/steer flags disabled. Codex app-server resume will negotiate the experimental protocol capability and request thread metadata without materializing historical turns. The existing exec/app-server fresh-replay recovery seam will classify Codex's exact dangling-custom-tool diagnostic as persisted-thread corruption.

**Tech Stack:** TypeScript, Electron main process, Codex app-server JSON-RPC, Vitest.

## Global Constraints

- Preserve unrelated work in the dirty tree.
- Do not edit Codex rollout JSONL or SQLite state to repair a session.
- Do not commit or push.
- Keep this plan untracked until all agent-runnable verification is complete.
- Write each regression test before its production change and observe the expected failure.
- Run the canonical project gates before renaming this file `_completed.md`.

---

### Task 1: Capability-aware stale runtime reconciliation

**Files:**
- Modify: `src/main/instance/stale-runtime-reconciler.ts`
- Modify: `src/main/instance/stale-runtime-reconciler.spec.ts`
- Modify: `src/main/instance/instance-manager.ts`
- Modify: `src/main/cli/adapters/acp-cli-adapter.ts`
- Modify: `src/main/cli/adapters/acp-cli-adapter.spec.ts`

**Interfaces:**
- Consume: `CliAdapter.getAdapterCapabilities(): { residentSession: boolean; ... }`
- Produce: `ReconcilerDeps.shouldProbeProcess(instanceId: string): boolean`

- [x] Add a failing reconciler test whose missing PID belongs to a non-resident runtime and assert `markRuntimeLost` is not called.
- [x] Run `npm run test:quiet -- src/main/instance/stale-runtime-reconciler.spec.ts`; confirm the new assertion fails because every non-Antigravity PID is currently probed.
- [x] Add `shouldProbeProcess` to `ReconcilerDeps` and skip the OS PID probe when it returns false.
- [x] Wire `InstanceManager` to require a resident adapter with a current local PID matching the stored PID, defaulting conservatively to probing for unknown adapter shapes.
- [x] Correct ACP's process-lifetime capability to `residentSession: true` while leaving `liveInterrupt` and `liveSteer` disabled; add a regression test.
- [x] Retain the existing Antigravity synthetic-PID protection as a compatibility fallback.
- [x] Re-run the targeted reconciler tests and both TypeScript configurations; confirm they pass.

### Task 2: Metadata-only Codex app-server resume

**Files:**
- Modify: `src/main/cli/adapters/codex/app-server-types.ts`
- Modify: `src/main/cli/adapters/codex/app-server-client.ts`
- Modify: `src/main/cli/adapters/codex/app-server-client.spec.ts`
- Modify: `src/main/cli/adapters/codex/thread-resume-retry.ts`
- Modify: `src/main/cli/adapters/codex/thread-resume-retry.spec.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.thread-recovery.spec.ts`

**Interfaces:**
- Extend: `ThreadResumeParams` with `excludeTurns?: boolean`
- Change: default `InitializeCapabilities.experimentalApi` from `false` to `true`
- Send: every AIO lifecycle `thread/resume` request with `excludeTurns: true`

- [x] Add a failing client test that inspects the initialize request and requires `experimentalApi: true`.
- [x] Add failing retry-helper assertions requiring `excludeTurns: true`; the helper is the single construction seam used by exact-cursor, thread-list, and JSONL-scan resume calls.
- [x] Run the focused client and recovery specs and confirm failures are caused by the missing capability/parameter.
- [x] Extend the handwritten request type, enable the protocol capability, and add `excludeTurns: true` at the shared resume request construction seam so all retry attempts inherit it.
- [x] Re-run focused Codex app-server and recovery specs.
- [x] Run `npm run verify:codex-protocol` to confirm the installed generated protocol supports `excludeTurns`.

### Task 3: Dangling custom-tool-call recovery

**Files:**
- Modify: `src/main/cli/adapters/codex/exec-error-classifier.ts`
- Modify: `src/main/cli/adapters/codex/exec-error-classifier.spec.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.thread-recovery.spec.ts`

**Interfaces:**
- Extend: `isRecoverableThreadResumeError(error: unknown): boolean`
- Match: Codex's exact diagnostic family `Custom tool call output is missing for call id: ...`

- [x] Add classifier tests for the exact production diagnostic and near-miss messages that must remain non-recoverable.
- [x] Add a failing exec-mode test proving the first poisoned resume is abandoned and the original input is retried once on a fresh session.
- [x] Run the focused tests and confirm they fail before implementation.
- [x] Extend the classifier narrowly to the custom-tool-output diagnostic without weakening the existing thread/session guard for generic `missing` messages.
- [x] Re-run focused tests and confirm the fresh replay is one-shot and cannot loop.

### Task 4: Runtime and regression verification

**Files:**
- Update this plan's evidence section only after commands run.

- [x] Run a read-only direct Codex app-server probe against the affected thread using `experimentalApi: true` and `excludeTurns: true`; require one valid response, zero invalid JSON lines, the exact thread id, and zero returned turns.
- [x] Run targeted tests for every changed subsystem.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`.
- [x] Run `npm run test:quiet`.
- [x] Inspect `git diff --check`, `git diff`, and `git status --short`; confirm unrelated changes were preserved and the active plan remains untracked.
- [x] Record exact verification evidence below, change status to `Completed`, then rename this file to `2026-07-15-codex-resume-interruption-recovery-plan_completed.md`.

Deferred rebuilt-app validation is recorded in [2026-07-15-codex-resume-interruption-recovery-plan_livetest.md](./2026-07-15-codex-resume-interruption-recovery-plan_livetest.md).

## Verification Evidence

- Red phase: the combined focused run failed 6 of 103 tests, covering the missing non-resident probe guard, experimental capability, metadata-only resume parameter, exact diagnostic classification, and fresh replay state reset.
- ACP contract red phase: 2 of 37 focused tests failed before ACP advertised its actual resident process lifetime and the reconciler restored the capability requirement.
- Focused green phase: the six-file changed-subsystem run passed 137 tests; the final ACP/reconciler run passed 38 tests, including unknown-adapter fallback.
- TypeScript: both production and spec configurations passed.
- Lint: passed.
- TypeScript LOC ratchet: passed; the only remaining tolerance note is the unrelated pre-existing `instance-lifecycle.ts` overage.
- Protocol generation check: passed against installed Codex CLI 0.144.4.
- Live read-only probe: the requested and returned thread IDs matched (SHA-256/12 correlation `634063a4d66f`), `turnCount: 0`, `invalidLines: 0`.
- Full suite: 1,361 files and 13,419 tests passed in 330.9 seconds.
- Review: an independent read-only code review found no remaining production-code defect after the ACP capability correction.
- Final inspection: `git diff --check` passed; the implementation diff is 13 files with 181 insertions and 8 deletions; unrelated modified and untracked work remained untouched; this completed plan remains untracked.
- Deferred live check: the exact rebuilt/restarted AIO history-resume flow is specified in the companion `_livetest.md`; no live UI success is claimed here.
