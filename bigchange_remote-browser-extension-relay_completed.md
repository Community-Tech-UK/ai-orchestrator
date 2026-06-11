# Bigchange: Remote Browser-Extension Relay (Route 2)

**Date:** 2026-06-10
**Status:** IMPLEMENTED — automated verification passed 2026-06-11; manual two-machine Chrome E2E still requires a remote host
**Goal:** Let the Browser Gateway's `browser.*` tools drive the user's **real, logged-in Chrome session on a remote machine** by relaying the Browser Gateway extension transport through `worker-agent`, over the existing coordinator↔worker WebSocket.

---

## 1. Problem & Motivation

Google (Play Console et al.) blocks logins in automation-launched browsers. The
Browser Gateway extension is the only transport that shares the user's *real*
everyday Chrome cookies — but its entire chain is local-only:

```
Chrome extension → native host (aio-mcp native-host)
  → Unix socket (<userData>/bg-*.sock) → BrowserGatewayRpcServer (Electron main)
```

On a remote node there is no Electron app, so the extension has nothing to talk
to. The remote worker currently only offers managed Chrome over the CDP tunnel
("Path 2", `remote-browser-connector.ts`), which is a separate AIO profile, not
the user's real session.

**This plan = "Path 3":** extension on the remote machine → native host →
worker-agent local socket → WS RPC relay → coordinator `BrowserGatewayService`.
All governance (approvals, grants, audit, redaction, origin policy) stays on
the coordinator, identical to the local extension path.

## 2. Current Protocol (what we're relaying)

The extension protocol is **small and pull-based** — only 3 RPC methods,
which makes this far simpler than the CDP tunnel (no opaque frame stream):

| Method (native host → gateway) | Purpose | Shape |
|---|---|---|
| `browser.extension_attach_tab` | Register/update a tab (push, on tab events + periodic alarm; also batched via `tab_inventory`) | `{ extensionToken, extensionOrigin?, payload: BrowserAttachExistingTabRequest }` |
| `browser.extension_poll_command` | Long-poll for queued commands | `{ ..., payload: { timeoutMs? } }` → `BrowserExtensionQueuedCommand \| null` |
| `browser.extension_command_result` | Ack/resolve a command | `{ ..., payload: { commandId, ok, result?, error? } }` |

**Poll timing budget (verified):** the extension polls with
`timeoutMs = 10_000` (`background.js:3`); the native host's per-call socket
RPC has a hard **15 s timeout** (`browser-extension-native-host.ts:320`); the
command store merely *clamps* requests to 25 s (`command-store.ts:106`) —
nothing ever polls that long. **The 15 s native-host timeout is the
end-to-end ceiling** for the entire relay chain.

Key current-code facts (verified by direct read, 2026-06-10):

- Native host: `src/main/browser-gateway/browser-extension-native-host.ts` —
  spawned fresh by Chrome per `connectNative()`, reads socket path + token from
  `AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG` env (runtime.json), 4-byte-LE-framed
  JSON on stdio, line-delimited JSON-RPC on the socket. **Opens a NEW socket
  connection per RPC call** (`sendExtensionRpc`, `:313-357` — connect, one
  request, one newline-terminated response, end). The file is **already
  electron-free**: imports only `node:fs`/`node:net`/`node:process`,
  `@contracts/types/browser`, and a *type-only* import from
  `browser-extension-native-runtime.ts`.
- The extension `background.js` buffers tab reports in a bounded `outbox` and
  re-queues on **native-port send failure only** (`:18, :91-110`) — it does
  NOT retry `{ok:false}` responses, so error-shaped relay replies are final
  (see Phase 2's coordinator-disconnected behavior, which is designed around
  exactly this).
- Server dispatch: `browser-gateway-rpc-server.ts:157-275` — `browser.extension_*`
  methods validated by exact `extensionToken` match (`:374-382`); everything
  else is MCP-client traffic keyed by `instanceId`.
- Command store: `browser-extension-command-store.ts` — **one global FIFO
  queue** + `pending Map<commandId>` with 30 s default timeout. `pollCommand()`
  shifts from the single queue. ← *the* multi-extension hazard.
- Tab store: `browser-extension-tab-store.ts` — attachments keyed by
  `targetId` derived from `existing-tab:${windowId}:${tabId}`. ← tab/window IDs
  **collide across machines**.
- Service routing: `browser-gateway-service.ts` ops (snapshot `:757`,
  navigate `:676`, click, screenshot…) check `extensionTabStore.getTab()` first,
  else fall through to the puppeteer driver. We reuse this unchanged.
- Target registry: `browser-target-registry.ts` — global, no node field.
- Extension assets: in-repo at `resources/browser-extension/` (MV3, fixed key,
  ID `jbkobgefdoglecnehdhfpgjamiginjfo`), loaded unpacked/sideloaded manually.
- Runtime installer: `browser-extension-native-runtime.ts` — writes
  runtime.json (0600), wrapper script (0700) exec'ing
  `"<aioMcpCliPath>" native-host`, and the Chrome NativeMessagingHosts
  manifest (+ Windows registry key). **Already electron-free and already
  parameterized** (corrected, 7th pass): it takes `userDataPath` as an option
  (`:17-18, :42`); the `app.getPath('userData')` lookup lives in the *caller*
  (`browser-gateway-rpc-server.ts:106`). The only remaining coupling to the
  local deployment is the `aioMcpCliPath` option — the wrapper hardcodes
  `<exe> native-host` with no room for leading args (`:124, :136`).
- ⚠️ The native-host manifest name is a **fixed constant**
  (`BROWSER_EXTENSION_NATIVE_HOST_NAME = 'com.ai_orchestrator.browser_gateway'`,
  `:6`) and the manifest path is `<chromeNativeMessagingDir>/<name>.json` —
  one install per Chrome user profile, last-install-wins. See risk 10.

