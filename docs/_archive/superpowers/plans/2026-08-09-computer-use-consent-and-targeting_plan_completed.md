# Computer Use Consent And Targeting Remediation Implementation Plan

**Status:** Completed and independently verified; rebuilt-app checks deferred

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the consent, window identity, accessibility targeting, grant-reporting, and focus-guidance defects recorded in the 9 August Computer Use incident report.

**Architecture:** Keep policy decisions in the orchestration and desktop-gateway layers, normalise platform-specific identity in the Darwin driver, and label window-external accessibility nodes before they enter the observation store. Preserve all fail-closed input checks.

**Tech Stack:** TypeScript 6, Vitest 3, Electron 40, Swift/AppKit/ApplicationServices.

## Global Constraints

- Work in the existing checkout; do not create a branch or worktree.
- Preserve unrelated dirty-tree changes and do not commit or push.
- Write every regression test first and observe the expected failure.
- Do not weaken grant, observation-token, sensitive-action, app, active-window, or in-window coordinate checks.

---

### Task 1: Restrict YOLO Auto-approval To ACP Transport

**Files:**
- Create: `src/main/app/permission-auto-approval.ts`
- Create: `src/main/app/permission-auto-approval.spec.ts`
- Modify: `src/main/app/initialization-steps.ts`

**Interfaces:**
- Produces: `shouldAutoApproveAcpPermissionRequest(request: PermissionRequest, yoloMode: boolean): boolean`
- Consumes: `PermissionRequest.details.transport`

- [x] Add tests proving an ACP request in YOLO mode returns `true`, while `desktop_computer_use_grant`, missing transport metadata, and non-YOLO requests return `false`.
- [x] Run the new test and confirm it fails because the classifier does not exist.
- [x] Implement the pure classifier and use it in the existing `permission:requested` listener before calling `permissionRegistry.resolve(..., 'auto_approve')`.
- [x] Run the focused app tests and confirm the desktop request remains pending while ACP behaviour is preserved.

### Task 2: Canonicalise Equivalent macOS Screenshot Window IDs

**Files:**
- Modify: `src/main/desktop-gateway/platform/darwin-driver.ts`
- Modify: `src/main/desktop-gateway/platform/darwin-driver.spec.ts`
- Modify: `src/main/desktop-gateway/desktop-gateway-service.spec.ts`

**Interfaces:**
- Produces: a `DesktopScreenshotResult.windowId` expressed in the requested helper ID format when Electron's source ID is proven equivalent.

- [x] Add a Darwin driver test where target `216` produces capture ID `window:216:0` and assert result ID `216`.
- [x] Add a service regression test proving the same pair is accepted and still produces a window-bound observation token.
- [x] Run both tests and confirm the literal mismatch fails.
- [x] Reuse the existing Electron/CGWindow equivalence matcher when projecting the driver result; leave unrelated IDs unchanged.
- [x] Run focused driver and gateway tests.

### Task 3: Mark Window-external Accessibility Nodes As Ineligible For Input

**Files:**
- Create: `src/main/desktop-gateway/desktop-accessibility-actionability.ts`
- Create: `src/main/desktop-gateway/desktop-accessibility-actionability.spec.ts`
- Modify: `src/shared/types/desktop-gateway.types.ts`
- Modify: `src/main/desktop-gateway/desktop-observation-store.ts`
- Modify: `src/main/desktop-gateway/desktop-input-controller.ts`
- Modify: `src/main/desktop-gateway/desktop-gateway-service.ts`
- Modify: `src/main/desktop-gateway/desktop-gateway-service.spec.ts`

**Interfaces:**
- Produces: `annotateInputEligibility(nodes, windowBounds)` and optional `inputEligible` metadata on snapshot nodes/candidates.

- [x] Add pure tests proving an in-window node is eligible, an out-of-window menu item is ineligible, and input metadata propagates through nested nodes without mutation.
- [x] Add a gateway regression test proving `query_elements` reports the menu item as ineligible and every click/typing/hotkey route rejects it without calling the driver.
- [x] Run the tests and confirm the eligibility API/behaviour is absent.
- [x] Annotate snapshots using the requested window descriptor's bounds, project the metadata through observations, and reject explicitly ineligible element handles and focused keyboard targets.
- [x] Run the focused actionability, observation-store, and gateway tests.

