# Harness Cross-Platform Startup Regression Implementation Plan

**Status:** Completed on 2026-07-16.

**Goal:** Restore packaged Harness startup on macOS and Windows, preserve fail-closed context-evidence storage, and ensure an optional evidence-runtime failure cannot prevent the main window from opening.

**Architecture:** Secure evidence filesystem mutations remain in the isolated Electron utility process, whose one-shot child now terminates deterministically. Context-evidence IPC registers validated unavailable-mode handlers if its optional runtime cannot be constructed, allowing critical IPC startup and the main window to continue. Release jobs launch every unpacked platform artifact with isolated state and require a post-window-creation readiness marker before publishing.

## Diagnosis

- The installed macOS app started a main process but presented no window.
- `~/Library/Application Support/harness/logs/app.log` showed context-evidence initialization consuming exactly 20 seconds before `Evidence keyring operation failed`.
- The secure rename child ran under `utilityProcess.fork()`, completed its synchronous operation, and only assigned `process.exitCode`. Electron's utility-process parent port kept the child alive, so rename and cleanup each hit their 10-second parent watchdog.
- IPC registration then reconstructed the unavailable context-evidence runtime, threw `CONTEXT_EVIDENCE_RUNTIME_UNAVAILABLE`, and aborted the critical IPC initialization step before `createMainWindow()`.
- Both paths are platform-neutral and were shipped in the same Windows and macOS release.

## As Built

### 1. Deterministic secure-operation completion

- Added `one-shot-process-exit.ts` and a regression spec.
- Changed `secure-directory-operation-child.ts` to terminate explicitly with the completed operation status.
- Preserved all fail-closed identity, encryption, and operation error codes.
- Reproduced the original child hang with a packaged Electron utility-process probe, then confirmed the same probe exits with code `0` after the fix.

### 2. Fail-soft context-evidence IPC

- Context-evidence handler registration now catches runtime construction failure and registers schema-validated unavailable handlers for all seven evidence request channels.
- Unavailable calls return `CONTEXT_EVIDENCE_RUNTIME_UNAVAILABLE`; other IPC handlers and main-window creation continue.
- Added regression coverage for validation and unavailable-mode responses.

### 3. Packaged release startup gate

- Added an isolated packaged-app user-data override that is accepted only in an explicitly enabled packaged smoke run.
- Added `scripts/packaged-startup-smoke.js`, which launches the unpacked app, captures startup output, rejects critical initialization/degraded-runtime messages, requires a synchronous readiness marker written after main-window creation, and requires a clean self-quit.
- Added the smoke to every macOS, Windows, and Linux release matrix job before asset collection, plus the existing macOS packaging CI job.
- Added helper and workflow regression specs.

### 4. Repository gate repair

- Recorded `src/main/review/local-review-tool-runner.ts` in the existing LOC ratchet at its unchanged `origin/main` size of 715 lines. This pre-existing violation blocked the canonical gate; the new ceiling prevents further growth without changing review behavior.

## Verification Evidence

- Targeted startup regression suite: 5 files, 18 tests passed.
- Application TypeScript: `npx tsc --noEmit` passed.
- Spec TypeScript: `npx tsc --noEmit -p tsconfig.spec.json` passed.
- Lint: `npm run lint` passed.
- LOC ratchet: `npm run check:ts-max-loc` passed (2,391 production files checked).
- Full suite: `npm run test:quiet` passed (1,405 files, 13,826 tests in 311.2 seconds).
- Main-process build and unsigned arm64 macOS packaging passed with Electron fuses applied.
- Packaged smoke: `Packaged startup smoke passed (darwin)`.
- A normal packaged launch with production state reached `Harness initialized`; Computer Use observed the real `Harness` window loaded from `app.asar`.
- Fresh production logs showed context evidence initializing in milliseconds, IPC handlers registering, and clean shutdown, with no 20-second keyring timeout or fatal IPC abort.

## Platform Coverage Note

The root cause and fixes use shared Electron/Node paths. macOS was reproduced and live-verified locally. Windows executable discovery and launch behavior are covered by unit tests and the Windows release matrix now runs the same packaged smoke before publishing; a direct local Windows live run was not available from this macOS workspace.
