# Bigchange: Remote Worker Nodes

## Overview

Add multi-machine support to the AI Orchestrator so a single instance running on the Mac (the **coordinator**) can dispatch work to one or more **worker nodes** running on remote machines (e.g. the Windows PC). This enables workload offloading — browser automation, GPU-heavy tasks, and parallel compilation can run on worker nodes while the coordinator stays responsive for orchestration, Discord/WhatsApp messaging, and the user's day-to-day work.

### Primary Use Case

- Mac (M5 Max) runs the Orchestrator GUI, Discord/WhatsApp channels, orchestration logic
- Windows PC (Ryzen 9 9950X3D / RTX 5090 / 96GB RAM) runs a headless worker node
- Browser automation tasks are routed to the Windows node so the Mac is never "blocked"
- GPU-accelerated workloads (local model inference, indexing) offloaded to Windows
- Parallel worktree tasks can be split across both machines

### Design Principles

1. **Minimal disruption** — extend existing patterns (singletons, adapters, EventEmitter) rather than replacing them
2. **Coordinator stays the brain** — all routing, orchestration, and channel logic stays on the coordinator; worker nodes are "dumb hands"
3. **Progressive adoption** — local instances work exactly as before; remote is opt-in per-instance or per-task
4. **Security first** — mutual TLS, token auth, no open ports by default (SSH tunnel or WireGuard)
5. **Self-contained** — the worker agent is built entirely within this repo using our existing CLI adapters; no external agent framework dependencies

---

## Phase 1: Foundation — Worker Node Agent & Registry

### 1.1 New: `src/main/remote-node/` Domain

Create a new domain with these files:

```
src/main/remote-node/
├── index.ts                    # Exports, singleton getters
├── worker-node.types.ts        # Shared types
├── worker-node-registry.ts     # Tracks connected worker nodes
├── worker-node-connection.ts   # WebSocket client/server for node comms
├── worker-node-rpc.ts          # RPC protocol (spawn, send, terminate, etc.)
├── worker-node-health.ts       # Heartbeat, capability reporting
└── __tests__/
```

### 1.2 Types: `worker-node.types.ts`

```typescript
export type NodePlatform = 'darwin' | 'win32' | 'linux';

export interface WorkerNodeCapabilities {
  platform: NodePlatform;
  arch: string;                          // 'arm64', 'x64'
  cpuCores: number;
  totalMemoryMB: number;
  availableMemoryMB: number;
  gpuName?: string;                      // 'NVIDIA RTX 5090'
  gpuMemoryMB?: number;
  supportedClis: CanonicalCliType[];     // Which CLIs are installed
  hasBrowserRuntime: boolean;            // Chrome/Edge available
  hasBrowserMcp: boolean;               // Chrome MCP extension connected
  hasDocker: boolean;                    // Container isolation available
  maxConcurrentInstances: number;
  workingDirectories: string[];          // Mounted/available project paths
}

export interface WorkerNodeInfo {
  id: string;                            // Stable UUID, persisted in node config
  name: string;                          // User-friendly name ("windows-pc", "mac-mini")
  address: string;                       // WebSocket URL (wss://...)
  capabilities: WorkerNodeCapabilities;
  status: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  connectedAt?: number;
  lastHeartbeat?: number;
  activeInstances: number;
  latencyMs?: number;                    // Round-trip ping
}

export type ExecutionLocation =
  | { type: 'local' }
  | { type: 'remote'; nodeId: string };

/**
 * Preferences for where to execute an instance.
 * Used by the node selector to pick the best node.
 */
export interface NodePlacementPrefs {
  /** Require browser automation capability */
  requiresBrowser?: boolean;
  /** Require GPU */
  requiresGpu?: boolean;
  /** Prefer a specific platform */
  preferPlatform?: NodePlatform;
  /** Prefer a specific node by ID */
  preferNodeId?: string;
  /** Require specific CLI provider available */
  requiresCli?: CanonicalCliType;
  /** Require specific working directory available on node */
  requiresWorkingDirectory?: string;
}
```

### 1.3 Worker Node Registry: `worker-node-registry.ts`

Singleton that tracks all connected worker nodes.

```typescript
export class WorkerNodeRegistry extends EventEmitter {
  private static instance: WorkerNodeRegistry;
  private nodes = new Map<string, WorkerNodeInfo>();

  static getInstance(): WorkerNodeRegistry { ... }
  static _resetForTesting(): void { ... }

  registerNode(info: WorkerNodeInfo): void;
  deregisterNode(nodeId: string): void;
  getNode(nodeId: string): WorkerNodeInfo | undefined;
  getAllNodes(): WorkerNodeInfo[];
  getHealthyNodes(): WorkerNodeInfo[];

  /**
   * Select the best node for an instance based on placement preferences.
   * Returns null if no suitable node found (fall back to local).
   */
  selectNode(prefs: NodePlacementPrefs): WorkerNodeInfo | null;

  updateNodeMetrics(nodeId: string, partial: Partial<WorkerNodeInfo>): void;
  updateHeartbeat(nodeId: string, capabilities: WorkerNodeCapabilities): void;
}

export function getWorkerNodeRegistry(): WorkerNodeRegistry {
  return WorkerNodeRegistry.getInstance();
}
```