Worker RPC layer facts (verified):

- WS JSON-RPC 2.0, max payload 80 MB, backpressure 32 MB
  (`rpc-schemas.ts:12-14`).
- The **coordinator** fully supports answering node→coordinator requests:
  `rpc-event-router.ts:109-175` validates a per-request session token
  (`params.token`), validates against `RPC_PARAM_SCHEMAS`, and replies via
  `connection.sendResponse()`.
- ⚠️ **But the worker has NO request/response correlation today**
  (`worker-agent.ts:473-519`): the only response it consumes is the
  registration reply (`pendingRegistrationId`); all other responses are
  silently dropped. Existing "requests" like `sendPermissionRequest`
  (`worker-instance-notifier.ts:170-183`) are fire-and-forget with synthetic
  ids. **The poll relay needs the response**, so Phase 2 must add a
  pending-request map to the worker (this is new infrastructure, not reuse).
- All node→coordinator requests must include the session token in `params`
  (`getToken()`), exactly as the notifier does.
- CDP tunnel is the wiring template: constants in `worker-node-rpc.ts`, Zod
  per-method schemas in `rpc-schemas.ts:296-343`, worker dispatch in
  `worker-rpc-dispatcher.ts:86-411` (scope `'service'`), coordinator routing in
  `rpc-event-router.ts:181-248` → `registry.emit('remote:…')`.
- **Electron-import isolation**: worker build (tsconfig.worker.json) crashes on
  any transitive top-level `import 'electron'`. `src/main/browser-gateway/` is
  NOT in the worker include list and must not be imported wholesale.
- Worker config: `worker-config.ts:72-94` (`~/.orchestrator/worker-node.json`),
  hot-updatable via `config.update` RPC. Capabilities:
  `capability-reporter.ts:24-64`.

## 3. Architecture Decision

**Semantic relay, not frame relay.** The CDP tunnel relays opaque frames
because CDP is a huge protocol. The extension protocol is 3 stable methods —
relay them as **typed, Zod-validated RPC methods**, matching codebase
conventions and letting the coordinator tag node identity per call.

**Pull model preserved end-to-end.** The extension long-polls its local native
host → worker forwards the poll as a node→coordinator RPC request → coordinator
blocks on the (node-scoped) command queue. No coordinator→worker push methods
needed for the data path at all. One in-flight poll per remote extension
(10 s cycle) is negligible WS traffic.

**Trust model.** The worker generates its **own** local `extensionToken` and
validates it before forwarding — the coordinator's local token is never shared.
Coordinator attributes relayed calls to the `nodeId` of the authenticated WS
connection (node token, constant-time compared — existing `auth-validator.ts`).
Rate limiting keyed `extension:node:${nodeId}` instead of origin string.

```
REMOTE MACHINE                                COORDINATOR (Electron main)
┌──────────────┐  native msg  ┌─────────────┐
│ Chrome + ext │─────────────▶│ native host │   (worker-agent native-host
└──────────────┘   (stdio)    │  (process)  │    subcommand — NOT aio-mcp)
                              └──────┬──────┘
                              unix socket/pipe
                              ┌──────▼────────────┐   WS JSON-RPC    ┌─────────────────────────┐
                              │ WorkerExtension-  │─ ext.attachTab ─▶│ RpcEventRouter          │
                              │ Relay (in worker- │─ ext.pollCmd ───▶│  → RemoteExtension-     │
                              │ agent service)    │─ ext.cmdResult ─▶│    Bridge → existing    │
                              └───────────────────┘                  │    tab/command stores   │
                                                                     │    (node-scoped)        │
                                                                     │  BrowserGatewayService  │
                                                                     │  approvals/grants/audit │
                                                                     └─────────────────────────┘
```

## 4. Implementation Phases

### Phase 0 — Make host code worker-buildable (smaller than first thought)

Verified: `browser-extension-native-host.ts` is **already electron-free**
(node builtins + `@contracts/types/browser` + a type-only runtime-config
import). So no big extraction is needed for the host loop itself.

1. Add `src/main/browser-gateway/browser-extension-native-host.ts` to the
   `tsconfig.worker.json` include list (deep file include, like
   `worker-node-rpc.ts` — do NOT include the browser-gateway barrel).
   Alias note: its `@contracts/types/browser` import is safe — the worker is
   **bundled** by esbuild with `tsconfig: 'tsconfig.worker.json'`
   (`build-worker-agent.ts:13`), and that config `extends: './tsconfig.json'`
   so the `@contracts` paths are inherited (verified); `paths` resolve at
   build time;
   Packaging Gotcha #1's runtime-resolver trap does not apply to the worker.
   (Conversely: `external: ['electron', ...]` means a stray electron import
   builds fine and only crashes at runtime — which is why the isolation spec
   in step 4 matters.)
2. The **runtime installer** (`browser-extension-native-runtime.ts`) needs
   far less than first written (corrected on the 7th pass): the file is
   **already electron-free** (`node:fs`/`node:os`/`node:path`/`child_process`
   only) and **already takes `userDataPath` as an option** — the
   `app.getPath('userData')` lookup is in the caller
   (`browser-gateway-rpc-server.ts:106`). No split, no core extraction, no
   Electron wrapper. The only real change: generalize `aioMcpCliPath` →
   `hostCommand: { exe: string; args?: string[] }` so the wrapper can emit
   `node <dist>/worker-agent/index.js native-host` in dev and the SEA binary
   path in service installs (today the wrapper hardcodes
   `"<aioMcpCliPath>" native-host`, `:124, :136`). Update the existing
   coordinator call site and keep `browser-extension-native-runtime.spec.ts`
   green. Add the file to `tsconfig.worker.json` includes alongside the host.
