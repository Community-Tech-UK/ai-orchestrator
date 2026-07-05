# Remote Worker Identity And Pairing Design

## Status

Implemented and verified.

## Problem

Remote workers technically connect, but the operator experience is too opaque.
When several workers are connected, a local operator or agent may have to
correlate WebSocket IPs, Tailscale names, registry entries, and UI state to know
which machine is which. That is unacceptable for a system whose product surface
already names machines like `noah3900x`, `noahlaptop`, and `windows-pc`.

Pairing a new worker is also too fiddly. The Remote Nodes UI generates a
connection config using `token`, `host`, `port`, and `requireTls`, while docs and
manual examples use `authToken` and `coordinatorUrl`. The worker accepts both
shapes, but the generated config does not look like the worker's native config,
and the practical path still pushes users toward hand-editing JSON. If a user
copies only the credential, worker startup prints `Connecting to coordinator at
undefined...` and falls back to mDNS, which is unreliable on Windows.

## Goals

- Make the connected worker roster obvious from one authoritative source:
  machine name, node ID, platform, connection address, status, capabilities,
  heartbeat, capacity, and allowed working directories.
- Make logs and debug/status output identify workers by human-readable machine
  name as well as node ID.
- Make the Remote Nodes UI generate a canonical worker config that matches what
  the worker wants to read.
- Add a worker-side pairing command that accepts a pairing link/code, writes the
  config, validates reachability, and starts or installs the worker without
  manual JSON editing.
- Keep existing worker configs compatible.
- Build the pairing core so a later full Harness "Worker Mode" UI can reuse it.

## Non-Goals

- Do not require LAN broadcast/discovery for the first fix. Windows mDNS and
  multicast behavior are inconsistent enough that explicit pairing links remain
  the primary path.
- Do not remove support for legacy `token`/`host`/`port` config files.
- Do not expose transport tokens in logs, snapshots, CLI tables, or UI lists.
- Do not change remote work routing behavior in this feature. This is identity,
  observability, and onboarding only.

## Recommended Approach

Build the small, reliable path first:

1. A unified roster service in the main process.
2. A canonical pairing/config contract shared by the UI and worker.
3. A worker CLI pairing command.
4. UI copy changes that point users to the CLI command instead of JSON editing.
5. A later Worker Mode screen in the packaged app, built on the same pairing
   library.

This fixes the immediate pain without making first-run app packaging the place
where pairing semantics are invented.

## Current System Facts

- Live workers are stored in `WorkerNodeRegistry` as `WorkerNodeInfo`.
- Registered identities are persisted in `remoteNodesRegisteredNodes` through
  `RemoteAuthService` and `NodeIdentityStore`.
- Worker registration carries `nodeId`, `name`, `token`, and capabilities.
- The coordinator-side `RpcEventRouter.handleNodeRegister()` registers live
  nodes with name and capabilities.
- `RemoteNodesSettingsTabComponent.buildConnectionConfig()` currently emits the
  UI config shape:

  ```json
  {
    "token": "pair-token",
    "namespace": "default",
    "host": "macbook-pro.tail4fc107.ts.net",
    "port": 4878,
    "requireTls": false
  }
  ```

- `worker-config.ts` accepts that UI shape and normalizes it into `authToken`
  and `coordinatorUrl`, but the worker's native config and docs use:

  ```json
  {
    "authToken": "pair-token",
    "coordinatorUrl": "ws://macbook-pro.tail4fc107.ts.net:4878",
    "namespace": "default"
  }
  ```

- The app already has MCP-facing `list_remote_nodes`, but local shell/debug
  operators do not have an obvious first-class roster command.

## Feature 1: Unified Worker Roster

Add a main-process service that produces one safe, merged operator view of known
workers.

Suggested file:

- `src/main/remote-node/remote-node-roster-service.ts`

Suggested exported type:

