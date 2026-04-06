# Remote Nodes UX Design

**Date:** 2026-04-06
**Status:** Approved
**Scope:** UI for creating, viewing, and managing CLI instances on remote worker nodes

## Context

The backend for remote node placement is fully implemented: worker nodes connect via WebSocket, report capabilities, and the coordinator routes CLI instance creation to them via `resolveExecutionLocation()`. What's missing is the UI to let users choose where sessions run and see which sessions are remote.

### What exists today

- **Backend**: `InstanceCreateConfig` has `forceNodeId` and `nodePlacement` fields. `resolveExecutionLocation()` implements the full decision tree (forceNodeId -> nodePlacement -> local fallback). `WorkerNodeRegistry.selectNode()` scores candidates against placement preferences. `RemoteCliAdapter` proxies CLI operations over RPC.
- **IPC gap**: `InstanceCreatePayloadSchema` does not expose `forceNodeId` or `nodePlacement`. The renderer cannot request remote placement.
- **UI**: Instance row shows an 8-char truncated UUID badge for remote instances. No node picker, no filtering, no detail info.
- **Auto-offload**: Browser intent detection routes channel messages to browser-capable nodes. GPU detection is a placeholder. Both are internal — they use `nodePlacement`, not `forceNodeId`.

### Design review

This design was reviewed by Gemini and GitHub Copilot. Key feedback incorporated:

- Capability gating in the node picker (disable nodes missing the selected CLI)
- Push-based node status subscription instead of polling
- Submit-time re-validation of selected node
- Loading/error/disconnection states
- Filter toggle over node grouping for sidebar (simpler, preserves project-based structure)
- Keep `nodePlacement` internal; expose only `forceNodeId` at the IPC level

## 1. IPC & Type Plumbing

### IPC Schema

Add `forceNodeId` to the instance creation payload:

```typescript
// src/shared/validation/ipc-schemas.ts
// Add to InstanceCreatePayloadSchema:
forceNodeId: z.string().uuid().optional(),
```

### Renderer Types

```typescript
// src/renderer/app/core/state/instance/instance.types.ts
// Add to CreateInstanceConfig:
forceNodeId?: string;
```

### Instance Store

Update `createInstance()` and `createInstanceWithMessage()` in `instance-list.store.ts` to pass `forceNodeId` through to the IPC call when set.

### IPC Handler

The existing instance creation handler in `instance-handlers.ts` already spreads validated payload into `InstanceCreateConfig`. Once the schema accepts `forceNodeId`, it flows through automatically to `resolveExecutionLocation()`.

### What stays internal

`nodePlacement` is not exposed at the IPC level. It is used internally by auto-offload (browser/GPU intent detection in channel message router). If user-facing routing policy is needed later, expose a high-level enum (`auto | localOnly | remotePreferred`) rather than the raw `NodePlacementPrefs` object.

## 2. Node Status Subscription

### Problem

Calling `listNodes()` on every dropdown open introduces latency and stale data. Nodes connect/disconnect in real time.

### Solution

Push-based reactive model via a new `RemoteNodeStore`:

**Main process side:**
- Emit `remote-node:nodes-changed` IPC event whenever a node connects, disconnects, changes status (degraded/reconnected), or updates capabilities via heartbeat.
- Event payload: full `WorkerNodeInfo[]` array (not deltas — keeps renderer logic simple).

**Preload:**
- Add `onRemoteNodeNodesChanged(callback)` listener that returns an unsubscribe function.

**Renderer side:**
- New injectable `RemoteNodeStore` service with:
  - `readonly nodes = signal<WorkerNodeInfo[]>([])` — all known nodes
  - `readonly connectedNodes = computed(() => nodes().filter(n => n.status === 'connected'))` — healthy nodes only
  - On init: one `listNodes()` call to seed, then subscribe to `nodes-changed` events
  - `nodeById(id: string)` convenience method for lookups
- All consumers (node picker, sidebar badges, instance header tooltips) read from this store.

