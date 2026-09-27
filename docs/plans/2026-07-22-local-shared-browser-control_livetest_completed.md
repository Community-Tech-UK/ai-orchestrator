# Live tests — local + remote shared-browser control

## Status — completed 2026-09-27

Open: 0 · Closed: 4 · Transferred: 4 · Failed: 0

The four checks that still require a human-controlled shared browser, a disruptive Chrome shutdown,
an approved real multi-window desktop session, or the correct external ProContract opportunity have
been moved to the consolidated residual document. No executable check remains in this file.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Deferred checks from
[2026-07-22-local-shared-browser-control_plan_completed.md](./2026-07-22-local-shared-browser-control_plan_completed.md).

Every item here needs a rebuilt/restarted app, a real Chrome with a human sharing a tab, the
`windows-pc` worker, or a real multi-window macOS app. Everything agent-runnable was verified
in-loop (`tsc`, spec `tsc`, lint, LOC ratchet, 15321 tests) and is **not** repeated here.

## Prerequisites

1. `npm run build:desktop-helper` — **required**. The helper protocol moved to `1.2.0` and is
   compared for strict equality, so an app running against a `1.1.0` helper binary will report
   `computer_use_helper_version_mismatch` for every Computer Use call.
2. `npm run build:aio-mcp-dist` — the browser-gateway MCP forwarder and native host run from the
   SEA, so the reveal-restore and local-contact changes are not live until this is rebuilt.
3. `npm run build:worker-dist` + redeploy to `windows-pc` for §6.
4. Restart AI Orchestrator, then reload the Harness extension in `chrome://extensions`
   (the local native port must reconnect to the new gateway socket).
5. No extension source changed, so no extension *repackaging* is needed — only a reload.

## Current authorization note — 2026-08-31

Since 2026-08-26, local Mac browser and application UI control has standing authorization after a
failed `windows-pc` Browser Gateway preflight. Read-only/shared-tab and safe-app checks (§2's
extension reload, §4's tab-share) are agent-runnable through the normal grant flow. Quitting
Chrome (§3), TCC interaction (§5), and any other sensitive/destructive step still need James.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| §1 Local extension health is reported and accurate | 2026-08-24 | `browser.health` clean pass after restoring native-host manifest ownership (LT-520): `state: "ready"`, `installed/registered/polling: true`, `contactAgeMs: 1671`, no `remediation`, `warnings: []` — 8/8 expected fields matched |
| §2 Stale-socket detection and repair | 2026-09-27 | The 2026-08-12 restart produced the required `silent` state and extension-reload remediation text. Current `browser.health` after reload reports `state: "ready"`, `installed/registered/polling: true`, extension `0.2.36`, contact age about 5 seconds, and no warnings (audit `14352dfa-959c-4acd-984e-6291c85903fd`). Together these prove both sides of the transition. |
| §6 Remote worker parity | 2026-08-18 (orchestrator) | `browser.list_targets`/`preflight_target`/`snapshot` against `windows-pc` all matched spec (channel `remote-extension`, cross-computer isolation, live read); auditIds `8b4dfff0…`, `c30db1ec…`, `d9ff8f16…`, `29c2089b…` |
| §7 Reveal continuity across real execution cells | 2026-08-12 | Codex cells A/B/C run; AIO's own reveal-restore confirmed healthy (`mcpSessions.schemaMatch: true`, `toolParity 42/42`, no `revealRestoreFailed`); the cell-B/C gap traced conclusively to Codex CLI's own MCP client not respawning a killed subprocess — accepted per this doc's own "client-side snapshot — record and stop" rule, no LT filed |

## Residuals transferred on 2026-09-27

| Former check | New owner | Current evidence |
| --- | --- | --- |
| §3 Local Chrome shutdown fast-fail | [RES-004](2026-09-27-livetest-human-external-residuals_livetest.md#res-004--local-chrome-shutdown-fast-fail) | Still needs an exclusive window in which quitting James's shared Chrome will not interrupt other sessions. |
| §4 Positive shared-tab discovery/preflight | [RES-005](2026-09-27-livetest-human-external-residuals_livetest.md#res-005--local-shared-tab-discovery-and-preflight) | The negative isolation half passed on 2026-08-12. On 2026-09-27 local health was ready but no tab was shared; the desktop approval request expired without approval, so the extension-popup click was not available. |
| §5 Real multi-window activation | [RES-006](2026-09-27-livetest-human-external-residuals_livetest.md#res-006--computer-use-multi-window-activation) | `computer.health` was healthy and all macOS permissions were available, but Chrome exposed only one visible window. The bounded `observeAndInput` request expired without approval, so no input was attempted. |
| §8 ProContract withdrawal | [RES-007](2026-09-27-livetest-human-external-residuals_livetest.md#res-007--procontract-withdrawal-flow) | Secure automatic relogin succeeded. Exact-title, `Website`, and `Hosting` searches with expired and withdrawn opportunities included did not find the named tender. The available response is ERSP1073223 / ERFX1008859, “Dedicated Housing Tenant Website”, and the tab was restored to that original response (navigation audit `2a93868a-1083-45e8-a292-80723b8c9924`; snapshot audit `6b6803b0-688f-4a68-bba1-32c24fb19ba3`). The conversation ledger had zero case-insensitive matches for the requested title, and targeted historical-session search found no portal URL tied to the breadcrumb. |

## Completion note

All agent-accessible checks are evidenced above. The four non-autonomous checks now have exact
steps, expected results and rollback/safety notes in the consolidated residual document. No defect
was reproduced by this campaign, so no remediation-register entry was added.
