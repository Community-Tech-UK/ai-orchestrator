# Remote Browser Automation — Design & Plan

**Status:** IMPLEMENTED & verified. Path 1, Settings UI (Tiers 1–3), and the
Path 2 CDP-tunnel gateway integration are complete. The original full gateway
port remains future work. Operator guide:
`docs/remote-browser-automation-runbook.md`.
**Date:** 2026-06-09

## Shipped

- **Path 1** — worker owns a managed Chrome (remote-debugging, dedicated profile)
  and injects `chrome-devtools` MCP into spawned agents; capability reporting +
  routing prefer browser-ready nodes.
- **Settings UI Tier 1** — per-node readiness badge (Ready / Chrome only / Off).
- **Settings UI Tier 2** — per-node enable toggle + profile/headless fields via a
  privileged `config.update` coordinator→node RPC (service-scoped); worker applies,
  persists, reconfigures Chrome, and re-reports capabilities live.
- **Settings UI Tier 3** — guided one-time profile login: copy a platform-tailored
  launch command, or **Run on node** via the terminal RPC (Chrome opens on the
  node's screen; injection-guarded command builder).
- **Path 2 CDP tunnel** — browser profiles can bind to a remote node and the
  coordinator's existing browser gateway drives that node's Chrome through a raw
  CDP tunnel while keeping stores, approval, grant, audit, and driver logic on
  the coordinator.
- **Stage 4 hardening** — explicit WebSocket payload ceilings, oversized reverse
  CDP frame rejection, worker send-path backpressure handling, CDP teardown on
  worker disconnect/reconnect, and remote profile runtime cleanup on tunnel
  browser disconnect.
**Author:** (planning session with James)
**Related:** `docs/superpowers/specs/2026-05-03-browser-gateway-design_completed.md` (declared remote-worker browser access a v1 non-goal)

---

## 1. Problem

The `browser.*` gateway tools only run on the machine hosting the Electron app (the
Mac). When work is offloaded to a remote node (e.g. `windows-pc`), the spawned agent
gets **no** browser tools — `spawn-config-builder.ts:234` and `:261` explicitly return
`null` for `executionLocation.type === 'remote'`. So an agent on the Windows box "can't
touch Facebook" even though that box has Chrome and (potentially) the logged-in session.

James's expectation was that remote control would let browser automations run on the
Windows machine. The capability registry *advertises* `hasBrowserRuntime` / `hasBrowserMcp`
(`worker-node.types.ts`), and the coordinator already routes "browser intent" jobs toward
`hasBrowserRuntime` nodes (`worker-node-registry.ts:118`) — so it *looks* supported, but no
code path delivers browser tools to a remote agent.

## 2. Key architectural fact

**In every design, the browser-driving code must execute on the node that owns the Chrome
session.** You cannot drive a remote Chrome from the Mac without code running next to it,
because (a) the logged-in cookies live in that Chrome's profile and (b) CDP binds to
loopback (confirmed in the spike — see §3). The only real question is *who calls the
browser*: an agent running **on** the node (local call) or an agent on the Mac reaching
**across** the network (transparent forwarding).

The existing gateway is already split at a clean RPC seam: agent → stdio forwarder
(`aio-mcp browser-gateway`) → JSON-RPC `browser.<method>` → `BrowserGatewayRpcServer`
(`browser-gateway-rpc-server.ts:121`, plain `net.createServer`). That seam is reusable; the
hard part is making a **server** run on the worker.

## 3. Spike results (2026-06-09, executed on `windows-pc`)

Non-destructive CDP feasibility probe (temp profile, killed after):

| Check | Result |
|---|---|
| Chrome | **148.0.7778.217** at `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| Node / npx | **v24.11.0 / 11.12.1** (modern, present) |
| CDP launch + `/json/version` round-trip | ✅ **SUCCESS** — `--headless=new --remote-debugging-port=9222` returned a live `webSocketDebuggerUrl` |
| `npx -y chrome-devtools-mcp@latest --help` | ✅ fetches & runs; flags: `--browserUrl`, `--wsEndpoint`, `--userDataDir`, `--executablePath`, `--isolated`, `--headless`, `--channel` |
| Existing real profiles | `Default`, `Profile 1`, `Profile 2`, `Profile 3` — a logged-in session exists to reuse |
| CDP port binding | **loopback-only** — `127.0.0.1:9222` LISTENING; LAN attempt to `192.168.0.199:9222` refused |
| Tunnel availability | **Tailscale present** (`100.113.93.104`) → a tunnel for Mac→Windows CDP is feasible |

**Verdict:** the lightweight `chrome-devtools-mcp`-on-the-node path is viable today. Node,
npx, Chrome, and CDP all work; the MCP package runs unmodified.

## 4. Two paths

### Path 1 — `chrome-devtools-mcp` on the node (RECOMMENDED, near-term)

The agent spawned on `windows-pc` is given a `chrome-devtools-mcp` MCP server that drives a
worker-local Chrome. No AIO-gateway port required. Delivers James's overnight use case.

- **Pro:** small, proven by the spike, no network round-trips per click, Mac stays free.
- **Con:** bypasses the AIO gateway's approval/grant/audit governance (chrome-devtools-mcp
  has none); browser ops are only available to agents *running on the node*, not to
  Mac-resident agents.

### Path 2 — Port the AIO gateway to the worker (heavyweight, later)

Run `BrowserGatewayService` + Puppeteer driver + extension native host + stores inside the
worker process, preserving approval/grant/audit. Optionally add a `browser.<method>` RPC
family to the coordinator↔node protocol so the **Mac's** `browser.*` tools can transparently
drive the remote Chrome (the literal "Mac tools → Windows Chrome" James pictured).

- **Pro:** full governance parity; network-transparent option.
- **Con:** large. Requires Electron-decoupling, an sqlite-in-worker decision, and a Windows
  native-host/extension install that can't be fully scripted.

**Recommendation:** ship **Path 1** now; treat **Path 2** as a follow-up only if governance
(approvals/audit) on remote browser actions becomes a hard requirement, or if a Mac-resident
agent genuinely needs to reach remote Chrome.

---

## 5. Path 1 — implementation plan

### Injection point (verified)

The worker spawns CLIs in `LocalInstanceManager.spawn` and passes `params.mcpConfig`
straight to `createCliAdapter` (`src/worker-agent/local-instance-manager.ts:126-137`). The
coordinator sends an empty `mcpConfig` for remote instances, so the worker must **build and
append its own** chrome-devtools MCP entry here.

### Tasks

1. **Worker-side browser-MCP config builder.**
   New `src/worker-agent/browser-mcp-injection.ts` that returns an MCP server spec for
   `chrome-devtools-mcp`. Two modes (configurable):
   - **(a) MCP-launched Chrome** — let `chrome-devtools-mcp` own Chrome via
     `--userDataDir <automation-profile> --executablePath <chrome>` (or `--isolated` for a
     throwaway profile). Simplest.
   - **(b) Worker-managed Chrome** — worker launches a persistent Chrome with
     `--remote-debugging-port` + a chosen profile and passes `--browserUrl http://127.0.0.1:<port>`.
     Better when a single long-lived logged-in session is shared across turns.
   Resolve `chrome.exe` from the same paths as `capability-reporter.ts:detectBrowser()`.

2. **Wire it into the spawn path.**
   In `local-instance-manager.ts:spawn`, when browser automation is enabled for this node,
   append the builder's output to `params.mcpConfig` before `createCliAdapter`. Gate behind a
   worker config flag (default off) so plain nodes are unaffected.

3. **Automation profile / session story.**
   - Document the **profile-lock constraint**: Chrome locks a `user-data-dir`, so the
     automation Chrome cannot share a profile directory with the user's running everyday
     Chrome. Use a **dedicated automation profile** logged into the target site (BinsOut
     Facebook) once, or a copy of an existing profile.
   - Provide a one-time "log in the automation profile" helper/runbook (launch the
     automation Chrome non-headless once so the human can log in + clear 2FA).

4. **Capability reporting.**
   Set `hasBrowserMcp: true` in `capability-reporter.ts` when the worker has browser
   automation configured (currently hard-coded `false` at line 39). This lets the coordinator
   route browser-intent work to genuinely browser-*capable* nodes, not just Chrome-installed
   ones.

5. **Coordinator routing tighten-up.**
   In `worker-node-registry.ts`, prefer/require `hasBrowserMcp` (not just `hasBrowserRuntime`)
   when `requiresBrowser` is set, so jobs don't land on a node that has Chrome but no MCP.

6. **Settings + UI.**
   Per-node toggle "Enable browser automation on this node" + profile path + headless choice.
   Persist in node config; surface the automation-profile login runbook from the UI.

7. **Security posture (explicit).**
   `chrome-devtools-mcp` has **no approval/grant/audit layer** — it can do anything in that
   Chrome. Restrict to trusted/owned nodes; consider requiring `yoloMode`/an explicit opt-in
   flag; never point it at a profile holding sensitive non-target logins. Document this clearly.

8. **Spam/ban guardrails (product, not infra).**
   For the Facebook-commenting use case specifically: rate-limit posting, randomize timing,
   cap volume per window. Posting many business comments quickly is exactly what trips
   platform spam detection and risks the asset. (Carried over from the original session.)

### Verification

- `npx tsc --noEmit` + `-p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`.
- Spawn an agent on `windows-pc` via `run_on_node`; confirm it now exposes
  `mcp__chrome-devtools__*` tools and can navigate + read a benign page.
- Confirm a plain node (flag off) is unchanged (no chrome-devtools MCP injected).
- Confirm the automation Chrome does not collide with the user's everyday Chrome (profile lock).

### Worker-isolation hazard (must respect)

The worker is a plain Node process. Per the known "workers crash on transitive electron
imports" hazard, `browser-mcp-injection.ts` and anything it imports must **not** pull in
`electron` (directly or via a barrel). Keep it dependency-light (build a config object;
spawn via the existing adapter path).

---

## Path 2 — chosen architecture: CDP tunnel (supersedes §6 below)

**Decision:** rather than port the gateway to the worker (§6 — sqlite, Electron
decouple, worker native-host), tunnel **raw CDP frames** over the existing worker
connection and `puppeteer.connect({ transport })` to a remote-backed `Browser`.
The **entire gateway (stores, approval, grant, audit, driver) stays on the Mac** —
which also resolves §6b's "approval UI is on the Mac while the browser is remote"
concern, since approval *should* live with the human on the Mac.

Verified: puppeteer-core 22.15 supports a custom `ConnectionTransport`.

### Stage 1 — CDP tunnel (IMPLEMENTED & verified)
- Protocol: `browser.cdp.open/send/close` (coordinator→node, service-scoped) +
  `browser.cdp.message/closed` (node→coordinator, trusted high-frequency stream).
- Worker `WorkerCdpTunnel`: reuses the Path 1 `WorkerBrowserManager` Chrome, opens
  a `ws` to its browser-level CDP endpoint, relays frames both ways. Dispatcher
  cases are service-scoped; `WorkerAgent` forwards frames + tears down on disconnect.
- Coordinator `RemoteCdpTransport` (buffers pre-`onmessage` frames) +
  `RemoteCdpTunnelClient` (session routing via registry events) +
  `connectBrowser(nodeId)` → puppeteer `Browser`.
- `rpc-event-router` routes the reverse channel to `remote:browser-cdp-*` events.
- Tests: transport buffering/send/close, client session routing + teardown, worker
  relay (open/send/close/error/idempotency), dispatcher scope enforcement.

### Stage 2 — gateway integration (IMPLEMENTED & verified)
The driver depends on its launcher only via `launchProfile`/`getBrowser`/
`closeProfile`, so a **`RoutingBrowserLauncher`** drops in at that seam:
- `BrowserProfile.executionNodeId` (contract type + migration 038 +
  `profileStore.setExecutionNode`) binds a profile to a node.
- `RemoteBrowserConnector` connects/holds/releases a puppeteer `Browser` for a
  node-bound profile via the Stage 1 tunnel client; it `disconnect()`s (never
  `close()`s) so the node's Chrome keeps running, navigates the start URL, and
  mirrors runtime state into the profile store.
- `RoutingBrowserLauncher` routes per profile (remote vs local); the driver,
  stores, approval, grant, and audit are **completely unchanged** — they operate
  on a `Browser`.
- `getPuppeteerBrowserDriver()` now uses the routing launcher.
- Tests: routing dispatch (local/remote, getBrowser/close, failed-connect
  un-mark), connector (connect/get/close, disconnect-not-kill, start-URL nav,
  reconnect, runtime-state resilience), profile-store migration 038 round-trip.

### Stage 3 — UI + lifecycle (IMPLEMENTED & verified)
Bind a browser profile to a node (node picker); surface remote-profile status;
choose the node for `browser.*` work. Implemented through
`BrowserProfile.executionNodeId`, the browser page profile-node controls, and
the routing launcher.

### Stage 4 — hardening (IMPLEMENTED & verified)
Large-frame backpressure / coordinator-WS `maxPayload` for big CDP results
(screenshots), per-node teardown on disconnect, send-path optimization
(notification instead of request/response per frame), and reconnect semantics.
Implemented with shared CDP frame/payload constants, byte-based CDP schema
validation, coordinator and worker WebSocket `maxPayload`, reverse-frame drop
guards in `RpcEventRouter`, worker send backpressure handling that closes the
affected CDP tunnel, worker CDP `closeAll()` on coordinator socket close, and
remote profile runtime-state cleanup when a tunneled browser disconnects.

---

## 6. Path 2 (original) — full gateway port (NOT pursued; see CDP tunnel above)

Superseded by the CDP-tunnel architecture. Retained for context. Only revisit if
the **extension-based real-Chrome sharing** (vs a dedicated automation profile)
becomes a hard requirement on remote nodes.

**6a. Make the gateway portable (the bulk of the work).**
- Core `browser-gateway-service.ts` is already clean (imports only `node:path` + stores).
- **Electron-coupled files** to decouple / inject paths into: `index.ts`,
  `browser-gateway-rpc-server.ts`, `browser-profile-registry.ts` (they import `electron`).
- **sqlite-backed stores** (`browser-grant-store`, `browser-approval-store`,
  `browser-audit-store`, `browser-profile-store`) use `better-sqlite3`, which the worker
  doesn't have. Decide: ship sqlite to the worker, or re-back these on the worker's existing
  store (lmdb), or a JSON store.
- **Chrome extension + native messaging host** (`prepareBrowserExtensionNativeHostRuntime`):
  install the extension + register the native host in Windows Chrome. **One-time manual step
  on the node — cannot be fully scripted.** This is the only way to share the *real*
  authenticated everyday Chrome rather than a dedicated automation profile.
- Stand up `BrowserGatewayRpcServer` (already a portable `net.createServer`) on a worker-local
  socket; inject the `aio-mcp browser-gateway` forwarder into worker-spawned agents
  (mirror of the Mac path in `spawn-config-builder.ts`, but executed worker-side).

**6b. Network-transparent forwarding (optional — the literal "Mac tools → Windows Chrome").**
- Add a `browser.<method>` RPC family to `COORDINATOR_TO_NODE` + a Zod schema in
  `rpc-schemas.ts` (`COORDINATOR_TO_NODE_PARAM_SCHEMAS`) + a `case` in
  `worker-rpc-dispatcher.ts`. The **terminal.*** methods are the exact implementation
  template.
- Point the Mac's browser forwarder at a chosen remote node.
- Extra problems Path 1 avoids: screenshots/snapshots are large base64 payloads over the
  wire (need chunking or size caps); **approval/grant/audit UI lives on the Mac coordinator
  today while the browser is remote** — must decide where the human approval surfaces.
- Alternatively, skip the RPC family and tunnel CDP directly over Tailscale (spike showed
  Tailscale is present) — but that exposes a raw debugging port and still bypasses governance.

---

## 7. Decision log / open questions

- **Profile reuse vs dedicated automation profile** — dedicated profile is simpler and
  avoids the profile-lock collision; reusing `Default` requires the user's Chrome to be
  closed. Recommend dedicated.
- **Headless vs headful** — headless=new works (spike), but some sites behave differently
  headless; headful on the node is fine since the node runs unattended.
- **Governance** — Path 1 has none. Acceptable for a single trusted overnight job; not
  acceptable as a general capability. Revisit Path 2 if scope grows.
