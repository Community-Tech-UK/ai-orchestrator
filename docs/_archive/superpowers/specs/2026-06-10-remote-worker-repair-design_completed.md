# Remote Worker Repair Design

**Date:** 2026-06-10
**Status:** Implemented (verified 2026-06-11)

## Context

AI Orchestrator already supports remote worker nodes over the remote-node WebSocket/RPC layer. A healthy worker can receive service-scoped RPCs such as `service.status`, `service.restart`, and `config.update`.

The incident that prompted this design was different: the worker became "depaired" before it could authenticate. The coordinator logs showed repeated `Invalid or expired pairing token` registration rejections for a known node. That means the worker could reach the coordinator, but it was presenting an enrollment/manual pairing token that had already been consumed or expired instead of a valid persisted node token, with no successful recovery-token path at that moment.

Once a worker is rejected during `node.register`, the coordinator cannot use the existing service RPC path because the worker is not an authenticated node socket. Tailscale can prove the machine is reachable, but it does not by itself provide a command-execution channel. Plain SSH was not reachable on the Windows peer during investigation.

## Goals

1. Detect a depaired worker from coordinator-side evidence without exposing secrets.
2. Give the operator a clear repair action when a known worker is failing authentication.
3. Prefer in-band diagnostics and safe service actions when the worker is still authenticated.
4. Provide an out-of-band Windows repair command when a registered worker is failing authentication.
5. Verify repair by waiting for a fresh accepted registration.
6. Keep credentials out of logs, diagnostics, screenshots, tests, and persistent UI state.

## Non-Goals

- Do not add a general remote shell, RDP client, WinRM client, or Tailscale SSH dependency.
- Do not expose transport tokens, recovery tokens, enrollment tokens, or repair tokens in logs.
- Do not let unauthenticated workers mutate coordinator state beyond the existing registration flow.
- Do not revoke or rewrite healthy worker credentials unless the operator explicitly starts repair.
- Do not solve worker binary distribution or upgrades in this feature.
- Do not add Doctor UI integration in v1. Keep the operator action in Remote Nodes; Doctor can link to it in a later, separate change.

## Current Behavior

`RemoteAuthService.authenticateRegistration()` accepts three cases:

1. Existing transport token for the same node id.
2. Pending one-time/manual pairing token.
3. Same-node recovery token, when the worker also sends `recoveryToken`.

The worker persists accepted `nodeToken` and `recoveryToken` into its config file after registration succeeds. In service mode the config path is platform-specific; on Windows it is `C:\ProgramData\Orchestrator\worker-node.json`. If the service config loses the persisted node token/recovery token, or if the service is reading a different config file than the one the operator repaired, it can keep retrying with an already-consumed manual pairing token and get rejected repeatedly.

The existing Remote Nodes UI shows registered nodes and live nodes, but it does not show rejected registration attempts. Doctor has repair-action UI patterns, but it does not yet include remote worker pairing health.

## Design Summary

Add a **Remote Worker Repair** capability with two paths:

1. **Healthy path:** if the worker is currently authenticated, use existing service RPCs to inspect service status, confirm the service config path, and optionally restart the service.
2. **Depaired path:** if the registered worker is reaching the coordinator but failing authentication, generate a one-time repair command for Windows that the operator runs on the remote machine through RDP, physical access, or any command channel they already have.

Both paths are driven by coordinator-side diagnostics:

- registered node identity exists
- live node is missing or repeatedly rejected
- latest rejection reason
- last successful authentication time
- local coordinator URLs, including Tailscale address/DNS when available
- whether the node has persisted recovery metadata on the coordinator

## Data Model

Add repair payload types to `src/shared/types/worker-node.types.ts`:

```typescript
export type RemoteWorkerRepairStatus =
  | 'healthy'
  | 'depaired'
  | 'unreachable'
  | 'unknown';

export interface RemoteWorkerRejectedRegistration {
  nodeId: string;
  nodeName?: string;
  platformHint?: NodePlatform;
  reason: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
}

export interface RemoteWorkerRepairDiagnostic {
  nodeId: string;
  nodeName: string;
  status: RemoteWorkerRepairStatus;
  liveStatus?: WorkerNodeInfo['status'];
  trustedPlatform?: NodePlatform;
  platformHint?: NodePlatform;
  lastSeenAt?: number;
  lastHeartbeat?: number;
  lastRejectedRegistration?: RemoteWorkerRejectedRegistration;
  coordinatorUrls: string[];
  hasCoordinatorRecoveryToken: boolean;
  recommendedAction:
    | 'none'
    | 'copy_windows_command'
    | 'choose_platform'
    | 'check_connectivity'
    | 'configure_tls'
    | 're_pair';
  availableActions: Array<'check_service_status'>;
  summary: string;
}

export interface RemoteWorkerRepairCommand {
  nodeId: string;
  nodeName: string;
  platform: 'win32';
  expiresAt: number;
  serviceId: string;
  configPath: string;
  primaryCoordinatorUrl: string;
  coordinatorUrls: string[];
  command: string;
  redactedPreview: string;
}
```

`RemoteWorkerRepairDiagnostic` must never include raw tokens. `RemoteWorkerRepairCommand.command` contains a one-time pairing credential and is only returned from the explicit "Generate repair command" action. It is not stored in settings and not emitted to logs.

`RemoteWorkerRepairCommand` metadata fields are deliberately non-secret so the UI can show what the command will affect without parsing or displaying the secret-bearing command body.

Place these types after `WorkerNodeInfo` in `src/shared/types/worker-node.types.ts` so `WorkerNodeInfo['status']` and `NodePlatform` are already available.

For diagnostics with no registered identity, set `nodeName` to the rejected registration's sanitized `nodeName` when available, otherwise fall back to `nodeId`. Do not make `nodeName` optional because the settings UI should not need a separate missing-name rendering path.

Also extend `NodeIdentity` with a trusted, non-secret platform snapshot:

```typescript
platform?: NodePlatform;
platformSeenAt?: number;
```

Populate those fields only from authenticated node data: the accepted `node.register` capability payload after `authenticateRegistration()` succeeds, and later authenticated heartbeats if needed. Never populate them from a rejected unauthenticated registration. The update must be persisted with the rest of the node identity JSON, not left only in an in-memory `NodeIdentityStore` mutation.

## Coordinator Components

### Rejected Registration Tracker

Create `src/main/remote-node/remote-worker-repair-tracker.ts`.

Responsibility:

- Maintain an in-memory, bounded map of recent rejected registrations.
- Key by `nodeId` when present.
- Store `nodeId`, optional `nodeName`, optional sanitized `platformHint`, sanitized `reason`, `firstSeenAt`, `lastSeenAt`, and `count`.
- Expire entries after 24 hours.
- Cap the map at 200 entries and drop oldest entries first.
- Expose `get(nodeId)`, `recordRejectedRegistration(input)`, `clear(nodeId)`, and `_resetForTesting()` using the same singleton/testing pattern as other remote-node services.

Integration:

- In `src/main/remote-node/worker-node-connection.ts`, when registration fails, call the tracker before closing the socket.
- In the same file, clear the tracker for that `nodeId` immediately after a successful registration so the UI does not keep showing a repaired node as depaired.
- When calling `RemoteAuthService.authenticateRegistration()`, pass a sanitized `platform` extracted from `params.capabilities.platform` when it is one of `darwin`, `win32`, or `linux`. Extend `RemoteAuthService` so accepted `registered`, `recovered`, and `paired` results persist `platform`/`platformSeenAt` into `NodeIdentity`. Alternative implementation: add a dedicated post-auth `recordTrustedPlatform(nodeId, platform)` method on `RemoteAuthService` that updates `NodeIdentityStore` and persists sessions.
- Do not store request tokens, recovery tokens, remote headers, IP addresses, or raw payloads.
- If extracting `platformHint` from unauthenticated registration params, read only `params.capabilities.platform` from the submitted `node.register` payload, accept only `darwin`, `win32`, or `linux`, and treat it as operator context, not trusted authorization data.

### Repair Diagnostic Service

Create `src/main/remote-node/remote-worker-repair-service.ts`.