Node selection scoring:

```
Score = (capability match * 100)
      + (platform preference * 20)
      + (available memory / total memory * 30)
      + (inverse active instances * 25)
      + (inverse latency * 10)
      - (missing working directory * 200)  // hard penalty
```

### 1.4 WebSocket Connection: `worker-node-connection.ts`

The coordinator runs a WebSocket server; worker nodes connect to it.

```typescript
export class WorkerNodeConnectionServer extends EventEmitter {
  private wss: WebSocket.Server | null = null;
  private connections = new Map<string, WebSocket>();

  async start(port: number, host?: string): Promise<void>;
  async stop(): Promise<void>;

  /** Send an RPC request to a specific node and await the response */
  sendRpc<T>(nodeId: string, method: string, params: unknown): Promise<T>;

  /** Send a fire-and-forget message to a node */
  sendNotification(nodeId: string, method: string, params: unknown): void;

  /** Broadcast to all connected nodes */
  broadcast(method: string, params: unknown): void;
}
```

Protocol is JSON-RPC 2.0 over WebSocket with these methods:

| Direction | Method | Description |
|-----------|--------|-------------|
| Node → Coordinator | `node.register` | Initial handshake with capabilities |
| Node → Coordinator | `node.heartbeat` | Periodic health + metrics |
| Node → Coordinator | `instance.output` | Streaming output from remote instance |
| Node → Coordinator | `instance.stateChange` | Status transitions |
| Node → Coordinator | `instance.permissionRequest` | Tool approval prompts |
| Coordinator → Node | `instance.spawn` | Create a new CLI instance |
| Coordinator → Node | `instance.sendInput` | Send user message to instance |
| Coordinator → Node | `instance.terminate` | Kill an instance |
| Coordinator → Node | `instance.interrupt` | Interrupt current operation |
| Coordinator → Node | `instance.hibernate` | Hibernate an instance |
| Coordinator → Node | `instance.wake` | Wake a hibernated instance |
| Coordinator → Node | `node.ping` | Latency measurement |

### 1.5 Heartbeat & Health: `worker-node-health.ts`

```typescript
export class WorkerNodeHealth {
  private intervals = new Map<string, NodeJS.Timeout>();

  /** Start monitoring a connected node (every 10s) */
  startMonitoring(nodeId: string): void;

  /** Stop monitoring (on disconnect) */
  stopMonitoring(nodeId: string): void;

  /** Mark node as degraded after 3 missed heartbeats, disconnected after 5 */
  private checkHealth(nodeId: string): void;
}
```

---

## Phase 2: Remote CLI Adapter & Instance Lifecycle

### 2.1 Extend Instance Types

Add `executionLocation` to `Instance` and `InstanceCreateConfig`:

**File: `src/shared/types/instance.types.ts`**

```typescript
// Add to Instance interface:
export interface Instance {
  // ... existing fields ...

  /** Where this instance is executing */
  executionLocation: ExecutionLocation;

  /** Remote process handle (replaces processId for remote instances) */
  remoteProcessHandle?: string;
}

// Add to InstanceCreateConfig:
export interface InstanceCreateConfig {
  // ... existing fields ...

  /** Placement preferences for remote execution */
  nodePlacement?: NodePlacementPrefs;

  /** Force execution on a specific node (overrides placement logic) */
  forceNodeId?: string;
}
```

Update `createInstance()` factory to set `executionLocation: { type: 'local' }` by default.

### 2.2 New: Remote CLI Adapter

**File: `src/main/cli/adapters/remote-cli-adapter.ts`**

This adapter implements the same interface as local adapters but proxies everything over the worker node RPC connection.