**Event trigger points in main process:**
- `WorkerNodeRegistry` emits on: `node:registered`, `node:deregistered`, `node:status-changed`, `node:metrics-updated`
- Wire these to broadcast the IPC event via `BrowserWindow.webContents.send()`

## 3. Node Picker at Session Creation

### Location

Always-visible dropdown in the session creation area. Two integration points:
- `instance-welcome.component.ts` — the welcome screen shown before first message
- `input-panel.component.ts` — the message composer (for the initial draft)

Both use the same node picker component.

### Component: `NodePickerComponent`

Standalone Angular component, OnPush, signals-based.

**Inputs:**
- `selectedNodeId: InputSignal<string | null>` — current selection (null = local)
- `selectedCli: InputSignal<CanonicalCliType | 'auto'>` — currently chosen provider, for capability gating

**Outputs:**
- `nodeSelected: OutputEmitter<string | null>` — emits nodeId or null for local

**Template structure:**

```
[Dropdown button: "Local" or node name]
  └─ Dropdown panel (absolute positioned)
     ├─ Local (always first, always enabled)
     ├─ ── separator ──
     ├─ Node: windows-pc
     │    Win32 · GPU · Chrome · 3 CLIs    ●green  12ms
     ├─ Node: linux-server
     │    Linux · Docker · 2 CLIs          ●green  45ms
     └─ Node: old-laptop (greyed out)
          Darwin · 1 CLI                   ●red    —
          "Codex CLI not installed"
```

**Behavior:**
- Reads `RemoteNodeStore.nodes()` for the node list
- For each node, checks if `selectedCli` is in `node.capabilities.supportedClis` (or selectedCli is 'auto'). If not, node is disabled with a tooltip explaining why.
- Disconnected nodes (`status !== 'connected'`) shown greyed out, not selectable.
- Health indicator: green dot for connected, yellow for degraded, red/grey for disconnected.
- Latency shown as "{N}ms" or "—" if unknown.

**Submit-time validation:**
When the user clicks create, the parent component re-checks `RemoteNodeStore.nodes()` to verify the selected node is still connected. If not, show an error toast: "Node '{name}' disconnected. Please select another node or use Local." Do not create the instance.

### Visibility

The dropdown is always visible but only shows remote options when `RemoteNodeStore.connectedNodes()` has entries AND the remote nodes feature is enabled (`SettingsStore.remoteNodesEnabled()`). When no remote nodes are available, the picker shows "Local" as a static label (no dropdown interaction needed).

## 4. Instance List Sidebar

### Node Name Badge

Replace the current 8-char truncated UUID badge with the node's human-readable name:

```typescript
// instance-row.component.ts
// Change from:
remoteNodeId() | slice:0:8
// To:
remoteNodeName()  // looked up from RemoteNodeStore.nodeById()
```

If the node is no longer in the store (deregistered), fall back to first 8 chars of the nodeId.

### Disconnection Warning

When a session's remote node has `status !== 'connected'`:
- Badge switches to **warning style** (yellow/orange background)
- Tooltip: "Node '{name}' disconnected — session may be interrupted"

This uses the `RemoteNodeStore` reactively — when a node's status changes, all badges for sessions on that node update automatically.

### Filter Toggle

Add a segmented toggle at the top of the instance list sidebar:

```
[ All | Local | Remote ]
```

- Default: "All" (current behavior, no filtering)
- "Local": hide instances where `executionLocation.type === 'remote'`
- "Remote": hide instances where `executionLocation.type === 'local'` or `executionLocation` is undefined
- Implemented as a `signal<'all' | 'local' | 'remote'>('all')` in `instance-list.component.ts`
- Applied as a filter on the existing sorted/grouped instance list — does not change the project-based grouping structure
- Only visible when `RemoteNodeStore.nodes().length > 0` (no point showing the toggle if there are no remote nodes)

## 5. Instance Detail Header

### Node Badge

Add a node name badge next to the existing provider badge in `instance-header.component.ts`:

```
[● idle] [claude] [windows-pc]  Session Name
```

