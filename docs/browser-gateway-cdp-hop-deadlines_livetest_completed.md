# Live test: bounded CDP hops for existing-tab commands

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

## Current status — 2026-09-27

Open: 0 · Closed: 5 · Moved: 1 · Failed: 0

The five agent-runnable checks are closed. The only remaining assertion needs James's authenticated
eTendersNI CfT workspace tab and has moved to
[RES-028](plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-028--authenticated-etendersni-cdp-hop-deadline).
This source document is complete as a campaign record; moving the check does not claim it passed.

## Why these checks are deferred

The change bounds every CDP hop the extension makes for an existing-tab command
(attach, keep-alive, `DOM.enable`, `Accessibility.enable`,
`Accessibility.getFullAXTree`, `Page.getLayoutMetrics`, `Page.captureScreenshot`,
detach) and decorates the coordinator-side failure. The unit level is verified in-loop:

- `browser-extension-assets.spec.ts` — a hanging `Accessibility.getFullAXTree`
  fails as `browser_extension_cdp_timeout:Accessibility.getFullAXTree`, a hanging
  attach fails as `…:attach` without ever issuing a CDP command, a hanging
  `Page.captureScreenshot` fails as `…:Page.captureScreenshot`, the debugger is
  detached in every case, and no deadline shorter than the 5s floor is armed.
- `browser-extension-command-failures.spec.ts` — classification and agent wording.
- `browser-gateway-service-existing-tabs.spec.ts` — a timed-out read reaches the
  agent with the channel, "NOT a permission problem", "do not call
  browser.request_grant", and records a `command_timeout` reliability event.

What cannot run here: whether the **real** page that triggered this
(`https://etendersni.gov.uk/epps/cft/prepareViewCfTWS.do?resourceId=…` on the
Windows node, node `bb62e3ee-…`) actually stalls in `getFullAXTree`, and whether
48s is enough for it to succeed. That needs the node's Chrome on that page.

## Prerequisites

- `npm run build` (or a dev run) so the `src/main` changes ship.
- **Reload the extension on the Windows node** — the bounded hops live in
  `resources/browser-extension/background.js`. `chrome://extensions` → reload
  Harness Browser Gateway. Confirm the node reports `extensionVersion` `0.2.2`
  (`list_remote_nodes`, or the extension inventory on `/browser`); `0.2.1` means
  the node is still running the old bundle and every check below is invalid.
- A shared, logged-in Chrome tab on that node.

## Checks

### Moved

1. **Authenticated tender-page AX deadline.** The exact steps, host-permission guard, good/bad
   outcomes and debugger-detach follow-up are now owned by
   [RES-028](plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-028--authenticated-etendersni-cdp-hop-deadline).
   Current inventory on 2026-09-27 again confirmed there is no eTendersNI tab to test; opening an
   unauthenticated replacement would not exercise the original page.

### Closed — see table below

2. The agent is told it is not a permission problem.
3. The timeout is visible without a database query.
4. Screenshots are bounded the same way.
5. Healthy commands are unaffected.
6. Debugger is not left attached after a bounded failure.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 2. Agent told "not a permission problem" | 2026-08-19 | Verbatim tool result on a real `command_timeout`: channel summary + "NOT a permission problem" + "do not call browser.request_grant" all present, auditId `b51b9dc2-83d2-453f-9ea0-ed4958cb2b6a` |
| 3. Timeout visible via `browser.health` + app.log without a DB query | 2026-08-19 | `recentReliabilityEvents` entry + matching `warn` line in `app.log` for `command_timeout`; `cdpStep` was absent on this instance only because the failure was a host-permission rejection, not a bounded CDP hop (no CDP step to name) — not re-tested against a genuine CDP-hop timeout since |
| 4. Screenshots bounded the same way (real image, or named `Page.captureScreenshot` timeout) | 2026-08-24 | `browser.screenshot` on a public, no-account tab returned a real JPEG, no `cdp_timeout`; auditId `22e8c3de-f39d-4c98-bced-33ed0bfe7341` (first confirmed 2026-08-20 on a Krystal tab, auditId `b1273c3e`) |
| 5. Healthy commands unaffected (`query_elements`, `snapshot`, `click`, `evaluate`) | 2026-08-24 | All 5 commands succeeded on a quiet node (`latencyMs: 1`, `activeInstances: 0`) against a public content tab with no account state; auditIds `cd24dca3`, `c1a8a389`, `ffce82c6`, `22e8c3de`, `a860f0fa`. Supersedes the 2026-08-20 partial run, which saw `browser.evaluate` fail `browser_extension_command_receipt_missing` twice and attributed it to node load (`latencyMs: 4146`, `activeInstances: 4`), later confirmed correct when the same call succeeded on a quiet node |
| 6. Debugger not left attached after a bounded failure | 2026-08-19 | Immediate re-run of `accessibility_snapshot` on the same target attached cleanly and reached the same timeout rather than `browser_tab_debugger_busy`; auditId `d0578617-4751-4805-9f6f-1a14b8ce7036` |

### Notable defects found while running these checks (filed separately, not part of this doc's own pass/fail)

- **LT-216** — `find_or_open` could not attach to an existing tab on a relay-backed
  remote node (confirm step only accepted a re-report inside a 2.5–3s window
  against a 20–55s extension sweep) and silently opened a duplicate tab when a
  URL was supplied. Fixed and confirmed live in the packaged app on 2026-08-20
  (3/3 previously-failing tabs attached). This is what had blocked checks 4 and 5.
- **LT-217** — `browser_audit_entries` is ~99.7% internal bookkeeping (3.44M rows,
  1.36 GB) with no pruning path. Not fixed (pruning an audit trail is a policy
  decision, not a bug fix); unrelated to this doc's checks.
- **LT-218** — `browser.snapshot`/`accessibility_snapshot` report `outcome:
  "succeeded"` with empty text when the extension lacks host permission for the
  page, instead of surfacing the rejection. Fix is in source and
  regression-tested, but the live extension on `windows-pc` had not been reloaded
  as of the last check (`extensionReloadedAt` ~22.6h stale on 2026-08-20) — its
  live recheck is folded into check 1's blocker above, since check 1 needs a
  permission probe on the same origin regardless.

## Prior blocker history (superseded)

Two earlier diagnoses in this doc's history turned out to be wrong and were
corrected in later runs; recorded once here rather than at every occurrence:

- 2026-08-01/2026-08-12 stated check 1 was blocked on James answering a
  main-vs-`windows-pc` routing dialog. 2026-08-19 established this gate is
  **session-scoped and clearable by an agent** (fires once per session
  regardless of which parameter is passed; the retry succeeds) — not a standing
  human blocker. `docs/plans/livetest-campaign-runbook.md` was corrected to match.
- The 2026-08-18/19 runs also separately confirmed there was, at those times, no
  `etendersni.gov.uk` tab shared on `windows-pc` at all (checked against 20, then
  48 shared targets) — a distinct, now-current reason check 1 remains open.

The current and only blocker for check 1 is the one stated above: the
authenticated tab does not exist/is not shared, `windows-pc` needs to be
online, and origin host-permission needs a probe once it is.