```typescript
export class RemoteCliAdapter extends EventEmitter {
  private nodeId: string;
  private remoteInstanceId: string | null = null;

  constructor(
    private nodeConnection: WorkerNodeConnectionServer,
    private targetNodeId: string,
    private spawnOptions: UnifiedSpawnOptions
  ) { ... }

  async spawn(): Promise<void> {
    // RPC: instance.spawn → remote node
    // Remote node creates a *real* CLI adapter locally and spawns
    // Returns remoteInstanceId
    const result = await this.nodeConnection.sendRpc<{ instanceId: string }>(
      this.targetNodeId,
      'instance.spawn',
      this.spawnOptions
    );
    this.remoteInstanceId = result.instanceId;
  }

  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    // RPC: instance.sendInput → remote node
    // Attachments are base64-encoded in the RPC payload
    await this.nodeConnection.sendRpc(this.targetNodeId, 'instance.sendInput', {
      instanceId: this.remoteInstanceId,
      message,
      attachments,
    });
  }

  getStatus(): CliStatus { ... }

  async interrupt(): Promise<void> {
    await this.nodeConnection.sendRpc(this.targetNodeId, 'instance.interrupt', {
      instanceId: this.remoteInstanceId,
    });
  }

  async terminate(): Promise<void> {
    await this.nodeConnection.sendRpc(this.targetNodeId, 'instance.terminate', {
      instanceId: this.remoteInstanceId,
    });
  }

  // Output events arrive via node.instanceOutput RPC from the worker
  // The WorkerNodeConnectionServer routes these to the correct RemoteCliAdapter
  handleRemoteOutput(message: { type: string; content: string; timestamp: number }): void {
    this.emit('output', message);
  }

  handleRemoteExit(code: number): void {
    this.emit('exit', { code });
  }

  handleRemoteStateChange(status: string): void {
    this.emit('stateChange', status);
  }
}
```

### 2.3 Extend Adapter Factory

**File: `src/main/cli/adapters/adapter-factory.ts`**

Add a new branch to `createCliAdapter()`:

```typescript
export function createCliAdapter(
  cliType: CliType,
  options: UnifiedSpawnOptions,
  executionLocation?: ExecutionLocation
): CliAdapter | RemoteCliAdapter {
  // If remote, create a RemoteCliAdapter regardless of CLI type
  if (executionLocation?.type === 'remote') {
    const connection = getWorkerNodeConnectionServer();
    return new RemoteCliAdapter(connection, executionLocation.nodeId, {
      ...options,
      // The remote node will resolve CLI type locally
      requestedCliType: cliType,
    });
  }

  // Existing local adapter creation (unchanged)
  switch (cliType) {
    case 'claude': return createClaudeAdapter(options);
    case 'codex':  return createCodexAdapter(options);
    // ...
  }
}
```

### 2.4 Modify Instance Lifecycle

**File: `src/main/instance/instance-lifecycle.ts`**

In the instance creation flow (Phase 1 + Phase 2):

```typescript
// During Phase 1 (synchronous):
// Determine execution location based on placement prefs
const location = this.resolveExecutionLocation(config);
instance.executionLocation = location;

// During Phase 2 (async init):
// If remote, use RemoteCliAdapter instead of local adapter
if (instance.executionLocation.type === 'remote') {
  const adapter = createCliAdapter(resolvedCliType, spawnOptions, instance.executionLocation);
  // Wire up remote output events → instance output buffer
  // Wire up remote state changes → instance state machine
  // Wire up remote permission requests → observer server
} else {
  // Existing local spawn logic (unchanged)
}
```

New private method:

```typescript
private resolveExecutionLocation(config: InstanceCreateConfig): ExecutionLocation {
  // 1. Explicit node override
  if (config.forceNodeId) {
    const node = getWorkerNodeRegistry().getNode(config.forceNodeId);
    if (node?.status === 'connected') {
      return { type: 'remote', nodeId: config.forceNodeId };
    }
  }

  // 2. Placement preferences
  if (config.nodePlacement) {
    const node = getWorkerNodeRegistry().selectNode(config.nodePlacement);
    if (node) {
      return { type: 'remote', nodeId: node.id };
    }
  }

  // 3. Default: local
  return { type: 'local' };
}
```

---

## Phase 3: Worker Node Agent (Runs on Remote Machines)

### 3.1 New Package: `src/worker-agent/`

A lightweight headless Node.js process that runs on worker machines. It does NOT include Angular, Electron, or any UI — just the CLI adapter layer and a WebSocket client.

```
src/worker-agent/
├── index.ts                    # Entry point
├── worker-agent.ts             # Main agent class
├── worker-config.ts            # Configuration (coordinator URL, node ID, etc.)
├── local-instance-manager.ts   # Manages instances spawned on this machine
├── capability-reporter.ts      # Detects local capabilities (CLIs, browser, GPU)
└── package.json                # Separate package, minimal deps
```

### 3.2 Worker Agent Entry Point

```typescript
// src/worker-agent/index.ts
import { WorkerAgent } from './worker-agent';
import { loadWorkerConfig } from './worker-config';

const config = loadWorkerConfig();
const agent = new WorkerAgent(config);

agent.connect().then(() => {
  console.log(`Worker node "${config.name}" connected to coordinator`);
});

// Graceful shutdown
process.on('SIGINT', () => agent.disconnect());
process.on('SIGTERM', () => agent.disconnect());
```

### 3.3 Worker Agent Class

