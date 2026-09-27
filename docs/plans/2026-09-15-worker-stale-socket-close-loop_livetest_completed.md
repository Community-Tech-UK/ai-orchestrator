# Worker Stale-Socket Close Loop — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-15-worker-stale-socket-close-loop_plan_completed.md](2026-09-15-worker-stale-socket-close-loop_plan_completed.md)

**Prerequisites:**

- Rebuild and restart Harness from this checkout (`npm run build:main && npm run build:aio-mcp-dist`,
  then restart) so the coordinator runs the flap monitor, connection reset, two-clock health and
  CAPTCHA probe. This restart replaces the process hosting the implementing session, which is why
  these checks could not run in-loop.
- Checks 1 and 3 need the **old** worker build still running on `windows-pc`
  (node `bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`). Run them before redeploying the worker.
- Checks 2, 4 and 5 need the **new** worker build deployed to `windows-pc` (`npm run build:worker-dist`,
  then the normal worker deployment/installer; see `windows-worker-had-no-supervision` in memory: the
  installer must actually run, and confirm process `startedAt` is newer than the dist mtime).
- Coordinator log: `~/Library/Application Support/harness/logs/app.log`. Count replaces with
  `grep -c "Replacing existing socket" app.log` over a time window, never across the whole file.

## Status — 2026-09-15

Open: 5 · Closed: 0 · Failed: 0

At implementation time the storm was still running: 287 `Replacing existing socket` lines for
windows-pc, the latest at 2026-09-15T20:57:27Z, one stream epoch.

## Outstanding checks

### 1. Coordinator reset ends a storm from the old worker build

1. After the Harness restart, watch `app.log` for 5 minutes. A coordinator restart closes every
   socket, so the loop may not re-form on its own. If there are fewer than 4 replaces in 5 minutes,
   record "storm did not re-form after restart" and use check 3 to exercise the reset path instead.
2. If the storm re-forms, expect exactly one `Worker node connection flap storm detected` WARN with
   `rule: "slow"`, then `Worker node flap reset — closing the new connection once after registration`
   and `Resetting worker node connection` with reason `Flap reset`.
3. Expected: within 60 s after the reset, `Replacing existing socket` stops for windows-pc and does
   not resume for 10 minutes. `browser_health` shows `channelState: "fresh"` for windows-pc.

### 2. New worker build: restart produces no replace loop

1. Deploy the new worker build and restart the worker service on windows-pc.
2. Expected: one `Node registered via WebSocket` for windows-pc and zero `Replacing existing socket`
   lines in the following 60 s (and none in 10 minutes). The worker log shows no
   `Stale coordinator socket closed; ignoring` loop.

### 3. `browser_health` and `browser.recover_extension` on `relay_not_forwarding`

1. While windows-pc is in the old-worker loop (check 1 before any automatic reset, or immediately
   after the loop re-forms), call `browser.health` / `browser_health`.
2. Expected: the windows-pc node shows `channelState: "relay_not_forwarding"`,
   `commandsDeliverable: false`, `relayContactAgeMs` under ~30 000, a large `coordinatorPollAgeMs`,
   and `connectionFlap.stormActive: true`. The warning names `browser.recover_extension`.
3. A `browser.list_targets` with `refresh: true` fails with a message containing
   `extension polled the relay … ago; the coordinator has not received a poll for …`.
4. Call `browser.recover_extension` with `computer: "windows-pc"`.
5. Expected: `recoveryAction: "connection_reset"`, `recoveryStatus: "recovered"`, and `after.coordinatorPollAt`
   newer than the call. No native-host restart RPC appears in the worker log.
6. If no loop can be reproduced, instead use Settings → Remote Nodes → **Reset connection** on
   windows-pc and the `reset_node_connection` orchestrator tool (`node: "windows-pc"`). Expected: each
   logs `Resetting worker node connection`, the node reconnects within its backoff, and it is not
   revoked (it stays listed and needs no re-pairing).

### 4. `list_targets refresh` returns non-stale targets after recovery

1. After check 2 or 3, call `browser.list_targets` with `refresh: true` for windows-pc.
2. Expected: success, and shared tabs have `lastConfirmedAt` newer than the recovery. No `stale: true`
   on reachable tabs.

### 5. CAPTCHA parking uses page evidence

