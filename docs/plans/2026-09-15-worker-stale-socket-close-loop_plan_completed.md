# Worker stale-socket close loop breaks Browser Gateway delivery — plan

Status: **implemented and verified in-loop 2026-09-15**; live checks deferred to
[2026-09-15-worker-stale-socket-close-loop_livetest.md](2026-09-15-worker-stale-socket-close-loop_livetest.md). See §6 for as-built notes.
Owner incident: windows-pc (`bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`), 2026-09-15 19:08:58Z onward.

## 1. What happened (evidence)

All times UTC. Coordinator log = `~/Library/Application Support/harness/logs/app.log`.
Audit rows = `browser_audit_entries` in `rlm/rlm.db`.

| Time | Evidence |
|---|---|
| 18:38:06 → 19:06:56 | Harness quit (`shutdown.ndjson` `electron-before-quit`) and relaunched. This is the "MCP disconnect" the session saw; the session was native-resumed 19:07:56. |
| 19:07:10 | windows-pc registered once, from LAN `192.168.0.199`. Clean. |
| 19:08:20–19:08:58.163 | list_targets, find_or_open, screenshot, a11y snapshot, click, type all `succeeded` (audit). |
| 19:08:58.711 | `Worker WebSocket closed` code **1006**, `sessionMs 108542`. |
| 19:08:59.920 | Re-registered from Tailscale `100.113.93.104`; `Worker stream epoch changed` 1789474590009 → **1789499339399** (= `workerAgent.startedAt`) — a new worker process. |
| 19:09:01.107 | First `Replacing existing socket for nodeId`. Then every 16–32 s, still running at 20:15 (159 replacements; gaps 2,5,7,13, then 16–32 s). One address, one epoch throughout. |
| 19:10:29 → now | Every extension command `browser_extension_command_not_delivered`, "last contacted 8–24s ago". `recover_extension` refused `incident_not_confirmed`. |
| 20:15 (reproduction) | `list_targets refresh:true` → `inventory refresh FAILED … not_delivered — extension last contacted 15s ago`; every tab `lastConfirmedAt ≤ 19:08:58.142` (audit `6a7d2776-e60e-43c2-b4f6-90ea11ef9eec`). |

Zero `Worker node connection flap storm detected` warnings: the detector needs 10 replaces in 60 s
(`worker-node-connection.ts:41-42`); this storm runs at ~2.5/min.

## 2. Root cause

**A single worker process is stuck in a self-sustaining reconnect loop caused by an unscoped
socket `close` handler.** Reproduced deterministically in a vitest harness (real `WorkerAgent`,
mocked `ws`/discovery): after each coordinator 1001 on the *replaced* socket, the worker's
current socket is still open but `this.ws === null`, `registrationAccepted === false`, and
`sendRequest` fails `worker_not_registered`; a new socket opens and the cycle repeats.

1. `tryConnect()` attaches a `close` handler to every socket
   (`src/worker-agent/worker-agent.ts:312-331`). It unconditionally sets `this.ws = null`,
   `registrationAccepted = false`, stops heartbeat, rejects pending requests and calls
   `scheduleReconnect()` — even when the closing socket is **not** `this.ws`.
2. When the worker opens socket N+1 while N is still open, the coordinator replaces N and closes
   it with 1001 (`src/main/remote-node/worker-node-connection.ts:563-568`). N's close handler on
   the worker wipes the reference to the healthy N+1 and schedules another reconnect.
3. The timer opens N+2 while N+1 is still open at the transport level → the coordinator replaces
   N+1 → N+1's close wipes N+2 … forever. Backoff never resets because no connection survives
   60 s (`reconnect-backoff.ts:18-24`), so it settles at 15–30 s — matching the observed gaps.

**Why delivery fails while "last contacted" stays fresh:**

- The relay stamps its own `lastExtensionContactAt` when the extension's poll arrives over the
  pipe, *before* forwarding (`src/worker-agent/worker-extension-relay.ts:228-231`).
- The forward uses `WorkerAgent.sendRequest`, which rejects with `worker_not_registered` /
  `coordinator_not_connected` (`worker-agent.ts:413-419`); `forwardPollCommand` swallows it and
  returns `null` (`worker-extension-relay.ts:263-271`), so the extension sees "no command" and
  keeps polling. No poll ever reaches the coordinator, so queued commands hit the undelivered
  deadline (`browser-extension-command-store.ts` undelivered timeout).