```typescript
export class WorkerAgent {
  private ws: WebSocket | null = null;
  private instances = new Map<string, CliAdapter>();  // local instances on this machine
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private config: WorkerConfig) {}

  async connect(): Promise<void> {
    // 1. Connect WebSocket to coordinator
    // 2. Send node.register with capabilities
    // 3. Start heartbeat interval (every 10s)
    // 4. Listen for RPC commands
  }

  // RPC handlers:
  private async handleSpawn(params: SpawnParams): Promise<{ instanceId: string }> {
    // Create a real CLI adapter locally (Claude, Codex, etc.)
    // Wire output events to send back to coordinator
    // Return local instance ID
  }

  private async handleSendInput(params: SendInputParams): Promise<void> {
    const adapter = this.instances.get(params.instanceId);
    await adapter?.sendInput(params.message);
  }

  private async handleTerminate(params: { instanceId: string }): Promise<void> {
    const adapter = this.instances.get(params.instanceId);
    await adapter?.terminate();
    this.instances.delete(params.instanceId);
  }
}
```

### 3.4 Configuration

Worker config file at `~/.orchestrator/worker-node.json`:

```json
{
  "nodeId": "uuid-persisted-on-first-run",
  "name": "windows-pc",
  "coordinatorUrl": "wss://192.168.1.100:4878",
  "authToken": "shared-secret-or-cert-path",
  "maxConcurrentInstances": 10,
  "workingDirectories": [
    "C:\\Users\\suas\\work",
    "D:\\projects"
  ]
}
```

### 3.5 Build & Distribution

The worker agent is built separately from the Electron app. The key challenge is
that the worker agent reuses CLI adapter code from `src/main/cli/` and utility
code from `src/main/logging/` and `src/main/security/`, but must NOT pull in
Electron or Angular dependencies.

**Shared code strategy: separate `tsconfig` + bundler tree-shaking**

The CLI adapters and their transitive dependencies are already pure Node.js code
with one exception: `src/main/cli/adapters/codex/app-server-broker.ts` imports
`electron`. The worker agent avoids this by importing only the adapter classes
directly (not the Codex app-server broker, which is a Codex-specific Electron
integration for the renderer process).

Dependency audit of code the worker agent imports:

| Module | Electron-free? | Notes |
|--------|---------------|-------|
| `src/main/cli/adapters/base-cli-adapter.ts` | ✅ | Uses `child_process`, `events`, logger |
| `src/main/cli/adapters/claude-cli-adapter.ts` | ✅ | Extends base adapter |
| `src/main/cli/adapters/codex-cli-adapter.ts` | ✅ | Extends base adapter (NOT app-server-broker) |
| `src/main/cli/adapters/gemini-cli-adapter.ts` | ✅ | Extends base adapter |
| `src/main/cli/adapters/copilot-sdk-adapter.ts` | ✅ | Extends base adapter |
| `src/main/cli/adapters/adapter-factory.ts` | ✅ | Pure factory function |
| `src/main/cli/cli-detection.ts` | ✅ | Uses `child_process` for `which` checks |
| `src/main/logging/logger.ts` | ✅ | Pure Node.js structured logging |
| `src/main/security/env-filter.ts` | ✅ | Pure function, no Electron deps |
| `src/main/cli/adapters/codex/app-server-broker.ts` | ❌ | `import { app } from 'electron'` — **excluded** |

**Build configuration:**

1. **`tsconfig.worker.json`** — extends the base `tsconfig.json` with a restricted
   `include` list and path aliases:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist/worker-agent",
    "rootDir": "src",
    "paths": {
      "@worker/*": ["src/worker-agent/*"],
      "@cli/*": ["src/main/cli/*"],
      "@logging/*": ["src/main/logging/*"],
      "@security/*": ["src/main/security/*"],
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": [
    "src/worker-agent/**/*.ts",
    "src/main/cli/**/*.ts",
    "src/main/logging/**/*.ts",
    "src/main/security/env-filter.ts",
    "src/shared/types/**/*.ts"
  ],
  "exclude": [
    "src/main/cli/adapters/codex/app-server-broker.ts",
    "**/*.spec.ts"
  ]
}
```

2. **`esbuild` bundle** — produces a single `dist/worker-agent/index.js` with all
   dependencies bundled. Tree-shaking eliminates any dead code paths. The
   `electron` module is marked as an external that will cause a clear error if
   accidentally imported:

```typescript
// build-worker-agent.ts (build script)
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/worker-agent/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/worker-agent/index.js',
  external: ['electron', 'better-sqlite3'],  // native modules loaded at runtime
  tsconfig: 'tsconfig.worker.json',
  banner: {
    js: '#!/usr/bin/env node',
  },
});
```

3. **CI gate** — the worker agent build runs as a separate step in CI. If it
   fails (e.g. someone adds an Electron import to a shared adapter), the build
   breaks immediately:

```bash
# In package.json scripts:
"build:worker-agent": "tsx build-worker-agent.ts && node -e \"require('./dist/worker-agent/index.js')\" --dry-run"
```

**Distribution:**

```bash
# Build worker agent as standalone Node.js app
npm run build:worker-agent

