# Remote Nodes Settings — Design Spec

**Date:** 2026-04-04
**Status:** Approved
**Approach:** Flat settings keys + custom UI component + mDNS autodiscovery + hardened auth

## Overview

Add a "Remote Nodes" section to the Settings UI that lets users enable, configure, and monitor the remote worker node subsystem. The backend (WebSocket server, node registry, health monitoring, JSON-RPC 2.0) is already fully implemented. This spec covers: persistence of remote node config, the settings UI, mDNS autodiscovery, and security hardening.

## Goals

1. Users can enable/disable the remote node server from Settings
2. Configuration (port, host, namespace, TLS, offload preferences) persists across restarts
3. Auth tokens are encrypted at rest and manageable from the UI
4. Workers auto-discover the coordinator on the LAN via mDNS
5. Per-node identity with revocation replaces the single shared token model
6. Reconnect resilience with exponential backoff and coordinator-side rate limiting

## Non-Goals

- Full node monitoring dashboard (separate feature — this spec only includes a lightweight status line in settings linking to that dashboard)
- Cloud relay / cross-subnet discovery
- Per-node token expiry / automatic rotation schedules (v2)
- Mutual TLS / client certificate authentication (v2)

---

## 1. Data Layer

### 1.1 New AppSettings Keys

12 flat keys added to `AppSettings` in `src/shared/types/settings.types.ts`, persisted via `SettingsManager` (ElectronStore). Follows the existing flat-key pattern used by all other settings.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `remoteNodesEnabled` | `boolean` | `false` | Master switch — starts/stops the WebSocket server |
| `remoteNodesServerPort` | `number` | `4878` | WebSocket server port |
| `remoteNodesServerHost` | `string` | `'0.0.0.0'` | Bind address (`0.0.0.0` = all interfaces) |
| `remoteNodesEnrollmentToken` | `string` | `''` | Shared secret for first-time node enrollment. Auto-generated (64-char hex via `crypto.randomBytes(32)`) on first enable when empty. |
| `remoteNodesAutoOffloadBrowser` | `boolean` | `true` | Route browser-requiring tasks to capable remote nodes |
| `remoteNodesAutoOffloadGpu` | `boolean` | `false` | Route GPU-requiring tasks to capable remote nodes |
| `remoteNodesNamespace` | `string` | `'default'` | Cluster isolation — workers only connect to matching namespace |
| `remoteNodesRequireTls` | `boolean` | `false` | When true, server only accepts WSS connections |
| `remoteNodesTlsMode` | `'auto' \| 'custom'` | `'auto'` | Auto = self-signed cert generated in userData; Custom = user-provided cert/key paths |
| `remoteNodesTlsCertPath` | `string` | `''` | Path to TLS certificate file (PEM) for custom TLS mode |
| `remoteNodesTlsKeyPath` | `string` | `''` | Path to TLS private key file (PEM) for custom TLS mode |
| `remoteNodesRegisteredNodes` | `string` | `'{}'` | Encrypted JSON of registered node identities (encrypted via `safeStorage`) |

### 1.2 Token Encryption

- `remoteNodesEnrollmentToken` and `remoteNodesRegisteredNodes` are encrypted at rest using Electron's `safeStorage` API.
- On Linux where `safeStorage.isEncryptionAvailable()` may return false, fall back to plaintext with a warning icon in the UI.
- File permissions on the settings file set to `0o600` (owner read/write only).

### 1.3 RemoteNodeConfig Hydration

The existing in-memory `RemoteNodeConfig` in `src/main/remote-node/remote-node-config.ts` is hydrated from these `AppSettings` keys on app startup. A settings-change listener keeps it in sync when settings are modified at runtime.

### 1.4 DEFAULT_SETTINGS Additions

```typescript
// Remote Nodes
remoteNodesEnabled: false,
remoteNodesServerPort: 4878,
remoteNodesServerHost: '0.0.0.0',
remoteNodesEnrollmentToken: '',
remoteNodesAutoOffloadBrowser: true,
remoteNodesAutoOffloadGpu: false,
remoteNodesNamespace: 'default',
remoteNodesRequireTls: false,
remoteNodesTlsMode: 'auto',
remoteNodesTlsCertPath: '',
remoteNodesTlsKeyPath: '',
remoteNodesRegisteredNodes: '{}',
```

