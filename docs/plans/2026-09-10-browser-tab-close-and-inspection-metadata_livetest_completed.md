# Live tests — Browser tab close and inspection metadata

## Status — 2026-09-10

Open: 3 · Closed: 0 · Failed: 0
Needs a rebuilt (`npm run build:main`) and relaunched Electron instance, plus the
0.2.20 Browser Gateway extension reloaded on `windows-pc`.

> **Found a defect while running these checks?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-09-10-browser-tab-close-and-inspection-metadata_plan_completed.md](./2026-09-10-browser-tab-close-and-inspection-metadata_plan_completed.md)

## Why these are deferred

Close-tab grant, last-tab refusal, matching filters, and agent-safe `targetId` /
inspection fields are covered by unit tests. Closing a real shared Chrome tab on
`windows-pc` and confirming the 0.2.20 extension command after deploy/reload
require the rebuilt app, the physical worker, and a disposable tab.

## Prerequisites

- Rebuild main, then relaunch Electron. An already-running instance still has
  the old MCP tool surface and coordinator close handlers.
- `windows-pc` connected with Browser Gateway extension relay healthy.
- Reload or redeploy the worker extension so `manifest.version` reports `0.2.20`.
  This bundle also contains in-progress secret-observation-protection work that
  was already in the same working tree; do not treat 0.2.20 as close-tab-only.
- Do not close James's local Mac Chrome tabs. All live checks run on `windows-pc`.
- Keep at least two http(s) tabs open in the same Chrome window before closing
  anything. The last tab in a window is refused unless `allowCloseLastInWindow`
  is true.

## Checks

### 1. Extension 0.2.20 is live on windows-pc

1. Confirm the worker extension version is `0.2.20` (Browser health / node
   extension runtime, or the extension's own status).
2. If it still reports `0.2.19` or earlier, reload/redeploy and re-check.

Expected: version `0.2.20`. Older builds fail `close_tab` as an unsupported
command.

### 2. Opaque listing rows expose a usable handle

1. From a session with Browser Gateway tools, call `browser.list_targets` with
   `computer: "windows-pc"` (or `refresh: true` after scoping to that node).
2. If any row has title `Tab inspection unavailable` or `Secret-filled tab`,
   record its fields.

Expected: every row has `id` and `targetId` with the same `existing-tab:…:target`
value, plus `inspectionState` (`readable` | `secret_tainted` |
`inspection_unavailable`). Opaque rows also have `windowId` / `tabIndex` when
Chrome reported them. Page-controlled title/URL stay redacted
(`https://redacted.invalid/` or origin + `/`). No worker loopback URL or
transport secret appears.

### 3. Close one disposable tab on windows-pc

1. Open or identify a disposable http(s) tab on `windows-pc` that is not the
   last tab in its window (for example a `about`-adjacent docs page you opened
   for this check, or a second example.com tab).
2. `browser.list_targets` and copy that row's `profileId` and `targetId`.
3. Call `browser.close_tab` with those ids. If the tool requires approval,
   approve a destructive grant (YOLO/autonomous or a one-shot approval).
4. `browser.list_targets` again.

Expected: first call returns `closed: true` and a `remainingTabCount`. The
closed tab is gone from the listing. Chrome on `windows-pc` no longer shows
that tab. Other tabs in the window stay open.

Optional follow-up: `browser.close_matching` with `urlContains` for a second
disposable tab, or `dryRun: true` first. Inspection-unavailable tabs must stay
skipped unless `includeInspectionUnavailable: true`.

## Status — 2026-09-24

Open: 0 · Closed: 3 · Failed: 0
All three checks passed on 2026-09-24 against the packaged app (built 2026-09-23 21:12 from about
`9efc4871`, which contains this plan's coordinator changes) and the live `windows-pc` extension
channel. The optional `close_matching` follow-up exposed one P3 reporting defect, filed and fixed in
code as [LT-615](livetest-remediation-register.md). It is not one of this document's three checks.

## Evidence run — 2026-09-24 (orchestrating session)

- **Check 1 — PASS.** `list_remote_nodes` reports `windows-pc` `extensionRelay.extensionVersion:
  "0.2.34"`, `registration: "ok"`. That is later than the 0.2.20 this check requires, and check 3
  proves `close_tab` is supported, which a pre-0.2.20 build would have refused.
- **Check 2 — PASS.** `browser.list_targets {computer: "windows-pc", refresh: true}` returned 18
  rows. Every row had `id === targetId` (`existing-tab:n.<node>:<window>:<tab>:target`), an
  `inspectionState` (all `readable`), and `windowId`/`tabIndex`. No row carried a loopback URL or
  transport secret. No opaque row (`Tab inspection unavailable` / `Secret-filled tab`) was present,
  so the redaction half had nothing to show; its unit coverage stands.
- **Check 3 — PASS.** Opened a disposable `https://example.com/` tab via `browser.find_or_open`
  (tabIndex 10 in window `771564446`, alongside 10 other tabs). `browser.close_tab` returned
  `closed: true, remainingTabCount: 10` (audit `cf57d912-8fab-412d-91d5-da609e682242`), with no
  approval prompt needed in this session. The refreshed listing shows the row as `status: "closed"`,
  and all 10 other tabs in that window are still `selected`. The check says the tab should be "gone
  from the listing". In fact the registry keeps closed rows marked `closed` by design
  (`BrowserTargetRegistry.markClosed`), and `close_matching {status: "closed"}` exists to sweep them.
  The substance, that Chrome no longer reports the tab, holds.
- **Optional follow-up.** `close_matching {urlContains: "example.com", dryRun: true}` (audit
  `4bc20f22…`) listed the already-closed row under `closed`, meaning "would close". Filed as LT-615
  (P3) and fixed in the working tree with a regression test; its live re-check is recorded in the
  register.