Responsibility:

- Build `RemoteWorkerRepairDiagnostic` for a node by combining:
  - registered identity from `NodeIdentityStore`
  - live node from `WorkerNodeRegistry`
  - recent rejection from `remote-worker-repair-tracker`
  - server status and coordinator URLs from existing network helpers
- Never rely on `WorkerNodeRegistry` as the only source for disconnected-node data. The registry deregisters nodes on disconnect, so a depaired node may only have `NodeIdentityStore` plus rejected-registration evidence.
- Use `WorkerNodeInfo.connectedAt` as context for any rejected registration that happens while the node is live. For disconnected nodes, use `NodeIdentity.lastSeenAt` as the last successful authentication/seen timestamp. Do not introduce a second timestamp source unless the existing fields prove insufficient during implementation.
- Classify status:
  - `healthy`: node is currently connected. If a rejected registration exists after `connectedAt`, include it in the summary as a duplicate/stale-config warning, but keep the primary path in-band.
  - `depaired`: a registered node is disconnected and has a recent rejection newer than `NodeIdentity.lastSeenAt`, especially `Invalid or expired pairing token`.
  - `unreachable`: registered node is disconnected with no recent rejection.
  - `unknown`: no registered identity, even if a recent rejected registration exists for that id.
- Recommend action:
  - `none` for healthy nodes.
  - `copy_windows_command` for depaired nodes whose platform is known from trusted coordinator state to be Windows.
  - `choose_platform` for registered depaired nodes whose platform is unknown.
  - `check_connectivity` for unreachable registered nodes with no recent rejected registration; there is no evidence yet that auth repair is the right fix.
  - `configure_tls` when the node otherwise looks repairable but the coordinator is reachable only through a TLS mode the worker cannot satisfy, such as mTLS without worker client certificate material.
  - `re_pair` when there is no registered identity, or when a depaired node's platform is not Windows in v1.
- Expose `check_service_status` in `availableActions` for connected nodes where the operator can verify service state/config path or restart the service. This is a secondary maintenance/diagnostic action, not the primary repair recommendation.

Only treat platform as trusted when it comes from an authenticated live `WorkerNodeInfo.capabilities.platform` snapshot or from the authenticated `NodeIdentity.platform` snapshot. A `platformHint` extracted from a rejected unauthenticated registration is useful context for the summary, but it must not by itself trigger `copy_windows_command`. If platform is unknown because the node is disconnected and there is no trusted snapshot, the UI may offer a Windows repair-command option only after the operator explicitly chooses Windows. Do not infer Windows from node name alone.

### Repair Command Generator

Add a command generator to `remote-worker-repair-service.ts`.

For Windows v1, generate a PowerShell command that:

1. Ensures `C:\ProgramData\Orchestrator` exists.
2. Reads existing `worker-node.json` when present.
3. Preserves safe non-auth settings from the existing config, at minimum `maxConcurrentInstances`, `workingDirectories`, `reconnectIntervalMs`, `heartbeatIntervalMs`, `browserAutomation`, and `androidAutomation`.
4. Writes:
   - `nodeId`
   - `name`
   - `coordinatorUrl`
   - `coordinatorUrls`
   - `authToken` set to a fresh one-time pairing credential
   - `namespace`
   - existing safe non-auth settings
5. Clears `nodeToken`, `recoveryToken`, and any legacy `token` field locally so the worker does a clean pairing exchange.
6. Restarts the Windows service if it exists.
7. Falls back to printing a clear message if the service is not installed.
8. Tells the operator when the command needs an elevated PowerShell session to write `C:\ProgramData\Orchestrator` or restart the Windows service.

Use `RemoteAuthService.issuePairingCredential({ label, ttlMs, purpose: 'repair', allowedNodeId: nodeId })` for the one-time repair credential. Use a short default TTL such as 30 minutes. The label should identify the node and repair purpose without including secrets, for example `Repair windows-pc`.