### Task 4: Report Requested Grant Duration Explicitly

**Files:**
- Modify: `src/shared/types/desktop-gateway.types.ts`
- Modify: `src/main/desktop-gateway/desktop-grant-store.ts`
- Modify: `src/main/desktop-gateway/desktop-grant-approval-controller.ts`
- Modify: `src/main/desktop-gateway/desktop-gateway-service-helpers.ts`
- Modify: `src/main/desktop-gateway/desktop-gateway-service.spec.ts`

**Interfaces:**
- Produces: optional `duration: DesktopGrantDuration` and `minutes?: number` on stored grants and list summaries for backward-compatible persisted records.

- [x] Extend the bounded-grant test to assert `scope: 'session'`, `duration: 'boundedMinutes'`, and the requested minutes.
- [x] Run it and confirm duration metadata is missing.
- [x] Persist request duration/minutes when materialising a grant and project the optional fields into list summaries.
- [x] Run the focused gateway and grant-store tests.

### Task 5: Clarify Safe Focus And Menu Handling

**Files:**
- Modify: `src/main/desktop-gateway/desktop-mcp-tools.ts`
- Modify: `src/main/desktop-gateway/desktop-mcp-tools.spec.ts`

**Interfaces:**
- Produces: concise model-facing instructions for immediate activation/re-observation/input orchestration and window-scoped menu limitations.

- [x] Add assertions that activation guidance requires immediate re-observation/input without an avoidable top-level pause and that menu-bar nodes outside the approved window are unavailable.
- [x] Run the spec and confirm the current descriptions fail those assertions.
- [x] Update the relevant tool descriptions without weakening the final active-target validation.
- [x] Run the focused MCP tool spec.

### Task 6: Verification And Documentation Closure

**Files:**
- Modify: `docs/superpowers/specs/2026-08-09-computer-use-consent-and-targeting_spec_planned.md`
- Modify: `docs/superpowers/plans/2026-08-09-computer-use-consent-and-targeting_plan.md`
- Create if required: `docs/superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest.md`

**Interfaces:**
- Produces: verified implementation evidence and closed `_completed` documentation, with rebuilt-app-only checks explicitly deferred.

- [x] Run all focused Computer Use and initialization tests.
- [x] Run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, and the full suite as supported sequential shards.
- [x] Inspect the source diff for generated or unrelated changes.
- [x] Obtain a fresh independent `task-completion-gate` review; fix every actionable finding and repeat until `VERDICT: PASS`.
- [x] Record rebuilt-app live checks separately because local Mac UI control was not authorised in-loop.
- [x] Update as-built notes, link the completed plan filename, and rename the spec and plan to `_completed.md` after the agent-runnable gates pass.

## As-Built Verification

- Consent isolation, equivalent macOS window identity, window-external actionability, requested
  grant duration, and focus/menu guidance were implemented as specified.
- The first fresh completion gate found that implicitly focused typing and hotkeys did not yet
  enforce `inputEligible: false`. A red service regression reproduced both native-driver calls;
  the controller was made fail-closed for every focused or explicit observed input route.
- Post-fix focused verification passed 13 files/115 tests. Both TypeScript checks, lint, the LOC
  ratchet, and `build:main` passed.
- The full suite passed in four supported sequential shards: 433 files/4,474 tests; 433/4,387;
  433/4,524; and 433/4,657. Total: 1,732 file executions and 18,042 tests.
- A different fresh agent reran the task-completion and required diff-scoped repo-health gates and
  returned `VERDICT: PASS` with no task-scoped findings. It noted only pre-existing advisories in
  unchanged dependencies.
- Real rebuilt-app prompt, screenshot, AX-menu, and foreground-race checks remain in
  [2026-08-09-computer-use-consent-and-targeting_livetest.md](./2026-08-09-computer-use-consent-and-targeting_livetest.md).