---

## 2. Per-Node Identity & Revocation

### 2.1 Enrollment Flow

The shared token is now an **enrollment token** — used once per worker for initial registration. After enrollment, each node gets its own unique token.

```
Worker                          Coordinator
  |                                  |
  |-- generate nodeId locally (UUIDv4) |
  |-- WS connect (enrollment token) -->|
  |-- rpc: node.register(nodeId,      |
  |        name, caps)             -->|
  |                                  |-- validate enrollment token
  |                                  |-- upsert: if nodeId exists, return existing token
  |                                  |--         if new, generate nodeToken (64-char hex)
  |                                  |-- store/update NodeIdentity
  |<-- rpc response: { nodeId, token } -|
  |                                  |
  |-- persist nodeId + token locally   |
  |-- reconnect using nodeToken ------>|
```

**Idempotent enrollment:** The worker generates its own `nodeId` (UUIDv4) on first run and persists it locally before connecting. If the worker crashes after the coordinator registers it but before it persists the response, it retries with the same `nodeId`. The coordinator performs an upsert — returning the existing token if the `nodeId` is already registered. This prevents orphaned ghost nodes.

### 2.2 NodeIdentity Type

```typescript
// Persisted identity (encrypted in AppSettings)
interface NodeIdentity {
  nodeId: string;        // UUID v4 — generated by the WORKER on first run, sent in register payload
  nodeName: string;      // Human-readable name from worker config
  token: string;         // Unique 64-char hex token for this node
  createdAt: number;     // Epoch ms
}
```

Stored as `Record<string, NodeIdentity>` (keyed by nodeId) in the `remoteNodesRegisteredNodes` setting (encrypted JSON string).

**Ephemeral state** (`lastSeen`, `latencyMs`, `activeInstances`) is tracked in-memory only by the `WorkerNodeRegistry` — NOT persisted to AppSettings. This avoids blocking the main thread with repeated encrypt+write cycles on every heartbeat.

### 2.3 Authentication Priority

1. Connection sends a token in the `Authorization` header during WebSocket upgrade
2. Coordinator checks against registered node tokens first (O(n) scan, n is small)
3. If no match, checks against the enrollment token
4. If enrollment token matches, this is a new node — run enrollment flow
5. If neither matches, reject with `UNAUTHORIZED` error

### 2.4 Revocation

- User clicks "Revoke" on a node in the UI
- Coordinator removes the `NodeIdentity` from `remoteNodesRegisteredNodes`
- If the node has an active WebSocket connection, it is immediately closed
- The revoked node's token is permanently invalid; it must re-enroll with the enrollment token

### 2.5 Enrollment Token Rotation

- "Regenerate" button generates a new enrollment token
- Existing registered nodes are NOT affected (they use their own node tokens)
- Only new enrollments require the new token
- Confirm prompt: "This will invalidate the enrollment token. Existing nodes are not affected."

---

## 3. IPC Channels

### 3.1 New Channels

Added to `IPC_CHANNELS` enum in `src/shared/types/ipc.types.ts`:

| Channel | Payload | Response | Description |
|---------|---------|----------|-------------|
| `REMOTE_NODE_REGENERATE_TOKEN` | `void` | `{ token: string }` | Generate new enrollment token, persist, update live config |
| `REMOTE_NODE_SET_TOKEN` | `{ token: string }` | `{ success: boolean }` | Set custom enrollment token (min 16 chars), persist |
| `REMOTE_NODE_REVOKE` | `{ nodeId: string }` | `{ success: boolean }` | Remove node identity, disconnect if active |
| `REMOTE_NODE_GET_SERVER_STATUS` | `void` | `{ status, address?, error?, authFailures, runningConfig? }` | Get current server state + effective runtime config for draft comparison |

### 3.2 Existing Channels (no changes needed)

- `REMOTE_NODE_LIST` — returns connected nodes
- `REMOTE_NODE_START_SERVER` — starts WebSocket server
- `REMOTE_NODE_STOP_SERVER` — stops WebSocket server
- `REMOTE_NODE_EVENT` — server-to-renderer push events (node connected/disconnected/updated)
- `SETTINGS_SET` — used for all settings changes