Split the coordinator's in-memory pending credential record from the renderer-facing `RemotePairingCredentialInfo`. Today `RemoteAuthService` aliases the internal `RemotePairingCredential` type to `RemotePairingCredentialInfo`; change that so internal records can carry repair-only metadata while `RemotePairingCredentialInfo` remains the public Quick Pairing shape. Do not add repair metadata to the shared UI-facing type.

Internal pending credential records need:

- `purpose: 'pairing' | 'repair'`
- `allowedNodeId?: string`

`authenticateRegistration()` must reject a pairing credential with `allowedNodeId` when `params.nodeId` does not match, without consuming the credential, and with a sanitized rejection reason. Normal one-time pairing credentials remain unbound. `listPendingPairings()` and the server-status `pendingPairingCount` must exclude `purpose: 'repair'` credentials so a generated repair token does not become the active Quick Pairing QR code/link/config in the existing settings UI.

Keep the existing `REMOTE_NODE_ISSUE_PAIRING` IPC path as an ordinary Quick Pairing path only. Its schema should continue accepting only `label` and `ttlMs`; `purpose` and `allowedNodeId` are internal main-process inputs used only by repair command generation. Any public response that returns a pairing credential must serialize only `token`, `createdAt`, `expiresAt`, and `label`; do not spread internal credential records into IPC responses.

One-time pairing credentials are coordinator-process state. A generated repair command expires when its TTL passes or when the coordinator app restarts, whichever happens first. The UI should say that an expired command must be regenerated.

Build the command from a JSON repair payload encoded as UTF-8 base64 and decoded inside PowerShell with `[Text.Encoding]::UTF8.GetString(...)` before `ConvertFrom-Json`. Do not interpolate individual JSON values directly into PowerShell statements. This keeps node names, paths, URLs, and tokens from creating quoting or injection bugs. Base64 is only for shell-syntax safety, not secrecy. If the whole PowerShell script is wrapped with `-EncodedCommand`, encode the script itself as UTF-16LE per PowerShell's convention; keep the embedded repair payload UTF-8.

When writing `worker-node.json`, use JSON output with sufficient depth and UTF-8 encoding so `loadWorkerConfig()` can read it directly.

The command should prefer stable coordinator URLs:

1. Tailscale MagicDNS name if present.
2. Tailscale IPv4 address if present.
3. Local IPv4 addresses.
4. Existing server host/port when it is not `0.0.0.0`.

The primary URL should match the server TLS mode reported by `getRemoteNodeConfig()` and server status. If only non-TLS listening is active, generate `ws://...`. Generate `wss://...` only when the coordinator is actually listening with TLS and the worker can validate the certificate chain with its current WebSocket configuration. Do not generate an mTLS-only repair command in v1: the current worker config does not carry client certificate/key material, so a server requiring client certs (`tlsCaPath`/mutual TLS) needs a separate TLS enrollment design before repair commands can cover it. If TLS is enabled with an untrusted/self-signed certificate and the worker has no configured CA trust path, the diagnostic should say repair command generation is blocked until the operator uses a reachable non-mTLS endpoint or configures trust through a separate mechanism.

Use the worker service path from `servicePaths('win32').configFile`. If importing `src/worker-agent/service/paths.ts` from main creates a bundling or ownership problem, move the path helper to a small shared module used by both main and worker-agent code instead of duplicating the Windows path string.

Use the Windows service id `ai-orchestrator-worker`, matching `WindowsServiceManager`. Prefer exporting this from a shared service constants module used by both the worker service manager and repair command generator, rather than copying the string into the repair service.

## IPC and Contracts

Add channels to `packages/contracts/src/channels/communication.channels.ts`:

- `REMOTE_NODE_REPAIR_DIAGNOSE: 'remote-node:repair:diagnose'`
- `REMOTE_NODE_REPAIR_COMMAND: 'remote-node:repair:command'`

Add schemas to `packages/contracts/src/schemas/remote-node.schemas.ts`:

```typescript
export const RemoteNodeRepairDiagnosePayloadSchema = z.object({
  nodeId: z.string().uuid(),
});

export const RemoteNodeRepairCommandPayloadSchema = z.object({
  nodeId: z.string().uuid(),
  platform: z.literal('win32').optional(),
  operatorConfirmedPlatform: z.boolean().optional(),
}).refine((payload) => payload.operatorConfirmedPlatform !== true || payload.platform === 'win32', {
  message: 'operatorConfirmedPlatform requires platform="win32"',
  path: ['operatorConfirmedPlatform'],
});
```

