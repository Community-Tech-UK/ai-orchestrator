# Usage-Aware Throttling — Implementation Plan

Status: COMPLETED — implementation verified 2026-06-05.
Owner: James + Claude. Created 2026-06-05.

## Problem / root cause

A loop ran 500 iterations / 1h57m and ended `CAP REACHED` with the final agent
"response" being `You've hit your monthly spend limit · raise it at
claude.ai/settings/usage`. Tracing it:

1. The loop hit the Claude **5-hour** (or weekly "All models") window.
2. The account's **usage-credits toggle is ON**, so Anthropic silently spilled
   over into **paid overage** — no error, exit 0, just charges (£10.92, 109%,
   resets Jul 1).
3. The overage cap hit → the "monthly spend limit" notice.
4. The loop never recognized any of this: `isProviderNotice()` is wired into
   consensus / multi-verify / auto-title / magic-prompt / compare, but **not**
   the loop-coordinator. So every iteration recorded the notice as normal output
   and ground to the iteration cap, spending real money the whole way.

Two independent gaps:
- **Reactive gap:** the loop doesn't detect a provider notice and stop.
- **Preventive gap:** AIO has no visibility into usage windows, so it can't slow
  down *before* spilling into paid credits.

The standalone `token-usage-monitor` already solves the visibility problem — but
only if installed, and it renders to the macOS menu bar, not AIO.

## Goal

Bring the monitor's **polling + display** into AIO (NOT its mitmproxy), so AIO:
- shows live usage windows in its own chrome (status strip + detail popover);
- throttles / downshifts / parks loops **before** spilling into paid overage;
- resumes automatically after the relevant window resets.

## Key technical finding (decides the architecture)

The data AIO needs does **not** require MITM. Per `poller.py`, every window is
*polled* with a token already on the machine:

| Provider | Endpoint | Auth source | MITM? |
| --- | --- | --- | --- |
| Claude | `GET api.anthropic.com/api/oauth/usage` | Keychain `Claude Code-credentials` → `claudeAiOauth` (READ-ONLY) | No |
| Copilot | `GET api.github.com/copilot_internal/user` | `~/.config/github-copilot/apps.json` | No |
| Gemini | `GET cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | `~/.gemini/oauth_creds.json` | No |
| Codex | `GET chatgpt.com/backend-api/wham/usage` | `~/.codex/auth.json` | No (WS frames only add real-time deltas) |
| Cursor | `GET cursor.com/api/usage-summary` | Keychain `cursor-access-token` | Routed through proxy for cookies only |

The mitmproxy's only unique contribution is real-time freshness between polls,
which the throttle use case does not need (windows move slowly; poll every
30–60s; throttle at 90% leaves headroom).

**Decision: port the poller, not the proxy.** mitmproxy / root CA / Python /
launchd / shell-wrappers do NOT ship in AIO.

## Architecture

```
[native pollers] ──┐
                   ├─→ ProviderQuotaService ──→ quota-warning / quota-exhausted events
[~/.usage/state.json (optional)] ─┘                    │
                                                       ├─→ Renderer: status strip + popover
                                                       └─→ LoopCoordinator: throttle / downshift / park
