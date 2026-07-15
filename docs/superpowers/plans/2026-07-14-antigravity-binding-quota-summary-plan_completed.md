# Antigravity Binding Quota Summary Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in the current
> workspace. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the compact `AG` percentage show the binding Gemini quota window.

**Architecture:** Extend the existing preferred-summary selector so a provider
may nominate multiple canonical windows and the selector chooses the most-used
of those windows. Preserve the existing all-window fallback when no preferred
window is available.

**Tech Stack:** TypeScript, Angular 21 signals, Vitest.

## Global Constraints

- Keep Gemini as Antigravity's compact headline family.
- Do not change the four-window detail popover.
- Preserve unrelated working-tree changes.
- Do not commit or push.

---

### Task 1: Select the binding preferred window

**Files:**

- Modify: `src/renderer/app/shared/components/provider-quota-chip/provider-quota-chip.component.ts`
- Test: `src/renderer/app/shared/components/provider-quota-chip/provider-quota-chip.component.spec.ts`

**Interfaces:**

- Consumes: `ProviderQuotaSnapshot.windows` and `PREFERRED_SUMMARY_WINDOW_IDS`.
- Produces: the existing private `summaryWindow(snapshot)` result used by
  `stripEntries`.

- [x] **Step 1: Change the focused regression expectation**

  Use an Antigravity snapshot whose Gemini five-hour usage is `0%` and Gemini
  weekly usage is `100%`. Expect the compact strip to contain `AG100%` and not
  `AG0%`.

- [x] **Step 2: Run the focused test and confirm the red state**

  Run:

  ```bash
  npm run test:quiet -- src/renderer/app/shared/components/provider-quota-chip/provider-quota-chip.component.spec.ts
  ```

  Expected: the binding-window test fails because the selector still returns
  `antigravity.gemini-5h`.

- [x] **Step 3: Implement the minimal selector change**

  Add `antigravity.gemini-weekly` to Antigravity's preferred summary IDs. In
  `summaryWindow`, collect all valid preferred windows and select the most-used
  window from that collection. If none exist, keep the current all-window
  fallback.

- [x] **Step 4: Run the focused test and confirm the green state**

  Run the command from Step 2. Expected: all tests in the component spec pass.

- [x] **Step 5: Run project verification**

  Run:

  ```bash
  npx tsc --noEmit
  npx tsc --noEmit -p tsconfig.spec.json
  npm run lint
  npm run check:ts-max-loc
  npm run test:quiet
  ```

  Expected: every command exits successfully.

- [x] **Step 6: Close documentation lifecycle**

  Record as-built changes and verification evidence, create a focused live-test
  document only if a rebuilt app is required, then rename this plan and its
  design to add `_completed` before `.md`.

## As Built

- `summaryWindow()` now selects the highest-used valid window among a
  provider's preferred summary IDs before falling back to the highest-used
  window in the full snapshot.
- Antigravity's preferred summary IDs now include both Gemini five-hour and
  Gemini weekly.
- The focused regression reproduces the reported `0%` five-hour plus `100%`
  weekly state and requires `AG100%`.
- Probe collection, percentage normalization, detail rows, and Claude/GPT
  windows are unchanged.

## Verification Evidence

- Red state: focused component test failed with `expected 'AG0%' to contain
  'AG100%'`.
- Green state: focused component suite passed, 26 tests.
- `npx tsc --noEmit`: passed in the working tree and clean verifier worktree.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed in both workspaces.
- `npm run lint`: passed in both workspaces.
- Clean verifier `npm run test:quiet`: passed 1,340 files and 13,259 tests.
- Fresh-agent task-completion gate: `VERDICT: PASS`; no task-attributable
  findings or escalation triggers. The verifier independently reproduced the
  focused test, both TypeScript checks, lint, and the clean full-suite result.
- Dirty working-tree `npm run test:quiet`: two unrelated concurrent-work
  failures in notification digest timing and RLM migration setup; neither
  failure appeared in the clean verifier worktree.
- `npm run check:ts-max-loc`: blocked in both the working tree and clean
  verifier worktree by committed baseline file
  `scripts/analyze-codex-context-pressure.ts` at 1,153 lines against a 700-line
  limit. The quota component itself decreased by three lines.
- Rebuilt-app observation is deferred to
  `2026-07-14-antigravity-binding-quota-summary-plan_livetest.md`.

## Close-out Re-verification — 2026-07-15

- Focused component suite: 26 tests passed.
- `npx tsc --noEmit`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npm run lint`: passed.
- `npm run check:ts-max-loc`: passed. The former unrelated LOC blocker has
  been resolved; one unrelated allowlisted file remains within its permitted
  ratchet tolerance.
- `npm run test:quiet`: 1,361 files and 13,389 tests passed.
- The rebuilt-app observation remains deferred to
  `2026-07-14-antigravity-binding-quota-summary-plan_livetest.md`.

All agent-runnable requirements pass, so this plan and its design are closed
and renamed with `_completed`.