- The fresh relay timestamp reaches the coordinator inside each re-registration's capabilities
  (`worker-agent.ts:202-208`), and health takes `max(coordinator-observed, relay-reported)`
  (`src/main/browser-gateway/browser-health-service.ts:535-537`). Hence an age that is always
  less than one reconnect interval.

**Why `recover_extension` refused:** it accepts only `silent` (contact > 90 s) **and**
`lastDisconnect.reason === 'native_host_stdin_eof'`
(`src/main/browser-gateway/browser-extension-recovery-operation.ts:104-111`). Neither holds, and
the relay/native host/extension are healthy anyway — recovering them would not help.

### Not verified (worker-side logs unreadable this session)

- **What opened the second socket at 19:09:01.** The only code path found that opens a socket while
  one is open: `connect()` starts continuous mDNS discovery *before* `this.ws` is assigned
  (`worker-agent.ts:211`), and the discovery callback calls `scheduleReconnect()` whenever
  `!this.ws` (`worker-agent.ts:718-724`); `connect()` has no "already open" guard
  (`worker-agent.ts:194-197`). Separating test: `worker-agent.log` on windows-pc should show
  `Coordinator re-discovered at …, reconnecting...` between 19:08:59 and 19:09:01, followed by
  `Coordinator socket closed {code:1001, reason:'Replaced by new connection'}` +
  `Reconnecting in …` each cycle.
- **Why the previous worker process died at 19:08:58.7** (1006, ~550 ms after a successful
  `browser.type`). Needs `worker-supervisor.log` / `worker-agent.log` around 19:08:58.
- Blockers: `exec_on_node` admits only literal `Write-*`/`curl https` (`run-on-node-exec-policy.ts:121-131`),
  cursor/antigravity are not signed in on windows-pc, and its Copilot seat is EBRD-only.

## 3. Changes

### 3.1 Worker: scope socket handlers to the socket (root fix)

`src/worker-agent/worker-agent.ts`
- In the `close` and post-open `error` handlers of `tryConnect`, return early (log
  `stale coordinator socket closed; ignoring`) when `ws !== this.ws`.
- In `open`: if `this.ws` is another OPEN socket, close the old one with 1000
  `superseded by worker` **after** detaching it (`this.ws = ws` first), so its close is ignored.
- `handleMessage`: take the source socket; ignore registration responses whose socket is not
  `this.ws` (a late response for a superseded socket must not flip `registrationAccepted`).
- `connect()`: return early when `this.ws?.readyState` is OPEN or CONNECTING.
- Discovery callback: do not `scheduleReconnect()` while `this.connecting` is true.

### 3.2 Coordinator: break loops from unfixed workers (Mac-only deploy)

The Windows worker is hard to redeploy, so the coordinator must be able to end this loop alone.
`src/main/remote-node/worker-node-connection.ts` + `connection-flap-detector.ts`
- Add a slow-storm rule next to the fast one: ≥4 replaces within 5 min with an unchanged
  stream epoch (`noteNodeEpoch`) ⇒ storm. Emit the single WARN + `node:flap-storm` event.
- On a slow storm, once: after sending the registration response, close the **new active** socket
  with a dedicated code (e.g. 4010 `flap reset`). Reasoned from the current worker code, not yet
  tested: its handler clears the (already null) ref and finds the reconnect timer armed; the next
  connect finds no active socket, so no replace and no stale close — the loop ends. The first
  implementation step is a spec proving this against the unmodified worker. Rate-limit to one reset per
  node per 10 min and log it.
- Add a non-revoking "reset connection" action (IPC + orchestrator MCP tool). Today the only
  UI disconnect is Revoke (`src/main/ipc/handlers/remote-node-handlers.ts:239-248`), which also
  revokes the session.

### 3.3 Browser Gateway health, errors and recovery

- Keep the two contact clocks separate. Expose `relayContactAgeMs` (extension→relay, from
  capabilities) and `coordinatorPollAgeMs` (poll RPCs actually seen, `extensionContactState`).
  Use `coordinatorPollAgeMs` for delivery freshness and in `not_delivered` messages
  ("extension polled the relay 15s ago; the coordinator has not received a poll for 67m").
- New channel state `relay_not_forwarding`: relay contact fresh, coordinator poll age > 90 s.
  Include the node's current flap-storm flag and replace count in `browser_health`.
- `recover_extension`: accept `relay_not_forwarding` as a confirmed incident, but recover by
  triggering the §3.2 connection reset (not an extension/native-host restart), then wait for a
  fresh **coordinator-observed** poll. Keep the existing `native_host_stdin_eof` path unchanged.

