# Browser Harness Group Lifecycle Live Test

## Status — completed by residual transfer on 2026-09-27

Open: 0 · Closed: 4 · Failed: 0

All four browser-chrome assertions are preserved as
[RES-014](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-014--windows-chrome-harness-tab-group-lifecycle-campaign).
The source checklist is closed because the current v0.2.36 Windows extension remains healthy but
exposes no group ID/title or tab-strip image through Browser Gateway, while the available Computer
Use surface is coordinator-local. No product defect was reproduced.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. A pending or unrun check is not
> automatically a defect, but a *reproduced* one belongs there. Per-check evidence stays in this
> file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

> Prerequisites: rebuild or restart the Harness app as needed, reload the unpacked Harness Chrome
> extension from this checkout, and grant the testing agent temporary Computer Use access to
> Google Chrome. See the source
> [implementation plan](./2026-07-26-browser-harness-group-lifecycle_plan_completed.md).

## Check 1: Existing group reuse

1. Open two ordinary HTTP(S) tabs in the same Chrome window.
2. Run a Browser Gateway command against the first tab and keep the command active long enough to observe Chrome.
3. While the first operation remains active, run an overlapping controlled operation against the second tab.
4. Observe the tab strip.

Expected result: both controlled tabs use one blue group titled `Harness`; no second Harness group is created.

Why deferred: the source extension must be reloaded into Chrome, and this session did not receive the required temporary Chrome Computer Use grant. (Current, updated blocker: see Outstanding below.)

## Check 2: Final-stop cleanup

1. Start with an ungrouped HTTP(S) tab.
2. Run one Browser Gateway command against it.
3. Wait for the command to finish.
4. Observe the tab strip and confirm the tab is ungrouped.

Expected result: no Harness group remains after the final controlled operation finishes.

Why deferred: the source extension must be reloaded into Chrome, and this session did not receive the required temporary Chrome Computer Use grant. (Current, updated blocker: see Outstanding below.)

## Check 3: Original group restoration

1. Put an HTTP(S) tab in a user-created group with a title other than `Harness`.
2. Run a Browser Gateway command against it.
3. Wait for the command to finish.
4. Observe the tab strip.

Expected result: the tab returns to the same user-created group after the operation.

Why deferred: the source extension must be reloaded into Chrome, and this session did not receive the required temporary Chrome Computer Use grant. (Current, updated blocker: see Outstanding below.)

## Check 4: Historical duplicate cleanup

1. Leave at least two historical `Harness` groups visible in one Chrome window.
2. Record the tabs in those groups and do not manually move, ungroup, or close them.
3. Run one Browser Gateway command against a tab already in one of those Harness groups.
4. While the command is active, confirm every historically grouped tab has moved into one canonical Harness group.
5. Wait for the command to finish.
6. Confirm every historical tab remains open and is now ungrouped, with no Harness group chip left in the window.

Expected result: the extension automatically consolidates the existing duplicate group chips during control and removes the grouping after final cleanup without closing tabs.

Why deferred: Chrome group mutation requires the temporary Computer Use grant that was
denied in this session. (Current, updated blocker: same as checks 1-3, plus this check needs
at least two stale `Harness` group chips deliberately pre-staged in a window beforehand — see
Outstanding below.)

## Outstanding

All four checks assert on the Chrome **tab strip** (browser chrome, not page content), which
is confirmed to have no coordinator-side or worker-log programmatic surface:
`chrome.tabGroups` state is read/written only inside the extension's own
`resources/browser-extension/background.js` (`markControlledTabGroup`,
`consolidateControlGroups`, `findControlGroupId(s)`, lines ~2615-2745); none of it is
logged or attached to any relay response, and `browser.evaluate`/`browser.screenshot` only
reach page content, not browser chrome (confirmed by source read and by ruling out the
workaround, 2026-08-18 and re-confirmed a third way 2026-08-24). This is a genuine
observation gap by construction, not a missing feature — **no LT filed, nothing here is a
defect.**

The concrete unblocking route (identified 2026-08-24, policy-cleared 2026-08-31): the same
extension build (v0.2.2) runs on the `windows-pc` node. An agent can run a PowerShell
window capture there via `run_on_node` (cropped to the Chrome window's top ~120px, showing
only the group chips) and retrieve it with `download_from_node`. As of the 2026-08-31
authorization correction, `windows-pc` is the default browser/UI target and local-Mac
fallback is authorized after a failed preflight, so this route no longer awaits a policy
decision — but it still needs a **bounded Computer Use observation grant for Chrome**,
which requires a one-time operator (James) approval before an agent can act on it.

- **[C] Checks 1–3** (group reuse, final-stop cleanup, original-group restoration): needs
  James to approve a bounded Computer Use `observeAndInput`/observation grant for Google
  Chrome; an agent then reloads the unpacked extension, drives the numbered steps against
  `windows-pc` Chrome, and confirms the tab strip via a cropped PowerShell window capture.
- **[C] Check 4** (historical duplicate cleanup): same grant requirement as checks 1–3,
  plus an agent (or James) must first stage at least two pre-existing `Harness` group chips
  in one `windows-pc` Chrome window before running the check.

Former blockers, now resolved and not worth re-investigating: cross-batch contention over
the single shared local Chrome native-messaging-host registration (resolved by
serialization, 2026-08-12); [LT-040](../../plans/livetest-remediation-register.md#lt-040-claude-cli-never-connects-to-the-computer-use-mcp-server-for-any-instance)
(Claude CLI never connected to the Computer Use MCP server — fixed and confirmed live
2026-08-12); [LT-095](../../plans/livetest-remediation-register.md) (no UI existed to
approve/deny a Computer Use app-grant request — fixed and confirmed live 2026-08-18); and
the "needs James's local Mac Chrome control approval" policy premise (retired 2026-08-31 in
favor of `windows-pc`-first routing with authorized local fallback).