Use a test page you control (never a third-party form you would submit): one page with a visible
reCAPTCHA v2 checkbox (Google's public test site key), and one page with only the invisible v3 badge.

1. Share the v3-only page. Click an ordinary button with actionHint
   `"Enable the reCAPTCHA Enterprise API"` under an input grant.
   Expected: the click executes (not parked).
2. Share the v2 checkbox page. Before solving, `browser.click` any button.
   Expected: `requires_user` with a `captcha` reason (escalation parked). `browser.evaluate` on the same
   tab parks the same way.
3. Solve the checkbox by hand, then repeat the click. Expected: it executes.

## Status — 2026-09-24

Open: 3 · Closed: 2 · Failed: 0
Checks 2 and 4 passed on 2026-09-24. Check 3 is half done: the `reset_node_connection` fallback path
passed, but the `relay_not_forwarding` observation and the Settings → Reset connection button are
still outstanding. Checks 1 and 3's first half both need a worker running the pre-fix build, and
`windows-pc` now runs the fixed one (started 2026-09-23 ~21:25Z), so its storm can no longer re-form.
A disposable pre-fix worker paired to an isolated dev app over loopback (the WS15 livetest method)
can stage the storm without touching `windows-pc`, and that same dev app can click the Settings
button. That is agent work. Check 5 needs a CAPTCHA test page served somewhere `windows-pc` can
reach; the agent can do everything except step 3's hand-solve.

## Evidence run — 2026-09-24 (orchestrating session, packaged app built 2026-09-23 21:12)

- **Check 2 — PASS.** The current `windows-pc` worker registered once, at
  `1790198723289` ("Node registered via WebSocket"). Across the following ~3 h 20 m of
  `~/Library/Application Support/harness/logs/app.log` there are **zero** `Replacing existing socket`
  lines and no further registrations until the deliberate reset below. The worker's own
  `%USERPROFILE%\.orchestrator\logs\worker-agent.log` (808,365 bytes, last written
  2026-09-24T01:03:24Z) contains **0** `Stale coordinator socket closed` lines. It was read through a
  `run_on_node` Antigravity agent (instance `i0n7ak5bp`, since terminated), because `exec_on_node`
  admits only literal-output PowerShell, by design. The only replace anywhere near this window, at
  `1790197286132`, was a single one during the pre-deploy restarts, not a loop.
- **Check 3 — the `reset_node_connection` fallback (step 6, tool half) PASSES.** At
  `1790211835000` the tool returned `{reset: true}`. `app.log` then shows `Resetting worker node
  connection` (…836005), `Worker WebSocket closed`, and a re-register 1.1 s later with `Node
  re-registered within disconnect grace — treating as continuous session`, `Node registered`, and
  `Durable stream resume completed`. The node was not revoked: it stayed listed and needed no
  re-pairing. Two `sendResponse: requesting socket is no longer active` warnings followed. Those are
  responses to requests that arrived on the socket just closed, and they are expected. The
  `relay_not_forwarding` half (steps 1–5) and the Settings button half are still open (see status).
- **Check 4 — PASS.** `browser.list_targets {computer: "windows-pc", refresh: true}` straight after
  the reset (audit `502ffab3…`) succeeded. All 10 live tabs have `lastConfirmedAt` ≈ `1790211862440`,
  26 s after the reset, and none carries `stale: true`. Rows marked `status: "closed"` are stale
  registry entries for tabs already gone, and are expected.

## Status — 2026-09-27

Open: 0 · Closed: 5 · Failed: 0

The agent-accessible old-worker and Settings assertions are now closed. The live extension-only
`relay_not_forwarding` branch and the human CAPTCHA solve were moved to
[RES-023](2026-09-27-livetest-human-external-residuals_livetest.md#res-023--reload-browser-gateway-v0237-and-confirm-lt-658-live),
where the required Windows extension reload and operator step are already owned. They are not
represented here as passed.

## Evidence run — 2026-09-27 (isolated current coordinator plus archived pre-fix worker)

- **Check 1 — PASS.** A disposable worker built from archived commit `fbe537ae` paired to an
  isolated current coordinator on loopback as node
  `213f0001-8f7a-4f13-a2f7-cc42af081bc0`. A second post-open `connect()` reproduced the historical
  stale-close race without touching `windows-pc`. `app.log` records replaces at
  `1790496787005`, `1790496790708`, `1790496794005` and `1790496798024`. On the fourth replace the
  coordinator emitted exactly one `Worker node connection flap storm detected` with
  `rule: "slow"`, one `Worker node flap reset — closing the new connection once after registration`,
  then `Resetting worker node connection` with `reason: "Flap reset"`. The worker re-registered at
  `1790496806031`, 8.0 s later. No further replace occurred through `1790497471665`, 11 m 13 s
  after the reset. A contemporaneous `browser.health` also reported the real `windows-pc` channel
  `fresh`, `commandsDeliverable: true`, and no active connection-flap storm.
- **Check 3 — fallback path PASS; incident-specific branch moved.** The 2026-09-24 tool reset was
  complemented by the real Settings path in the isolated rendered app. **Settings → Remote Nodes →
  Computers → Reset connection** was visible for the connected historical worker. Clicking it at
  `1790497188100` logged `Resetting worker node connection` with
  `reason: "Operator reset connection"`, closed only that socket, and re-registered the same node
  at `1790497191034` (2.9 s) with the disconnect-grace and durable-resume events. The node remained
  enrolled and required no pairing. The `relay_not_forwarding`-specific health/recovery branch
  needs a live Windows extension relay in that exact incident state and is now in RES-023.
- **Check 5 — agent preparation attempted; operator branch moved.** The agent served controlled
  v3-only and visible-v2 pages containing Google's public test key and routed the attempt explicitly
  to `windows-pc`. Health was initially `fresh`, but `browser.find_or_open` timed out before opening
  the page; the follow-up health read showed the extension channel `silent`, and the sanctioned
  `browser.recover_extension` attempt timed out after 60.5 s with unchanged contact timestamps.
  No click/evaluate was dispatched and no CAPTCHA was solved. The controlled-page assertions plus
  the mandatory human checkbox solve are now part of RES-023 after the v0.2.37 reload.