3. **Audit the import closure** anyway (type-only imports are fine; watch for
   future regressions and barrels, per `worker-electron-import-isolation`
   memory).
4. Add an import-isolation spec modeled on
   `src/main/instance/__tests__/context-worker-import-isolation.spec.ts`
   walking the closure of the worker-included browser-gateway files.

### Phase 1 — RPC vocabulary

`src/main/remote-node/worker-node-rpc.ts` — add to `NODE_TO_COORDINATOR`:

- `BROWSER_EXT_ATTACH_TAB = 'browser.ext.attachTab'` (request → result)
- `BROWSER_EXT_POLL_COMMAND = 'browser.ext.pollCommand'` (request → `BrowserExtensionQueuedCommand | null`)
- `BROWSER_EXT_COMMAND_RESULT = 'browser.ext.commandResult'` (request → `{ ok: true }`)

**Timing:** the worker forwards the extension's `timeoutMs` (10 s today) to
the coordinator's `pollCommand`, and sets its own WS request timeout to
`timeoutMs + 3 s`. Total must stay under the native host's hard 15 s socket
timeout — clamp forwarded `timeoutMs` to 10 s in the Zod schema to keep
headroom for WS round-trip latency.

Coordinator→node: **none required** for the data path. Optionally
`BROWSER_EXT_STATUS` later (e.g. force-expire), skip for v1.

`src/main/remote-node/rpc-schemas.ts` — add Zod schemas to
`RPC_PARAM_SCHEMAS` (coordinator-side inbound validation):

- `BrowserExtAttachTabParamsSchema` — reuse/wrap the existing
  `BrowserAttachExistingTabRequestSchema`; bound `text` (≤ 120 KB) and
  `screenshotBase64` (≤ 2 MB) explicitly, matching tab-store truncation.
- `BrowserExtPollCommandParamsSchema` — `{ timeoutMs?: number (0–10_000), extensionOrigin?: string }` (see timing note above).
- `BrowserExtCommandResultParamsSchema` — `{ commandId: string, ok: boolean, result?: unknown, error?: string }`, bounded result size.

### Phase 2 — Worker side

**Prerequisite (new infrastructure, verified missing):** worker-agent has no
request/response correlation — `handleMessage` (`worker-agent.ts:473-519`)
consumes only the registration response and silently drops all others.
Add a `sendRequest(method, params, timeoutMs): Promise<unknown>` helper on
`WorkerAgent`: `pending = new Map<id, { resolve, reject, timeout }>()`, ids
prefixed (e.g. `ext-<seq>`), resolved in `handleMessage`'s response branch
before the registration check, all rejected on disconnect. Id safety
(verified): existing synthetic ids are namespaced by prefix (`reg-`, and the
notifier's `sc-`/`exit-`/`perm-` sharing one `seq` counter,
`worker-instance-notifier.ts:20`) — `ext-<seq>` with its own counter is
collision-free; the pending map must match exact ids so fire-and-forget
responses still fall through harmlessly. Include the session
token in `params` (as `worker-instance-notifier.ts:170-183` does). This helper
is generally useful (future worker-initiated queries) and should get its own
unit spec.

