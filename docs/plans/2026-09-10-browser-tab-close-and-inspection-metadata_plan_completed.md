# Browser Tab Close and Inspection Metadata Plan

**Date:** 2026-09-10
**Status:** Complete (automated verification). Live Windows deploy/reload and a real close on `windows-pc` are deferred to the livetest doc.
**Spec:** [2026-09-10-browser-tab-close-and-inspection-metadata_spec_completed.md](../superpowers/specs/2026-09-10-browser-tab-close-and-inspection-metadata_spec_completed.md)

## Approach

Keep CLI/MCP layering unchanged. Close is a new destructive Browser Gateway method with an extension command for shared tabs and a Puppeteer page close for managed profiles. Inspection opacity stays a secret-safety boundary; listing gains a handle alias and Chrome position metadata.

## Implementation

1. **Contracts** — add close request/result schemas; optional attach + target inspection fields (`inspectionState`, `tabIndex`, `pinned`, `active`, `textUnavailableReason` already exists on attach).
2. **Agent-safe listing** — `toAgentSafeTarget` always sets `targetId = id` and passes inspection/position fields. Never strip `id`/`profileId`.
3. **Extension 0.2.20** — `close_tab` via `chrome.tabs.remove`; inventory payload includes inspection state and Chrome position; bump the append-only background hash row.
4. **Coordinator** — `BrowserCloseTabOperations` owns grant check, last-tab guard, extension/Puppeteer execution, immediate detach, and matching. Thin service + RPC + MCP wiring.
5. **Safety lists** — mark `close_tab` / `close_matching` mutating; `close_tab` is target-scoped for remote offload; `close_matching` is a discovery method so an unscoped bulk close can route to `windows-pc`.
6. **Tests** — coordinator close/match/grant tests, DTO tests, extension harness close + inventory metadata, schema tests.
7. **Live checks** — recorded in [2026-09-10-browser-tab-close-and-inspection-metadata_livetest.md](./2026-09-10-browser-tab-close-and-inspection-metadata_livetest.md) (deploy 0.2.20, close one disposable tab on `windows-pc`).

## Assumptions

- Destructive keeps the existing autonomy rule (`actionClassRequiresAutonomy`).
- Older extensions fail `close_tab` with the existing unsupported-command error until 0.2.20 is deployed.
- `https://redacted.invalid/` remains a valid attach URL so opaque tabs keep a stable `existing-tab:…:target` handle.

## As-built

- `BrowserCloseTabOperations` grant-matches every `close_matching` candidate. A grant for origin A does not close origin B. A `targetId`-bound grant does not close another target. Unique `per_action` grants used in a batch are consumed once each.
- Remaining tab count is scoped to `profileId` / resolved `nodeId` (including `computer` resolution).
- Last shared Chrome tab in a window is refused unless `allowCloseLastInWindow`. The coordinator counts attached inventory; the 0.2.20 extension also checks `chrome.tabs.query({ windowId })`.
- Agent-safe listing always sets `targetId = id` and `inspectionState`. Page-controlled title/URL stay redacted for `secret_tainted` / `inspection_unavailable`.
- Extension `0.2.20` (`62c869613df1`) implements `close_tab`. That bundle also contains sibling secret-observation-protection work already in the tree; the livetest says not to treat the version as close-tab-only.
- Automated gates: `tsc` (main + spec), lint, loc, `build:main`, `build:renderer`, `test:quiet` (2040 files / 22615+ tests). Independent completion-gate verdict: PASS.
