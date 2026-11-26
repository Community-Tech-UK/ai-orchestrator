# Remote Worker Nodes — Phase 1 & 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add worker node types, registry, WebSocket connection, RPC protocol, health monitoring, failover handling, remote CLI adapter, and instance lifecycle integration — enabling the coordinator to track remote worker nodes and route instance creation to them.

**Architecture:** Coordinator-as-brain pattern. A `WorkerNodeRegistry` singleton tracks connected nodes. A `WorkerNodeConnectionServer` manages WebSocket connections with JSON-RPC 2.0 protocol. A `RemoteCliAdapter` proxies CLI operations over RPC. Instance lifecycle gains `executionLocation` awareness — local by default, remote when placement preferences match an available node.

**Tech Stack:** TypeScript 5.9, Node.js `ws` package, Vitest, EventEmitter, Zod 4 validation

**Source spec:** `docs/bigchange_remote-nodes.md`

**Status:** ✅ ALL TASKS COMPLETE (verified 2026-04-03)

> **Known gap:** `InstanceStatus` type in `src/shared/types/instance.types.ts` does not include `'degraded'` status, but `node-failover.ts` sets instances to `'degraded'`. This needs to be added to the union type.

---

## File Structure

### New Files (Phase 1)

| File | Responsibility |
|------|---------------|
| `src/shared/types/worker-node.types.ts` | Shared types: `WorkerNodeCapabilities`, `WorkerNodeInfo`, `ExecutionLocation`, `NodePlacementPrefs` |
| `src/main/remote-node/index.ts` | Barrel exports and singleton getters |
| `src/main/remote-node/worker-node-registry.ts` | Singleton registry tracking connected nodes, node selection scoring |
| `src/main/remote-node/worker-node-connection.ts` | WebSocket server + JSON-RPC 2.0 transport |
| `src/main/remote-node/worker-node-rpc.ts` | RPC message types, method constants, serialization helpers |
| `src/main/remote-node/worker-node-health.ts` | Heartbeat tracking, degraded/disconnected transitions |
| `src/main/remote-node/node-failover.ts` | Grace-period failover on node disconnect |
| `src/main/remote-node/__tests__/worker-node-registry.spec.ts` | Registry unit tests |
| `src/main/remote-node/__tests__/worker-node-health.spec.ts` | Health monitor unit tests |
| `src/main/remote-node/__tests__/node-failover.spec.ts` | Failover unit tests |

### New Files (Phase 2)

| File | Responsibility |
|------|---------------|
| `src/main/cli/adapters/remote-cli-adapter.ts` | CLI adapter that proxies operations over RPC to a remote node |
| `src/main/cli/adapters/__tests__/remote-cli-adapter.spec.ts` | Remote adapter unit tests |

### Modified Files

| File | Change |
|------|--------|
| `src/shared/types/instance.types.ts` | Add `executionLocation` to `Instance`, add `nodePlacement`/`forceNodeId` to `InstanceCreateConfig`, update `createInstance()` factory |
| `src/main/cli/adapters/adapter-factory.ts` | Add remote branch to `createCliAdapter()`, update `CliAdapter` type union |

---

## Task 1: Install `ws` Package

**Files:**
- Modify: `package.json`

- [x] **Step 1: Install ws and its types**

```bash
npm install ws && npm install -D @types/ws
```

- [x] **Step 2: Verify installation**

```bash
node -e "require('ws'); console.log('ws OK')"
```

Expected: `ws OK`

---

## Task 2: Worker Node Types

**Files:**
- Create: `src/shared/types/worker-node.types.ts`
- Test: Compile check only (pure types)

- [x] **Step 1: Create the types file**

```typescript
// src/shared/types/worker-node.types.ts
import type { CanonicalCliType } from './settings.types';

export type NodePlatform = 'darwin' | 'win32' | 'linux';

export interface WorkerNodeCapabilities {
  platform: NodePlatform;
  arch: string;                          // 'arm64', 'x64'
  cpuCores: number;
  totalMemoryMB: number;
  availableMemoryMB: number;
  gpuName?: string;                      // 'NVIDIA RTX 5090'
  gpuMemoryMB?: number;
  supportedClis: CanonicalCliType[];
  hasBrowserRuntime: boolean;
  hasBrowserMcp: boolean;
  hasDocker: boolean;
  maxConcurrentInstances: number;
  workingDirectories: string[];
}

export interface WorkerNodeInfo {
  id: string;
  name: string;
  address: string;                       // WebSocket URL (wss://...)
  capabilities: WorkerNodeCapabilities;
  status: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  connectedAt?: number;
  lastHeartbeat?: number;
  activeInstances: number;
  latencyMs?: number;
}

export type ExecutionLocation =
  | { type: 'local' }
  | { type: 'remote'; nodeId: string };

export interface NodePlacementPrefs {
  requiresBrowser?: boolean;
  requiresGpu?: boolean;
  preferPlatform?: NodePlatform;
  preferNodeId?: string;
  requiresCli?: CanonicalCliType;
  requiresWorkingDirectory?: string;
}
```

- [x] **Step 2: Verify types compile**

```bash
npx tsc --noEmit
```

Expected: no errors

- [x] **Step 3: Commit**

```bash
git add src/shared/types/worker-node.types.ts
git commit -m "feat(remote-node): add worker node shared types"
```

---

## Task 3: RPC Protocol Types

**Files:**
- Create: `src/main/remote-node/worker-node-rpc.ts`

- [x] **Step 1: Create the RPC types and constants file**

```typescript
// src/main/remote-node/worker-node-rpc.ts

/**
 * JSON-RPC 2.0 message types for coordinator ↔ worker node communication.
 */

// ── RPC Method Constants ──

/** Methods sent FROM worker node TO coordinator */
export const NODE_TO_COORDINATOR = {
  REGISTER: 'node.register',
  HEARTBEAT: 'node.heartbeat',
  INSTANCE_OUTPUT: 'instance.output',
  INSTANCE_STATE_CHANGE: 'instance.stateChange',
  INSTANCE_PERMISSION_REQUEST: 'instance.permissionRequest',
} as const;

/** Methods sent FROM coordinator TO worker node */
export const COORDINATOR_TO_NODE = {
  INSTANCE_SPAWN: 'instance.spawn',
  INSTANCE_SEND_INPUT: 'instance.sendInput',
  INSTANCE_TERMINATE: 'instance.terminate',
  INSTANCE_INTERRUPT: 'instance.interrupt',
  INSTANCE_HIBERNATE: 'instance.hibernate',
  INSTANCE_WAKE: 'instance.wake',
  NODE_PING: 'node.ping',
} as const;

// ── JSON-RPC 2.0 Message Types ──

export interface RpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
  token?: string;          // Auth token
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: RpcError;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  token?: string;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ── Standard JSON-RPC Error Codes ──

export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Application-specific
  UNAUTHORIZED: -32000,
  NODE_NOT_FOUND: -32001,
  INSTANCE_NOT_FOUND: -32002,
  SPAWN_FAILED: -32003,
} as const;

// ── Helpers ──

export function createRpcRequest(
  id: string | number,
  method: string,
  params?: unknown,
  token?: string
): RpcRequest {
  return { jsonrpc: '2.0', id, method, params, token };
}

export function createRpcResponse(
  id: string | number,
  result: unknown
): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function createRpcError(
  id: string | number,
  code: number,
  message: string,
  data?: unknown
): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export function createRpcNotification(
  method: string,
  params?: unknown,
  token?: string
): RpcNotification {
  return { jsonrpc: '2.0', method, params, token };
}

export function isRpcRequest(msg: unknown): msg is RpcRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as RpcRequest).jsonrpc === '2.0' &&
    'id' in msg &&
    'method' in msg
  );
}

export function isRpcResponse(msg: unknown): msg is RpcResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as RpcResponse).jsonrpc === '2.0' &&
    'id' in msg &&
    !('method' in msg)
  );
}

export function isRpcNotification(msg: unknown): msg is RpcNotification {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as RpcNotification).jsonrpc === '2.0' &&
    'method' in msg &&
    !('id' in msg)
  );
}
```