Follow the existing schema-file pattern and export inferred payload aliases for the new schemas, for example `ValidatedRepairDiagnosePayload` and `ValidatedRepairCommandPayload`, if the handlers need named validated types.

Add IPC handlers in `src/main/ipc/handlers/remote-node-handlers.ts`:

- diagnose handler returns `RemoteWorkerRepairDiagnostic`
- command handler returns `RemoteWorkerRepairCommand`
- command handler must reject `nodeId` values that do not have a registered identity. A recent rejected-registration record without a registered identity is not enough for repair; that case should use normal pairing.
- command handler must reject unknown-platform requests unless `platform === 'win32'` and `operatorConfirmedPlatform === true`
- command handler must not let `operatorConfirmedPlatform` override a trusted non-Windows platform from authenticated coordinator state. The confirmation only fills an unknown trusted platform.
- command handler must reject diagnostics with `recommendedAction === 'configure_tls'`; those nodes need a worker-reachable non-mTLS endpoint or separate TLS trust/client-certificate setup before v1 repair commands are valid.
- command handler must reject healthy nodes and unreachable nodes that have no recent rejected-registration evidence; v1 repair commands are for depaired registered nodes.

Add renderer methods in `src/renderer/app/core/services/ipc/remote-node-ipc.service.ts`:

- `diagnoseRepair(nodeId: string): Promise<RemoteWorkerRepairDiagnostic | null>`
- `generateRepairCommand(nodeId: string, options?: { platform?: 'win32'; operatorConfirmedPlatform?: boolean }): Promise<RemoteWorkerRepairCommand | null>`

Preload must expose these through `src/preload/domains/communication.preload.ts` using the same invoke pattern as the existing remote-node methods:

- `remoteNodeRepairDiagnose(nodeId)`
- `remoteNodeRepairCommand(nodeId, options?)`, where `options` can carry `{ platform: 'win32', operatorConfirmedPlatform: true }` for registered nodes whose platform is unknown.

After adding contract channels, update `src/preload/generated/channels.ts` by running `npm run generate:ipc` or by the same generated-channel workflow used elsewhere in the repo. Include `src/preload/__tests__/ipc-channel-contract.spec.ts` in focused verification so the generated preload channel object cannot drift from `@contracts/channels`.

## UI

Add the first operator-facing controls to `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts` and `.html`.

For each registered node card:

- Show a compact repair diagnostic row when the node is disconnected or has a recent rejection.
- Include:
  - status label
  - sanitized summary
  - last rejected registration time/count when present
  - recommended action
- For connected nodes with `availableActions` containing `check_service_status`, show a "Check service status" action using the existing `remoteNodeServiceStatus` IPC method. If `configPath` is returned, compare it with the expected platform service config path; if it is absent, show "config path unavailable" instead of treating the check as failed.
- For depaired Windows nodes, show "Generate repair command".
- For depaired nodes with `recommendedAction === 'choose_platform'`, show a compact platform selector before command generation. V1 should only enable Windows.
- For unreachable nodes with `recommendedAction === 'check_connectivity'`, show that the coordinator has not seen a failed registration recently and that the operator should check the remote service/network first.
- For nodes with `recommendedAction === 'configure_tls'`, show that repair command generation is blocked until the coordinator exposes a worker-reachable non-mTLS endpoint or the worker gains a separate trusted TLS/client-certificate configuration path.

When the command is generated:

- Display it in `CodePreviewBlockComponent` with a clear "Copy" action.
- Show the expiration time.
- Before explicit generation, show only non-secret metadata from the diagnostic and command metadata that the service can compute safely, such as node name, platform choice, coordinator URL candidates, and config path. Do not show a command body or secret-bearing preview before generation.
- After explicit generation, `RemoteWorkerRepairCommand.redactedPreview` can be used for collapsed summaries, copy confirmations, or error-safe display; the full `command` string is shown only in the generated-command panel.
- Do not persist the command in component state longer than the current view session.
- Clear it when the user switches away from that node or refreshes diagnostics.