### 3.3 Server Lifecycle State Machine

The server lifecycle is managed by a state machine to prevent interleaving from the settings listener and manual UI restart actions:

```
stopped → starting → running → stopping → stopped
                  ↘ failed → stopped
```

Both the settings-change listener and the "Apply & Restart Server" UI action go through this state machine. Transitions are serialized — a start request while stopping queues until the stop completes.

A listener on `SETTINGS_SET` in the main process handles these side effects:

- `remoteNodesEnabled` changes to `true` → transition to `starting` → start WebSocket server + mDNS publish → `running` (or `failed`)
- `remoteNodesEnabled` changes to `false` → transition to `stopping` → stop server + mDNS unpublish → `stopped`
- `remoteNodesEnrollmentToken` is empty on first enable → auto-generate 64-char hex token, broadcast `SETTINGS_CHANGED` event to renderer so UI updates immediately
- Port/host/namespace/TLS changes do NOT auto-restart — the UI manages this via "Apply & Restart Server"

### 3.4 Preload Bridge Additions

```typescript
// Added to electronAPI.remoteNode in src/preload/preload.ts
regenerateToken(): Promise<IpcResponse>;
setToken(token: string): Promise<IpcResponse>;
revokeNode(nodeId: string): Promise<IpcResponse>;
getServerStatus(): Promise<IpcResponse>;
```

---

## 4. UI — Remote Nodes Settings Tab

### 4.1 Sidebar Registration

New entry in `NAV_ITEMS` in `settings.component.ts`:

```typescript
{ id: 'remote-nodes', label: 'Remote Nodes', group: 'Advanced' },
```

Placed first in the Advanced group (before Ecosystem). The `SettingsTab` type union gets `'remote-nodes'` added.

### 4.2 Component: `remote-nodes-settings-tab.component.ts`

Fully custom component (pattern matches `connections-settings-tab.component.ts`). Standalone, `OnPush`, signal-based.

### 4.3 Layout (top to bottom)

#### Header
```
Remote Nodes
Allow remote machines to connect as worker nodes.
```

#### Enable Toggle
- Toggle for `remoteNodesEnabled`
- Status line below: "Listening on 192.168.0.15:4878" / "Starting..." / "Failed: Port 4878 already in use" / "Stopped"
- Status fetched via `REMOTE_NODE_GET_SERVER_STATUS` IPC, refreshed on toggle and via `REMOTE_NODE_EVENT` push

#### Server Config (visible when enabled)
All fields use **local component signals** — not saved to AppSettings on input. Only persisted when "Apply & Restart Server" is clicked.

- **Port** — number input, min 1024, max 65535
- **Host** — text input, default `0.0.0.0`, hint: "Set to 0.0.0.0 to accept connections from other machines. Your LAN IP: **192.168.0.15**" (LAN IP resolved at component init via a simple IPC or reading from main process)
- **Namespace** — text input, hint: "Only workers with the same namespace will connect. Use to isolate dev/prod."
- **Require TLS** — toggle
- **TLS Mode** — select (auto/custom), visible when Require TLS is on
- **Auto-offload Browser** — toggle (saved immediately via `SETTINGS_SET`)
- **Auto-offload GPU** — toggle (saved immediately via `SETTINGS_SET`)
- **"Apply & Restart Server"** button — visible when port, host, namespace, or TLS settings differ from the running server config. Saves changed values to AppSettings, then calls `REMOTE_NODE_STOP_SERVER` + `REMOTE_NODE_START_SERVER`.

#### Auth Token (visible when enabled)
- **Enrollment Token** label with hint: "Share this with new worker nodes for first-time setup. Existing nodes are not affected by changes."
- Masked monospace input (dots by default), eye icon to reveal
- **Copy** button — copies token to clipboard
- **Regenerate** button — confirm prompt: "Generate a new enrollment token? Existing registered nodes are not affected." → calls `REMOTE_NODE_REGENERATE_TOKEN`
- **Set Custom** — link that switches to editable input (min 16 chars) with Save/Cancel → calls `REMOTE_NODE_SET_TOKEN`
- **Copy Connection Config** — generates and copies full `worker-node.json` content:
  ```json
  {
    "name": "my-worker",
    "authToken": "<enrollment-token>",
    "namespace": "<current-namespace>",
    "workingDirectories": []
  }
  ```
  No `coordinatorUrl` included since mDNS handles discovery. The WORKER_AGENT_SETUP.md docs note the manual URL override for environments where mDNS is blocked.