**Reconnect ordering:** `sendRequest` must gate on *registration accepted*,
not merely *socket open* — after a reconnect the coordinator rejects requests
until `node.register` completes (per-request session-token validation in
`rpc-event-router.ts:113-122`). Follow the notifier's precedent
(`flushCriticalQueue()` runs only after registration is accepted,
`worker-agent.ts:515`): while unregistered, fail relay calls fast (the
extension's poll/outbox retry absorbs it) rather than queueing them.

New `src/worker-agent/worker-extension-relay.ts` (mirrors `WorkerCdpTunnel`
shape but is a socket **server**, not client):

- On `start()`: create Unix socket / named pipe; write runtime.json; install
  wrapper script + Chrome native-messaging manifest via the Phase 0 installer.
  Wrapper execs `<worker-agent-binary> native-host` (worker-agent gains the
  subcommand — avoids needing aio-mcp deployed on the remote machine).
  **Stability across restarts (Codex finding #2):** the native host reads
  runtime.json ONCE at spawn and Chrome keeps the native port (and host
  process) alive long-term — a relay restart with a fresh token/socket would
  strand the live native host on stale config until Chrome respawns it. So:
  use a **stable socket path** (fixed name under
  `~/.orchestrator/browser-gateway/`, perms 0600; on Windows a stable
  `\\.\pipe\…` name — note the coordinator randomizes its pipe name per boot,
  `browser-gateway-rpc-server.ts:403-404`, and pipes have no fs perms, so on
  Windows the persisted token is the *only* access guard) and **persist the
  32-byte-hex token** in the runtime dir, regenerating only on
  `uninstall-browser-extension` — unlike the coordinator's per-boot token.
- Socket handler: line-delimited JSON-RPC, **one connection per request**
  (verified: the native host connects, sends one request, reads one
  newline-terminated response, ends — `sendExtensionRpc`). So the handler is
  request-scoped: read line → validate local `extensionToken` → map the three
  `browser.extension_*` methods 1:1 onto the Phase 1 WS requests via the new
  `sendRequest` helper → write response line → end. No persistent-stream state.
  Coordinator-disconnected behavior (corrected per Codex finding #1 — the
  extension outbox only retries **native-port send failures**, NOT
  `{ok:false}` responses, so "fail quietly and it retries" is wrong).
  **Layer note (7th pass):** the relay speaks line-delimited JSON-RPC on the
  socket — it replies `{jsonrpc, id, result}` or `{jsonrpc, id, error}`; the
  *native host* converts those into the extension-facing envelopes
  (`{type:'browser_command', command: result ?? null}` for polls,
  `:112-115`; `{ok:false, error}` on rejection, `:234-239`, `:346-348`). So:
  - `poll_command` → reply JSON-RPC **success with `result: null`** after a
    short delay — never a JSON-RPC error (the host would surface `{ok:false}`
    and polling can wedge on unfixed extensions). The host turns `null` into
    `{ type: 'browser_command', command: null }`.
  - `attach_tab` → reply JSON-RPC error (host emits `{ok:false}`);
    acceptable, the periodic `tab_inventory` re-reports tabs on the next
    cycle anyway.
  - `command_result` → buffer briefly (a few seconds) and retry once on
    reconnect; if still down, drop it — the coordinator's pending command
    times out with a clean `browser_extension_command_timeout`, which is the
    correct failure surface for the calling tool.
- **Stable-socket lifecycle (scenario review, 2026-06-11):** on `start()`,
  if the stable socket path already exists, **probe-connect first** — a live
  responder means another worker process owns the relay (two workers on one
  machine, e.g. dev + service install): log, report `hasExtensionRelay:
  false`, do NOT start. A dead socket file must be **unlinked before
  `listen()`** (classic unix-socket `EADDRINUSE` pitfall — note the
  coordinator never hits it because it randomizes its path per boot).
  Unconditional unlink without the probe would steal a live relay's socket.
- **Extension poll-loop hardening (root fix, verified 2026-06-11):**
  `background.js` `handleNativeMessage` early-returns on any reply that is
  not `type:'browser_command'` **without resetting `pollInFlight` or
  scheduling the next poll** (`:157-165` vs `pollForCommand`'s
  `pollInFlight` guard `:192-194`) — so an `{ok:false}` poll reply stalls
  polling until the MV3 service worker recycles or the native port drops.
  This is a pre-existing bug (same wedge occurs locally today when the
  Electron app is closed), but the relay makes "host alive, gateway absent"
  a common state (relay disabled, worker stopped, cold start before first
  enable). Fix it in the extension as part of this change: treat any
  unexpected poll reply as `command: null` (reset `pollInFlight`,
  `scheduleNextPoll(POLL_IDLE_DELAY_MS)`). With this fix the chain
  self-heals from every "gateway absent" state within one poll/alarm cycle —
  the host opens a fresh socket connection per RPC, so no host restart is
  needed when the relay (re)appears.
- **Hot-disable semantics:** `config.update` → `enabled: false` calls
  `relay.stop()`: close the server, end in-flight request connections
  (request-scoped, so this is clean), keep manifest + token. The extension
  sees failed polls until re-enabled and recovers automatically per the
  hardening fix above. Re-enable = `start()` on the same path/token.
- `stop()/closeAll()`: close socket, **unlink the socket file**, remove
  runtime.json (leave manifest — cheap to keep; document `uninstall`
  subcommand as cleanup).

Wiring:

- `worker-config.ts`: add
  `extensionRelay?: { enabled: boolean; socketDir?: string }` to `WorkerConfig`;
  default disabled; hot-apply on `config.update`. ⚠️ **Codex finding #5:** the
  config-update path does NOT automatically cover new blocks —
  `ConfigUpdateParamsSchema` (`rpc-schemas.ts:244`) and `applyConfigUpdate`
  (`worker-agent.ts:360`, dispatched at `worker-rpc-dispatcher.ts:326`) each
  enumerate `browserAutomation`/`androidAutomation` explicitly. Extend all
  three with `extensionRelay`, plus the coordinator-side sender and renderer
  node-settings form.
- `worker-agent.ts`: construct relay in constructor (always, toggled by
  config like `WorkerBrowserManager`); start after WS connect; `closeAll()` on
  disconnect/shutdown.
- `worker-rpc-dispatcher.ts`: no new inbound *methods* (data path is
  worker-initiated), but its existing `CONFIG_UPDATE` case (`:326`) feeds
  `applyConfigUpdate`, which must learn the `extensionRelay` block per the
  finding above — the dispatcher's update-summary typing changes with it.
- `capability-reporter.ts`: add `hasExtensionRelay: boolean`
  (enabled && manifest installed && socket up). Include "extension seen
  recently" (last poll timestamp) for health surfacing.
- New CLI subcommands in `src/worker-agent/index.ts`:
  - `worker-agent native-host` — runs `runBrowserExtensionNativeHost()` (this
    is what Chrome spawns via the wrapper). ⚠️ **Parse this subcommand FIRST
    in `main()`**, before `parseServiceArgs`/config loading — today an unknown
    arg falls through to "run" mode, which would make every Chrome
    `connectNative()` spawn try to connect to the coordinator as a worker.
  - `worker-agent install-browser-extension` / `uninstall-browser-extension` —
    manifest/wrapper management + prints the unpacked-extension load
    instructions (`resources/browser-extension/` must be copied to the remote
    machine; print path expectations).
    ⚠️ **Coordinator-collision guard (7th pass, risk 10):** the manifest name
    is a fixed constant, so installing on a machine where the coordinator app
    also runs would overwrite *its* manifest (and the coordinator re-installs
    on boot, clobbering back — silent last-install-wins). Before writing, read
    any existing manifest; if its `path` points at a wrapper outside the
    worker's runtime dir, refuse with a clear message (allow `--force`).
  - **Wrapper exe resolution** (verified: the worker ships both as plain Node
    output, `build:worker-agent`, and as a Node SEA, `build:worker-sea` —
    contrary to an earlier note in this investigation): the installer's
    `hostCommand: { exe, args }` covers both — SEA binary path in service
    installs, `node <dist>/worker-agent/index.js` in dev. Resolve from
    `process.execPath`/argv at install time. Mirror aio-mcp's dispatcher
    convention: no `require.main === module` guard (misfires in bundles —
    see comment at `browser-extension-native-host.ts:363`).

### Phase 3 — Coordinator bridge

New `src/main/remote-node/remote-extension-bridge.ts` (coordinator side;
singleton `getRemoteExtensionBridge()`):

- `rpc-event-router.ts`: add request handlers for the three methods
  (these are *requests needing responses* — follow the permission-request
  handler pattern, not the notification pattern), delegating to the bridge
  with `nodeId` from the connection.
  ⚠️ **Async-handler gap (verified 2026-06-11):** every existing request
  handler is synchronous (`handleRpcRequest` is `void` with a sync
  `try/catch`, `:139-174`; `handleInstancePermissionRequest` replies
  inline, `:466-489`). The relay handlers — `pollCommand` especially, which
  must `await` the command store for up to 10 s before responding — are the
  **first async, deferred-response handlers** in this router. The sync
  `catch` will NOT see their rejections, so each handler must own its
  failure path: `void this.handleX(...).catch(err => sendResponse(rpcError))`
  (or equivalent), otherwise a thrown bridge error leaves the node's request
  to die by timeout instead of getting a clean error reply.
  (`sendResponse` itself is drop-safe if the WS closed mid-poll — it warns
  and returns, `worker-node-connection.ts:366-371`.)
- Bridge behavior:
  - `attachTab(nodeId, payload)` → namespace IDs (Phase 4), then
    `browserGatewayService.attachExistingTab()` with
    `provider: 'orchestrator'`, `extensionOrigin: payload.extensionOrigin`,
    `nodeId`. **How `nodeId` travels (explicit contract decision, 8th pass):**
    it is deliberately NOT added to the contracts wire type —
    `BrowserAttachExistingTabRequestSchema` is `.strict()`
    (`browser.schemas.ts:333-345`) and stays `nodeId`-free, so a relayed (or
    local-extension) payload claiming a `nodeId` is rejected at validation;
    node identity is server-assigned trust metadata, same logic as the
    `allowedOrigins` strip below. Instead add `nodeId?: string` to the
    gateway-internal `BrowserGatewayAttachExistingTabRequest`
    (`browser-gateway-service-types.ts:57-59`), and thread it through
    `attachExistingTab` — note its destructure
    `const { instanceId, provider, ...input } = request`
    (`browser-gateway-service.ts:313-315`) must pull `nodeId` out explicitly
    (or it leaks into `...input` and trips the store's input typing) and pass
    it to `extensionTabStore.attachTab(input, { nodeId })` (signature change,
    Phase 4). ⚠️ **Codex finding #3 (security):**
    `BrowserAttachExistingTabRequestSchema` permits `allowedOrigins`, and the
    tab store trusts it (`browser-extension-tab-store.ts:58`) — a compromised
    worker could attach a tab with an overbroad origin policy. The bridge
    must **strip `allowedOrigins` from the relayed payload** — stripping is
    sufficient, because when the field is omitted the tab store already
    derives the exact origin from the tab URL itself
    (`browser-extension-tab-store.ts:58, 137-143`); no new derivation code
    is needed. Never trust the worker's claim.
  - `pollCommand(nodeId, timeoutMs)` → `extensionCommandStore.pollCommand(queueKeyFor(nodeId), timeoutMs)`.
  - `commandResult(nodeId, payload)` → `extensionCommandStore.resolveCommand(payload)`
    (verify the commandId belongs to that node's queue — reject cross-node acks).
  - Rate-limit per `extension:node:${nodeId}`. ⚠️ Verified: the existing
    limiter is **private state inside `BrowserGatewayRpcServer`**
    (`:77-110, :393-395` — in-memory buckets, 30 req / 10 s), not a reusable
    service. Either extract a small shared sliding-window helper from the
    rpc-server (preferred — keeps one semantics) or give the bridge its own
    per-node bucket. Do NOT route bridge traffic through the rpc-server just
    to reuse its limiter. ⚠️ **Codex finding #6 — do NOT copy the 30/10 s
    default for `attachTab`:** one `tab_inventory` cycle fans out up to
    `MAX_INVENTORY_TABS` (40) sequential attach RPCs and would self-throttle
    legitimate traffic. Use per-method limits: `attachTab` sized above the
    inventory burst (e.g. 80/10 s), `pollCommand`/`commandResult` near the
    existing default.
- `node:disconnected` registry event → expire that node's tabs
  (tab store + target registry) and reject its pending commands with a clear
  `"remote node disconnected"` error.

### Phase 4 — Node-scoping the stores (the real refactor)

This is where the single-extension assumptions live; everything else is plumbing.

1. **Command store** (`browser-extension-command-store.ts`):
   - Replace the single `queue` array with `Map<queueKey, Command[]>` and
     per-key poll waiters. `queueKey = 'local' | node:<nodeId>`.
   - `sendCommand(request)` derives queueKey from the target attachment's
     `nodeId` (resolved before enqueue — add `queueKey` to
     `BrowserExtensionSendCommandRequest`). Verified: the single production
     enqueue path is `browser-existing-tab-operations.ts:205`
     (`existingTabOperations.sendCommand`), which **all** extension-tab ops
     (navigate, snapshot, click, type, select…) funnel through — that file
     carries the queueKey, not `browser-gateway-service.ts` itself. Its
     `BrowserExtensionCommandTarget` (`command-store.ts:19-24`) has no
     `nodeId` today.
   - `pollCommand(queueKey, timeoutMs)` — local RPC server passes `'local'`;
     bridge passes the node key. `pending` map stays global (commandIds are
     UUIDs) but records queueKey for the cross-node ack check.
   - Timeout semantics unchanged (30 s default).
2. **Tab store** (`browser-extension-tab-store.ts`):
   - Add `nodeId?: string` to `BrowserExistingTabAttachment`.
   - `attachTab(input: BrowserAttachExistingTabRequest)` (`:56`) gains a
     second param (or options object) carrying `{ nodeId?: string }` — kept
     OUT of the `input` wire type on purpose (see Phase 3's contract
     decision: the strict contracts schema stays `nodeId`-free).
   - **ID namespacing** to prevent cross-machine windowId/tabId collisions:
     local format unchanged (`existing-tab:${windowId}:${tabId}`); remote tabs
     get `existing-tab:n.${nodeId}:${windowId}:${tabId}` (and derived
     targetId). Verified low-risk: the format is constructed in exactly **one**
     prod site (`browser-extension-tab-store.ts:147`) and never string-parsed
     elsewhere (`rg "existing-tab:"` — only specs/test-helpers otherwise; all
     lookups go through the store by full ID). Still wrap it in a
     `makeExistingTabProfileId(nodeId|null, windowId, tabId)` helper, and
     update spec fixtures that hardcode the literal.
   - `expireNode(nodeId)` for disconnect cleanup.
3. **Target registry** (`browser-target-registry.ts` + `browser-types.ts`):
   - Add optional `nodeId?: string` (and human-readable `nodeName?`) to
     `BrowserTarget`; populated by `extensionTabStore.toTarget()`.
   - Verified: the registry has no public removal-by-predicate API (its only
     `delete` is internal) — add `removeByNodeId(nodeId)` (or equivalent) for
     the disconnect-cleanup path.
4. **Safe DTO / redaction** (`browser-safe-dto.ts`): pass `nodeId`/`nodeName`
   through to agent-visible target listings.

### Phase 5 — Tool surface (discoverability — the lesson from Route 1)

Route 1 taught us a fully-built capability that agents can't see might as well
not exist. So:

- `browser_list_targets` / `browser_find_or_open`: include `nodeId`/`nodeName`
  per target; add optional `nodeId` filter param. `find_or_open`'s
  open-new-tab path routes the `open_tab` command to the matching node's queue
  (default: local; explicit `nodeId` targets a remote extension).
  ⚠️ **Codex finding #7:** the current matcher searches ALL attached tabs
  before deciding to open (`browser-gateway-service.ts:513` →
  `findExistingTabCandidate`, `browser-gateway-target-utils.ts:5`) — the
  `nodeId` filter must be applied to the candidate set *before* matching, or
  an explicit remote request can silently bind to another machine's
  same-URL tab.
- `browser_health`: report connected extensions per node
  (`{ nodeId, nodeName, lastPollAt, tabCount }`).
- **Update tool descriptions** (`browser-mcp-tools.ts`) to state that tabs may
  live on remote nodes and how to target them.
- Mirror schema changes in `packages/contracts` (remember the three-place
  alias rule from Packaging Gotcha #1 if any new `@contracts/...` subpath is
  added — prefer extending existing `browser.types.ts`/schemas to avoid it).
  **Explicit contracts delta (8th pass):** the only contract-surface changes
  are *outbound* — `nodeId?`/`nodeName?` on agent-visible target/health
  shapes (target listings, `browser_health`) and the optional `nodeId` filter
  param on `browser_list_targets`/`browser_find_or_open`.
  `BrowserAttachExistingTabRequestSchema` deliberately does NOT gain `nodeId`
  (stays `.strict()` and `nodeId`-free — see Phase 3); the inbound node
  attribution lives only in the gateway-internal request type
  (`browser-gateway-service-types.ts`), which is not a contracts file.

### Phase 6 — Renderer UI (mostly deferrable — Codex finding #8)

The relay is fully usable once Phase 5 exposes node identity through the
MCP tools, so split this phase:

- **v1 (required):** node settings toggle for `extensionRelay.enabled`
  (without it the feature can't be turned on remotely) → `config.update`
  path extended in Phase 2. Lives in
  `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts`
  (verified: this component already carries the `browserAutomation`
  enable/draft form, `:399-408, :468` — mirror that pattern for
  `extensionRelay`).
- **v1.1 (deferrable):** browser-page grouping/badges per node, relay status
  display. Signals/OnPush per Angular conventions when built.

### Phase 7 — Verification

- Unit: command-store multi-queue (poll isolation, cross-node ack rejection,
  timeout per queue); tab-store namespacing + node expiry; bridge handlers
  (schema validation, node attribution); relay socket server (token reject,
  coordinator-down fallbacks); runtime installer parameterization.
- Import isolation spec (Phase 0) in CI.
- Integration: extend `browser-gateway-rpc-integration.spec.ts` with a fake
  remote source — assert a remote tab is listable, snapshot/click round-trips
  through the bridge path, and a local extension never receives remote
  commands (and vice versa).
- Gates: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`,
  `tsconfig.worker.json` build, `npm run lint`, `npm run check:ts-max-loc`,
  `npm run test`.
- Manual E2E: two machines (or two user accounts) — worker with relay enabled,
  unpacked extension loaded in the remote user's real Chrome, share a tab via
  the popup, then from the coordinator run `browser_find_or_open` →
  `browser_snapshot` → `browser_click` against it. Verify approvals fire on
  the coordinator UI.

## 5. Security Considerations

- Worker socket: 0600 perms + worker-local random token; same posture as the
  coordinator's local socket today. Be explicit about what that means
  remotely: any process running as the same user on the **remote** machine
  can read the persisted token and impersonate the extension (inject
  `attach_tab`, steal queued commands). That is the same-user trust model the
  local path already accepts, but document it: enable the relay only on
  trusted single-user machines — which matches the feature's premise (the
  user's own logged-in Chrome).
- Coordinator never shares its local extension token; node attribution comes
  from the WS connection's node token (`auth-validator.ts`, constant-time).
- All origin policy, grants, approvals, classification, redaction run on the
  coordinator exactly as for local tabs — remote tabs get no policy bypass.
- Payload bounds enforced in Zod at the WS boundary (text 120 KB, screenshot
  2 MB, result size cap) — well under the 80 MB WS ceiling, and prevents a
  compromised worker from memory-ballooning the coordinator.
- Cross-node ack check prevents one node resolving another node's commands.
- A relayed `attach_tab` must never set origin policy: the bridge strips
  `allowedOrigins` and derives it coordinator-side (Phase 3, Codex finding #3).
- Audit attribution (revised per Codex finding #4 — `BrowserAuditEntry` /
  audit store / result recorder have no `nodeId` field, and adding one means
  contracts + store + recorder + migration churn): for v1, node identity is
  **already implicit** in audit rows because remote profile/target IDs are
  namespaced (`existing-tab:n.<nodeId>:…`). Defer an explicit `nodeId` audit
  column to a follow-up; do not let it silently expand this change's scope.

## 6. Risks / Open Questions

1. **Worker request/response correlation is new infrastructure** — the relay's
   correctness rests on the new `sendRequest` helper (timeout handling,
   disconnect rejection, no id collisions with registration). Unit-test it
   hard; it's the one piece with no existing precedent on the worker side.
2. **Manual steps on a remote screen** — `browser_pause_for_manual_step` /
   `browser_request_user_login` for a remote tab requires a human (or screen
   share) at the remote machine. Document; possibly surface node name in the
   approval prompt so the operator knows where to go. (For Google Play
   specifically this is fine — you log in once on that machine, by hand,
   which is the whole point.)
3. **Extension distribution** — unpacked extension must be manually loaded on
   the remote Chrome and survives only while dev mode allows it. Acceptable
   for v1; packed .crx/enterprise-policy install is out of scope.
4. **Long-poll vs reconnect** — if the WS drops mid-poll the worker answers
   `null`; extension re-polls (10 s cadence). No command loss: commands stay
   queued on the coordinator side, so a dropped poll just delays delivery.
   Pending-command 30 s timeout gives ~2–3 remote poll cycles of slack; may
   need a bump for remote latency — make it configurable per queueKey if E2E
   shows flakiness. Note the whole relay chain must answer each poll within
   the native host's hard 15 s socket timeout (see §2 timing budget).
   One accepted edge: a command can **execute but lose its ack** (WS drops
   between execution and `command_result` delivery) — the coordinator
   reports timeout while e.g. the tab actually opened, and a caller retry
   can double-open. No idempotency guard in v1; the next `tab_inventory`
   surfaces the orphan tab within ≤1 min.
5. **Coordinator restart** — tab store and command store are in-memory for
   local AND remote alike (parity, no new handling needed): a restart drops
   attachments and pending commands; in-flight callers time out cleanly;
   remote tabs re-attach within ≤1 min via the extension's inventory alarm
   (the worker just keeps relaying — no worker-side state to rebuild).
6. **Native host spawn on Windows** — wrapper is a `.cmd`; worker-agent binary
   path must be stable (service install path). Remember cmd.exe quote-stripping
   (memory note) — wrapper passes no inline JSON, only env var, so we're fine,
   but verify on Windows.
7. **Per-node single queue assumes one extension per node** — if a remote
   machine runs multiple Chrome profiles with the extension, they'd share one
   queue and steal each other's commands, same as the local single-queue
   limitation today. Accept for v1; the queueKey design extends to
   `node:<id>:<origin>` later.
8. **Uninstall with a live native host** — `uninstall-browser-extension`
   removes manifest/runtime.json (and regenerates the token on reinstall),
   but a native host process already spawned by Chrome keeps its old config
   until its port drops. With the poll-loop hardening above this degrades to
   clean failed polls, not a wedge; the uninstall subcommand should print
   "reload the extension (or restart Chrome) to complete removal".
9. **Tab-inventory bandwidth** — verified: every periodic `tab_inventory`
   builds payloads with `includeText: true` (up to 120 KB page text per tab,
   capped at `MAX_INVENTORY_TABS`; screenshots only on explicit share). Over
   the WS that's potentially a few MB per inventory cycle per remote node.
   Acceptable for v1 (well under the 80 MB payload cap), but if it shows up
   in profiling, trim/strip `text` at the worker relay and let the
   coordinator's snapshot path fetch live text on demand (it already has a
   cache-or-live fallback).
10. **Same-machine coordinator/worker manifest collision (7th pass)** — the
    Chrome native-messaging manifest name is a fixed constant
    (`com.ai_orchestrator.browser_gateway`), one per Chrome user profile,
    last-install-wins. A worker relay installed on the coordinator's own
    machine silently steals the local extension (and the coordinator's boot
    re-install steals it back). Guarded by the install subcommand's
    refuse-unless-`--force` check (Phase 2); document "don't enable the relay
    on the coordinator's machine". Note Phase 7's two-user-account E2E option
    is safe — the manifest dir is per-user.

## 7. Optional Quick Win (separate, tiny): surface Route 1 to agents

Deliberately excluded from this change's scope but worth a decision: expose a
`browser.set_profile_execution_node` MCP tool (or mention remote-capable nodes
in `browser_health`) so agents can discover/use the already-built remote
managed-Chrome path. One file each in `browser-mcp-tools.ts`,
`browser-gateway-rpc-server.ts`, plus a spec update (the current spec asserts
profile lifecycle is NOT exposed — that assertion encodes the old decision and
must be consciously changed, not worked around).

## 8. Effort Estimate

| Phase | Scope | Est. |
|---|---|---|
| 0 | Worker-include host file + parameterize installer + isolation spec | 0.25 day |
| 1 | RPC constants + Zod schemas | 0.25 day |
| 2 | Worker `sendRequest` infra + relay + config + CLI subcommands + capability | 1.25 days |
| 3 | Coordinator bridge + router handlers + disconnect cleanup | 0.5 day |
| 4 | Store node-scoping + ID namespacing (single construction site, verified) | 0.75 day |
| 5 | Tool surface + contracts (incl. node-filtered matching) | 0.5 day |
| 6 | v1: settings toggle only (UI polish deferred to v1.1) | 0.25 day |
| 7 | Tests + 2-machine manual E2E | 1 day |

**Total: ~5 focused days.** Phases 0–4 are sequential; 5/6 can parallelize after 4.

> Reviewed 6×: two author verification passes against source (2026-06-10) +
> one independent Codex review (session 019eb3b3-0aa1-7650-9217-24708dcacc63);
> all 7 IMPORTANT findings from the Codex pass are incorporated above. A
> fourth fresh-eyes pass (2026-06-11, four parallel source re-verifications)
> confirmed every file:line claim and added three refinements: the
> `browser-existing-tab-operations.ts:205` enqueue site, the strip-only
> `allowedOrigins` fix (store self-derives when omitted), and the worker
> request-id namespace note. A fifth pass (2026-06-11) confirmed no source
> drift since verification (latest relevant commit 25c877df, Jun 10 16:23,
> predates the verification reads) and added the Phase 3 async-handler gap
> (router request handlers are all sync today; the relay handlers must own
> their async failure paths), the Windows stable-pipe-name caveat, and the
> tsconfig.worker.json `extends`-inherits-paths confirmation. A sixth pass
> (2026-06-11, adversarial scenario walkthrough: cold start, restarts,
> double-enable, uninstall, hot-disable, lost-ack, multi-user) found one
> root-cause bug — the extension poll loop stalls on non-`browser_command`
> replies (pre-existing locally, common remotely) — fixed via the Phase 2
> poll-loop hardening; plus stable-socket probe-then-unlink lifecycle,
> hot-disable semantics, the lost-ack/double-execute note (risk 4),
> coordinator-restart parity (risk 5), and the uninstall stale-host note
> (risk 8). A seventh pass (2026-06-11, fresh-eyes: 2 parallel source
> re-verifications + drift check — no relevant commits or working-tree
> changes since 25c877df) re-confirmed all worker/remote-node/store claims
> and the poll-wedge root cause (`{ok:false}` written at native-host
> `:234-239`), and corrected three things: Phase 0 step 2 was stale (the
> installer is already electron-free and already takes `userDataPath`; only
> the `hostCommand { exe, args }` generalization remains), the Phase 2
> coordinator-disconnected replies were specified at the wrong layer (the
> relay answers socket JSON-RPC `result: null` / error; the *host* builds
> the extension-facing envelopes), and a missed hazard was added as risk 10
> (fixed manifest name → same-machine coordinator/worker install collision,
> guarded in the install subcommand). An eighth pass (2026-06-11,
> cross-model review + source verification) addressed two gaps: the
> `nodeId` attach-path threading is now an explicit contract decision
> (contracts `BrowserAttachExistingTabRequestSchema` stays `.strict()` and
> `nodeId`-free — node identity is server-assigned via the gateway-internal
> `BrowserGatewayAttachExistingTabRequest`, threaded through the
> `attachExistingTab` destructure into `attachTab(input, { nodeId })`), and
> the Phase 6 v1 renderer item now names
> `remote-nodes-settings-tab.component.ts` directly (verified home of the
> existing `browserAutomation` config form).

## 9. File Inventory (new / modified)

**New:**
- `src/worker-agent/worker-extension-relay.ts` (+ spec)
- `src/main/remote-node/remote-extension-bridge.ts` (+ spec)
- worker import-isolation spec for the relay closure
- unit spec for `WorkerAgent.sendRequest` correlation

**Modified:**
- `src/main/remote-node/worker-node-rpc.ts`, `rpc-schemas.ts`, `rpc-event-router.ts`
- `src/shared/types/worker-node.types.ts` (`WorkerNodeCapabilities.hasExtensionRelay` — verified this is where the type lives)
- `src/worker-agent/index.ts`, `worker-agent.ts` (**+ `sendRequest` pending-map infra**), `worker-config.ts`, `capability-reporter.ts`
- `src/main/browser-gateway/browser-health-service.ts` (per-node extension status for `browser_health`, Phase 5)
- `src/main/browser-gateway/browser-extension-command-store.ts`, `browser-extension-tab-store.ts` (`attachTab` gains `{ nodeId? }`), `browser-target-registry.ts`, `browser-types.ts`, `browser-safe-dto.ts`, `browser-gateway-service.ts` (thread `nodeId` through the `attachExistingTab` destructure, `:313-315`), `browser-gateway-service-types.ts` (`nodeId?` on `BrowserGatewayAttachExistingTabRequest`, `:57-59`), `browser-existing-tab-operations.ts` (queueKey resolution — the single enqueue site, `:205`), `browser-extension-native-runtime.ts` (`aioMcpCliPath` → `hostCommand { exe, args }`; already electron-free, no split needed), `browser-mcp-tools.ts`, `browser-gateway-rpc-server.ts` (pass `'local'` queueKey; update installer call site)
- `packages/contracts/src/types/browser.types.ts` (+ schemas)
- `resources/browser-extension/background.js` (poll-loop hardening: treat
  unexpected poll replies as `command: null` — see Phase 2)
- Renderer:
  `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts`
  (+ `.html`/`.scss`) — v1 `extensionRelay.enabled` toggle, mirroring its
  existing `browserAutomation` form; `browser-page.component.ts` only in
  v1.1 (per Phase 6 split)
- `tsconfig.worker.json` (include `browser-extension-native-host.ts` + installer core)