```ts
export interface RemoteNodeRosterEntry {
  id: string;
  name: string;
  status: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  platform?: 'darwin' | 'win32' | 'linux';
  arch?: string;
  address?: string;
  connected: boolean;
  connectedAt?: number;
  lastHeartbeat?: number;
  lastAuthenticatedAt?: number;
  pairingLabel?: string;
  authMethod?: 'pairing_credential' | 'manual_pairing';
  supportedClis: string[];
  hasBrowserRuntime: boolean;
  hasBrowserMcp: boolean;
  hasAndroidMcp: boolean;
  hasDocker: boolean;
  gpuName?: string;
  activeInstances: number;
  maxConcurrentInstances: number;
  workingDirectories: string[];
}
```

The service should merge:

- `getWorkerNodeRegistry().getAllNodes()`
- `getRemoteAuthService().listSessions()`
- connection address data already present on `WorkerNodeInfo.address`, plus any
  transport-level address captured during registration if needed

Consumers:

- Remote Nodes Settings UI
- MCP `list_remote_nodes`
- orchestration prompt connected-node snapshot
- logs around registration, reconnect, disconnect, work dispatch, and repair
- a local operator command, either `aio remote nodes` or an existing CLI
  subcommand that can call the same runtime service

Logging should include both `node` and `nodeId`:

```ts
logger.info('Remote worker connected', {
  node: 'noah3900x',
  nodeId: '...',
  platform: 'win32',
  address: '100.106.40.97',
});
```

The registry should not make operators infer identity from IP addresses.

## Feature 2: Canonical Pairing Contract

Define one canonical worker pairing config and use it in docs and UI.

Canonical generated config:

```json
{
  "name": "Noah3900x",
  "authToken": "pair-token",
  "coordinatorUrl": "ws://macbook-pro.tail4fc107.ts.net:4878",
  "namespace": "default",
  "maxConcurrentInstances": 10,
  "workingDirectories": []
}
```

Rules:

- `coordinatorUrl` is always generated by the coordinator UI.
- `authToken` is the one-time pairing credential or manual token.
- `name` is optional in the config UI, but the worker should default to
  `os.hostname()` if omitted.
- `workingDirectories` may be empty, but the worker CLI should offer to add a
  default directory during pairing.
- Legacy `token`/`host`/`port`/`requireTls` remains accepted by the worker.
- The UI may still include a pairing link and QR code, but the code preview
  should be the canonical config.

Worker startup validation should fail early with a clear message when no
coordinator URL can be derived:

```text
Worker config is missing coordinatorUrl. Paste the full Connection Config or run:
  aio-worker pair <pairing-link>
```

It should not print `Connecting to coordinator at undefined...`.

## Feature 3: Worker Pairing CLI

Add a worker-side pairing command that removes manual JSON editing.

Primary commands:

```powershell
aio-worker pair "ai-orchestrator://remote-node/pair?host=macbook-pro.tail4fc107.ts.net&port=4878&namespace=default&token=...&requireTls=false"
```

```powershell
aio-worker pair
```

Interactive `pair` flow:

1. Prompt for a pairing link, full connection config JSON, or one-time
   credential.
2. If only a credential is pasted, prompt for coordinator host or ask the user
   to paste the full link/config.
3. Ask for a worker display name, defaulting to the Windows computer name.
4. Ask for allowed working directories, defaulting to
   `%USERPROFILE%\Documents\work` when it exists.
5. Write `worker-node.json`.
6. Validate `coordinatorUrl` is reachable with a WebSocket/TCP probe.
7. Start the worker with `--supervise` or ask whether to install/start the
   service when elevated.
8. Print the resolved name and coordinator:

   ```text
   Paired noah3900x with macbook-pro.tail4fc107.ts.net:4878.
   Worker started and waiting for work.
   ```

Implementation should live beside existing worker service CLI code so it can
reuse `loadWorkerConfig`, `persistConfig`, service paths, and token handling.

Suggested files:

- `src/worker-agent/cli/pair-cli.ts`
- `src/worker-agent/cli/pairing-config.ts`
- `src/worker-agent/cli/service-cli.ts`
- `src/worker-agent/index.ts`

The command must never print token values after parsing them.

## Feature 4: UI Changes