#### Registered Nodes (visible when enabled)
- Section header: "Registered Nodes" with count badge
- Per-node row: name, nodeId (truncated), last seen timestamp, **Revoke** button
- Empty state: "No nodes registered yet. Share the enrollment token with a worker to get started."

#### Connected Nodes Status
- Lightweight line: "**3** nodes connected" / "No nodes connected" — links to the node dashboard view (separate from settings)
- If any recent auth failures: "**2** connection attempts rejected (invalid token)" in warning style

### 4.4 Styles

Follow existing patterns from `connections-settings-tab.component.ts`:
- `.connection-card` for the server config and token sections
- `.status-badge` for node status (connected/degraded/disconnected)
- `.field-input`, `.field-label`, `.field-hint` for form fields
- `.btn-primary`, `.btn-danger` for actions
- Monospace font for token display

### 4.5 Error States

| Scenario | UI Behavior |
|----------|-------------|
| Enable toggle fails (EADDRINUSE) | Toggle reverts to off, error shown inline |
| Token regeneration fails | Error toast/inline message |
| Revoke fails | Error inline next to the node row |
| mDNS publish fails | Warning in status line: "Server running but not discoverable on LAN" |
| safeStorage unavailable (Linux) | Warning icon next to token: "Token stored without encryption on this platform" |

---

## 5. Autodiscovery via mDNS

### 5.1 Package

`bonjour-service` — pure TypeScript, no native dependencies, no electron-rebuild.

```bash
npm install bonjour-service
```

### 5.2 Coordinator: Discovery Service

New file: `src/main/remote-node/discovery-service.ts`

**Publish** when the WebSocket server starts:
```typescript
bonjour.publish({
  name: `orchestrator-${nodeId}`,
  type: 'ai-orchestrator',
  port: 4878,
  txt: {
    version: '1.0',
    namespace: 'default',
    auth: 'token',
  }
});
```

**Unpublish** on server stop or app shutdown (goodbye packets).

TXT records contain only: `version`, `namespace`, `auth` method hint. No secrets, no TLS fingerprint (passed out-of-band via Copy Connection Config).

### 5.3 Worker: Discovery Client

New file: `src/worker-agent/discovery-client.ts`

**Connection priority:**
1. `coordinatorUrl` set in `worker-node.json` → use directly, skip mDNS
2. Not set → mDNS browse for `_ai-orchestrator._tcp`, filter by namespace
3. Discovery timeout (10s) → log warning, retry on reconnect interval
4. Continuous discovery: keep browser running to detect coordinator restarts/IP changes

```typescript
const browser = bonjour.find({ type: 'ai-orchestrator' });
browser.on('up', (service) => {
  if (service.txt?.namespace === myNamespace && !isConnected()) {
    connectToCoordinator(service);
  }
});
browser.on('down', (service) => {
  logger.warn(`Coordinator ${service.name} disappeared`);
});
```

### 5.4 Namespace Isolation

Workers only connect to coordinators broadcasting a matching namespace. This prevents:
- Dev and prod instances on the same LAN from interfering
- Different users' orchestrators from cross-connecting

Namespace is soft isolation (not a security boundary) — auth tokens provide the actual access control.

### 5.5 Platform Considerations

- **macOS Sequoia+**: Triggers "wants to find devices on your local network" prompt. Add `NSLocalNetworkUsageDescription` to `Info.plist`.
- **macOS firewall**: "Accept incoming connections?" on first run. Code-signing reduces friction.
- **Enterprise networks**: Some block multicast. Manual `coordinatorUrl` fallback handles this.
- **Multiple interfaces**: `bonjour-service` handles via `multicast-dns` options.
- **Docker/WSL2**: mDNS may not cross virtual network bridges. Document manual URL override.