### 3.4 CAPTCHA parking (separate defect)

Verified: on shared (extension) tabs the classifier sees **only** the caller's `actionHint`
(`browser-gateway-action-guard.ts:534-541`), matched by substring `includes('captcha')`
(`browser-action-classifier.ts:45,226,437`). Both parked clicks had agent-written hints:
`"Enable the reCAPTCHA Enterprise API in the Comtech project"` (293dc7ec…) and
`"Submit the TEST - IGNORE contact enquiry (reCAPTCHA observe check)"` (889c9f58…). No page
challenge was detected. `browser.evaluate` passes a fixed `classificationOverride`
(`browser-gateway-service.ts:1426-1439`), so it never runs the CAPTCHA/2FA rules; it still needs a grant.

Decisions for James (numbered). Resolved 2026-09-15 on the recommendations: 1 and 3 implemented; 2 is
subsumed (the remaining own-label match uses a word boundary). See §6.4.
1. Stop classifying CAPTCHA from agent-authored `actionHint` text; require element/page evidence
   (reCAPTCHA/hCaptcha/Turnstile challenge iframe or checkbox widget, not the invisible v3 badge).
   Recommended.
2. Until 1 lands, at least use word-boundary matching so "reCAPTCHA" in a descriptive hint is not
   a challenge. (Weaker; still hint-based.)
3. Run the same page-level challenge check for `browser.evaluate`, so JS cannot be used to act on
   a live challenge that `click` would park. Recommended; the current bypass looks incidental to
   the override, not a stated intent.

## 4. Tests

- `src/worker-agent/__tests__/worker-agent.spec.ts`: replaced-socket 1001 close does not clear the
  active socket or registration; `sendRequest` still works; no reconnect scheduled. Discovery
  `onUp` during an in-flight connect does not produce a second socket. (Scratch repro from the
  diagnosis session: startup `onUp` → second socket → 6 loop cycles; must fail before 3.1.)
- `connection-flap-detector.spec.ts`: slow-storm rule; epoch change does not count.
- `worker-node-connection` spec: slow storm triggers exactly one reset close; rate-limited.
- Health/recovery specs: `relay_not_forwarding` classification; message shows both ages;
  `recover_extension` accepts it and uses the connection reset.
- Classifier specs: "reCAPTCHA Enterprise API" hint is not a challenge; a real challenge element is.

## 5. Verification gates

Targeted specs, then the canonical checklist in `AGENTS.md` (`tsc` ×2, `lint`,
`check:ts-max-loc`, `build:main`, `build:renderer`, `test:quiet`). `build:aio-mcp-dist` for the
gateway changes.

Live checks (require rebuilt Harness and a redeployed windows-pc worker) are in
`2026-09-15-worker-stale-socket-close-loop_livetest.md`: worker restart produces no
`Replacing existing socket` after 60 s; coordinator reset ends a storm from an old worker build;
`browser_health` / `recover_extension` on `relay_not_forwarding`; `list_targets refresh` returns
non-stale; CAPTCHA parking on a real challenge page.

## 6. As-built (2026-09-15)

### 6.1 Worker (`src/worker-agent/worker-agent.ts`)
- `close` / post-open `error` handlers ignore a socket that is not `this.ws`
  (`Stale coordinator socket closed; ignoring`).
- `open` detaches the previous socket first, resets per-connection state (heartbeat, pending requests,
  CDP sessions), then closes the old socket with 1000 `Superseded by worker`.
- `handleMessage(raw, source)` ignores registration results/errors from a superseded socket.
- `connect()` returns early while a socket is OPEN/CONNECTING; the discovery callback does not schedule
  a reconnect while `connecting`.
- File-transfer summary helpers moved to `worker-file-transfer-summary.ts` (LOC ceiling).
- Proof: new specs in `__tests__/worker-agent.spec.ts` failed before the fix (6 sockets in 60 s; replaced
  1001 close wiped the live socket) and pass after. Two older specs called `connect()` on an agent with an
  injected fake open socket; they now build a fresh agent (the guard is the intended behaviour).

### 6.2 Coordinator
- `worker-connection-flap-monitor.ts` owns both rules (fast 10/60 s unchanged; slow ≥4 live-socket
  replaces / 5 min with an unchanged `capabilities.streamEpoch`). One WARN + `node:flap-storm` per storm.