```

### 1. Data source — native pollers (main process)

- New probe(s) implementing the existing `ProviderQuotaProbe` contract
  (`provider-quota-service.ts:40`), returning `ProviderQuotaSnapshot` with
  `windows[].{label, used, resetsAt}`.
- **Claude first** (`ClaudeUsageEndpointProbe`): read the keychain token
  read-only, `GET oauth/usage` with `Authorization: Bearer`, `anthropic-beta:
  oauth-2025-04-20`, `anthropic-version: 2023-06-01`; parse `five_hour` /
  `weekly` / `weekly_sonnet` / credits into windows.
  - **CRITICAL — read-only token discipline:** never refresh/rotate the keychain
    token (its refresh_token is single-use; rotating it breaks Claude Code
    login). Read, never write. Skip the cycle if the token is expired.
  - Replaces the no-op windows path in the existing `ClaudeQuotaProbe` (its
    header already says `parseAuthStatus` is the one place to change).
- Others (Copilot / Gemini / Codex) ported incrementally, same pattern.
- Treat as **best-effort**: undocumented endpoints, tokens expire. On failure →
  snapshot `null` / status `unknown`; never hard-depend.

### 2. Optional interop with the standalone monitor

- A `StateJsonProbe`/source that reads `~/.usage/state.json` when present and
  fresh. Lets power users running the full monitor get MITM-only extras (Codex
  live WS, Cursor) layered on. Pure enhancement; AIO degrades cleanly without it.
- Precedence: native poll is source of truth; `state.json` fills providers the
  native pollers don't cover yet.

### 3. Periodic refresh

- `quota-auto-refresh.ts` already refreshes on adapter lifecycle events (60s
  debounce). Add a low-frequency idle poll (e.g. every 60s) so windows stay
  fresh even when no loop is running, gated by the existing pause-coordinator.

### 4. UI — status strip + detail popover (renderer)

- Compact strip: `CC 95% · CX 4% · GM 33% · CP 79% · CU 5%`, color thresholds
  green/amber/red at 75/90%. Lives in AIO chrome (title/footer bar — exact slot
  TBD with you).
- Click → detail popover mirroring the SwiftBar dropdown: per provider, each
  window with a usage bar, `used %`, reset countdown ("resets 3h 23m"),
  "updated 4m ago", a Refresh button.
- Pure Angular over a quota signal exposed from the quota service via IPC. New
  read-only IPC channel `quota:getSnapshots` + push events on change.

### 5. Loop integration — the throttle ladder

Subscribe the loop-coordinator to the quota service. On the **active provider's
binding window**:

1. **≥90% → throttle:** stop spawning *new* iterations (finish the in-flight
   one). Each iteration is a full paid agent turn, so "slow down" = "don't start
   another."
2. **Downshift (optional, decision #2):** if a cheaper bucket on the same
   provider has room (e.g. `weekly sonnet` at 7% while `weekly` is 95%), switch
   the loop model to that bucket instead of parking.
3. **Exhausted / would-spill-to-credits → park:** suspend the loop until the
   window's `resetsAt`, then resume.
4. **Credits/overage window → hard guard (decision #3):** never ride paid
   overage unless explicitly opted in. This is the real-money guard that was
   missing.

Plus the **reactive backstop** (independent of polling, in case the endpoint is
down): detect `isProviderNotice(childResult.output)` in the loop-coordinator
(~line 1438, before progress detection), don't count it as a real iteration,
and park/terminate with a distinct `provider-limit` reason instead of grinding
to `cap-reached`.

## Decisions (LOCKED 2026-06-05)

1. **Park-and-resume mechanism:** Durable AIO automation scheduled at `resetsAt`
   (via `create_automation`) that re-kicks the loop — survives restart, visible &
   manageable in AIO. NOT the host scheduler. (Rejected: in-process timer — dies
   if AIO closes.)
2. **At 90%:** Downshift to a cheaper bucket on the same provider if one has room
   (e.g. `weekly sonnet` at 7% while `weekly` is 95%), else park. (Rejected:
   always park.)
3. **Credits/overage:** Hard-never — AIO never rides paid overage. (Rejected:
   opt-in "allow up to £X"; may revisit later if wanted.)

## Scope

**In (Phase 1):** Claude native poller + quota-service wiring; periodic refresh;
status strip + detail popover + IPC; loop throttle/downshift/park ladder;
provider-notice reactive backstop + `provider-limit` terminal reason;
`state.json` interop; resume mechanism per decision #1.

**Deferred (Phase 2, optional):** scoped in-process capture proxy for AIO's
*own* spawned children only (env-injected `HTTPS_PROXY` + per-child
`NODE_EXTRA_CA_CERTS`, never global, no system CA), for real-time per-loop token
attribution. Best-effort; degrades to polling where TLS pinning blocks it.

**Out (never):** system-wide mitmproxy, global root CA install, Python runtime,
shell-wrappers, launchd agents.

## File-level change list (Phase 1, Claude)

- `src/main/core/system/provider-quota/claude-quota-probe.ts` — populate windows
  from `oauth/usage` (read-only keychain token).
- `src/main/core/system/provider-quota/usage-monitor-source.ts` (new) — optional
  `~/.usage/state.json` reader.
- `src/main/core/system/provider-quota-service.ts` — add periodic idle refresh;
  expose snapshots for IPC.
- `src/main/ipc/handlers/...` — `quota:getSnapshots` + change push event.
- `src/preload/preload.ts` + `packages/contracts/src/channels` — new channel.
- `src/main/orchestration/loop-coordinator.ts` — subscribe to quota events
  (throttle/downshift/park) + `isProviderNotice` backstop + `provider-limit`
  terminal reason.
- `src/main/orchestration/loop-coordinator-state-helpers.ts` — park state +
  resume scheduling.
- `src/renderer/app/.../usage-strip.component.ts` + popover (new) — UI.
- Tests alongside each.

## Testing

- Probe parsing: fixtures of real `oauth/usage` payloads → expected windows
  (incl. expired-token skip, HTTP-error → null).
- Quota-service threshold events at 75/90/100 + window-reset detection.
- Loop: 90% → no new iteration; downshift picks the cheaper bucket; exhausted →
  park; provider-notice output → `provider-limit` not `cap-reached`; resume
  fires at `resetsAt`.
- UI: strip color thresholds; popover countdown formatting; stale-snapshot state.

## Risks

- Undocumented endpoint may change / rate-limit the poll itself — best-effort,
  cache last good snapshot, back off the poll.
- Keychain access prompts / headless contexts — handle denial gracefully.
- Read-only token discipline is load-bearing — a write would break Claude login.
- Cross-platform: keychain is macOS; Windows/Linux use creds files or the
  `state.json` interop until native paths are added.