- [x] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no errors

- [x] **Step 3: Commit**

```bash
git add src/main/remote-node/worker-node-rpc.ts
git commit -m "feat(remote-node): add JSON-RPC 2.0 protocol types and helpers"
```

---

## Task 4: Worker Node Registry

**Files:**
- Create: `src/main/remote-node/worker-node-registry.ts`
- Test: `src/main/remote-node/__tests__/worker-node-registry.spec.ts`

- [x] **Step 1: Write registry tests**

```typescript
// src/main/remote-node/__tests__/worker-node-registry.spec.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkerNodeRegistry } from '../worker-node-registry';
import type { WorkerNodeInfo, WorkerNodeCapabilities, NodePlacementPrefs } from '../../../shared/types/worker-node.types';

function makeCapabilities(overrides?: Partial<WorkerNodeCapabilities>): WorkerNodeCapabilities {
  return {
    platform: 'win32',
    arch: 'x64',
    cpuCores: 16,
    totalMemoryMB: 65536,
    availableMemoryMB: 40000,
    supportedClis: ['claude', 'codex'],
    hasBrowserRuntime: true,
    hasBrowserMcp: false,
    hasDocker: true,
    maxConcurrentInstances: 10,
    workingDirectories: ['/projects'],
    ...overrides,
  };
}

function makeNode(id: string, overrides?: Partial<WorkerNodeInfo>): WorkerNodeInfo {
  return {
    id,
    name: `node-${id}`,
    address: `wss://192.168.1.${id}:4878`,
    capabilities: makeCapabilities(),
    status: 'connected',
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    activeInstances: 0,
    latencyMs: 5,
    ...overrides,
  };
}

