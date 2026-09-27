# Outlook / Microsoft 365 Graph calendar connector live test

## Status — completed 2026-09-27

Open: 0 · Closed: 1 · Transferred: 4 · Failed: 0

One interactive Microsoft delegated sign-in/consent as `james@communitytech.co.uk` is still needed
before the safe round trip can run. The recurring-reminder and optional personal-account checks also
need explicit content/registration decisions. All four are now owned by
[RES-009](2026-09-27-livetest-human-external-residuals_livetest.md#res-009--microsoft-graph-calendar-connection-and-live-round-trips).

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Implementation plan: [2026-07-23-outlook-graph-calendar-connector_plan_completed.md](./2026-07-23-outlook-graph-calendar-connector_plan_completed.md)

## Prerequisites

- Build and launch a fresh AIO app instance containing the completed implementation.
- Restart each connected Claude/Codex/Grok client after the app is running so it reloads the rebuilt `aio-mcp` SEA tool roster.
- Keep the registered Entra application single-tenant for the business-account checks. The shipped defaults use its registered public client ID and tenant-specific authority.
- Electron `safeStorage` must be available. The connector must fail rather than persist a plaintext token cache when it is unavailable.
- Use the M365 communitytech calendar (`james@communitytech.co.uk`) for Comtech work. Do not create personal reminders on the shared family Hotmail calendar.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 1 — fresh-client tool roster | 2026-08-25 (last re-confirmed; first passed 2026-07-25, re-verified 2026-08-18/19/24 with no regressing commits) | All eight `graph_calendar_*` tools present on the live packaged-app MCP socket with no manual config; schemas carry no token/secret/authorization field; `git log` confirmed no behaviour-affecting change to `orchestrator-tools-step.ts`'s `authorizeCalendarMutation` since 2026-08-19 |

**Important scope correction found 2026-08-18 (do not restate the old framing):** the checks-2–5
blocker is **not** tenant-administrator consent. `Calendars.ReadWrite` and `User.Read` are both
user-consentable; admin consent was never required. The actual blocker is a one-time interactive
delegated OAuth sign-in and consent click by James as `james@communitytech.co.uk`
(`src/main/graph/graph-auth.ts:93-133`: `acquireTokenInteractive` via loopback-redirect system browser,
with device-code fallback). Live-MCP-client calls can be driven directly against the running packaged
app's `orchestrator-tools` socket without a throwaway instance — see
`_scratch/lt-2026-08-18/batchX/mcp-call.mjs` / `mcp-list.mjs`.

**Approval-gate mechanism already verified independently (2026-08-18):** once an account is connected,
`graph_calendar_create_event`/`update_event`/`delete_event`/`connect` all route through
`authorizeCalendarMutation()` (`src/main/app/orchestrator-tools-step.ts:305-343`) into the same
`PermissionRegistry` LT-095 fixed and live-verified on 2026-08-12 (renderer-reachable
approve/deny/extend surface). A live `create_event` call was sanity-checked to hang pending approval
and mutate nothing (`graph_calendar_status`/`list_accounts` unchanged after a 20 s timeout). So once
check 2 is done, checks 3-4 have a working approval surface waiting — nothing else needs building for
that half.

## Residuals transferred on 2026-09-27

The production operator database was queried read-only and contains exactly zero `graph_accounts`
rows. Direct live MCP status calls were also attempted, but the current conversation's RPC policy
returned `EVIDENCE_CAPTURE_REQUIRED`; that policy refusal is not calendar-product evidence and did
not trigger sign-in or mutate anything.

[RES-009](2026-09-27-livetest-human-external-residuals_livetest.md#res-009--microsoft-graph-calendar-connection-and-live-round-trips)
now contains the exact sign-in, temporary create/read/delete, recurring-reminder and optional
Hotmail guard steps. No real calendar event or account registration was changed by this campaign.