- Same visual style as sidebar badge
- Warning style when node is disconnected
- Only shown when `instance.executionLocation?.type === 'remote'`

### Hover Tooltip

On hover over the node badge, show a tooltip card with:

```
windows-pc
Platform:     Windows (x64)
Latency:      12ms
CPU:          8 cores
Memory:       14.2 / 32 GB available
GPUs:         NVIDIA RTX 4070 (12 GB)
CLIs:         claude, codex, gemini
Sessions:     3 active on this node
Status:       Connected
```

Data sourced from `RemoteNodeStore.nodeById(nodeId)`. If node is no longer in store, show minimal info: "Node {first 8 chars} — no longer registered".

### Loading State

When creating a remote instance, show a spinner/skeleton in the header area with text: "Connecting to {node-name}..." until the remote CLI process confirms it's running (first state change event from the worker agent).

## 6. Error & Edge Case Handling

### Node disconnects during active session

- Instance status becomes 'degraded' (existing failover logic handles this)
- Sidebar badge and header badge switch to warning style
- After 30s grace period (existing), if node doesn't reconnect, instance status becomes 'failed'
- User sees the session history but cannot send new messages

### Selected node disconnects before session creation

- Submit-time validation catches this (see section 3)
- Toast error with suggestion to pick another node or use Local

### No remote nodes available

- Node picker shows "Local" as static text, no dropdown
- Filter toggle hidden in sidebar
- No other UI changes — the feature is invisible when not applicable

### Remote creation fails (spawn error)

- Existing error handling in instance lifecycle applies
- Error surfaces in the instance detail as a failed state with the error message
- User can retry or create a new session

## 7. Files to Create or Modify

### New files
- `src/renderer/app/core/state/remote-node.store.ts` — RemoteNodeStore service
- `src/renderer/app/shared/components/node-picker/node-picker.component.ts` — Node picker dropdown

### Modified files (renderer)
- `src/renderer/app/core/state/instance/instance.types.ts` — add `forceNodeId` to `CreateInstanceConfig`
- `src/renderer/app/core/state/instance/instance-list.store.ts` — pass `forceNodeId` to IPC
- `src/renderer/app/features/instance-detail/instance-welcome.component.ts` — integrate node picker
- `src/renderer/app/features/instance-detail/input-panel.component.ts` — integrate node picker for initial draft
- `src/renderer/app/features/instance-list/instance-row.component.ts` — node name badge, disconnection warning
- `src/renderer/app/features/instance-list/instance-list.component.ts` — filter toggle
- `src/renderer/app/features/instance-detail/instance-header.component.ts` — node badge, tooltip, loading state

### Modified files (backend/shared)
- `src/shared/validation/ipc-schemas.ts` — add `forceNodeId` to `InstanceCreatePayloadSchema`
- `src/main/remote-node/worker-node-registry.ts` — emit events for node state changes (if not already)
- `src/main/remote-node/worker-node-connection.ts` — broadcast `nodes-changed` IPC event to renderer
- `src/preload/preload.ts` — add `onRemoteNodeNodesChanged` listener

### Not modified
- `src/main/instance/instance-lifecycle.ts` — already handles `forceNodeId`, no changes needed
- `src/main/cli/adapters/adapter-factory.ts` — already routes via `executionLocation`, no changes needed
- `src/main/cli/adapters/remote-cli-adapter.ts` — already implemented, no changes needed

## 8. Future Enhancements (not this iteration)

- **Session migration**: Move running sessions between nodes (complex — needs CLI state transfer)
- **GPU auto-offload detection**: `detectGpuIntent()` equivalent for automatic routing
- **Routing policy enum**: `auto | localOnly | remotePreferred` exposed via settings or per-session
- **Group-by-node sidebar mode**: Optional view mode for users with many nodes
- **Per-instance placement preferences**: UI for `nodePlacement` (requiresBrowser, requiresGpu, etc.)
- **Node actions in header**: Migrate, move-to, restart-on-different-node from instance detail