- Slow storm ⇒ `resetNodeConnection(nodeId, 'Flap reset')` closes the NEW socket with 4010 after its
  registration response. At most one reset per node per 10 min; a persisting storm gets another attempt
  after the interval.
- Pre-implementation proof against the unmodified worker (HEAD `worker-agent.ts` copied into a scratch
  module, fake coordinator mirroring `handleRegistration`, both close orderings): without reset 57 sockets
  in 20 min (~2.5/min, matching the incident); with a reset at the 4th replace the loop ends at 6 sockets
  and the worker's `ws` is the live, registered socket. Scratch files deleted.
- Non-revoking reset surfaces: IPC `remote-node:reset-connection` (+ preload, renderer service,
  **Reset connection** button beside Revoke in Settings → Remote Nodes) and orchestrator MCP tool
  `reset_node_connection` (exact node name/id only; deferred, searchable). `worker-node-connection-control.ts`
  also now hosts the connected-node resolver `exec_on_node` used inline.

### 6.3 Browser Gateway
- `classifyRemoteExtensionContact` (`browser-extension-node-contact.ts`) keeps the clocks separate:
  `fresh` (coordinator poll ≤ 90 s), `relay_not_forwarding` (relay fresh, coordinator stale — or no poll
  seen more than 90 s after registration), `silent`. `isRemoteExtensionContactFresh` now means coordinator
  delivery freshness, so stale flags and find_or_open prechecks no longer trust the relay clock.
- Messages: `extension polled the relay 15s ago; the coordinator has not received a poll for 67m (worker is
  not forwarding polls; browser.recover_extension resets the node connection)`. Healthy/silent wording is
  unchanged.
- `browser_health` nodes add `channelState`, `coordinatorPollAgeMs`, `relayContactAgeMs`,
  `connectionFlap`; `relay_not_forwarding` makes `commandsDeliverable` false and adds a warning.
- `recover_extension` accepts `relay_not_forwarding`: calls the connection reset (no worker relay RPC) and
  succeeds only on a coordinator-observed poll newer than the reset. Result gains `recoveryAction`
  (`connection_reset` | `extension_relay`); the `native_host_stdin_eof` path is unchanged.

### 6.4 CAPTCHA (decisions 1 and 3)
- Classifier: agent-hint-derived context (`elementContextSource: 'agent_hint'`, shared tabs) is never CAPTCHA
  evidence. Inspected elements count only via challenge iframe / response-token markers or a whole-word
  "captcha" in the element's own label/name (not nearbyText, so the v3 disclosure text and `reCAPTCHA`
  hints do not match).
- `browser-page-challenge-probe.ts`: before `browser.click` and `browser.evaluate` (including evaluate's fixed
  override), a read-only probe detects a visible reCAPTCHA v2 / hCaptcha / Turnstile widget with an empty
  response token (invisible badge excluded). Shared tabs use the existing `read_control` command (one call
  when no widget; 4 s timeout so it is a fast probe; skipped when the remote channel is not fresh); managed
  tabs evaluate a fixed expression. Probe failure is fail-open (`unavailable`), classification then uses
  element evidence only. Payment/identity hard stops stay stronger.
- `pageChallengeProbe: null` disables the probe for dispatch-counting test fakes (same pattern as
  `persistenceSentinel`); `makeService` defaults it off and new specs opt in with `'default'`.

### 6.5 Verification (in-loop)
- Targeted specs: worker-agent (47), remote-node (482 + new), MCP (425), browser-gateway (1386 + new).
- `tsc --noEmit` and `-p tsconfig.spec.json`: clean except `src/renderer/app/core/state/provider-quota.store.ts`,
  which is another session's uncommitted work in this tree (not touched here).
- `npm run lint`, `check:ts-max-loc`, `build:main`, `build:aio-mcp-dist`: pass.
- `build:renderer`: fails in this tree only on that same provider-quota file; passes in a `/tmp` copy with the
  other session's non-main files restored to HEAD (proves the Settings template/component changes compile).
- Full `npm run test:quiet`: 2088 files, 24800 tests passed. An earlier run failed 422 tests in
  `orchestrator-tools-step.spec.ts` because `worker-node-connection-control.ts` imported the server/registry
  directly, which bypassed that spec's barrel mock; the helper now takes injected `{ server, registry }`.
- Fresh-eyes completion gate (independent agent): `VERDICT: PASS`. Disclosed residual risk: the CAPTCHA probe
  fails open, so a live challenge on a shared tab can go undetected while the probe errors or the remote
  channel is stale.
