# Remote Worker Nodes — Phase 5 Integration & Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Phase 1 & 2 remote-node infrastructure into the main process so that worker nodes can connect, instances can be routed to remote nodes, and the renderer UI can query node state.

**Architecture:** The coordinator's `index.ts` startup sequence initializes the worker node subsystem (registry, connection server, health monitor). An RPC event router connects incoming WebSocket messages to the appropriate services. `resolveExecutionLocation` in instance lifecycle determines where instances run. IPC handlers + preload bridge expose node management to the Angular renderer. Load balancer, resource governor, and observer server gain remote-node awareness.

**Tech Stack:** TypeScript 5.9, Electron IPC, Zod 4 validation, Vitest

**Depends on:** `feat/remote-nodes-phase1-phase2` branch (Phase 1 & 2 complete)

**Status:** ✅ ALL TASKS COMPLETE (verified 2026-04-03)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/main/remote-node/rpc-event-router.ts` | Routes inbound RPC messages from worker nodes to registry, health monitor, and remote CLI adapters |
| `src/main/remote-node/remote-node-config.ts` | Configuration type and loader for remote node server settings |
| `src/main/remote-node/__tests__/rpc-event-router.spec.ts` | RPC router unit tests |
| `src/main/ipc/handlers/remote-node-handlers.ts` | IPC handlers for renderer to manage nodes |

### Modified Files

| File | Change |
|------|--------|
| `src/main/remote-node/index.ts` | Export new modules |
| `src/main/index.ts` | Add worker node initialization to startup sequence |
| `src/main/instance/instance-lifecycle.ts` | Add `resolveExecutionLocation` method, pass `executionLocation` to `createCliAdapter` |
| `src/main/instance/instance-manager.ts` | Add `getInstancesByNode()` method |
| `src/main/process/load-balancer.ts` | Add `nodeLatencyMs` to `LoadMetrics`, latency penalty in `computeScore` |
| `src/main/process/resource-governor.ts` | Add `isRemoteCreationAllowed()` method |
| `src/main/remote/observer-server.ts` | Add `workerNodes` to snapshot |
| `src/shared/types/ipc.types.ts` | Add remote-node IPC channel constants |
| `src/preload/preload.ts` | Add remote-node API methods and channels |
| `src/main/ipc/handlers/index.ts` | Export new handler registration |
| `src/main/ipc/ipc-main-handler.ts` | Call `registerRemoteNodeHandlers()` |

---

## Task 1: Remote Node Configuration

**Files:**
- Create: `src/main/remote-node/remote-node-config.ts`

- [x] **Step 1: Create the config type and loader**

```typescript
// src/main/remote-node/remote-node-config.ts

export interface RemoteNodeConfig {
  /** Master switch — remote node subsystem is off by default */
  enabled: boolean;
  /** WebSocket server port for worker connections */
  serverPort: number;
  /** Bind address for the WebSocket server */
  serverHost: string;
  /** Shared secret for node authentication (auto-generated if empty) */
  authToken?: string;
  /** Auto-route browser tasks to nodes with browser capability */
  autoOffloadBrowser: boolean;
  /** Auto-route GPU tasks to nodes with GPU */
  autoOffloadGpu: boolean;
  /** Global cap on total remote instances */
  maxRemoteInstances: number;
}

const DEFAULT_CONFIG: RemoteNodeConfig = {
  enabled: false,
  serverPort: 4878,
  serverHost: '127.0.0.1',
  autoOffloadBrowser: true,
  autoOffloadGpu: false,
  maxRemoteInstances: 20,
};

let currentConfig: RemoteNodeConfig = { ...DEFAULT_CONFIG };

export function getRemoteNodeConfig(): RemoteNodeConfig {
  return currentConfig;
}

export function updateRemoteNodeConfig(partial: Partial<RemoteNodeConfig>): void {
  currentConfig = { ...currentConfig, ...partial };
}