# Creates dist/worker-agent/
#   index.js        (bundled, no Electron/Angular deps)
#   package.json    (runtime deps only: ws, better-sqlite3)
```

Can be installed on Windows via:
```bash
# On Windows PC
npm install -g @orchestrator/worker-agent
orchestrator-worker --coordinator wss://mac.local:4878 --name windows-pc
```

Or run via NanoClaw as a skill.

---

## Phase 4: Browser Automation Offloading

### 4.1 Extend Channel Message Router

When a message implies browser work, route to a node with browser capabilities:

**File: `src/main/channels/channel-message-router.ts`**

```typescript
// In the routing logic, when creating a new instance for a browser task:
const nodePlacement: NodePlacementPrefs = {
  requiresBrowser: this.detectBrowserIntent(message.content),
};

// Pass to instance creation
const config: InstanceCreateConfig = {
  workingDirectory,
  initialPrompt: message.content,
  nodePlacement,
};
```

### 4.2 Browser Intent Detection

Simple heuristic in the message router:

```typescript
private detectBrowserIntent(content: string): boolean {
  const browserKeywords = [
    'browse', 'browser', 'website', 'web page', 'click',
    'screenshot', 'navigate', 'test in browser', 'open url',
    'selenium', 'playwright', 'e2e test', 'end-to-end',
    'chrome', 'scrape', 'crawl',
  ];
  const lower = content.toLowerCase();
  return browserKeywords.some(kw => lower.includes(kw));
}
```

### 4.3 Extend Discord Commands

Add new commands for node management:

```
/nodes                     — list connected worker nodes with status
/nodes <name>              — show details for a specific node
/run-on <node> <message>   — force a task to run on a specific node
/offload browser           — enable auto-offloading browser tasks
```

---

## Phase 5: Integration & Wiring

### 5.1 Main Process Initialization

**File: `src/main/index.ts`**

Add to startup sequence:

```typescript
// After existing initialization...
import { getWorkerNodeRegistry } from './remote-node';
import { WorkerNodeConnectionServer } from './remote-node/worker-node-connection';

// Initialize worker node subsystem
const nodeRegistry = getWorkerNodeRegistry();
const nodeServer = WorkerNodeConnectionServer.getInstance();

// Start WebSocket server for worker connections (configurable, off by default)
const remoteConfig = getRemoteNodeConfig();
if (remoteConfig.enabled) {
  await nodeServer.start(remoteConfig.port, remoteConfig.host);
}

// Wire node events to existing systems
nodeRegistry.on('node:connected', (node) => {
  logger.info('Worker node connected', { nodeId: node.id, name: node.name });
  getRemoteObserverServer().broadcast('node-state', { type: 'connected', node });
});