Doctor integration is out of scope for v1. The Remote Nodes tab is the repair surface. A later Doctor change can add a read-only status section or a link into Remote Nodes without changing the repair model.

## Healthy In-Band Repair Path

When the node is connected:

1. Run `service.status` through existing `sendServiceRpc`.
2. Confirm the reported service `configPath` matches the expected platform service config path when `service.status` returns that detail.
3. Restart the service only after explicit confirmation.
4. Re-fetch node status and repair diagnostic.

This path should not rotate credentials in v1 and should not extend `config.update` to carry auth fields. The current worker `config.update` path accepts automation settings, not registration tokens. The main value of the connected path is confirming that the worker service is running, and, when the worker reports `configPath`, that it is reading the expected config. Missing `configPath` is an inconclusive result, not a failure.

## Depaired Out-of-Band Repair Path

When the diagnostic classifies a registered node as depaired:

1. Operator clicks "Generate repair command".
2. Coordinator issues a one-time repair pairing credential.
3. Main process builds a Windows PowerShell command using that credential.
4. Operator copies the command and runs it on the Windows machine.
5. Worker service restarts, registers with the one-time credential, receives a fresh transport token and recovery token, and persists them.
6. Coordinator clears the rejected-registration tracker entry for the node when registration succeeds.
7. Coordinator watches `REMOTE_NODE_NODES_CHANGED` / node registration events and updates the node card.

The command must not try to embed any existing coordinator-side transport token or recovery token. The coordinator should let the normal registration exchange issue fresh tokens.

## Security

- Treat repair commands as secrets because they contain a live one-time pairing credential.
- Do not log repair command strings or pairing tokens.
- Do not put repair command strings in persisted settings, test fixtures, screenshots, or generated docs.
- Redact command content in errors and diagnostics.
- Keep repair credentials short-lived, and make the UI clear that app restart invalidates generated commands.
- Require an explicit click before generating the command.
- Require a registered node identity before issuing a repair command.
- Bind each repair credential to the registered node id so it cannot be used to pair a different worker.
- Treat `platformHint` from rejected registration params as untrusted UI context only.
- Treat `operatorConfirmedPlatform` as a UI confirmation only; it permits choosing the Windows command template, but it does not authenticate the remote machine.
- Use `execFile`/service RPC for any future automatic execution path; do not concatenate shell commands with untrusted data.

## Testing

Use focused tests before implementation code.

Main-process tests:

- `src/main/auth/remote-auth.spec.ts`
  - issues repair credentials scoped to the intended node id
  - excludes repair credentials from ordinary pending-pairing lists/counts
  - keeps repair metadata out of `RemotePairingCredentialInfo` and the ordinary pairing IPC path
  - serializes ordinary pairing responses without internal metadata
  - rejects a scoped repair credential for the wrong node id without consuming it
  - persists trusted platform snapshots only after successful registration
- `src/main/remote-node/__tests__/remote-worker-repair-tracker.spec.ts`
  - records sanitized rejections
  - stores only accepted platform hints
  - clears rejection state after successful registration
  - increments counts
  - expires old entries
  - caps retained entries
  - redacts token-like substrings if an error reason ever contains one
- `src/main/remote-node/__tests__/node-identity-store.test.ts`
  - persists trusted platform snapshots from authenticated registrations
  - ignores invalid platform values during normalization
  - does not populate trusted platform fields from rejected registrations
