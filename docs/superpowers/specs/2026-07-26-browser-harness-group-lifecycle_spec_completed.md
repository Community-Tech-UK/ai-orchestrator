# Browser Harness Group Lifecycle Spec

## Status

Completed and independently verified on 2026-07-26. The remaining rebuilt-extension Chrome observations are explicitly deferred to the linked live-test plan.

## Implementation Plan

[Browser Harness Group Lifecycle Implementation Plan](../plans/2026-07-26-browser-harness-group-lifecycle_plan_completed.md)

## Problem

The Browser Gateway Chrome extension moves a tab into a blue group titled `Harness` whenever a browser command starts. It reuses the oldest matching group in the tab's window, but `stopControlledTab()` removes only the page glow. The grouping therefore outlives the command and historical duplicate Harness groups accumulate in Chrome.

## Required Behaviour

- Reuse one existing `Harness` group per Chrome window while one or more Browser Gateway operations are active.
- Do not create a second Harness group when a canonical group already exists.
- Treat grouping as command-lifetime state: the final stop for a tab restores the tab to its pre-control group, or ungroups it when it started ungrouped.
- Support nested control scopes without cleaning up early.
- Never close a user tab or delete unrelated tab groups.
- Best-effort Chrome API failures must not fail the browser command.

## Design

Maintain an in-memory control lease per tab in the extension service worker. Each `startControlledTab(tabId)` returns a unique acquisition token. The first acquisition records the tab's current group metadata and establishes the visual control state. `stopControlledTab(tabId, token)` releases only that acquisition; only the final valid token removes the glow and restores the original group.

Retirement is synchronous and generation-aware. Forced watchdog cleanup invalidates all tokens and removes the retiring lease from the active map before awaiting any Chrome API, so the watchdog can reject immediately and a new acquisition cannot attach to the retiring generation. Setup checks retirement after every awaited boundary; if old setup settles late, it performs compensating cleanup only when no replacement lease exists. Original-group metadata is carried as restore lineage across replacement generations so a new lease that observes the temporary Harness group still restores the user's pre-control group.

When moving the tab caused Chrome to delete an empty original group, recreate that group from its captured title, colour, and collapsed state. If the tab began in the canonical Harness group, cleanup ungroups it so the extension does not leave permanent Harness UI behind.

The existing canonical-group lookup remains window-scoped and deterministic. Control setup continues to migrate a tab from any stale duplicate Harness group into the oldest matching Harness group.

When control starts, every tab in another matching Harness group in that window is migrated into the canonical group. When the final active lease in the window ends, all remaining tabs in Harness groups are ungrouped. This removes historical duplicate group chips without closing tabs.

## Verification

- Extension harness tests cover reuse, historical duplicate consolidation and cleanup, nesting, restoration, recreation of an emptied original group, watchdog late-finalizer isolation, hung setup retirement, reacquisition during pending cleanup, restore-lineage transfer, ungrouped cleanup, and best-effort failure handling.
- The focused browser extension asset spec passed all 51 tests.
- The canonical TypeScript, lint, LOC, and quiet test gates passed; the isolated full suite passed 15,974 tests across 1,594 files.
- A fresh independent completion review returned `VERDICT: PASS` with no unresolved findings.
- Rebuilt-extension Chrome observations are recorded in [the live-test plan](../plans/2026-07-26-browser-harness-group-lifecycle_livetest.md).