/** Reset to defaults (for testing) */
export function resetRemoteNodeConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
}
```

- [x] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

- [x] **Step 3: Commit**

```bash
git add src/main/remote-node/remote-node-config.ts
git commit -m "feat(remote-node): add remote node configuration with defaults"
```

---

## Task 2: RPC Event Router

**Files:**
- Create: `src/main/remote-node/rpc-event-router.ts`
- Test: `src/main/remote-node/__tests__/rpc-event-router.spec.ts`

The RPC event router listens to inbound messages from the connection server and dispatches them to the appropriate services: heartbeats go to registry, output goes to remote CLI adapters, state changes go to instance manager.

- [x] **Step 1: Write the RPC router tests**

```typescript
// src/main/remote-node/__tests__/rpc-event-router.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { RpcEventRouter } from '../rpc-event-router';
import { WorkerNodeRegistry } from '../worker-node-registry';
import { WorkerNodeHealth } from '../worker-node-health';
import type { RpcRequest, RpcNotification } from '../worker-node-rpc';

// Mock dependencies
vi.mock('../worker-node-health', () => ({
  getWorkerNodeHealth: vi.fn(() => mockHealth),
}));

const mockHealth = {
  startMonitoring: vi.fn(),
  stopMonitoring: vi.fn(),
};