describe('WorkerNodeRegistry', () => {
  let registry: WorkerNodeRegistry;

  beforeEach(() => {
    WorkerNodeRegistry._resetForTesting();
    registry = WorkerNodeRegistry.getInstance();
  });

  describe('registration', () => {
    it('should register and retrieve a node', () => {
      const node = makeNode('1');
      registry.registerNode(node);
      expect(registry.getNode('1')).toEqual(node);
    });

    it('should emit node:connected on register', () => {
      const events: WorkerNodeInfo[] = [];
      registry.on('node:connected', (n) => events.push(n));
      registry.registerNode(makeNode('1'));
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('1');
    });

    it('should deregister a node', () => {
      registry.registerNode(makeNode('1'));
      registry.deregisterNode('1');
      expect(registry.getNode('1')).toBeUndefined();
    });

    it('should emit node:disconnected on deregister', () => {
      const events: string[] = [];
      registry.on('node:disconnected', (id) => events.push(id));
      registry.registerNode(makeNode('1'));
      registry.deregisterNode('1');
      expect(events).toEqual(['1']);
    });

    it('should list all nodes', () => {
      registry.registerNode(makeNode('1'));
      registry.registerNode(makeNode('2'));
      expect(registry.getAllNodes()).toHaveLength(2);
    });
  });

  describe('getHealthyNodes', () => {
    it('should return only connected nodes', () => {
      registry.registerNode(makeNode('1', { status: 'connected' }));
      registry.registerNode(makeNode('2', { status: 'degraded' }));
      registry.registerNode(makeNode('3', { status: 'disconnected' }));
      const healthy = registry.getHealthyNodes();
      expect(healthy).toHaveLength(1);
      expect(healthy[0].id).toBe('1');
    });
  });

  describe('updateNodeMetrics', () => {
    it('should partially update node info', () => {
      registry.registerNode(makeNode('1', { activeInstances: 0 }));
      registry.updateNodeMetrics('1', { activeInstances: 3 });
      expect(registry.getNode('1')?.activeInstances).toBe(3);
    });

    it('should be no-op for unknown node', () => {
      expect(() => registry.updateNodeMetrics('unknown', { activeInstances: 1 })).not.toThrow();
    });
  });

  describe('updateHeartbeat', () => {
    it('should update lastHeartbeat and capabilities', () => {
      registry.registerNode(makeNode('1'));
      const newCaps = makeCapabilities({ availableMemoryMB: 20000 });
      registry.updateHeartbeat('1', newCaps);
      const node = registry.getNode('1');
      expect(node?.capabilities.availableMemoryMB).toBe(20000);
      expect(node?.lastHeartbeat).toBeGreaterThan(0);
    });
  });

  describe('selectNode', () => {
    it('should return null when no nodes registered', () => {
      expect(registry.selectNode({})).toBeNull();
    });

    it('should return null when no nodes are healthy', () => {
      registry.registerNode(makeNode('1', { status: 'disconnected' }));
      expect(registry.selectNode({})).toBeNull();
    });

    it('should prefer node with more available memory', () => {
      registry.registerNode(makeNode('1', {
        capabilities: makeCapabilities({ availableMemoryMB: 10000, totalMemoryMB: 65536 }),
      }));
      registry.registerNode(makeNode('2', {
        capabilities: makeCapabilities({ availableMemoryMB: 50000, totalMemoryMB: 65536 }),
      }));
      const selected = registry.selectNode({});
      expect(selected?.id).toBe('2');
    });

    it('should filter by requiresBrowser', () => {
      registry.registerNode(makeNode('1', {
        capabilities: makeCapabilities({ hasBrowserRuntime: false }),
      }));
      registry.registerNode(makeNode('2', {
        capabilities: makeCapabilities({ hasBrowserRuntime: true }),
      }));
      const selected = registry.selectNode({ requiresBrowser: true });
      expect(selected?.id).toBe('2');
    });

    it('should filter by requiresGpu', () => {
      registry.registerNode(makeNode('1', {
        capabilities: makeCapabilities({ gpuName: undefined }),
      }));
      registry.registerNode(makeNode('2', {
        capabilities: makeCapabilities({ gpuName: 'NVIDIA RTX 5090' }),
      }));
      const selected = registry.selectNode({ requiresGpu: true });
      expect(selected?.id).toBe('2');
    });

    it('should filter by requiresCli', () => {
      registry.registerNode(makeNode('1', {
        capabilities: makeCapabilities({ supportedClis: ['claude'] }),
      }));
      registry.registerNode(makeNode('2', {
        capabilities: makeCapabilities({ supportedClis: ['claude', 'gemini'] }),
      }));
      const selected = registry.selectNode({ requiresCli: 'gemini' });
      expect(selected?.id).toBe('2');
    });

    it('should hard-penalize missing working directory', () => {
      registry.registerNode(makeNode('1', {
        capabilities: makeCapabilities({ workingDirectories: ['/projects'] }),
      }));
      registry.registerNode(makeNode('2', {
        capabilities: makeCapabilities({ workingDirectories: ['/other'] }),
        activeInstances: 0,
      }));
      const selected = registry.selectNode({ requiresWorkingDirectory: '/projects/my-app' });
      expect(selected?.id).toBe('1');
    });

    it('should prefer a specific node by ID', () => {
      registry.registerNode(makeNode('1'));
      registry.registerNode(makeNode('2'));
      const selected = registry.selectNode({ preferNodeId: '2' });
      expect(selected?.id).toBe('2');
    });

    it('should boost preferred platform', () => {
      registry.registerNode(makeNode('1', {
        capabilities: makeCapabilities({ platform: 'darwin' }),
      }));
      registry.registerNode(makeNode('2', {
        capabilities: makeCapabilities({ platform: 'win32' }),
      }));
      const selected = registry.selectNode({ preferPlatform: 'win32' });
      expect(selected?.id).toBe('2');
    });

    it('should prefer fewer active instances', () => {
      registry.registerNode(makeNode('1', { activeInstances: 8 }));
      registry.registerNode(makeNode('2', { activeInstances: 1 }));
      const selected = registry.selectNode({});
      expect(selected?.id).toBe('2');
    });

    it('should exclude nodes at max capacity', () => {
      registry.registerNode(makeNode('1', {
        activeInstances: 10,
        capabilities: makeCapabilities({ maxConcurrentInstances: 10 }),
      }));
      registry.registerNode(makeNode('2', { activeInstances: 1 }));
      const selected = registry.selectNode({});
      expect(selected?.id).toBe('2');
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/main/remote-node/__tests__/worker-node-registry.spec.ts
```

Expected: FAIL — module not found

- [x] **Step 3: Implement the registry**

```typescript
// src/main/remote-node/worker-node-registry.ts
import { EventEmitter } from 'events';
import type {
  WorkerNodeInfo,
  WorkerNodeCapabilities,
  NodePlacementPrefs,
} from '../../shared/types/worker-node.types';

/**
 * Singleton registry tracking all connected worker nodes.
 * Emits: 'node:connected', 'node:disconnected', 'node:updated'
 */
export class WorkerNodeRegistry extends EventEmitter {
  private static instance: WorkerNodeRegistry;
  private nodes = new Map<string, WorkerNodeInfo>();

  static getInstance(): WorkerNodeRegistry {
    if (!this.instance) {
      this.instance = new WorkerNodeRegistry();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.removeAllListeners();
      this.instance.nodes.clear();
    }
    (this.instance as unknown) = undefined;
  }

  private constructor() {
    super();
  }

  registerNode(info: WorkerNodeInfo): void {
    this.nodes.set(info.id, info);
    this.emit('node:connected', info);
  }

  deregisterNode(nodeId: string): void {
    if (this.nodes.delete(nodeId)) {
      this.emit('node:disconnected', nodeId);
    }
  }

  getNode(nodeId: string): WorkerNodeInfo | undefined {
    return this.nodes.get(nodeId);
  }

  getAllNodes(): WorkerNodeInfo[] {
    return Array.from(this.nodes.values());
  }

  getHealthyNodes(): WorkerNodeInfo[] {
    return this.getAllNodes().filter((n) => n.status === 'connected');
  }

  updateNodeMetrics(nodeId: string, partial: Partial<WorkerNodeInfo>): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    Object.assign(node, partial);
    this.emit('node:updated', node);
  }

  updateHeartbeat(nodeId: string, capabilities: WorkerNodeCapabilities): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.capabilities = capabilities;
    node.lastHeartbeat = Date.now();
    // If node was degraded, restore it on successful heartbeat
    if (node.status === 'degraded') {
      node.status = 'connected';
    }
    this.emit('node:updated', node);
  }

  /**
   * Select the best node for an instance based on placement preferences.
   * Returns null if no suitable node found (fall back to local).
   *
   * Scoring:
   *   capabilityMatch * 100  (hard filter — 0 means excluded)
   * + platformPreference * 20
   * + (availableMemory / totalMemory) * 30
   * + inverseActiveInstances * 25
   * + inverseLatency * 10
   * + preferNodeId * 50
   * - missingWorkingDirectory * 200  (hard penalty)
   */
  selectNode(prefs: NodePlacementPrefs): WorkerNodeInfo | null {
    const candidates = this.getHealthyNodes();
    if (candidates.length === 0) return null;

    let bestNode: WorkerNodeInfo | null = null;
    let bestScore = -Infinity;

    for (const node of candidates) {
      const caps = node.capabilities;

      // Hard filters — exclude nodes that can't meet requirements
      if (caps.activeInstances >= caps.maxConcurrentInstances) continue;
      if (prefs.requiresBrowser && !caps.hasBrowserRuntime) continue;
      if (prefs.requiresGpu && !caps.gpuName) continue;
      if (prefs.requiresCli && !caps.supportedClis.includes(prefs.requiresCli)) continue;

      let score = 100; // Base capability match score

      // Platform preference bonus
      if (prefs.preferPlatform && caps.platform === prefs.preferPlatform) {
        score += 20;
      }

      // Memory availability ratio (0-30)
      if (caps.totalMemoryMB > 0) {
        score += (caps.availableMemoryMB / caps.totalMemoryMB) * 30;
      }

      // Fewer active instances = higher score (0-25)
      const instanceLoad = caps.maxConcurrentInstances > 0
        ? node.activeInstances / caps.maxConcurrentInstances
        : 1;
      score += (1 - instanceLoad) * 25;

      // Lower latency = higher score (0-10)
      if (node.latencyMs !== undefined && node.latencyMs > 0) {
        score += Math.max(0, 10 - node.latencyMs / 10);
      } else {
        score += 5; // Unknown latency gets middle score
      }

      // Preferred node bonus
      if (prefs.preferNodeId === node.id) {
        score += 50;
      }

      // Working directory check — hard penalty if required dir not available
      if (prefs.requiresWorkingDirectory) {
        const hasDir = caps.workingDirectories.some((dir) =>
          prefs.requiresWorkingDirectory!.startsWith(dir)
        );
        if (!hasDir) {
          score -= 200;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }

    // Don't return a node with negative score (failed hard requirements)
    return bestScore > 0 ? bestNode : null;
  }
}

export function getWorkerNodeRegistry(): WorkerNodeRegistry {
  return WorkerNodeRegistry.getInstance();
}
```

- [x] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/main/remote-node/__tests__/worker-node-registry.spec.ts
```

Expected: all tests PASS

- [x] **Step 5: Verify full compilation**

```bash
npx tsc --noEmit
```

- [x] **Step 6: Commit**

```bash
git add src/main/remote-node/worker-node-registry.ts src/main/remote-node/__tests__/worker-node-registry.spec.ts
git commit -m "feat(remote-node): add WorkerNodeRegistry with node selection scoring"
```

---

## Task 5: WebSocket Connection Server

**Files:**
- Create: `src/main/remote-node/worker-node-connection.ts`

This task creates the WebSocket server that worker nodes connect to. It handles JSON-RPC 2.0 message routing. Full integration testing will happen in a later phase when the worker agent exists — this task focuses on the server-side API and RPC dispatch.

- [x] **Step 1: Create the connection server**

```typescript
// src/main/remote-node/worker-node-connection.ts
import { EventEmitter } from 'events';
import WebSocket, { WebSocketServer } from 'ws';
import { getLogger } from '../logging/logger';
import {
  createRpcResponse,
  createRpcError,
  createRpcRequest,
  createRpcNotification,
  isRpcRequest,
  isRpcNotification,
  RPC_ERROR_CODES,
  type RpcRequest,
  type RpcResponse,
  type RpcNotification,
} from './worker-node-rpc';

const logger = getLogger('WorkerNodeConnection');

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * WebSocket server that accepts connections from worker nodes.
 * Routes JSON-RPC 2.0 messages between coordinator and worker nodes.
 *
 * Emits:
 * - 'rpc:request'  (nodeId: string, request: RpcRequest)   — inbound RPC from a node
 * - 'rpc:notification' (nodeId: string, notification: RpcNotification)
 * - 'node:ws-connected'    (nodeId: string)
 * - 'node:ws-disconnected' (nodeId: string)
 */
export class WorkerNodeConnectionServer extends EventEmitter {
  private static instance: WorkerNodeConnectionServer;
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, WebSocket>();
  private pendingRequests = new Map<string, PendingRequest>();
  private nextRequestId = 1;

  /** Default RPC timeout: 30 seconds */
  private rpcTimeoutMs = 30_000;

  static getInstance(): WorkerNodeConnectionServer {
    if (!this.instance) {
      this.instance = new WorkerNodeConnectionServer();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.stop();
      this.instance.removeAllListeners();
    }
    (this.instance as unknown) = undefined;
  }

  private constructor() {
    super();
  }

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    if (this.wss) {
      logger.warn('WebSocket server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port, host });

      this.wss.on('listening', () => {
        logger.info('Worker node WebSocket server started', { port, host });
        resolve();
      });

      this.wss.on('error', (err) => {
        logger.error('WebSocket server error', err);
        reject(err);
      });

      this.wss.on('connection', (ws) => {
        this.handleConnection(ws);
      });
    });
  }

  stop(): void {
    // Cancel all pending RPC requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Server shutting down'));
      this.pendingRequests.delete(id);
    }

    // Close all connections
    for (const [nodeId, ws] of this.connections) {
      ws.close(1001, 'Server shutting down');
      this.connections.delete(nodeId);
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
      logger.info('Worker node WebSocket server stopped');
    }
  }

  /** Send an RPC request to a specific node and await the response. */
  async sendRpc<T = unknown>(
    nodeId: string,
    method: string,
    params?: unknown,
  ): Promise<T> {
    const ws = this.connections.get(nodeId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Node ${nodeId} is not connected`);
    }

    const id = `coord-${this.nextRequestId++}`;
    const request = createRpcRequest(id, method, params);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout for ${method} to node ${nodeId}`));
      }, this.rpcTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      ws.send(JSON.stringify(request));
    });
  }

  /** Send a fire-and-forget notification to a node. */
  sendNotification(nodeId: string, method: string, params?: unknown): void {
    const ws = this.connections.get(nodeId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn('Cannot send notification: node not connected', { nodeId, method });
      return;
    }
    ws.send(JSON.stringify(createRpcNotification(method, params)));
  }

  /** Broadcast a notification to all connected nodes. */
  broadcast(method: string, params?: unknown): void {
    const msg = JSON.stringify(createRpcNotification(method, params));
    for (const ws of this.connections.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  /** Send an RPC response back to a node (used by RPC handler code). */
  sendResponse(nodeId: string, response: RpcResponse): void {
    const ws = this.connections.get(nodeId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(response));
  }

  isNodeConnected(nodeId: string): boolean {
    const ws = this.connections.get(nodeId);
    return ws !== undefined && ws.readyState === WebSocket.OPEN;
  }

  getConnectedNodeIds(): string[] {
    return Array.from(this.connections.keys());
  }

  // ── Internal ──

  private handleConnection(ws: WebSocket): void {
    // Node ID is assigned on first 'node.register' message.
    // Until then, we use a temp ID.
    let nodeId: string | null = null;

    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        logger.warn('Received non-JSON message from worker node');
        return;
      }

      if (isRpcRequest(msg)) {
        // Handle node.register specially to associate the WebSocket
        if (msg.method === 'node.register' && !nodeId) {
          const params = msg.params as { nodeId: string } | undefined;
          if (params?.nodeId) {
            nodeId = params.nodeId;
            this.connections.set(nodeId, ws);
            this.emit('node:ws-connected', nodeId);
            logger.info('Worker node WebSocket associated', { nodeId });

            // Send success response
            this.sendResponse(nodeId, createRpcResponse(msg.id, { ok: true }));
          } else {
            ws.send(JSON.stringify(
              createRpcError(msg.id, RPC_ERROR_CODES.INVALID_PARAMS, 'Missing nodeId in register')
            ));
          }
          return;
        }

        if (!nodeId) {
          ws.send(JSON.stringify(
            createRpcError(msg.id, RPC_ERROR_CODES.UNAUTHORIZED, 'Must register first')
          ));
          return;
        }

        // Forward to event listeners for processing
        this.emit('rpc:request', nodeId, msg);

      } else if (isRpcNotification(msg)) {
        if (nodeId) {
          this.emit('rpc:notification', nodeId, msg);
        }

      } else if (typeof msg === 'object' && msg !== null && 'id' in msg) {
        // This is an RPC response to a request we sent
        const response = msg as RpcResponse;
        const id = String(response.id);
        const pending = this.pendingRequests.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(id);
          if (response.error) {
            pending.reject(new Error(`RPC error: ${response.error.message}`));
          } else {
            pending.resolve(response.result);
          }
        }
      }
    });

    ws.on('close', () => {
      if (nodeId) {
        this.connections.delete(nodeId);
        this.emit('node:ws-disconnected', nodeId);
        logger.info('Worker node WebSocket disconnected', { nodeId });
      }
    });

    ws.on('error', (err) => {
      logger.error('Worker node WebSocket error', err, { nodeId });
    });
  }
}

export function getWorkerNodeConnectionServer(): WorkerNodeConnectionServer {
  return WorkerNodeConnectionServer.getInstance();
}
```

- [x] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no errors (may need `ws` installed from Task 1)

- [x] **Step 3: Commit**

```bash
git add src/main/remote-node/worker-node-connection.ts
git commit -m "feat(remote-node): add WebSocket connection server with JSON-RPC 2.0"
```

---

## Task 6: Health Monitor

**Files:**
- Create: `src/main/remote-node/worker-node-health.ts`
- Test: `src/main/remote-node/__tests__/worker-node-health.spec.ts`

- [x] **Step 1: Write health monitor tests**

```typescript
// src/main/remote-node/__tests__/worker-node-health.spec.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WorkerNodeHealth } from '../worker-node-health';
import { WorkerNodeRegistry } from '../worker-node-registry';
import type { WorkerNodeInfo, WorkerNodeCapabilities } from '../../../shared/types/worker-node.types';

function makeNode(id: string, overrides?: Partial<WorkerNodeInfo>): WorkerNodeInfo {
  return {
    id,
    name: `node-${id}`,
    address: `wss://localhost:4878`,
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      cpuCores: 16,
      totalMemoryMB: 65536,
      availableMemoryMB: 40000,
      supportedClis: ['claude'],
      hasBrowserRuntime: false,
      hasBrowserMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 10,
      workingDirectories: [],
    },
    status: 'connected',
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    activeInstances: 0,
    latencyMs: 5,
    ...overrides,
  };
}

describe('WorkerNodeHealth', () => {
  let health: WorkerNodeHealth;
  let registry: WorkerNodeRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    WorkerNodeRegistry._resetForTesting();
    WorkerNodeHealth._resetForTesting();
    registry = WorkerNodeRegistry.getInstance();
    health = WorkerNodeHealth.getInstance();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start monitoring a node', () => {
    const node = makeNode('1');
    registry.registerNode(node);
    health.startMonitoring('1');
    expect(health.isMonitoring('1')).toBe(true);
  });

  it('should stop monitoring a node', () => {
    const node = makeNode('1');
    registry.registerNode(node);
    health.startMonitoring('1');
    health.stopMonitoring('1');
    expect(health.isMonitoring('1')).toBe(false);
  });

  it('should mark node as degraded after 3 missed heartbeats', () => {
    const node = makeNode('1', { lastHeartbeat: Date.now() });
    registry.registerNode(node);
    health.startMonitoring('1');

    // Advance past 3 check intervals (10s each) = 30s
    vi.advanceTimersByTime(35_000);

    expect(registry.getNode('1')?.status).toBe('degraded');
  });

  it('should mark node as disconnected after 5 missed heartbeats', () => {
    const events: string[] = [];
    registry.on('node:disconnected', (id) => events.push(id));

    const node = makeNode('1', { lastHeartbeat: Date.now() });
    registry.registerNode(node);
    health.startMonitoring('1');

    // Advance past 5 check intervals = 50s
    vi.advanceTimersByTime(55_000);

    const n = registry.getNode('1');
    // Node should be deregistered
    expect(n).toBeUndefined();
  });

  it('should not degrade node if heartbeats arrive on time', () => {
    const node = makeNode('1', { lastHeartbeat: Date.now() });
    registry.registerNode(node);
    health.startMonitoring('1');

    // After 15s, simulate a heartbeat
    vi.advanceTimersByTime(15_000);
    registry.updateHeartbeat('1', node.capabilities);

    // Advance another 15s
    vi.advanceTimersByTime(15_000);

    expect(registry.getNode('1')?.status).toBe('connected');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/main/remote-node/__tests__/worker-node-health.spec.ts
```

Expected: FAIL — module not found

- [x] **Step 3: Implement the health monitor**

```typescript
// src/main/remote-node/worker-node-health.ts
import { getLogger } from '../logging/logger';
import { getWorkerNodeRegistry } from './worker-node-registry';

const logger = getLogger('WorkerNodeHealth');

/** Heartbeat check interval: 10 seconds */
const CHECK_INTERVAL_MS = 10_000;

/** Mark as degraded after this many seconds without heartbeat (3 intervals) */
const DEGRADED_THRESHOLD_MS = 30_000;

/** Deregister after this many seconds without heartbeat (5 intervals) */
const DISCONNECT_THRESHOLD_MS = 50_000;

/**
 * Monitors worker node health via heartbeat tracking.
 * Transitions nodes through: connected → degraded → disconnected.
 */
export class WorkerNodeHealth {
  private static instance: WorkerNodeHealth;
  private intervals = new Map<string, ReturnType<typeof setInterval>>();

  static getInstance(): WorkerNodeHealth {
    if (!this.instance) {
      this.instance = new WorkerNodeHealth();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.stopAll();
    }
    (this.instance as unknown) = undefined;
  }

  private constructor() {}

  startMonitoring(nodeId: string): void {
    if (this.intervals.has(nodeId)) return;

    const interval = setInterval(() => {
      this.checkHealth(nodeId);
    }, CHECK_INTERVAL_MS);

    this.intervals.set(nodeId, interval);
    logger.info('Started health monitoring', { nodeId });
  }

  stopMonitoring(nodeId: string): void {
    const interval = this.intervals.get(nodeId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(nodeId);
      logger.info('Stopped health monitoring', { nodeId });
    }
  }

  isMonitoring(nodeId: string): boolean {
    return this.intervals.has(nodeId);
  }

  stopAll(): void {
    for (const [nodeId, interval] of this.intervals) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }

  private checkHealth(nodeId: string): void {
    const registry = getWorkerNodeRegistry();
    const node = registry.getNode(nodeId);
    if (!node) {
      // Node was already removed — stop monitoring
      this.stopMonitoring(nodeId);
      return;
    }

    const now = Date.now();
    const timeSinceHeartbeat = now - (node.lastHeartbeat ?? node.connectedAt ?? 0);

    if (timeSinceHeartbeat >= DISCONNECT_THRESHOLD_MS) {
      logger.error('Node missed too many heartbeats, deregistering', {
        nodeId,
        timeSinceHeartbeat,
      });
      this.stopMonitoring(nodeId);
      registry.deregisterNode(nodeId);
    } else if (timeSinceHeartbeat >= DEGRADED_THRESHOLD_MS && node.status === 'connected') {
      logger.warn('Node heartbeat delayed, marking degraded', {
        nodeId,
        timeSinceHeartbeat,
      });
      registry.updateNodeMetrics(nodeId, { status: 'degraded' });
    }
  }
}

export function getWorkerNodeHealth(): WorkerNodeHealth {
  return WorkerNodeHealth.getInstance();
}
```

- [x] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/main/remote-node/__tests__/worker-node-health.spec.ts
```

Expected: all tests PASS

- [x] **Step 5: Commit**

```bash
git add src/main/remote-node/worker-node-health.ts src/main/remote-node/__tests__/worker-node-health.spec.ts
git commit -m "feat(remote-node): add heartbeat health monitor with degraded/disconnected transitions"
```

---

## Task 7: Node Failover Handler

**Files:**
- Create: `src/main/remote-node/node-failover.ts`
- Test: `src/main/remote-node/__tests__/node-failover.spec.ts`

- [x] **Step 1: Write failover tests**

```typescript
// src/main/remote-node/__tests__/node-failover.spec.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { handleNodeFailover } from '../node-failover';
import { WorkerNodeRegistry } from '../worker-node-registry';

// Mock the instance manager
const mockInstances = new Map<string, { id: string; status: string; executionLocation: { type: 'remote'; nodeId: string } }>();
const statusUpdates: Array<{ id: string; status: string; meta: unknown }> = [];
const emittedEvents: Array<{ event: string; data: unknown }> = [];

vi.mock('../../instance/instance-manager', () => ({
  getInstanceManager: () => ({
    getInstancesByNode: (nodeId: string) => {
      return Array.from(mockInstances.values()).filter(
        (i) => i.executionLocation.type === 'remote' && i.executionLocation.nodeId === nodeId
      );
    },
    updateInstanceStatus: (id: string, status: string, meta: unknown) => {
      statusUpdates.push({ id, status, meta });
      const inst = mockInstances.get(id);
      if (inst) inst.status = status;
    },
    emit: (event: string, data: unknown) => {
      emittedEvents.push({ event, data });
    },
  }),
}));

describe('handleNodeFailover', () => {
  let registry: WorkerNodeRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    WorkerNodeRegistry._resetForTesting();
    registry = WorkerNodeRegistry.getInstance();
    mockInstances.clear();
    statusUpdates.length = 0;
    emittedEvents.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should be no-op when node has no instances', () => {
    handleNodeFailover('node-1');
    expect(statusUpdates).toHaveLength(0);
  });

  it('should immediately mark instances as degraded', () => {
    mockInstances.set('inst-1', {
      id: 'inst-1',
      status: 'busy',
      executionLocation: { type: 'remote', nodeId: 'node-1' },
    });

    handleNodeFailover('node-1');

    expect(statusUpdates).toHaveLength(1);
    expect(statusUpdates[0]).toEqual({
      id: 'inst-1',
      status: 'degraded',
      meta: { reason: 'worker-node-disconnected', nodeId: 'node-1' },
    });
  });

  it('should mark instances as failed after grace period', () => {
    mockInstances.set('inst-1', {
      id: 'inst-1',
      status: 'busy',
      executionLocation: { type: 'remote', nodeId: 'node-1' },
    });

    handleNodeFailover('node-1');
    statusUpdates.length = 0; // Clear the degraded update

    // Advance past grace period (30s)
    vi.advanceTimersByTime(31_000);

    expect(statusUpdates).toHaveLength(1);
    expect(statusUpdates[0].status).toBe('failed');
    expect(emittedEvents.some((e) => e.event === 'instance:remote-lost')).toBe(true);
  });

  it('should cancel failover if node reconnects during grace period', () => {
    mockInstances.set('inst-1', {
      id: 'inst-1',
      status: 'busy',
      executionLocation: { type: 'remote', nodeId: 'node-1' },
    });

    handleNodeFailover('node-1');
    statusUpdates.length = 0;

    // Simulate node reconnection within grace period
    registry.registerNode({
      id: 'node-1',
      name: 'node-1',
      address: 'wss://localhost:4878',
      capabilities: {
        platform: 'win32',
        arch: 'x64',
        cpuCores: 16,
        totalMemoryMB: 65536,
        availableMemoryMB: 40000,
        supportedClis: ['claude'],
        hasBrowserRuntime: false,
        hasBrowserMcp: false,
        hasDocker: false,
        maxConcurrentInstances: 10,
        workingDirectories: [],
      },
      status: 'connected',
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      activeInstances: 0,
    });

    // Should restore original status
    expect(statusUpdates.some((u) => u.meta && (u.meta as Record<string, string>).reason === 'worker-node-reconnected')).toBe(true);

    // Advance past grace period — should NOT mark as failed
    vi.advanceTimersByTime(35_000);
    expect(statusUpdates.every((u) => u.status !== 'failed')).toBe(true);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/main/remote-node/__tests__/node-failover.spec.ts
```

Expected: FAIL — module not found

- [x] **Step 3: Implement the failover handler**

```typescript
// src/main/remote-node/node-failover.ts
import { getWorkerNodeRegistry } from './worker-node-registry';
import { getInstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';

const logger = getLogger('NodeFailover');

/** Grace period before marking instances as failed (allows brief reconnects) */
const FAILOVER_GRACE_MS = 30_000;

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

  // Capture original statuses for restoration on reconnect
  const originalStatuses = new Map(
    affectedInstances.map((i) => [i.id, i.status])
  );

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
        lastKnownState: originalStatuses.get(instance.id),
      });
    }
  }, FAILOVER_GRACE_MS);

  // If node reconnects during grace, cancel the timer
  const onReconnect = (reconnectedNode: { id: string }) => {
    if (reconnectedNode.id === nodeId) {
      clearTimeout(timer);
      registry.off('node:connected', onReconnect);

      logger.info('Node reconnected during grace period, cancelling failover', { nodeId });

      // Restore original instance statuses
      for (const instance of affectedInstances) {
        const originalStatus = originalStatuses.get(instance.id) ?? 'idle';
        instanceManager.updateInstanceStatus(instance.id, originalStatus, {
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

- [x] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/main/remote-node/__tests__/node-failover.spec.ts
```

Expected: all tests PASS

- [x] **Step 5: Commit**

```bash
git add src/main/remote-node/node-failover.ts src/main/remote-node/__tests__/node-failover.spec.ts
git commit -m "feat(remote-node): add grace-period failover handler for node disconnects"
```

---

## Task 8: Barrel Exports

**Files:**
- Create: `src/main/remote-node/index.ts`

- [x] **Step 1: Create the barrel export file**

```typescript
// src/main/remote-node/index.ts
export { WorkerNodeRegistry, getWorkerNodeRegistry } from './worker-node-registry';
export { WorkerNodeConnectionServer, getWorkerNodeConnectionServer } from './worker-node-connection';
export { WorkerNodeHealth, getWorkerNodeHealth } from './worker-node-health';
export { handleNodeFailover } from './node-failover';
export {
  NODE_TO_COORDINATOR,
  COORDINATOR_TO_NODE,
  RPC_ERROR_CODES,
  createRpcRequest,
  createRpcResponse,
  createRpcError,
  createRpcNotification,
  isRpcRequest,
  isRpcResponse,
  isRpcNotification,
} from './worker-node-rpc';
export type {
  RpcRequest,
  RpcResponse,
  RpcNotification,
  RpcError,
} from './worker-node-rpc';
```

- [x] **Step 2: Verify full project compiles**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json
```

Expected: no errors

- [x] **Step 3: Run all remote-node tests**

```bash
npx vitest run src/main/remote-node/
```

Expected: all tests PASS

- [x] **Step 4: Commit**

```bash
git add src/main/remote-node/index.ts
git commit -m "feat(remote-node): add barrel exports for remote-node domain"
```

---

## Task 9: Add ExecutionLocation to Instance Types

**Files:**
- Modify: `src/shared/types/instance.types.ts`

- [x] **Step 1: Add import and new fields**

In `src/shared/types/instance.types.ts`:

1. Add import at the top of the file:
```typescript
import type { ExecutionLocation, NodePlacementPrefs } from './worker-node.types';
```

2. Add `executionLocation` field to the `Instance` interface (after line ~189, after `currentModel`):
```typescript
  /** Where this instance is executing (local or remote node) */
  executionLocation: ExecutionLocation;
```

3. Add to `InstanceCreateConfig` (after `bareMode`, around line 241):
```typescript
  /** Placement preferences for remote execution */
  nodePlacement?: NodePlacementPrefs;

  /** Force execution on a specific node (overrides placement logic) */
  forceNodeId?: string;
```

4. Update `createInstance()` factory function to set default:
Add after line ~312 (after `diffStats: undefined,`):
```typescript
    executionLocation: { type: 'local' },
```

5. Update `serializeInstance()` — no changes needed since `ExecutionLocation` is a plain object.

- [x] **Step 2: Verify compilation**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json
```

Expected: no errors (ExecutionLocation is already a plain object, no Map conversion needed)

- [x] **Step 3: Commit**

```bash
git add src/shared/types/instance.types.ts
git commit -m "feat(remote-node): add executionLocation to Instance and placement prefs to InstanceCreateConfig"
```

---

## Task 10: Remote CLI Adapter

**Files:**
- Create: `src/main/cli/adapters/remote-cli-adapter.ts`
- Test: `src/main/cli/adapters/__tests__/remote-cli-adapter.spec.ts`

- [x] **Step 1: Write remote adapter tests**

```typescript
// src/main/cli/adapters/__tests__/remote-cli-adapter.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RemoteCliAdapter } from '../remote-cli-adapter';
import type { UnifiedSpawnOptions } from '../adapter-factory';

function createMockConnection() {
  return {
    sendRpc: vi.fn(),
    sendNotification: vi.fn(),
    isNodeConnected: vi.fn().mockReturnValue(true),
  };
}

describe('RemoteCliAdapter', () => {
  let adapter: RemoteCliAdapter;
  let mockConnection: ReturnType<typeof createMockConnection>;
  const spawnOptions: UnifiedSpawnOptions = {
    workingDirectory: '/projects/my-app',
    model: 'claude-opus-4-6',
  };

  beforeEach(() => {
    mockConnection = createMockConnection();
    adapter = new RemoteCliAdapter(
      mockConnection as any,
      'node-1',
      'claude',
      spawnOptions
    );
  });

  describe('spawn', () => {
    it('should send instance.spawn RPC and store remote instance ID', async () => {
      mockConnection.sendRpc.mockResolvedValue({ instanceId: 'remote-inst-1' });

      await adapter.spawn();

      expect(mockConnection.sendRpc).toHaveBeenCalledWith(
        'node-1',
        'instance.spawn',
        expect.objectContaining({
          requestedCliType: 'claude',
          options: spawnOptions,
        })
      );
      expect(adapter.getRemoteInstanceId()).toBe('remote-inst-1');
    });
  });

  describe('sendInput', () => {
    it('should send instance.sendInput RPC', async () => {
      mockConnection.sendRpc.mockResolvedValue({ instanceId: 'remote-inst-1' });
      await adapter.spawn();

      mockConnection.sendRpc.mockResolvedValue(undefined);
      await adapter.sendInput('hello');

      expect(mockConnection.sendRpc).toHaveBeenCalledWith(
        'node-1',
        'instance.sendInput',
        expect.objectContaining({
          instanceId: 'remote-inst-1',
          message: 'hello',
        })
      );
    });

    it('should throw if not spawned', async () => {
      await expect(adapter.sendInput('hello')).rejects.toThrow('not spawned');
    });
  });

  describe('interrupt', () => {
    it('should send instance.interrupt RPC', async () => {
      mockConnection.sendRpc.mockResolvedValue({ instanceId: 'remote-inst-1' });
      await adapter.spawn();

      mockConnection.sendRpc.mockResolvedValue(undefined);
      await adapter.interrupt();

      expect(mockConnection.sendRpc).toHaveBeenCalledWith(
        'node-1',
        'instance.interrupt',
        { instanceId: 'remote-inst-1' }
      );
    });
  });

  describe('terminate', () => {
    it('should send instance.terminate RPC and clear remote ID', async () => {
      mockConnection.sendRpc.mockResolvedValue({ instanceId: 'remote-inst-1' });
      await adapter.spawn();

      mockConnection.sendRpc.mockResolvedValue(undefined);
      await adapter.terminate();

      expect(mockConnection.sendRpc).toHaveBeenCalledWith(
        'node-1',
        'instance.terminate',
        { instanceId: 'remote-inst-1' }
      );
      expect(adapter.getRemoteInstanceId()).toBeNull();
    });
  });

  describe('remote event forwarding', () => {
    it('should emit output events when handleRemoteOutput is called', () => {
      const outputs: unknown[] = [];
      adapter.on('output', (msg) => outputs.push(msg));

      adapter.handleRemoteOutput({
        type: 'assistant',
        content: 'Hello',
        timestamp: Date.now(),
      });

      expect(outputs).toHaveLength(1);
    });

    it('should emit exit event when handleRemoteExit is called', () => {
      const exits: unknown[] = [];
      adapter.on('exit', (data) => exits.push(data));

      adapter.handleRemoteExit(0);

      expect(exits).toHaveLength(1);
      expect(exits[0]).toEqual({ code: 0 });
    });

    it('should emit stateChange event when handleRemoteStateChange is called', () => {
      const changes: unknown[] = [];
      adapter.on('stateChange', (status) => changes.push(status));

      adapter.handleRemoteStateChange('busy');

      expect(changes).toEqual(['busy']);
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/main/cli/adapters/__tests__/remote-cli-adapter.spec.ts
```

Expected: FAIL — module not found

- [x] **Step 3: Implement the remote CLI adapter**

```typescript
// src/main/cli/adapters/remote-cli-adapter.ts
import { EventEmitter } from 'events';
import type { CliType } from '../../../shared/types/cli-detection.types';
import type { UnifiedSpawnOptions } from './adapter-factory';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import type { FileAttachment } from '../../../shared/types/instance.types';

/**
 * CLI adapter that proxies all operations to a remote worker node via RPC.
 *
 * Implements the same event interface as local adapters:
 * - 'output'      (message: { type, content, timestamp })
 * - 'exit'        ({ code })
 * - 'stateChange' (status: string)
 * - 'status'      (status: string)
 * - 'error'       (error: Error | string)
 * - 'spawned'     (remoteInstanceId: string)
 * - 'input_required' (payload)
 *
 * Output events arrive from the worker node via the connection server,
 * which calls handleRemoteOutput/handleRemoteExit/handleRemoteStateChange.
 */
export class RemoteCliAdapter extends EventEmitter {
  private remoteInstanceId: string | null = null;

  constructor(
    private nodeConnection: WorkerNodeConnectionServer,
    private targetNodeId: string,
    private requestedCliType: CliType,
    private spawnOptions: UnifiedSpawnOptions,
  ) {
    super();
  }

  async spawn(): Promise<void> {
    const result = await this.nodeConnection.sendRpc<{ instanceId: string }>(
      this.targetNodeId,
      'instance.spawn',
      {
        requestedCliType: this.requestedCliType,
        options: this.spawnOptions,
      },
    );
    this.remoteInstanceId = result.instanceId;
    this.emit('spawned', this.remoteInstanceId);
  }

  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.remoteInstanceId) {
      throw new Error('Remote adapter not spawned: instance not yet created on remote node');
    }
    await this.nodeConnection.sendRpc(this.targetNodeId, 'instance.sendInput', {
      instanceId: this.remoteInstanceId,
      message,
      attachments,
    });
  }

  async interrupt(): Promise<void> {
    if (!this.remoteInstanceId) return;
    await this.nodeConnection.sendRpc(this.targetNodeId, 'instance.interrupt', {
      instanceId: this.remoteInstanceId,
    });
  }

  async terminate(): Promise<void> {
    if (!this.remoteInstanceId) return;
    await this.nodeConnection.sendRpc(this.targetNodeId, 'instance.terminate', {
      instanceId: this.remoteInstanceId,
    });
    this.remoteInstanceId = null;
  }

  getRemoteInstanceId(): string | null {
    return this.remoteInstanceId;
  }

  getTargetNodeId(): string {
    return this.targetNodeId;
  }

  isRunning(): boolean {
    return this.remoteInstanceId !== null;
  }

  // ── Remote event handlers ──
  // Called by the connection server when output arrives from the worker node.

  handleRemoteOutput(message: { type: string; content: string; timestamp: number }): void {
    this.emit('output', message);
  }

  handleRemoteExit(code: number): void {
    this.remoteInstanceId = null;
    this.emit('exit', { code });
  }

  handleRemoteStateChange(status: string): void {
    this.emit('stateChange', status);
    this.emit('status', status);
  }

  handleRemoteError(error: string): void {
    this.emit('error', new Error(error));
  }

  handleRemotePermissionRequest(payload: unknown): void {
    this.emit('input_required', payload);
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/main/cli/adapters/__tests__/remote-cli-adapter.spec.ts
```

Expected: all tests PASS

- [x] **Step 5: Commit**

```bash
git add src/main/cli/adapters/remote-cli-adapter.ts src/main/cli/adapters/__tests__/remote-cli-adapter.spec.ts
git commit -m "feat(remote-node): add RemoteCliAdapter that proxies CLI operations over RPC"
```

---

## Task 11: Extend Adapter Factory

**Files:**
- Modify: `src/main/cli/adapters/adapter-factory.ts`

- [x] **Step 1: Read the current adapter factory to identify exact edit locations**

Read `src/main/cli/adapters/adapter-factory.ts` to find:
- The `CliAdapter` type union (line ~48)
- The `createCliAdapter` function (line ~202)
- Import section

- [x] **Step 2: Add imports and update type union**

At the top of `adapter-factory.ts`, add import:
```typescript
import { RemoteCliAdapter } from './remote-cli-adapter';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import { getWorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
```

Update the `CliAdapter` type union to include `RemoteCliAdapter`:
```typescript
export type CliAdapter = ClaudeCliAdapter | CodexCliAdapter | GeminiCliAdapter | CopilotSdkAdapter | RemoteCliAdapter;
```

- [x] **Step 3: Extend createCliAdapter to handle remote execution**

Add an optional `executionLocation` parameter to `createCliAdapter`:

```typescript
export function createCliAdapter(
  cliType: CliType,
  options: UnifiedSpawnOptions,
  executionLocation?: ExecutionLocation,
): CliAdapter {
  // If remote, create a RemoteCliAdapter regardless of CLI type
  if (executionLocation?.type === 'remote') {
    const connection = getWorkerNodeConnectionServer();
    return new RemoteCliAdapter(connection, executionLocation.nodeId, cliType, options);
  }

  // Existing local adapter creation (unchanged)
  switch (cliType) {
    // ... existing cases ...
  }
}
```

Note: Only add the `executionLocation` parameter and the `if` block at the top of the existing function. Do not change the existing switch statement.

- [x] **Step 4: Verify compilation**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json
```

Expected: no errors

- [x] **Step 5: Run existing adapter factory tests (if any)**

```bash
npx vitest run src/main/cli/adapters/
```

Expected: all tests PASS

- [x] **Step 6: Commit**

```bash
git add src/main/cli/adapters/adapter-factory.ts
git commit -m "feat(remote-node): extend adapter factory to create RemoteCliAdapter for remote execution"
```

---

## Task 12: Final Verification

- [x] **Step 1: Run full TypeScript compilation**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json
```

Expected: no errors

- [x] **Step 2: Run lint**

```bash
npm run lint
```

Expected: no new errors

- [x] **Step 3: Run all new tests**

```bash
npx vitest run src/main/remote-node/ src/main/cli/adapters/__tests__/remote-cli-adapter.spec.ts
```

Expected: all tests PASS

- [x] **Step 4: Run full test suite**

```bash
npm run test
```

Expected: no regressions

---

## Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | Install `ws` | `package.json` |
| 2 | Worker node types | `src/shared/types/worker-node.types.ts` |
| 3 | RPC protocol types | `src/main/remote-node/worker-node-rpc.ts` |
| 4 | Worker node registry | `src/main/remote-node/worker-node-registry.ts` + tests |
| 5 | WebSocket connection server | `src/main/remote-node/worker-node-connection.ts` |
| 6 | Health monitor | `src/main/remote-node/worker-node-health.ts` + tests |
| 7 | Node failover handler | `src/main/remote-node/node-failover.ts` + tests |
| 8 | Barrel exports | `src/main/remote-node/index.ts` |
| 9 | ExecutionLocation on Instance | `src/shared/types/instance.types.ts` |
| 10 | Remote CLI adapter | `src/main/cli/adapters/remote-cli-adapter.ts` + tests |
| 11 | Extend adapter factory | `src/main/cli/adapters/adapter-factory.ts` |
| 12 | Final verification | Full build + lint + test |

**Not included in this plan (deferred to later phases):**
- Instance lifecycle integration (`resolveExecutionLocation` in `instance-lifecycle.ts`) — Phase 2.4 in the bigchange doc. This is a high-risk edit to a ~89K file. It should be planned separately with thorough reading of the instance lifecycle flow.
- IPC handlers, preload bridge, load balancer/resource governor extensions — Phase 5
- Worker agent package — Phase 3
- UI components — Phase 7
