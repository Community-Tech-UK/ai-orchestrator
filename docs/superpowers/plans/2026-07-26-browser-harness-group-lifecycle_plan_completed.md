# Browser Harness Group Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse one temporary Harness tab group during browser control and restore each tab's prior grouping when control finishes.

**Architecture:** Add per-tab control leases with unique acquisition tokens inside the Browser Gateway extension service worker. The first start captures prior group metadata and applies grouping/glow; the final valid token retires the lease synchronously, then restores, recreates, or ungroups the tab. Forced cleanup invalidates stale tokens and removes the retiring generation before awaiting Chrome so watchdog rejection and later reacquisition remain independent. Restore lineage carries the pre-control group across replacement generations.

**Tech Stack:** Chrome Manifest V3 extension JavaScript, Vitest, Node `vm` extension harness.

**Status:** Completed and independently verified on 2026-07-26. Live checks that require the rebuilt/reloaded extension and temporary Chrome Computer Use access remain in the linked [live-test plan](./2026-07-26-browser-harness-group-lifecycle_livetest.md).

## Global Constraints

- Do not close tabs or delete unrelated Chrome groups.
- Preserve nested browser command behaviour.
- Chrome API cleanup failures are best effort and must not replace the browser command result.
- Keep this plan and its linked spec untracked until implementation and verification complete.

---

### Task 1: Control-group lifecycle

**Files:**
- Modify: `resources/browser-extension/background.js`
- Test: `src/main/browser-gateway/browser-extension-assets.spec.ts`

**Interfaces:**
- Consumes: `startControlledTab(tabId)`, `stopControlledTab(tabId)`, `chrome.tabs.group`, `chrome.tabs.ungroup`, and `chrome.tabGroups.query`.
- Produces: reference-counted per-tab control leases and final-stop group restoration.

- [x] **Step 1: Extend the executable extension harness**

Expose `startControlledTab`, `stopControlledTab`, and lease state from the VM harness. Model tab `groupId` changes in the fake `chrome.tabs.group` and `chrome.tabs.ungroup` implementations so assertions observe extension behaviour rather than source text.

- [x] **Step 2: Add lifecycle regression coverage**

Add tests proving:

1. An ungrouped tab joins an existing Harness group and is ungrouped on the final stop.
2. Nested starts require matching token releases before cleanup.
3. A tab that began in a non-Harness group returns to that group.
4. An original group deleted by Chrome is recreated with its captured metadata.
5. A timed-out operation's late finalizer cannot release a newer lease.
6. A watchdog force-release does not wait for hung lease initialization.
7. A reacquisition during pending cleanup gets a new generation that old cleanup cannot release.
8. A replacement generation inherits original-group metadata while prior cleanup is pending.
9. Historical duplicate Harness groups consolidate during control and disappear after the final lease.
10. Cleanup failures do not reject `stopControlledTab`.

- [x] **Step 3: Run the focused spec and capture the expected failure**

Run:

```bash
npm run test:quiet -- src/main/browser-gateway/browser-extension-assets.spec.ts
```

Expected: the new cleanup assertions fail because `stopControlledTab()` currently removes only the glow.

- [x] **Step 4: Implement reference-counted control leases**

Add a `Map` keyed by tab id. On the first start, read and record the original `groupId` and group metadata, then apply the existing discard protection, canonical grouping, glow, and capture setup. Every start returns a unique token stored on the lease. Consolidate tabs from duplicate Harness groups into the canonical per-window group. On stop, invalidate only the supplied token and return while valid acquisitions remain. At zero, mark the lease retiring and remove it from the active map synchronously before cleanup. Forced cleanup invalidates the whole old token set and does not await setup. Setup checks retirement after awaited boundaries and runs compensating cleanup if it settles late. Cleanup stands down when a replacement lease owns the tab, while a separate restore-lineage map transfers the pre-control group to that replacement. Restore the original non-Harness group when possible, recreate it from captured metadata if Chrome deleted it, and, when no other active lease remains in the window, ungroup every tab left in a Harness group.

- [x] **Step 5: Re-run focused verification**

Run:

```bash
npm run test:quiet -- src/main/browser-gateway/browser-extension-assets.spec.ts
```

Expected: PASS.

- [x] **Step 6: Defer the live Chrome lifecycle**

The rebuilt/reloaded extension and temporary Chrome Computer Use grant were unavailable in this session. The exact remaining checks, prerequisites, expected observations, and remediation flow are recorded in [2026-07-26-browser-harness-group-lifecycle_livetest.md](./2026-07-26-browser-harness-group-lifecycle_livetest.md).

- [x] **Step 7: Run canonical repository gates**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

Expected: every command exits zero.

- [x] **Step 8: Run the independent completion gate**

Require a fresh agent to use the `task-completion-gate` skill against the complete diff and acceptance criteria. Resolve every actionable finding, rerun affected checks, and repeat until the verdict is `VERDICT: PASS`.

- [x] **Step 9: Close documentation lifecycle**

Record as-built notes and verification evidence, update the spec link, rename this file to `2026-07-26-browser-harness-group-lifecycle_plan_completed.md`, and rename the spec to `2026-07-26-browser-harness-group-lifecycle_spec_completed.md`.

## As Built

- Added generation-aware per-tab leases with unique acquisition tokens.
- Retirements remove the active generation synchronously, allowing watchdog rejection and later reacquisition to proceed without waiting for hung Chrome setup.
- Restore lineage preserves the user's original group across replacement generations and prevents older cleanup from overtaking a newer retiring generation.
- Original user groups are restored or recreated with captured metadata; user regrouping during control is preserved.
- Historical Harness groups are consolidated into one canonical per-window group during control and ungrouped after the final active lease without closing tabs.
- Chrome cleanup failures remain best effort and do not replace browser command results.

## Verification Evidence

- Focused extension suite: `1 file · 51 tests passed`.
- JavaScript syntax check: passed.
- Main and spec TypeScript checks: passed.
- Angular lint: passed.
- TypeScript LOC ratchet: passed.
- Scoped diff check: passed.
- Isolated full suite: `1,594 files · 15,974 tests passed in 466.0s`.
- Fresh independent completion gate: `VERDICT: PASS`, with no unresolved findings.