---

## 6. TLS Hardening

### 6.1 Auto Mode

When `remoteNodesRequireTls` is true and `remoteNodesTlsMode` is `'auto'`:

1. Check for `server.crt` and `server.key` in app userData directory
2. If missing, generate a self-signed 2048-bit RSA certificate (via Node.js `crypto` or `node-forge`)
3. Start HTTPS server with the cert, attach WebSocket to it
4. Workers connect with `rejectUnauthorized: false` (acceptable: app-level auth provides identity verification)

### 6.2 Custom Mode

When `remoteNodesTlsMode` is `'custom'`:

1. Read cert from `remoteNodesTlsCertPath` and key from `remoteNodesTlsKeyPath`
2. Validate that both files exist and are readable before starting the server
3. Mutual TLS (CA cert) is out of scope for v1 (listed in Non-Goals)

### 6.3 UI

- "Require TLS" toggle in Server Config
- "TLS Mode" select (auto/custom) visible when TLS is required
- Custom mode shows cert path and key path inputs (using the existing file-path input pattern)

### 6.4 WebSocket Hardening

- Max message size: 1MB (reject oversized frames before parsing)
- Max concurrent connections: 50 (configurable, prevents resource exhaustion)
- Connection origin validation: reject upgrade requests from unexpected origins when running with TLS

---

## 7. Reconnect Resilience

### 7.1 Worker: Exponential Backoff with Jitter

```typescript
const RECONNECT = {
  initialMs: 1_000,
  factor: 2,
  maxMs: 30_000,
};

function nextReconnectDelayMs(attempt: number): number {
  const exp = Math.min(
    RECONNECT.maxMs,
    RECONNECT.initialMs * RECONNECT.factor ** Math.min(attempt, 30),
  );
  // Equal jitter: 50%..100% of exp
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}
```

- Reset `attempt` to 0 after 60s of stable connection
- No hard retry cap — keep retrying indefinitely (daemon/service behavior)
- Log each retry with the delay for debugging

### 7.2 Coordinator: IP Rate Limiting

```typescript
const LIMIT = {
  windowMs: 60_000,
  maxAttemptsPerIp: 20,
  baseBanMs: 120_000,    // 2 minutes
  maxBanMs: 15 * 60_000, // 15 minutes
};
```

- Track connection attempts per IP in an in-memory sliding window
- Exceeding 20 attempts/min → temporary ban (120s, doubling on repeat, capped at 15min)
- Reject banned IPs at TCP level before auth processing (avoid CPU waste)
- Ban events surfaced in UI via auth failure count

---

## 8. Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `src/main/remote-node/discovery-service.ts` | mDNS publish/unpublish for coordinator |
| `src/main/remote-node/server-lifecycle.ts` | State machine for server start/stop transitions |
| `src/main/remote-node/ip-rate-limiter.ts` | Connection rate limiting per IP |
| `src/worker-agent/discovery-client.ts` | mDNS browse for workers |
| `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts` | Settings UI component |
| `src/renderer/app/core/services/ipc/remote-node-ipc.service.ts` | Renderer-side IPC service for remote node channels |

