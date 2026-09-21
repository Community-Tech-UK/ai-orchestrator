# Browser Tab Close and Inspection Metadata Spec

**Date:** 2026-09-10
**Status:** Complete (automated verification). Live Windows checks remain in the livetest doc.
**Owner:** James

**Implementation plan:** [2026-09-10-browser-tab-close-and-inspection-metadata_plan_completed.md](../../plans/2026-09-10-browser-tab-close-and-inspection-metadata_plan_completed.md)

## Problem

Browser Gateway can find or open tabs and change a tab URL, but it cannot close a tab. Remote worker nodes therefore accumulate leftover tabs that only a person at the physical machine can dismiss.

A second gap makes cleanup unsafe to delegate. Some shared/extension-relayed tabs list as `title: "Tab inspection unavailable"` and `url/origin: https://redacted.invalid/`. That redaction is correct when secret-taint inspection cannot run: page-controlled title, URL path, and text must not leave the extension. The listing still omits an obvious `targetId` field (the handle is `id`) and does not expose Chrome window/tab position or a redaction reason, so an operator or agent cannot identify the row or pass it to a close tool.

## Goals

1. Add `browser.close_tab` for one known target, gated as `destructive`.
2. Add `browser.close_matching` for bounded bulk cleanup by URL/title substring or already-closed registry status.
3. Keep secret-tainted and inspection-unavailable page content redacted.
4. Always return a usable handle (`id` and `targetId`) plus non-page-controlled position metadata and an inspection reason.
5. Return success/failure and the remaining open-tab count after a close.

## Non-Goals

- Do not restore page-controlled title, URL path, query, or text for secret-tainted or inspection-unavailable tabs.
- Do not add a UI close button on the Browser page in this change.
- Do not close Chrome internal pages (`chrome://`, `chrome-extension://`).
- Do not treat close as origin-wildcard access to snapshots or fills.

## Tool Contract

### `browser.close_tab`

Required: `profileId`, `targetId`.
Optional: `allowCloseLastInWindow` (default false).

Action class: `destructive` (existing autonomy rule applies: an ordinary grant must be `autonomous: true`, or the caller redeems a per-action approval).

Behaviour:

- Existing shared Chrome tab: send extension command `close_tab` (`chrome.tabs.remove`), then detach immediately.
- Managed profile page: close the Puppeteer page and mark the target closed.
- Refuse to close the last tab in a shared Chrome window unless `allowCloseLastInWindow` is true. Managed profiles are exempt.
- Already-closed or missing extension tab: succeed as closed after detaching any stale attachment.
- Result data: `{ closed: true, remainingTabCount, inspectionState? }`.

### `browser.close_matching`

Optional scope: `profileId`, `nodeId`, `computer`.
At least one filter is required: `urlContains`, `titleContains`, or `status: "closed"`.
Optional: `includeInspectionUnavailable` (default false), `includeSecretTainted` (default false), `allowCloseLastInWindow` (default false), `maxCount` (default 10, max 25), `dryRun` (default false).

Behaviour:

- Match is case-insensitive substring on the *listed* title/URL (including redacted sentinels only when the matching include flag is set).
- Inspection-unavailable and secret-tainted live tabs are skipped unless the corresponding include flag is set.
- `status: "closed"` only sweeps registry rows already marked closed. It does not call `chrome.tabs.remove`.
- One destructive authorization covers the batch. A `per_action` grant is consumed once after the batch, not after each tab.
- Partial success is reported. Result data: `{ closed, skipped, remainingTabCount, dryRun }`.

## Inspection Metadata

`list_targets` (and other agent-safe targets) must include:

- `id` (existing) and `targetId` (same value; this is the field close tools accept)
- `profileId`
- `inspectionState`: `readable` | `secret_tainted` | `inspection_unavailable`
- `textUnavailableReason` when inspection is blocked
- `windowId`, `tabIndex`, `pinned`, `active` from Chrome tab metadata (not page-controlled)

Page-controlled title/URL stay redacted:

- Secret-tainted with a known origin: listed URL is that origin + `/`, title is `Secret-filled tab`.
- Inspection unavailable: listed URL is `https://redacted.invalid/`, title is `Tab inspection unavailable`.

## Security

- Close never returns page text, screenshots, or unredacted titles/URLs.
- Close of an inspection-unavailable tab authorizes against the stored redacted origin, so a grant for a real site does not silently cover unknown tabs.
- Bulk close cannot run with zero filters.
- Last shared-window tab is refused by default so a cleanup cannot quit the operator's Chrome.

## Verification

- Unit tests for grant denial, last-tab refusal, matching filters, opaque-tab skip/include, managed-page close, and agent-safe `targetId` / inspection fields.
- Extension harness tests for `close_tab` and inventory metadata.
- Canonical project gates.
- Live Windows extension deploy/reload and a real close on `windows-pc` are livetest items.

## Live-Test Deferral

Closing a real shared tab on `windows-pc` and confirming the 0.2.20 extension command after deploy/reload require a rebuilt app and the physical worker. Record those in the livetest doc; do not claim them verified from unit tests.