Remote Nodes Settings should become operator-focused:

- Rename "One-Time Credential" emphasis to "Pair this computer".
- Show the recommended command first:

  ```powershell
  aio-worker pair "ai-orchestrator://remote-node/pair?..."
  ```

- Keep "Copy canonical config" as an advanced fallback.
- Remove or demote "paste the One-Time Credential" unless the UI also explains
  that a credential alone is not enough to locate the coordinator.
- Display a connected worker roster using the new roster entries. Each row
  should show name, platform, status, address, capabilities, last heartbeat, and
  capacity.
- Add "Copy diagnostics" for a worker row. The copied diagnostics must be
  redacted and include enough data for a human or agent to identify the node
  without IP/Tailscale correlation.

## Feature 5: Later Full App Worker Mode

After the CLI pairing path is reliable, add a first-run Worker Mode to the
packaged app:

- First-run choice: "Use this as the main Harness app" or "Use this computer as
  a worker for another Harness".
- Worker Mode screen: paste pairing link/code, choose display name, choose
  working directories, choose start-on-login/service.
- The screen calls the same pairing parser/writer used by `aio-worker pair`.
- The worker process starts under supervision or service mode.
- The UI shows current connection status and the coordinator name/address.

This is a second phase, not a prerequisite for fixing current onboarding.

## Security And Privacy

- Never log or display `authToken`, `nodeToken`, `transportToken`,
  `recoveryToken`, pairing token values, or extension relay tokens.
- Pairing links are secrets while valid. UI copy should describe them as
  one-time credentials, not harmless URLs.
- Roster entries may include operator-owned paths and machine names. That is
  acceptable inside Harness, but "Copy diagnostics" should be explicit and
  redacted.
- Service installation must still require elevation on Windows.
- Legacy manual pairing token remains advanced-only.

## Compatibility

- Existing `worker-node.json` files continue to load.
- Existing sessions continue to authenticate with per-node transport tokens.
- Existing pairing links continue to parse.
- Existing Remote Nodes UI can migrate in place because the worker already
  accepts both old and canonical config shapes.

## Testing

Unit tests:

- Roster service merges live node and persisted identity data.
- Roster service shows disconnected registered nodes and connected unpersisted
  nodes safely.
- Roster output redacts token fields.
- Worker config parser accepts canonical config.
- Worker config parser still accepts legacy UI config.
- Worker startup validation reports missing coordinator URL clearly.
- Pairing parser accepts:
  - `ai-orchestrator://remote-node/pair?...`
  - canonical JSON config
  - legacy UI JSON config
- Pairing parser rejects malformed or missing host/token without printing
  secrets.

Integration tests:

- `list_remote_nodes` uses the roster service output.
- Remote Nodes IPC list/status can return roster entries.
- Worker `pair` command writes the expected config to a temp config path.
- Registration logs include `node` and `nodeId`.

Manual checks:

- Pair a Windows worker from a copied command.
- Pair a Windows worker from a pasted link interactively.
- Verify Harness UI shows the worker name, platform, address, capabilities, and
  heartbeat without needing Tailscale status.
- Verify revoking a pending credential makes a copied link fail.
- Verify no token appears in logs.

## Rollout

Phase 1:

- Add roster service and route existing UI/MCP/listing/logging through it.
- Add clearer registration/disconnect/work logs.

Phase 2:

- Canonicalize generated config and worker startup validation.
- Update docs and Remote Nodes UI copy.

Phase 3:

- Add `aio-worker pair` and package/distribute it with worker builds.
- Make the UI's primary copy button produce the one-line pairing command.

Phase 4:

- Add full app Worker Mode and optional LAN broadcast/discovery.

## Open Decisions

- CLI binary naming: prefer `aio-worker` for worker-specific commands. If the
  packaged distribution already has a stronger convention by implementation
  time, use that name but keep the subcommand contract the same.
- Whether `aio remote nodes` should be a standalone local CLI or an app IPC/MCP
  command exposed through the existing `aio-mcp` binary. The important
  requirement is one operator-readable roster command with `--json`.