### Modified Files
| File | Changes |
|------|---------|
| `package.json` | Add `bonjour-service` dependency |
| `src/shared/types/settings.types.ts` | Add 12 keys to `AppSettings` and `DEFAULT_SETTINGS` (no metadata entries — tab is fully custom) |
| `src/shared/types/ipc.types.ts` | Add 4 new IPC channels |
| `src/shared/types/worker-node.types.ts` | Add `NodeIdentity` type, add `namespace` to relevant types |
| `src/shared/validation/ipc-schemas.ts` | Add Zod schemas for new IPC payloads (set token, revoke node) |
| `src/main/remote-node/remote-node-config.ts` | Add `namespace`, `registeredNodes` fields; hydrate from AppSettings; persist on change |
| `src/main/remote-node/worker-node-connection.ts` | Call discovery service on start/stop; integrate IP rate limiting; add WS hardening (max message size, max connections) |
| `src/main/remote-node/rpc-event-router.ts` | Add idempotent enrollment flow (upsert by worker-provided nodeId) |
| `src/main/remote-node/rpc-schemas.ts` | Update register payload schema for nodeId field |
| `src/main/remote-node/worker-node-rpc.ts` | Update register request/response types for enrollment |
| `src/main/remote-node/auth-validator.ts` | Two-tier auth: check node tokens first, then enrollment token |
| `src/main/ipc/handlers/remote-node-handlers.ts` | Add handlers for regenerate, set token, revoke, get server status |
| `src/main/core/config/settings-manager.ts` | Encrypt/decrypt token fields via safeStorage; set file permissions to 0o600 |
| `src/main/index.ts` | Wire settings-change listener for server auto-start/stop via lifecycle state machine |
| `src/preload/preload.ts` | Expose new IPC methods in `electronAPI.remoteNode` |
| `src/renderer/app/features/settings/settings.component.ts` | Add nav item, import, and @switch case for remote-nodes tab |
| `src/renderer/app/core/state/settings.store.ts` | Add computed for remote node settings |
| `src/worker-agent/worker-agent.ts` | Use discovery client before connecting; implement exponential backoff with jitter |
| `src/worker-agent/worker-config.ts` | Make `coordinatorUrl` optional, add `namespace`, add `nodeId`/`nodeToken` persistence |
| `build/entitlements.mac.plist` | Add `NSLocalNetworkUsageDescription` for mDNS on macOS Sequoia+ |
| `electron-builder.json` | Include plist entitlements for local network access |
| `docs/WORKER_AGENT_SETUP.md` | Update setup guide for mDNS discovery, enrollment flow, optional coordinatorUrl |

---

## 9. Future Enhancements (Out of Scope)

- Per-node token expiry and automatic rotation schedules
- Mutual TLS with client certificates
- Cloud relay for cross-subnet discovery
- Full node monitoring dashboard (CPU, memory, latency graphs)
- Node grouping / tagging for task routing
- Escalating ban notifications to the UI in real-time
- QR code / short-code pairing for fully zero-config setup (no manual token copy)

---

## 10. Review Notes

### Round 1 — Design Review
**Reviewed by:** Gemini 3 Pro, GitHub Copilot (GPT-5.3 Codex)

**Gemini verdict:** 9/10 — "The design is mature, secure by default, and prioritizes a clean user experience."

**Copilot verdict:** 6/10 — Directionally strong but needs hardening.

**Copilot concerns (addressed in hardening pass):**
- Per-node identity added (was single shared token)
- TLS posture strengthened (require option + auto-cert)
- Reconnect resilience added (backoff + rate limiting)
- Secret leakage mitigated (safeStorage + file permissions)
- Schema migration handled by existing SettingsManager patterns

### Round 2 — Spec Review
**Reviewed by:** Gemini 3 Pro, GitHub Copilot (GPT-5.3 Codex)

**Issues found and fixed:**
1. `lastSeen` heartbeat disk I/O — separated persistent identity from ephemeral state (Gemini)
2. Orphaned node race condition — made enrollment idempotent via worker-generated nodeId + upsert (Gemini)
3. Missing TLS cert/key path settings keys — added `remoteNodesTlsCertPath` and `remoteNodesTlsKeyPath` (Both)
4. Missing macOS plist/entitlements in files-to-modify — added (Both)
5. Missing validation schemas in files-to-modify — added `ipc-schemas.ts`, `rpc-schemas.ts` (Copilot)
6. Missing renderer IPC service — added `remote-node-ipc.service.ts` (Copilot)
7. Dual lifecycle control paths — added server lifecycle state machine (Copilot)
8. `GET_SERVER_STATUS` missing runtime config — added `runningConfig` to response for draft comparison (Copilot)
9. Auto-generated token not pushed to renderer — clarified `SETTINGS_CHANGED` broadcast (Gemini)
10. Invalid JSON comment in snippet — removed (Copilot)
11. WebSocket hardening — added max message size, max connections, origin validation (Copilot)
12. Dropped mutual TLS/CA from Section 6.2 — already listed as v2 non-goal (Copilot)
13. Added `server-lifecycle.ts`, `ip-rate-limiter.ts` to new files list
14. Added `docs/WORKER_AGENT_SETUP.md` to modified files list