nodeRegistry.on('node:disconnected', (nodeId) => {
  // Handle instance failover for instances on this node
  handleNodeFailover(nodeId);
});
```

### 5.1.1 Node Failover: `handleNodeFailover()`

**File: `src/main/remote-node/node-failover.ts`**

When a worker node disconnects (5 missed heartbeats), the coordinator must clean up
the instances that were running on it. The failover strategy is deliberately
conservative — no automatic re-creation on another node, because the user may
want to wait for the node to reconnect rather than lose session context.

```typescript
import { getWorkerNodeRegistry } from './worker-node-registry';
import { getInstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';

const logger = getLogger('NodeFailover');

/** Grace period before marking instances as failed (allows brief reconnects) */
const FAILOVER_GRACE_MS = 30_000; // 30 seconds

/**
 * Handle a worker node disconnect.
 *
 * 1. Immediately mark all instances on the node as 'degraded' (UI shows warning).
 * 2. Start a grace period timer. If the node reconnects within the grace period,
 *    cancel failover and re-mark instances as healthy.
 * 3. After grace period expires, transition all instances to 'failed' status.
 *    - Emit 'instance:remote-lost' event per instance (for observer/UI updates).
 *    - Do NOT auto-recreate locally — the user can manually retry or re-route.
 * 4. Clean up remote process handles and decrement the node's activeInstances count.
 */
export function handleNodeFailover(nodeId: string): void {
  const registry = getWorkerNodeRegistry();
  const instanceManager = getInstanceManager();
  const affectedInstances = instanceManager.getInstancesByNode(nodeId);

  if (affectedInstances.length === 0) {
    logger.info('Node disconnected with no active instances', { nodeId });
    return;
  }

  logger.warn('Node disconnected, entering failover grace period', {
    nodeId,
    instanceCount: affectedInstances.length,
    gracePeriodMs: FAILOVER_GRACE_MS,
  });

  // Phase 1: Mark instances as degraded immediately
  for (const instance of affectedInstances) {
    instanceManager.updateInstanceStatus(instance.id, 'degraded', {
      reason: 'worker-node-disconnected',
      nodeId,
    });
  }

  // Phase 2: Grace period — if node reconnects, cancel failover
  const timer = setTimeout(() => {
    const node = registry.getNode(nodeId);
    if (node?.status === 'connected') {
      // Node reconnected during grace period — nothing to do
      return;
    }

    // Phase 3: Grace expired — mark all as failed
    logger.error('Node failover: grace period expired, marking instances as failed', {
      nodeId,
      instanceCount: affectedInstances.length,
    });

    for (const instance of affectedInstances) {
      instanceManager.updateInstanceStatus(instance.id, 'failed', {
        reason: 'worker-node-lost',
        nodeId,
      });
      instanceManager.emit('instance:remote-lost', {
        instanceId: instance.id,
        nodeId,
        lastKnownState: instance.status,
      });
    }
  }, FAILOVER_GRACE_MS);

  // If node reconnects during grace, cancel the timer
  const onReconnect = (reconnectedNode: { id: string }) => {
    if (reconnectedNode.id === nodeId) {
      clearTimeout(timer);
      registry.off('node:connected', onReconnect);

      logger.info('Node reconnected during grace period, cancelling failover', { nodeId });

      // Restore instance status
      for (const instance of affectedInstances) {
        instanceManager.updateInstanceStatus(instance.id, instance.status, {
          reason: 'worker-node-reconnected',
        });
      }
    }
  };

  registry.on('node:connected', onReconnect);

  // Safety: clean up listener after grace period either way
  setTimeout(() => {
    registry.off('node:connected', onReconnect);
  }, FAILOVER_GRACE_MS + 1000);
}
```

Required supporting method on `InstanceManager`:

```typescript
/** Return all instances executing on a given worker node */
getInstancesByNode(nodeId: string): Instance[] {
  return this.getAllInstances().filter(
    i => i.executionLocation?.type === 'remote' && i.executionLocation.nodeId === nodeId
  );
}
```

### 5.2 IPC Handlers

**New file: `src/main/ipc/handlers/remote-node-handlers.ts`**

```typescript
// IPC channels for the renderer to manage nodes:
ipcMain.handle('remote-node:list', () => getWorkerNodeRegistry().getAllNodes());
ipcMain.handle('remote-node:get', (_, nodeId) => getWorkerNodeRegistry().getNode(nodeId));
ipcMain.handle('remote-node:start-server', (_, config) => nodeServer.start(config.port, config.host));
ipcMain.handle('remote-node:stop-server', () => nodeServer.stop());
```

### 5.3 Preload Bridge

**File: `src/preload/preload.ts`**

Add to the exposed API:

```typescript
remoteNodes: {
  list: () => ipcRenderer.invoke('remote-node:list'),
  get: (nodeId: string) => ipcRenderer.invoke('remote-node:get', nodeId),
  startServer: (config: RemoteNodeServerConfig) => ipcRenderer.invoke('remote-node:start-server', config),
  stopServer: () => ipcRenderer.invoke('remote-node:stop-server'),
  onNodeEvent: (callback: (event: NodeEvent) => void) => {
    ipcRenderer.on('remote-node:event', (_, event) => callback(event));
  },
}
```

### 5.4 Extend Load Balancer

**File: `src/main/process/load-balancer.ts`**

```typescript
export interface LoadMetrics {
  // ... existing fields ...
  executionLocation?: ExecutionLocation;   // Where this instance is running
  nodeLatencyMs?: number;                   // Network latency to node
}

// In computeScore(), add network latency penalty for remote instances:
private computeScore(m: LoadMetrics): number {
  const taskScore = Math.min(m.activeTasks * 25, 100);
  const contextScore = m.contextUsagePercent;
  const pressureScore = PRESSURE_SCORES[m.memoryPressure] ?? 0;
  const latencyPenalty = m.nodeLatencyMs ? Math.min(m.nodeLatencyMs / 10, 20) : 0;

  return (
    this.config.weightActiveTasks * taskScore +
    this.config.weightContextUsage * contextScore +
    this.config.weightMemoryPressure * pressureScore +
    latencyPenalty
  );
}
```

### 5.5 Extend Resource Governor

**File: `src/main/process/resource-governor.ts`**

```typescript
// Per-node instance caps
isCreationAllowed(location?: ExecutionLocation): boolean {
  if (location?.type === 'remote') {
    const node = getWorkerNodeRegistry().getNode(location.nodeId);
    if (!node) return false;
    return node.activeInstances < node.capabilities.maxConcurrentInstances;
  }
  // Existing local logic
  return this.localCreationAllowed();
}
```

### 5.6 Extend Remote Observer

The existing observer server already broadcasts events to web clients. Extend it to include worker node state:

```typescript
// In RemoteObserverServer, add to buildSnapshot():
private buildSnapshot(): RemoteObserverSnapshot {
  return {
    status: this.getStatus(),
    instances: this.listInstances(),
    jobs: getRepoJobService().listJobs({ limit: 50 }),
    pendingPrompts: Array.from(this.prompts.values()),
    workerNodes: getWorkerNodeRegistry().getAllNodes(),  // NEW
  };
}
```

---

## Phase 6: Security

### 6.1 Connection Security

**Option A (Recommended for LAN): SSH Tunnel**
```bash
# On Mac, create tunnel to Windows PC:
ssh -L 4878:localhost:4878 user@windows-pc
# Worker agent connects to localhost:4878 on Windows
# Traffic encrypted via SSH
```

**Option B: Mutual TLS**
```typescript
// Coordinator generates CA + certs for each node
// worker-node.json includes cert/key paths
// WebSocket server requires client certs
```

**Option C: WireGuard VPN**
```bash
# Both machines on same WireGuard network
# Worker connects to coordinator's WireGuard IP
# All traffic encrypted at network layer
```

### 6.2 Authentication

Every RPC message includes the auth token. The coordinator validates on every request.

```typescript
// On connection:
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (!validateAuthToken(msg.token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  // ... handle RPC
});
```

### 6.3 Path Sandboxing

Worker nodes only allow spawning instances in configured `workingDirectories`. Any path outside these is rejected.

```typescript
// On worker agent, before spawning:
private validateWorkingDirectory(dir: string): boolean {
  return this.config.workingDirectories.some(allowed =>
    path.resolve(dir).startsWith(path.resolve(allowed))
  );
}
```

---

## Phase 7: Renderer UI (Angular)

### 7.1 New Feature Module: `remote-nodes`

```
src/renderer/app/features/remote-nodes/
├── remote-nodes-page.component.ts    # Node management page
├── node-card.component.ts            # Individual node status card
├── node-detail.component.ts          # Node detail view
└── remote-nodes.routes.ts
```

### 7.2 Node Status in Instance Cards

Extend existing instance cards to show execution location:

```typescript
// In instance card template, show a badge:
@if (instance.executionLocation.type === 'remote') {
  <span class="badge badge-remote">
    {{ getNodeName(instance.executionLocation.nodeId) }}
  </span>
}
```

### 7.3 Instance Creation Dialog

Add optional "Run on" dropdown to instance creation:

```typescript
// Node selection (optional, defaults to auto)
nodeOptions = computed(() => [
  { label: 'Auto (best available)', value: null },
  { label: 'Local', value: 'local' },
  ...this.workerNodes().map(n => ({ label: n.name, value: n.id })),
]);
```

---

## Implementation Order

| Step | What | Files | Depends On |
|------|------|-------|------------|
| 1 | Worker node types | `src/shared/types/worker-node.types.ts` | — |
| 2 | Worker node registry | `src/main/remote-node/worker-node-registry.ts` | Step 1 |
| 3 | WebSocket connection server | `src/main/remote-node/worker-node-connection.ts` | Step 2 |
| 4 | RPC protocol | `src/main/remote-node/worker-node-rpc.ts` | Step 3 |
| 5 | Health monitoring | `src/main/remote-node/worker-node-health.ts` | Step 2, 3 |
| 5a | Node failover handler | `src/main/remote-node/node-failover.ts` | Step 2, 5 |
| 6 | Add `executionLocation` to Instance | `src/shared/types/instance.types.ts` | Step 1 |
| 7 | RemoteCliAdapter | `src/main/cli/adapters/remote-cli-adapter.ts` | Step 3, 4 |
| 8 | Extend adapter factory | `src/main/cli/adapters/adapter-factory.ts` | Step 7 |
| 9 | Extend instance lifecycle | `src/main/instance/instance-lifecycle.ts` | Step 6, 7, 8 |
| 10 | Worker agent package | `src/worker-agent/` | Step 4 |
| 10a | Worker agent build config | `tsconfig.worker.json`, `build-worker-agent.ts` | Step 10 |
| 11 | IPC handlers | `src/main/ipc/handlers/remote-node-handlers.ts` | Step 2, 3 |
| 12 | Preload bridge | `src/preload/preload.ts` | Step 11 |
| 13 | Extend load balancer | `src/main/process/load-balancer.ts` | Step 2 |
| 14 | Extend resource governor | `src/main/process/resource-governor.ts` | Step 2 |
| 15 | Extend observer server | `src/main/remote/observer-server.ts` | Step 2 |
| 16 | Browser intent detection | `src/main/channels/channel-message-router.ts` | Step 9 |
| 17 | Discord node commands | `src/main/channels/channel-message-router.ts` | Step 2, 11 |
| 18 | Main process wiring | `src/main/index.ts` | Steps 2-5a |
| 19 | Angular node management UI | `src/renderer/app/features/remote-nodes/` | Step 11, 12 |
| 20 | Worker agent build pipeline | `package.json`, build scripts | Step 10a |

---

## Testing Strategy

### Unit Tests

- `WorkerNodeRegistry` — registration, selection scoring, health transitions
- `RemoteCliAdapter` — spawn/sendInput/terminate via mock RPC
- `WorkerNodeHealth` — heartbeat tracking, degraded/disconnected transitions
- `handleNodeFailover()` — grace period, degraded→failed transition, reconnect cancellation
- `resolveExecutionLocation()` — placement logic with various prefs
- `detectBrowserIntent()` — keyword matching
- `WorkerAgent` — RPC handler dispatch
- Worker agent build — verify `tsconfig.worker.json` excludes Electron imports

### Integration Tests

- Coordinator ↔ Worker agent WebSocket handshake and RPC
- Remote instance lifecycle: spawn → output streaming → terminate
- Node failover: disconnect node → instances degraded → grace expires → instances failed
- Node failover with reconnect: disconnect → grace period → reconnect → instances restored
- Browser task routing: message → detect intent → route to remote node

### E2E Tests

- Start coordinator + worker agent on localhost
- Create instance via Discord → verify runs on worker
- Browser automation task → verify offloaded to node with browser
- Node disconnect → verify graceful degradation

---

## Configuration

### Coordinator Settings (via Settings UI)

```typescript
interface RemoteNodeConfig {
  enabled: boolean;                    // Master switch (default: false)
  serverPort: number;                  // WebSocket port (default: 4878)
  serverHost: string;                  // Bind address (default: '127.0.0.1')
  authToken?: string;                  // Shared secret (auto-generated if empty)
  autoOffloadBrowser: boolean;         // Auto-route browser tasks (default: true)
  autoOffloadGpu: boolean;             // Auto-route GPU tasks (default: false)
  maxRemoteInstances: number;          // Global cap on remote instances (default: 20)
}
```

### Worker Agent Settings

```typescript
interface WorkerConfig {
  nodeId: string;                      // Stable UUID
  name: string;                        // Display name
  coordinatorUrl: string;              // wss://... (required)
  authToken: string;                   // Must match coordinator
  maxConcurrentInstances: number;      // Default: 10
  workingDirectories: string[];        // Allowed project paths
  reconnectIntervalMs: number;         // Default: 5000
  heartbeatIntervalMs: number;         // Default: 10000
}
```

---

## Why Not NanoClaw / OpenClaw as a Dependency

The worker agent concept is architecturally similar to NanoClaw's container runtime (~500 lines of TypeScript), but we're building our own for good reasons:

1. **We only need the worker concept, not the messaging stack.** NanoClaw bundles WhatsApp/Telegram/Discord integrations, container orchestration, and a skill system. We already have all of that in the orchestrator — taking a dependency would mean two competing messaging layers, two skill systems, and two container models.

2. **Our CLI adapter layer is richer.** NanoClaw only supports Claude via the Agent SDK. We support Claude, Codex, Gemini, and Copilot with automatic failover. The worker agent reuses our `BaseCliAdapter` and adapter factory directly.

3. **The worker agent is ~300-400 lines.** It's a WebSocket client, an RPC dispatcher, a local instance map, and a capability reporter. There's no justification for an external dependency when the code is this small and this tightly coupled to our RPC protocol.

4. **Auditability.** Having the worker agent in our repo means one codebase, one build pipeline, one set of types. No version skew, no upstream breaking changes.

If we later want container isolation on worker nodes (Apple Container on macOS, Docker on Linux/Windows), we can add that ourselves without importing NanoClaw's opinionated runtime.

---

## Open Questions

1. **File synchronization**: When a remote instance needs files from the coordinator's filesystem (CLAUDE.md, project files), should we sync on demand via RPC, use a shared network drive, or git clone?
   - **Recommended**: Git-based — worker nodes clone the same repos. CLAUDE.md files are small enough to send via RPC at spawn time.

2. **Session persistence**: Remote instance sessions live on the worker machine. Should session data be synced back to the coordinator for the observer/history UI?
   - **Recommended**: Yes, stream session events back. Full session replay data stays on the worker but the coordinator keeps a summary.

3. **Multiple coordinators**: Should we support multiple coordinators for redundancy?
   - **Recommended**: No, not in MVP. One coordinator is the brain. If it goes down, worker nodes pause and reconnect when it comes back.

4. **Cross-node communication bridges**: Can two instances on different nodes communicate via CrossInstanceCommService?
   - **Recommended**: Yes, but messages route through the coordinator. The coordinator acts as a message relay between nodes.

5. **Cost tracking**: Remote instances use API keys configured on the worker machine. Should cost data flow back to coordinator?
   - **Recommended**: Yes, include cost estimates in the `instance.output` events so the coordinator's cost tracker stays accurate.