describe('RpcEventRouter', () => {
  let router: RpcEventRouter;
  let mockConnection: EventEmitter;
  let registry: WorkerNodeRegistry;

  beforeEach(() => {
    WorkerNodeRegistry._resetForTesting();
    registry = WorkerNodeRegistry.getInstance();
    mockConnection = new EventEmitter();
    vi.clearAllMocks();
    router = new RpcEventRouter(mockConnection as any, registry);
    router.start();
  });

  describe('node:ws-connected', () => {
    it('should start health monitoring when a node WebSocket connects', () => {
      mockConnection.emit('node:ws-connected', 'node-1');
      // Health monitoring starts after register RPC, not ws-connected
      // This is just the WebSocket layer — register comes next
    });
  });

  describe('node:ws-disconnected', () => {
    it('should stop health monitoring and deregister node', () => {
      // Pre-register the node
      registry.registerNode({
        id: 'node-1',
        name: 'test',
        address: 'wss://localhost:4878',
        capabilities: {
          platform: 'win32', arch: 'x64', cpuCores: 8,
          totalMemoryMB: 32768, availableMemoryMB: 16000,
          supportedClis: ['claude'], hasBrowserRuntime: false,
          hasBrowserMcp: false, hasDocker: false,
          maxConcurrentInstances: 10, workingDirectories: [],
        },
        status: 'connected',
        activeInstances: 0,
      });

      mockConnection.emit('node:ws-disconnected', 'node-1');

      expect(mockHealth.stopMonitoring).toHaveBeenCalledWith('node-1');
    });
  });

  describe('rpc:request — node.register', () => {
    it('should register node in registry and start health monitoring', () => {
      const request: RpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'node.register',
        params: {
          nodeId: 'node-1',
          name: 'windows-pc',
          capabilities: {
            platform: 'win32', arch: 'x64', cpuCores: 16,
            totalMemoryMB: 65536, availableMemoryMB: 40000,
            supportedClis: ['claude', 'codex'],
            hasBrowserRuntime: true, hasBrowserMcp: false,
            hasDocker: true, maxConcurrentInstances: 10,
            workingDirectories: ['/projects'],
          },
        },
      };

      mockConnection.emit('rpc:request', 'node-1', request);

      const node = registry.getNode('node-1');
      expect(node).toBeDefined();
      expect(node?.name).toBe('windows-pc');
      expect(node?.status).toBe('connected');
      expect(mockHealth.startMonitoring).toHaveBeenCalledWith('node-1');
    });
  });

  describe('rpc:request — node.heartbeat', () => {
    it('should update heartbeat in registry', () => {
      // Register first
      registry.registerNode({
        id: 'node-1', name: 'test', address: 'wss://localhost:4878',
        capabilities: {
          platform: 'win32', arch: 'x64', cpuCores: 8,
          totalMemoryMB: 32768, availableMemoryMB: 16000,
          supportedClis: ['claude'], hasBrowserRuntime: false,
          hasBrowserMcp: false, hasDocker: false,
          maxConcurrentInstances: 10, workingDirectories: [],
        },
        status: 'connected', activeInstances: 0,
      });

      const request: RpcRequest = {
        jsonrpc: '2.0', id: 2, method: 'node.heartbeat',
        params: {
          capabilities: {
            platform: 'win32', arch: 'x64', cpuCores: 8,
            totalMemoryMB: 32768, availableMemoryMB: 8000,
            supportedClis: ['claude'], hasBrowserRuntime: false,
            hasBrowserMcp: false, hasDocker: false,
            maxConcurrentInstances: 10, workingDirectories: [],
          },
        },
      };

      mockConnection.emit('rpc:request', 'node-1', request);

      const node = registry.getNode('node-1');
      expect(node?.capabilities.availableMemoryMB).toBe(8000);
      expect(node?.lastHeartbeat).toBeGreaterThan(0);
    });
  });

  describe('stop', () => {
    it('should remove all event listeners', () => {
      router.stop();
      expect(mockConnection.listenerCount('rpc:request')).toBe(0);
      expect(mockConnection.listenerCount('node:ws-connected')).toBe(0);
      expect(mockConnection.listenerCount('node:ws-disconnected')).toBe(0);
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/main/remote-node/__tests__/rpc-event-router.spec.ts
```

Expected: FAIL — module not found

- [x] **Step 3: Implement the RPC event router**

```typescript
// src/main/remote-node/rpc-event-router.ts
import { getLogger } from '../logging/logger';
import type { WorkerNodeRegistry } from './worker-node-registry';
import type { WorkerNodeConnectionServer } from './worker-node-connection';
import { getWorkerNodeHealth } from './worker-node-health';
import { NODE_TO_COORDINATOR, createRpcResponse } from './worker-node-rpc';
import type { RpcRequest, RpcNotification } from './worker-node-rpc';
import type { WorkerNodeCapabilities } from '../../shared/types/worker-node.types';

const logger = getLogger('RpcEventRouter');

/**
 * Routes inbound RPC messages from worker nodes to the appropriate services.
 *
 * Listens on WorkerNodeConnectionServer events and dispatches:
 * - node.register → WorkerNodeRegistry.registerNode + start health monitoring
 * - node.heartbeat → WorkerNodeRegistry.updateHeartbeat
 * - instance.output → emitted as 'remote:instance-output' for adapter routing
 * - instance.stateChange → emitted as 'remote:instance-state-change'
 * - instance.permissionRequest → emitted as 'remote:instance-permission-request'
 * - node:ws-disconnected → stop health monitoring, handle failover
 */
export class RpcEventRouter {
  private started = false;
  private boundHandlers: {
    onRequest: (nodeId: string, request: RpcRequest) => void;
    onNotification: (nodeId: string, notification: RpcNotification) => void;
    onWsConnected: (nodeId: string) => void;
    onWsDisconnected: (nodeId: string) => void;
  };

  constructor(
    private connection: WorkerNodeConnectionServer,
    private registry: WorkerNodeRegistry,
  ) {
    this.boundHandlers = {
      onRequest: this.handleRequest.bind(this),
      onNotification: this.handleNotification.bind(this),
      onWsConnected: this.handleWsConnected.bind(this),
      onWsDisconnected: this.handleWsDisconnected.bind(this),
    };
  }

  start(): void {
    if (this.started) return;
    this.connection.on('rpc:request', this.boundHandlers.onRequest);
    this.connection.on('rpc:notification', this.boundHandlers.onNotification);
    this.connection.on('node:ws-connected', this.boundHandlers.onWsConnected);
    this.connection.on('node:ws-disconnected', this.boundHandlers.onWsDisconnected);
    this.started = true;
    logger.info('RPC event router started');
  }

  stop(): void {
    if (!this.started) return;
    this.connection.off('rpc:request', this.boundHandlers.onRequest);
    this.connection.off('rpc:notification', this.boundHandlers.onNotification);
    this.connection.off('node:ws-connected', this.boundHandlers.onWsConnected);
    this.connection.off('node:ws-disconnected', this.boundHandlers.onWsDisconnected);
    this.started = false;
    logger.info('RPC event router stopped');
  }

  private handleWsConnected(nodeId: string): void {
    logger.info('Worker node WebSocket connected, awaiting registration', { nodeId });
  }

  private handleWsDisconnected(nodeId: string): void {
    logger.warn('Worker node WebSocket disconnected', { nodeId });
    getWorkerNodeHealth().stopMonitoring(nodeId);
    // Deregistration triggers 'node:disconnected' event on registry,
    // which is handled by index.ts to call handleNodeFailover
    if (this.registry.getNode(nodeId)) {
      this.registry.deregisterNode(nodeId);
    }
  }

  private handleRequest(nodeId: string, request: RpcRequest): void {
    const params = request.params as Record<string, unknown> | undefined;

    switch (request.method) {
      case NODE_TO_COORDINATOR.REGISTER:
        this.handleNodeRegister(nodeId, params, request.id);
        break;

      case NODE_TO_COORDINATOR.HEARTBEAT:
        this.handleNodeHeartbeat(nodeId, params);
        this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
        break;

      case NODE_TO_COORDINATOR.INSTANCE_OUTPUT:
        this.registry.emit('remote:instance-output', {
          nodeId,
          instanceId: params?.instanceId,
          message: params?.message,
        });
        this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
        break;

      case NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE:
        this.registry.emit('remote:instance-state-change', {
          nodeId,
          instanceId: params?.instanceId,
          status: params?.status,
        });
        this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
        break;

      case NODE_TO_COORDINATOR.INSTANCE_PERMISSION_REQUEST:
        this.registry.emit('remote:instance-permission-request', {
          nodeId,
          instanceId: params?.instanceId,
          payload: params?.payload,
        });
        this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
        break;

      default:
        logger.warn('Unknown RPC method from node', { nodeId, method: request.method });
        break;
    }
  }

  private handleNotification(nodeId: string, notification: RpcNotification): void {
    // Notifications are fire-and-forget — no response needed
    const params = notification.params as Record<string, unknown> | undefined;

    if (notification.method === NODE_TO_COORDINATOR.HEARTBEAT) {
      this.handleNodeHeartbeat(nodeId, params);
    }
  }

  private handleNodeRegister(
    nodeId: string,
    params: Record<string, unknown> | undefined,
    requestId: string | number,
  ): void {
    if (!params) {
      logger.warn('Node register missing params', { nodeId });
      return;
    }

    const capabilities = params.capabilities as WorkerNodeCapabilities;
    const name = (params.name as string) || nodeId;

    this.registry.registerNode({
      id: nodeId,
      name,
      address: '', // Set by connection server
      capabilities,
      status: 'connected',
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      activeInstances: 0,
    });

    getWorkerNodeHealth().startMonitoring(nodeId);
    logger.info('Worker node registered', { nodeId, name, platform: capabilities.platform });
  }

  private handleNodeHeartbeat(
    nodeId: string,
    params: Record<string, unknown> | undefined,
  ): void {
    if (!params?.capabilities) return;
    this.registry.updateHeartbeat(nodeId, params.capabilities as WorkerNodeCapabilities);
  }
}
```

- [x] **Step 4: Run tests**

```bash
npx vitest run src/main/remote-node/__tests__/rpc-event-router.spec.ts
```

Expected: all tests PASS

- [x] **Step 5: Commit**

```bash
git add src/main/remote-node/rpc-event-router.ts src/main/remote-node/__tests__/rpc-event-router.spec.ts
git commit -m "feat(remote-node): add RPC event router for inbound node messages"
```

---

## Task 3: Add `getInstancesByNode` to InstanceManager

**Files:**
- Modify: `src/main/instance/instance-manager.ts`

This method is required by the failover handler and by the resource governor extension.

- [x] **Step 1: Read the file to find the right location**

Read `src/main/instance/instance-manager.ts` around lines 561-580 (near `getAllInstances` and `getInstanceCount`).

- [x] **Step 2: Add `getInstancesByNode` method**

Add after `getInstanceCount()`:

```typescript
/** Return all instances executing on a given worker node */
getInstancesByNode(nodeId: string): Instance[] {
  return this.state.getAllInstances().filter(
    (i) => i.executionLocation?.type === 'remote' && i.executionLocation.nodeId === nodeId
  );
}
```

- [x] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [x] **Step 4: Commit**

```bash
git add src/main/instance/instance-manager.ts
git commit -m "feat(remote-node): add getInstancesByNode to InstanceManager"
```

---

## Task 4: Extend Load Balancer

**Files:**
- Modify: `src/main/process/load-balancer.ts`
- Modify: `src/main/process/load-balancer.spec.ts`

- [x] **Step 1: Read load-balancer.ts to find LoadMetrics and computeScore**

Read `src/main/process/load-balancer.ts` lines 7-13 (LoadMetrics) and 143-153 (computeScore).

- [x] **Step 2: Add `nodeLatencyMs` to LoadMetrics**

```typescript
export interface LoadMetrics {
  activeTasks: number;
  contextUsagePercent: number;
  memoryPressure: MemoryPressureLevel;
  status: string;
  lastUpdated?: number;
  /** Network latency to remote node (undefined for local instances) */
  nodeLatencyMs?: number;
}
```

- [x] **Step 3: Add latency penalty to computeScore**

```typescript
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

- [x] **Step 4: Add a test for latency penalty**

Add to `load-balancer.spec.ts`:

```typescript
it('should penalize remote instances with high latency', () => {
  balancer.updateMetrics('local-1', {
    activeTasks: 1,
    contextUsagePercent: 50,
    memoryPressure: 'normal',
    status: 'busy',
  });
  balancer.updateMetrics('remote-1', {
    activeTasks: 1,
    contextUsagePercent: 50,
    memoryPressure: 'normal',
    status: 'busy',
    nodeLatencyMs: 200,
  });
  // Local should be preferred (lower score = less loaded)
  const selected = balancer.selectLeastLoaded(['local-1', 'remote-1']);
  expect(selected).toBe('local-1');
});
```

- [x] **Step 5: Run tests**

```bash
npx vitest run src/main/process/load-balancer.spec.ts
```

- [x] **Step 6: Commit**

```bash
git add src/main/process/load-balancer.ts src/main/process/load-balancer.spec.ts
git commit -m "feat(remote-node): add network latency penalty to load balancer scoring"
```

---

## Task 5: Extend Resource Governor

**Files:**
- Modify: `src/main/process/resource-governor.ts`

- [x] **Step 1: Read resource-governor.ts to find isCreationAllowed**

Read `src/main/process/resource-governor.ts` lines 144-159.

- [x] **Step 2: Add `isRemoteCreationAllowed` method**

Add after `isCreationAllowed()`:

```typescript
/**
 * Check if creation is allowed on a specific remote node.
 * Checks node's own capacity limit independently from local limits.
 */
isRemoteCreationAllowed(nodeId: string): boolean {
  try {
    const { getWorkerNodeRegistry } = require('../remote-node');
    const registry = getWorkerNodeRegistry();
    const node = registry.getNode(nodeId);
    if (!node) return false;
    if (node.status !== 'connected') return false;
    return node.activeInstances < node.capabilities.maxConcurrentInstances;
  } catch {
    // Remote node module may not be initialized — fail closed
    return false;
  }
}
```

Note: Uses `require()` to avoid circular imports since resource-governor is initialized before remote-node.

- [x] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [x] **Step 4: Commit**

```bash
git add src/main/process/resource-governor.ts
git commit -m "feat(remote-node): add isRemoteCreationAllowed to resource governor"
```

---

## Task 6: Extend Observer Server

**Files:**
- Modify: `src/main/remote/observer-server.ts`

- [x] **Step 1: Read observer-server.ts to find buildSnapshot**

Read `src/main/remote/observer-server.ts` around line 165-172.

- [x] **Step 2: Add workerNodes to snapshot**

Add import at top:
```typescript
import { getWorkerNodeRegistry } from '../remote-node';
```

Update `buildSnapshot()`:
```typescript
private buildSnapshot(): RemoteObserverSnapshot {
  return {
    status: this.getStatus(),
    instances: this.listInstances(),
    jobs: getRepoJobService().listJobs({ limit: 50 }),
    pendingPrompts: Array.from(this.prompts.values()).sort((a, b) => b.createdAt - a.createdAt),
    workerNodes: getWorkerNodeRegistry().getAllNodes(),
  };
}
```

Also update the `RemoteObserverSnapshot` type to include the new field. Find the type definition and add:
```typescript
workerNodes?: WorkerNodeInfo[];
```

- [x] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [x] **Step 4: Commit**

```bash
git add src/main/remote/observer-server.ts
git commit -m "feat(remote-node): add worker nodes to observer server snapshot"
```

---

## Task 7: Resolve Execution Location in Instance Lifecycle

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts`

This is the deferred Phase 2.4 work. It adds a private method to determine if an instance should run locally or on a remote node, and passes the result to `createCliAdapter`.

- [x] **Step 1: Read instance-lifecycle.ts around the adapter creation section**

Read `src/main/instance/instance-lifecycle.ts` lines 830-870 to understand the exact code around `createCliAdapter`.

- [x] **Step 2: Add the `resolveExecutionLocation` private method**

Add to the `InstanceLifecycleManager` class:

```typescript
/**
 * Determine where an instance should execute based on its creation config.
 * Returns { type: 'local' } by default. Only returns remote if:
 * 1. A specific node is forced via forceNodeId, OR
 * 2. Placement preferences match an available remote node
 */
private resolveExecutionLocation(config: InstanceCreateConfig): ExecutionLocation {
  // 1. Explicit node override
  if (config.forceNodeId) {
    try {
      const { getWorkerNodeRegistry } = require('../remote-node');
      const registry = getWorkerNodeRegistry();
      const node = registry.getNode(config.forceNodeId);
      if (node?.status === 'connected') {
        return { type: 'remote', nodeId: config.forceNodeId };
      }
    } catch {
      // Remote node module not available — fall through to local
    }
  }

  // 2. Placement preferences
  if (config.nodePlacement) {
    try {
      const { getWorkerNodeRegistry } = require('../remote-node');
      const registry = getWorkerNodeRegistry();
      const node = registry.selectNode(config.nodePlacement);
      if (node) {
        return { type: 'remote', nodeId: node.id };
      }
    } catch {
      // Remote node module not available — fall through to local
    }
  }

  // 3. Default: local
  return { type: 'local' };
}
```

- [x] **Step 3: Wire resolveExecutionLocation into instance creation**

At line ~835 (where `createCliAdapter` is called without warm-start), change:

```typescript
// BEFORE:
adapter = createCliAdapter(resolvedCliType, spawnOptions);

// AFTER:
const executionLocation = this.resolveExecutionLocation(config);
instance.executionLocation = executionLocation;
adapter = createCliAdapter(resolvedCliType, spawnOptions, executionLocation);
```

Add the import at the top of the file:
```typescript
import type { ExecutionLocation } from '../../shared/types/worker-node.types';
```

- [x] **Step 4: Verify compilation**

```bash
npx tsc --noEmit
```

- [x] **Step 5: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts
git commit -m "feat(remote-node): add resolveExecutionLocation to instance lifecycle"
```

---

## Task 8: IPC Channels for Remote Nodes

**Files:**
- Modify: `src/shared/types/ipc.types.ts`

- [x] **Step 1: Read ipc.types.ts to find where to add channels**

Find the remote observer section (around line 338-342) as a reference point.

- [x] **Step 2: Add remote-node channels**

Add a new section near the remote observer channels:

```typescript
  // Remote nodes
  REMOTE_NODE_LIST: 'remote-node:list',
  REMOTE_NODE_GET: 'remote-node:get',
  REMOTE_NODE_START_SERVER: 'remote-node:start-server',
  REMOTE_NODE_STOP_SERVER: 'remote-node:stop-server',
  REMOTE_NODE_EVENT: 'remote-node:event',
```

- [x] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [x] **Step 4: Commit**

```bash
git add src/shared/types/ipc.types.ts
git commit -m "feat(remote-node): add IPC channel constants for remote node management"
```

---

## Task 9: IPC Handlers for Remote Nodes

**Files:**
- Create: `src/main/ipc/handlers/remote-node-handlers.ts`
- Modify: `src/main/ipc/handlers/index.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`

- [x] **Step 1: Create the handler file**

```typescript
// src/main/ipc/handlers/remote-node-handlers.ts
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getWorkerNodeRegistry, getWorkerNodeConnectionServer } from '../../remote-node';
import { getRemoteNodeConfig } from '../../remote-node/remote-node-config';
import { getLogger } from '../../logging/logger';

const logger = getLogger('RemoteNodeHandlers');

export function registerRemoteNodeHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_LIST,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: getWorkerNodeRegistry().getAllNodes(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_GET,
    async (_event, payload: { nodeId: string }): Promise<IpcResponse> => {
      try {
        const node = getWorkerNodeRegistry().getNode(payload.nodeId);
        return {
          success: true,
          data: node ?? null,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_START_SERVER,
    async (_event, payload?: { port?: number; host?: string }): Promise<IpcResponse> => {
      try {
        const config = getRemoteNodeConfig();
        const port = payload?.port ?? config.serverPort;
        const host = payload?.host ?? config.serverHost;
        await getWorkerNodeConnectionServer().start(port, host);
        return { success: true, data: { port, host } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_STOP_SERVER,
    async (): Promise<IpcResponse> => {
      try {
        getWorkerNodeConnectionServer().stop();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_NODE_STOP_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  logger.info('Remote node IPC handlers registered');
}
```

- [x] **Step 2: Add export to handlers/index.ts**

Read `src/main/ipc/handlers/index.ts` and add:

```typescript
export { registerRemoteNodeHandlers } from './remote-node-handlers';
```

- [x] **Step 3: Register in ipc-main-handler.ts**

Read `src/main/ipc/ipc-main-handler.ts` around line 285-290 (near remote observer handlers) and add:

```typescript
registerRemoteNodeHandlers();
```

Import at the top of the file:
```typescript
import { registerRemoteNodeHandlers } from './handlers/remote-node-handlers';
```

- [x] **Step 4: Verify compilation**

```bash
npx tsc --noEmit
```

- [x] **Step 5: Commit**

```bash
git add src/main/ipc/handlers/remote-node-handlers.ts src/main/ipc/handlers/index.ts src/main/ipc/ipc-main-handler.ts
git commit -m "feat(remote-node): add IPC handlers for remote node management"
```

---

## Task 10: Preload Bridge

**Files:**
- Modify: `src/preload/preload.ts`

- [x] **Step 1: Read preload.ts to find IPC_CHANNELS and electronAPI locations**

Find:
1. The IPC_CHANNELS constant (around line 12-685) — find the remote observer section
2. The electronAPI object — find where to add new methods

- [x] **Step 2: Add channel constants to preload IPC_CHANNELS**

Find the remote observer channels section and add nearby:

```typescript
  // Remote nodes
  REMOTE_NODE_LIST: 'remote-node:list',
  REMOTE_NODE_GET: 'remote-node:get',
  REMOTE_NODE_START_SERVER: 'remote-node:start-server',
  REMOTE_NODE_STOP_SERVER: 'remote-node:stop-server',
  REMOTE_NODE_EVENT: 'remote-node:event',
```

- [x] **Step 3: Add API methods to electronAPI object**

Add methods to the electronAPI object:

```typescript
  // Remote nodes
  remoteNodeList: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.REMOTE_NODE_LIST),

  remoteNodeGet: (nodeId: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.REMOTE_NODE_GET, { nodeId }),

  remoteNodeStartServer: (config?: { port?: number; host?: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.REMOTE_NODE_START_SERVER, config),

  remoteNodeStopServer: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.REMOTE_NODE_STOP_SERVER),

  onRemoteNodeEvent: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.REMOTE_NODE_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.REMOTE_NODE_EVENT, handler);
  },
```

- [x] **Step 4: Verify compilation**

```bash
npx tsc --noEmit
```

- [x] **Step 5: Commit**

```bash
git add src/preload/preload.ts
git commit -m "feat(remote-node): add preload bridge for remote node management"
```

---

## Task 11: Main Process Wiring

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/remote-node/index.ts` (add new exports)

This is the final wiring task — it initializes the remote node subsystem during app startup and wires events for node state management.

- [x] **Step 1: Update barrel exports**

Add to `src/main/remote-node/index.ts`:

```typescript
export { RpcEventRouter } from './rpc-event-router';
export { getRemoteNodeConfig, updateRemoteNodeConfig, resetRemoteNodeConfig } from './remote-node-config';
export type { RemoteNodeConfig } from './remote-node-config';
```

- [x] **Step 2: Read index.ts to find the right initialization location**

Read `src/main/index.ts` lines 238-270 (process manager initialization) and lines 917-935 (cleanup).

- [x] **Step 3: Add remote node initialization**

Add imports at the top of `src/main/index.ts`:
```typescript
import {
  getWorkerNodeRegistry,
  getWorkerNodeConnectionServer,
  getWorkerNodeHealth,
  handleNodeFailover,
  RpcEventRouter,
  getRemoteNodeConfig,
} from './remote-node';
```

Add to the `steps` array (after load balancer initialization, around line 270):

```typescript
{ name: 'Worker node registry', fn: () => {
  const config = getRemoteNodeConfig();
  if (!config.enabled) {
    logger.info('Remote node subsystem disabled');
    return;
  }

  const registry = getWorkerNodeRegistry();
  const connection = getWorkerNodeConnectionServer();

  // Start RPC event router
  const rpcRouter = new RpcEventRouter(connection, registry);
  rpcRouter.start();

  // Wire node disconnect → failover
  registry.on('node:disconnected', (nodeId: string) => {
    handleNodeFailover(nodeId);
  });

  // Wire node events → renderer
  registry.on('node:connected', (node) => {
    this.windowManager.getMainWindow()?.webContents.send('remote-node:event', {
      type: 'connected',
      node,
    });
  });

  registry.on('node:disconnected', (nodeId) => {
    this.windowManager.getMainWindow()?.webContents.send('remote-node:event', {
      type: 'disconnected',
      nodeId,
    });
  });

  registry.on('node:updated', (node) => {
    this.windowManager.getMainWindow()?.webContents.send('remote-node:event', {
      type: 'updated',
      node,
    });
  });

  logger.info('Worker node registry initialized');
} },
{ name: 'Worker node server', fn: async () => {
  const config = getRemoteNodeConfig();
  if (!config.enabled) return;
  await getWorkerNodeConnectionServer().start(config.serverPort, config.serverHost);
  logger.info('Worker node WebSocket server started', {
    port: config.serverPort,
    host: config.serverHost,
  });
} },
```

- [x] **Step 4: Add cleanup**

In the `cleanup()` method (around line 917-935), add before `this.instanceManager.terminateAll()`:

```typescript
try {
  getWorkerNodeHealth().stopAll();
  getWorkerNodeConnectionServer().stop();
} catch {
  // Remote node subsystem may not be initialized
}
```

- [x] **Step 5: Verify compilation**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json
```

- [x] **Step 6: Commit**

```bash
git add src/main/index.ts src/main/remote-node/index.ts
git commit -m "feat(remote-node): wire remote node subsystem into main process initialization"
```

---

## Task 12: Final Verification

- [x] **Step 1: Full TypeScript compilation**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json
```

- [x] **Step 2: Lint all changed files**

```bash
npx eslint src/main/remote-node/ src/main/process/load-balancer.ts src/main/process/resource-governor.ts src/main/remote/observer-server.ts src/main/ipc/handlers/remote-node-handlers.ts src/main/instance/instance-lifecycle.ts src/main/instance/instance-manager.ts
```

- [x] **Step 3: Run all remote-node tests**

```bash
npx vitest run src/main/remote-node/ src/main/process/load-balancer.spec.ts
```

- [x] **Step 4: Run full test suite**

```bash
npm run test
```

Expected: no regressions

---

## Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | Remote node config | `remote-node-config.ts` |
| 2 | RPC event router + tests | `rpc-event-router.ts` |
| 3 | getInstancesByNode | `instance-manager.ts` |
| 4 | Extend load balancer | `load-balancer.ts` |
| 5 | Extend resource governor | `resource-governor.ts` |
| 6 | Extend observer server | `observer-server.ts` |
| 7 | resolveExecutionLocation | `instance-lifecycle.ts` |
| 8 | IPC channels | `ipc.types.ts` |
| 9 | IPC handlers | `remote-node-handlers.ts` |
| 10 | Preload bridge | `preload.ts` |
| 11 | Main process wiring | `index.ts` |
| 12 | Final verification | Full build + lint + test |