- `src/main/remote-node/__tests__/remote-worker-repair-service.spec.ts`
  - classifies connected node as `healthy`
  - keeps connected nodes in the healthy/in-band path even when a later duplicate rejected registration exists
  - classifies recent rejection after `lastSeenAt` as `depaired`
  - classifies disconnected node with no rejection as `unreachable`
  - exposes `check_service_status` as an available action for connected nodes where service verification is useful
  - recommends `copy_windows_command` for depaired Windows nodes
  - recommends `choose_platform` for registered depaired nodes with unknown platform
  - recommends `check_connectivity` for unreachable nodes without rejected-registration evidence
  - recommends `configure_tls` when TLS mode blocks repair command generation
  - uses trusted `NodeIdentity.platform` for disconnected depaired nodes
  - treats unauthenticated `platformHint` as summary context rather than trusted platform state
  - requires explicit Windows selection when platform is unknown
  - rejects command generation for healthy nodes and unreachable nodes without rejected-registration evidence
  - rejects unknown-platform command generation without `operatorConfirmedPlatform`
  - generates Windows command with one-time pairing credential and expected config path
  - blocks repair command generation for mTLS-only coordinator configurations that the worker cannot satisfy
  - does not generate `wss://` URLs for untrusted TLS configurations without a worker trust path
  - returns non-secret command metadata for UI display
  - uses the shared Windows service id in the generated restart command
  - encodes command payload safely instead of interpolating raw values into PowerShell
  - writes worker config as UTF-8 JSON
  - command preserves safe non-auth config fields, including reconnect/heartbeat settings
  - command does not include coordinator transport or recovery tokens
- `src/main/ipc/handlers/__tests__/remote-node-repair-handlers.spec.ts`
  - validates payloads
  - returns diagnostic through IPC
  - returns command only through explicit command channel
  - rejects command generation for a node that has rejected-registration evidence but no registered identity

Renderer tests:

- `src/renderer/app/core/services/ipc/remote-node-ipc.service.spec.ts`
  - calls the new preload methods and handles failed IPC responses.
- `src/renderer/app/features/settings/remote-nodes-settings-tab.component.spec.ts`
  - shows repair status for depaired registered node
  - shows only non-secret repair metadata before explicit command generation
  - copies generated command only after explicit generation
  - clears command when diagnostics refresh
  - shows app restart/expiry warning for generated commands
  - treats missing service `configPath` as inconclusive, not failed

Contract tests:

- `packages/contracts/src/channels/__tests__/communication.channels.spec.ts`
- `packages/contracts/src/schemas/__tests__/remote-node.schemas.spec.ts`
- `src/preload/__tests__/ipc-channel-contract.spec.ts`

## Verification

After implementation:

1. Run the focused Vitest files for repair tracker, repair service, IPC, renderer service, Remote Nodes component, channels, and schemas.
2. Run `npm run generate:ipc`, then `npm run verify:ipc` and `npm run check:contracts`.
3. Run `npx tsc --noEmit`.
4. Run `npx tsc --noEmit -p tsconfig.spec.json`.
5. Run `npm run lint` or targeted ESLint for modified files.
6. Run `npm run check:ts-max-loc`.
7. Manually verify the UI with a connected node, a simulated rejection entry, repair command generation/expiry, and that generated repair credentials do not appear as Quick Pairing credentials.

## Rollout

Implement v1 for Windows service-mode workers first because that is the current affected worker class and the service config path is known. Linux and macOS can reuse the same diagnostic service later with platform-specific command generators.

The feature should ship behind the existing Remote Nodes settings surface. No migration is required because the rejected-registration tracker is in-memory and repair commands are generated on demand.

## Risks

- A repair command that writes the wrong config path will appear to succeed while the service keeps reading the old config. Mitigation: use `servicePaths('win32').configFile` as the source of truth and include that path visibly in the command summary.
- If the coordinator URL is wrong, the worker will remain unreachable. Mitigation: prefer Tailscale DNS/IP when available and include all candidate URLs in `coordinatorUrls`.
- If the worker binary is older and cannot persist recovery tokens, the depairing can recur. Mitigation: diagnostics should state whether a successful post-repair registration returned recovery metadata, and later worker update checks can be layered on top.
- The repair command is sensitive while valid. Mitigation: short TTL, explicit generation, no logging, no persistence, and clear expiration display.
- A generated repair credential could otherwise be reused to pair the wrong node. Mitigation: bind repair credentials to the registered node id and keep them out of ordinary Quick Pairing lists.
- A disconnected node may not have a trusted retained platform snapshot. Mitigation: use live capabilities when available, otherwise require the operator to choose Windows before generating a Windows-only repair command.
