# Browser Approval Active-Turn Race Implementation Plan

**Status:** Completed and independently verified on 2026-08-27.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Browser Gateway approval resumptions and renderer retries from starting a second Codex app-server turn while another turn owns the runtime.

**Architecture:** Extend session admission with an opt-in ready/runtime-idle requirement and have Browser Gateway use it. Preserve Codex runtime ownership in adapter status events, then teach the renderer to park active-turn collisions until a real ready edge.

**Tech Stack:** TypeScript, Electron, Angular signals, Vitest.

**Spec:** [2026-08-27-browser-approval-active-turn-race_spec_completed.md](../specs/2026-08-27-browser-approval-active-turn-race_spec_completed.md)

## Global Constraints

- Work in the existing checkout; do not create a branch or worktree.
- Preserve unrelated dirty-tree changes.
- Write each regression test first and observe the expected failure before production edits.
- Do not commit unless James explicitly requests it.

---

### Task 1: Runtime-aware Browser Gateway admission

**Files:**
- Modify: `src/main/session/session-admission-service.ts`
- Modify: `src/main/ipc/handlers/browser-gateway-handlers.ts`
- Test: `src/main/session/session-admission-service.spec.ts`
- Test: `src/main/ipc/handlers/browser-gateway-handlers.spec.ts`

**Interfaces:**
- `AdmitAutomatedWriteRequest.requireReadyForInput?: boolean`
- `AdmitAutomatedWriteRequest.coalesceKey?: string`
- `SessionAdmissionInstanceHost.getAdapter?(instanceId)` (existing InstanceManager surface, narrowed to runtime snapshots)

- [x] Add a failing test showing multiple Browser Gateway resumes remain deferred while lifecycle status is busy or provider runtime ownership is active, coalesce, then deliver once on a genuine idle edge.
- [x] Run the focused test and confirm it fails because `sendInput()` is called too early.
- [x] Add the opt-in readiness and coalescing fields, retain them in pending redeliveries, merge request/decision messages, and make redelivery re-check each entry's readiness contract.
- [x] Pass the opt-in flag from Browser Gateway and inspect the existing adapter runtime snapshot through the admission host.
- [x] Run the focused admission and handler tests and confirm they pass.

### Task 2: Preserve Codex active-turn status ownership

**Files:**
- Modify: `src/main/cli/adapters/codex-app-server-adapter.ts`
- Test: `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`

- [x] Add a failing test that starts one real synthetic app-server turn, attempts a second send, and asserts no `idle` status is emitted before the first turn completes.
- [x] Run the focused test and confirm the current `busy, busy, idle` sequence fails the ownership assertion.
- [x] When a recoverable send failure occurs while the app-server runtime still owns a turn, emit `busy`; otherwise retain the existing `idle` or `error` policy.
- [x] Run the focused adapter tests and confirm they pass.

### Task 3: Park renderer retries on active-turn collisions

**Files:**
- Modify: `src/renderer/app/core/state/instance/instance-messaging.store.ts`
- Test: `src/renderer/app/core/state/instance/instance-messaging.store.spec.ts`

- [x] Add a failing test that returns the active-turn collision from IPC and asserts one send attempt, a queued message, and `busy` status after advancing timers.
- [x] Run the focused test and confirm the current default unknown-error retry performs repeated sends.
- [x] Classify the collision as retryable only on a genuine ready edge by returning `nextStatus: 'busy'`.
- [x] Run the focused renderer tests and confirm they pass.

### Task 4: Verification and closure

- [x] Run all focused regression files.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`.
- [x] Run `npm run build:main`.
- [x] Run `npm run test:quiet`.
- [x] Obtain a fresh independent `task-completion-gate` review and address every actionable finding until it returns `VERDICT: PASS`.
- [x] Record as-built evidence, rename this plan and its linked spec to `_completed`, and update the spec link.

## As-Built Evidence

- Browser Gateway approval and denial resumptions opt into ready/runtime-idle admission, coalesce per instance, and preserve each request ID with its decision.
- Codex app-server collisions retain `busy` while the owning provider turn remains active.
- Renderer collisions stay queued without timer retries and drain only on a genuine ready edge.
- Focused verification: 4 files, 138 tests passed.
- Canonical verification: both TypeScript checks, lint, file-size ratchet, Electron main/preload build, and the full suite passed; the final full suite covered 1,806 files and 19,216 tests.
- Independent completion gate: `VERDICT: PASS`, no findings.
