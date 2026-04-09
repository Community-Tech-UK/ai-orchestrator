# Remote Session Latency Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate silent dead zones during extended thinking on remote sessions, and reduce per-message RPC overhead for output streaming.

**Architecture:** Four stacked changes on the worker-agent and coordinator RPC layer: (1) worker heartbeat during CLI silence, (2) `stream:idle` forwarding, (3) fire-and-forget output notifications, (4) output batching. No renderer changes — new statuses propagate through existing infrastructure.

**Tech Stack:** TypeScript, Node.js EventEmitter, WebSocket (ws), JSON-RPC 2.0, Vitest

**Spec:** `docs/superpowers/specs/2026-04-09-remote-session-latency-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types/instance.types.ts` | Modify | Add `'processing'` and `'thinking_deeply'` to `InstanceStatus` union |
| `src/worker-agent/local-instance-manager.ts` | Modify | Activity watchdog timer + `stream:idle` listener per instance |
| `src/worker-agent/worker-agent.ts` | Modify | Output notification format (no `id`), output batcher |
| `src/main/remote-node/worker-node-rpc.ts` | Modify | Add `INSTANCE_OUTPUT_BATCH` constant |
| `src/main/remote-node/rpc-event-router.ts` | Modify | Handle output as notification, batch handler, trusted methods |
| `src/main/remote-node/rpc-schemas.ts` | Modify | Remove `instance.output` from schema map |
| `src/worker-agent/__tests__/worker-agent.spec.ts` | Modify | Tests for notification format + batching |
| `src/main/remote-node/__tests__/rpc-event-router.spec.ts` | Modify | Tests for notification-based output + batch handling |

---

### Task 1: Add `'processing'` and `'thinking_deeply'` to InstanceStatus

**Files:**
- Modify: `src/shared/types/instance.types.ts:70-83`

- [ ] **Step 1: Add the two new status values**

In `src/shared/types/instance.types.ts`, add `'processing'` and `'thinking_deeply'` to the `InstanceStatus` union type:

```typescript
export type InstanceStatus =
  | 'initializing'
  | 'ready'           // Init complete, adapter spawned, waiting for first input
  | 'idle'
  | 'busy'
  | 'processing'      // CLI process alive, no output for several seconds (remote heartbeat)
  | 'thinking_deeply' // CLI process alive, no stdout for 90s+ (extended thinking)
  | 'waiting_for_input'
  | 'respawning'      // Instance is recovering from interrupt, cannot be interrupted again
  | 'hibernating'     // Saving state to disk before suspend
  | 'hibernated'      // State saved, process killed, can wake
  | 'waking'          // Restoring from hibernation
  | 'degraded'        // Remote worker node disconnected; awaiting reconnection or failover
  | 'error'
  | 'failed'          // Unrecoverable init/wake failure
  | 'terminated';
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS — these are additive union members, no existing code breaks.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/instance.types.ts
git commit -m "feat(types): add 'processing' and 'thinking_deeply' to InstanceStatus"
```

---

### Task 2: Add Activity Watchdog and stream:idle to LocalInstanceManager

**Files:**
- Modify: `src/worker-agent/local-instance-manager.ts`

- [ ] **Step 1: Add watchdog constant and timer tracking to ManagedInstance**

At the top of `src/worker-agent/local-instance-manager.ts`, add the constant and extend the interface:

```typescript
const ACTIVITY_WATCHDOG_INTERVAL_MS = 5_000;
```

Add `watchdogTimer` to the `ManagedInstance` interface:

```typescript
export interface ManagedInstance {
  instanceId: string;
  cliType: CliType;
  workingDirectory: string;
  adapter: WorkerManagedAdapter;
  createdAt: number;
  watchdogTimer: ReturnType<typeof setInterval> | null;
}
```

- [ ] **Step 2: Add helper methods for the watchdog**

Add two private methods after the `getInstance` method:

```typescript
  private startWatchdog(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    this.resetWatchdog(instanceId);
  }

  private resetWatchdog(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;

    if (inst.watchdogTimer) {
      clearInterval(inst.watchdogTimer);
    }

    inst.watchdogTimer = setInterval(() => {
      // Instance still exists and adapter is running — emit heartbeat
      if (this.instances.has(instanceId)) {
        this.emit('instance:stateChange', instanceId, 'processing');
      }
    }, ACTIVITY_WATCHDOG_INTERVAL_MS);

    // Don't let the timer keep the worker process alive
    if (inst.watchdogTimer.unref) {
      inst.watchdogTimer.unref();
    }
  }

  private clearWatchdog(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst?.watchdogTimer) return;
    clearInterval(inst.watchdogTimer);
    inst.watchdogTimer = null;
  }
```

- [ ] **Step 3: Wire adapter events to reset/clear watchdog and handle stream:idle**

In the `spawn` method, replace the existing adapter event wiring block (lines 91-99) with:

```typescript
    // Wire adapter events to emit them on this manager
    adapter.on('output', (msg: unknown) => {
      this.resetWatchdog(params.instanceId);
      this.emit('instance:output', params.instanceId, msg);
    });
    adapter.on('exit', (code: number | null, signal: string | null) => {
      this.clearWatchdog(params.instanceId);
      this.instances.delete(params.instanceId);
      this.emit('instance:exit', params.instanceId, { code, signal });
    });
    adapter.on('status', (state: unknown) => {
      this.resetWatchdog(params.instanceId);
      this.emit('instance:stateChange', params.instanceId, state);
    });
    adapter.on('input_required', (permission: unknown) => {
      this.emit('instance:permissionRequest', params.instanceId, permission);
    });
    adapter.on('stream:idle', () => {
      this.emit('instance:stateChange', params.instanceId, 'thinking_deeply');
    });
```

- [ ] **Step 4: Start watchdog after spawn, initialize watchdogTimer in instance record**

After `await adapter.spawn();`, update the instance record and start the watchdog:

```typescript
    // Spawn the process
    await adapter.spawn();

    this.instances.set(params.instanceId, {
      instanceId: params.instanceId,
      cliType: params.cliType,
      workingDirectory: params.workingDirectory,
      adapter,
      createdAt: Date.now(),
      watchdogTimer: null,
    });

    this.startWatchdog(params.instanceId);
```

- [ ] **Step 5: Clear watchdog on terminate**

In the `terminate` method, clear the watchdog before terminating:

```typescript
  async terminate(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    this.clearWatchdog(instanceId);
    await inst.adapter.terminate();
    this.instances.delete(instanceId);
  }
```

- [ ] **Step 6: Clear all watchdogs on terminateAll**

In the `terminateAll` method, clear watchdogs:

```typescript
  async terminateAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    for (const id of ids) {
      this.clearWatchdog(id);
    }
    await Promise.allSettled(ids.map((id) => this.terminate(id)));
  }
```

- [ ] **Step 7: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/worker-agent/local-instance-manager.ts
git commit -m "feat(worker): add activity watchdog heartbeat and stream:idle forwarding"
```

---

### Task 3: Switch instance.output to Notification on Worker

**Files:**
- Modify: `src/worker-agent/worker-agent.ts:344-351`

- [ ] **Step 1: Change output forwarding from RPC request to notification**

In `src/worker-agent/worker-agent.ts`, in the `wireInstanceEvents` method, change the `instance:output` handler. Replace:

```typescript
    this.instanceManager.on('instance:output', (instanceId: string, message: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: `out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: NODE_TO_COORDINATOR.INSTANCE_OUTPUT,
        params: { instanceId, message, token: this.config.nodeToken ?? this.config.authToken },
      });
    });
```

With:

```typescript
    this.instanceManager.on('instance:output', (instanceId: string, message: unknown) => {
      this.sendOutputNotification(instanceId, message);
    });
```

Add the helper method in the "Transport helpers" section:

```typescript
  private sendOutputNotification(instanceId: string, message: unknown): void {
    this.send({
      jsonrpc: '2.0',
      method: NODE_TO_COORDINATOR.INSTANCE_OUTPUT,
      params: { instanceId, message, token: this.config.nodeToken ?? this.config.authToken },
    } as RpcMessage);
  }
```

Note: No `id` field → the coordinator's `isRpcNotification` check will match this (has `method`, no `id`).

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/worker-agent/worker-agent.ts
git commit -m "feat(worker): send instance.output as fire-and-forget notification"
```

---

### Task 4: Handle Output Notifications on Coordinator

**Files:**
- Modify: `src/main/remote-node/rpc-event-router.ts`
- Modify: `src/main/remote-node/rpc-schemas.ts:96-114`
- Modify: `src/main/remote-node/worker-node-rpc.ts`

- [ ] **Step 1: Add INSTANCE_OUTPUT_BATCH to RPC constants**

In `src/main/remote-node/worker-node-rpc.ts`, add the batch method to `NODE_TO_COORDINATOR`:

```typescript
export const NODE_TO_COORDINATOR = {
  REGISTER: 'node.register',
  HEARTBEAT: 'node.heartbeat',
  INSTANCE_OUTPUT: 'instance.output',
  INSTANCE_OUTPUT_BATCH: 'instance.outputBatch',
  INSTANCE_STATE_CHANGE: 'instance.stateChange',
  INSTANCE_PERMISSION_REQUEST: 'instance.permissionRequest',
  FS_EVENT: 'fs.event',
} as const;
```

- [ ] **Step 2: Remove instance.output from RPC_PARAM_SCHEMAS**

In `src/main/remote-node/rpc-schemas.ts`, remove the `'instance.output'` entry from `RPC_PARAM_SCHEMAS`:

```typescript
export const RPC_PARAM_SCHEMAS: Record<string, z.ZodType> = {
  'node.register': NodeRegisterParamsSchema,
  'node.heartbeat': NodeHeartbeatParamsSchema,
  'instance.stateChange': InstanceStateChangeParamsSchema,
  'instance.permissionRequest': InstancePermissionRequestParamsSchema,
  'instance.spawn': InstanceSpawnParamsSchema,
  'instance.sendInput': InstanceSendInputParamsSchema,
  'instance.terminate': InstanceIdParamsSchema,
  'instance.interrupt': InstanceIdParamsSchema,
  'instance.hibernate': InstanceIdParamsSchema,
  'instance.wake': InstanceIdParamsSchema,
  'fs.readDirectory': FsReadDirectoryParamsSchema,
  'fs.stat': FsStatParamsSchema,
  'fs.search': FsSearchParamsSchema,
  'fs.watch': FsWatchParamsSchema,
  'fs.unwatch': FsUnwatchParamsSchema,
  'fs.event': FsEventParamsSchema,
};
```

Note: The `InstanceOutputParamsSchema` export can stay (it's harmless and may be used elsewhere), just remove it from the lookup map.

- [ ] **Step 3: Move output handling from request to notification path in RpcEventRouter**

In `src/main/remote-node/rpc-event-router.ts`:

First, add a trusted notification methods set at the top of the class:

```typescript
  /** Methods handled as trusted notifications — skip per-message auth validation. */
  private readonly trustedNotificationMethods = new Set([
    NODE_TO_COORDINATOR.INSTANCE_OUTPUT,
    NODE_TO_COORDINATOR.INSTANCE_OUTPUT_BATCH,
  ]);
```

Add the `NODE_TO_COORDINATOR` import (it should already be imported, but ensure `INSTANCE_OUTPUT_BATCH` is available — it comes from the same import).

Remove `instance.output` from the `handleRpcRequest` switch statement. Replace:

```typescript
        case NODE_TO_COORDINATOR.INSTANCE_OUTPUT:
          this.handleInstanceOutput(nodeId, request);
          break;
```

With nothing (delete those two lines).

In `handleRpcNotification`, replace the existing switch:

```typescript
  private handleRpcNotification(nodeId: string, notification: RpcNotification): void {
    // Trusted notification methods skip per-message auth validation.
    // The WebSocket was authenticated during node.register.
    if (!this.trustedNotificationMethods.has(notification.method)) {
      const params = notification.params as Record<string, unknown> | undefined;
      const token = typeof params?.['token'] === 'string' ? params['token'] : undefined;
      if (!validateAuthToken(token)) {
        logger.warn('Notification rejected: invalid auth token', { nodeId, method: notification.method });
        return;
      }
    }

    switch (notification.method) {
      case NODE_TO_COORDINATOR.HEARTBEAT: {
        const hbParams = notification.params as Record<string, unknown> | undefined;
        const node = this.registry.getNode(nodeId);
        if (!node) {
          logger.warn('Heartbeat notification received for unknown node', { nodeId });
          return;
        }
        this.registry.updateHeartbeat(nodeId, hbParams?.['capabilities'] as WorkerNodeCapabilities);
        this.registry.updateNodeMetrics(nodeId, {
          activeInstances: typeof hbParams?.['activeInstances'] === 'number'
            ? hbParams['activeInstances']
            : node.activeInstances,
        });
        break;
      }
      case NODE_TO_COORDINATOR.INSTANCE_OUTPUT: {
        this.handleInstanceOutputNotification(nodeId, notification);
        break;
      }
      case NODE_TO_COORDINATOR.INSTANCE_OUTPUT_BATCH: {
        this.handleInstanceOutputBatch(nodeId, notification);
        break;
      }
      default:
        logger.warn('Unknown RPC notification method received', { nodeId, method: notification.method });
    }
  }
```

- [ ] **Step 4: Add the notification handler methods**

Add these private methods to the RpcEventRouter class:

```typescript
  private handleInstanceOutputNotification(nodeId: string, notification: RpcNotification): void {
    if (!this.registry.getNode(nodeId)) {
      logger.warn('Output notification from unknown node', { nodeId });
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    this.registry.emit('remote:instance-output', {
      nodeId,
      instanceId: params?.['instanceId'],
      message: params?.['message'],
    });
  }

  private handleInstanceOutputBatch(nodeId: string, notification: RpcNotification): void {
    if (!this.registry.getNode(nodeId)) {
      logger.warn('Output batch notification from unknown node', { nodeId });
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    const items = params?.['items'];
    if (!Array.isArray(items)) {
      logger.warn('Output batch missing items array', { nodeId });
      return;
    }
    for (const item of items) {
      const entry = item as Record<string, unknown>;
      this.registry.emit('remote:instance-output', {
        nodeId,
        instanceId: entry['instanceId'],
        message: entry['message'],
      });
    }
  }
```

- [ ] **Step 5: Update the handleInstanceOutput method signature for request path (legacy/unused)**

The existing `handleInstanceOutput` method can be removed since `instance.output` is no longer handled as a request. Delete:

```typescript
  private handleInstanceOutput(nodeId: string, request: RpcRequest): void {
    if (!this.registry.getNode(nodeId)) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, `Unknown node: ${nodeId}`),
      );
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = request.params as Record<string, any> | undefined;
    this.registry.emit('remote:instance-output', {
      nodeId,
      instanceId: params?.['instanceId'],
      message: params?.['message'],
    });
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
  }
```

- [ ] **Step 6: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/remote-node/worker-node-rpc.ts src/main/remote-node/rpc-schemas.ts src/main/remote-node/rpc-event-router.ts
git commit -m "feat(coordinator): handle instance.output as notification, add batch support"
```

---

### Task 5: Add Output Batching to WorkerAgent

**Files:**
- Modify: `src/worker-agent/worker-agent.ts`

- [ ] **Step 1: Add batching constants and state**

At the top of the `WorkerAgent` class in `src/worker-agent/worker-agent.ts`, add batching state:

```typescript
  // Output batching
  private outputBuffer: { instanceId: string; message: unknown }[] = [];
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly OUTPUT_BATCH_INTERVAL_MS = 50;
  private static readonly OUTPUT_BATCH_MAX_SIZE = 10;
```

- [ ] **Step 2: Replace the sendOutputNotification method with batching**

Replace the `sendOutputNotification` method added in Task 3:

```typescript
  private sendOutputNotification(instanceId: string, message: unknown): void {
    this.outputBuffer.push({ instanceId, message });

    // Flush immediately if buffer is full
    if (this.outputBuffer.length >= WorkerAgent.OUTPUT_BATCH_MAX_SIZE) {
      this.flushOutputBuffer();
      return;
    }

    // Start flush timer if not already running
    if (!this.outputFlushTimer) {
      this.outputFlushTimer = setTimeout(() => {
        this.flushOutputBuffer();
      }, WorkerAgent.OUTPUT_BATCH_INTERVAL_MS);
      if (this.outputFlushTimer.unref) {
        this.outputFlushTimer.unref();
      }
    }
  }

  private flushOutputBuffer(): void {
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }

    if (this.outputBuffer.length === 0) return;

    const items = this.outputBuffer;
    this.outputBuffer = [];
    const token = this.config.nodeToken ?? this.config.authToken;

    if (items.length === 1) {
      // Single message — send as regular notification (no batch overhead)
      this.send({
        jsonrpc: '2.0',
        method: NODE_TO_COORDINATOR.INSTANCE_OUTPUT,
        params: { instanceId: items[0].instanceId, message: items[0].message, token },
      } as RpcMessage);
    } else {
      // Multiple messages — send as batch notification
      this.send({
        jsonrpc: '2.0',
        method: NODE_TO_COORDINATOR.INSTANCE_OUTPUT_BATCH,
        params: { items, token },
      } as RpcMessage);
    }
  }
```

- [ ] **Step 3: Flush buffer on disconnect**

In the `disconnect` method, flush before closing:

```typescript
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    this.stopContinuousDiscovery();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.flushOutputBuffer(); // Flush pending output before shutdown
    await this.instanceManager.terminateAll();
    this.fsHandler?.cleanupAllWatchers();
    if (this.ws) {
      this.ws.close(1000, 'Worker shutting down');
      this.ws = null;
    }
  }
```

- [ ] **Step 4: Add NODE_TO_COORDINATOR import if needed**

Verify that `NODE_TO_COORDINATOR` is imported in `worker-agent.ts`. It should already be — check the existing import at the top of the file:

```typescript
import { COORDINATOR_TO_NODE, NODE_TO_COORDINATOR, RPC_ERROR_CODES } from '../main/remote-node/worker-node-rpc';
```

If `NODE_TO_COORDINATOR` is missing, add it.

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/worker-agent/worker-agent.ts
git commit -m "feat(worker): add output batching with 50ms window and max-10 flush"
```

---

### Task 6: Update WorkerAgent Tests

**Files:**
- Modify: `src/worker-agent/__tests__/worker-agent.spec.ts`

- [ ] **Step 1: Add test for output notification format (no id)**

Add after the existing `'forwards permission requests...'` test:

```typescript
  it('sends instance.output as notification (no id field)', () => {
    vi.useRealTimers(); // Need real timers for flush
    (agent as unknown as { ws: { readyState: number; send: typeof wsSend } }).ws = {
      readyState: 1,
      send: wsSend,
    };

    mockInstanceManager.emit('instance:output', 'inst-1', { type: 'assistant', content: 'hello' });

    // Flush the output buffer (50ms batch window)
    // Single message should be sent immediately as notification
    vi.useFakeTimers();
    vi.advanceTimersByTime(60);

    expect(wsSend).toHaveBeenCalled();
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.output');
    expect(payload.id).toBeUndefined(); // Notification — no id
    expect(payload.params).toMatchObject({
      instanceId: 'inst-1',
      message: { type: 'assistant', content: 'hello' },
      token: 'test-token',
    });
  });
```

- [ ] **Step 2: Add test for output batching**

```typescript
  it('batches multiple output messages into instance.outputBatch', () => {
    mockInstanceManager.emit('instance:output', 'inst-1', { type: 'assistant', content: 'msg1' });
    mockInstanceManager.emit('instance:output', 'inst-1', { type: 'tool_use', content: 'msg2' });
    mockInstanceManager.emit('instance:output', 'inst-2', { type: 'assistant', content: 'msg3' });

    // Advance past the 50ms batch interval
    vi.advanceTimersByTime(60);

    expect(wsSend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.outputBatch');
    expect(payload.id).toBeUndefined(); // Notification — no id
    expect(payload.params.items).toHaveLength(3);
    expect(payload.params.items[0]).toMatchObject({ instanceId: 'inst-1' });
    expect(payload.params.items[2]).toMatchObject({ instanceId: 'inst-2' });
  });
```

- [ ] **Step 3: Add test for batch flush on max size**

```typescript
  it('flushes output buffer immediately when batch max size is reached', () => {
    // Send 10 messages (max batch size)
    for (let i = 0; i < 10; i++) {
      mockInstanceManager.emit('instance:output', 'inst-1', { type: 'assistant', content: `msg${i}` });
    }

    // Should flush immediately without waiting for timer
    expect(wsSend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.outputBatch');
    expect(payload.params.items).toHaveLength(10);
  });
```

- [ ] **Step 4: Add test for stateChange forwarding (still uses RPC request)**

```typescript
  it('sends instance.stateChange as RPC request (with id field)', () => {
    mockInstanceManager.emit('instance:stateChange', 'inst-1', 'processing');

    expect(wsSend).toHaveBeenCalled();
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.method).toBe('instance.stateChange');
    expect(payload.id).toBeDefined(); // RPC request — has id
    expect(payload.params.state).toBe('processing');
  });
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/worker-agent/__tests__/worker-agent.spec.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/worker-agent/__tests__/worker-agent.spec.ts
git commit -m "test(worker): add tests for output notification format and batching"
```

---

### Task 7: Update RpcEventRouter Tests

**Files:**
- Modify: `src/main/remote-node/__tests__/rpc-event-router.spec.ts`

- [ ] **Step 1: Update the mock rpc-schemas to remove instance.output**

In the mock at the top of the test file, remove `'instance.output'` from `RPC_PARAM_SCHEMAS`:

```typescript
vi.mock('../rpc-schemas', () => ({
  validateRpcParams: vi.fn(),
  RPC_PARAM_SCHEMAS: {
    'node.register': {},
    'node.heartbeat': {},
    'instance.stateChange': {},
    'instance.permissionRequest': {},
  },
}));
```

- [ ] **Step 2: Replace the existing instance.output request test with a notification test**

Replace the section "rpc:request instance.output — emits remote:instance-output on registry" with:

```typescript
  // -------------------------------------------------------------------------
  // rpc:notification instance.output — emits remote:instance-output on registry
  // -------------------------------------------------------------------------

  it('emits remote:instance-output on registry for instance.output notification', () => {
    registry.registerNode(makeNode('node-5'));
    const outputHandler = vi.fn();
    registry.on('remote:instance-output', outputHandler);

    mockConnection.emit('rpc:notification', 'node-5', {
      jsonrpc: '2.0',
      method: 'instance.output',
      params: {
        instanceId: 'inst-1',
        message: 'hello output',
      },
    });

    expect(outputHandler).toHaveBeenCalledWith({
      nodeId: 'node-5',
      instanceId: 'inst-1',
      message: 'hello output',
    });
    // Notification — no response sent
    expect(mockConnection.sendResponse).not.toHaveBeenCalled();
  });

  it('ignores instance.output notification from unknown node', () => {
    const outputHandler = vi.fn();
    registry.on('remote:instance-output', outputHandler);

    mockConnection.emit('rpc:notification', 'unknown-node', {
      jsonrpc: '2.0',
      method: 'instance.output',
      params: {
        instanceId: 'inst-1',
        message: 'hello',
      },
    });

    expect(outputHandler).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Add test for instance.outputBatch notification**

```typescript
  // -------------------------------------------------------------------------
  // rpc:notification instance.outputBatch — emits per-item remote:instance-output
  // -------------------------------------------------------------------------

  it('emits remote:instance-output for each item in instance.outputBatch notification', () => {
    registry.registerNode(makeNode('node-5b'));
    const outputHandler = vi.fn();
    registry.on('remote:instance-output', outputHandler);

    mockConnection.emit('rpc:notification', 'node-5b', {
      jsonrpc: '2.0',
      method: 'instance.outputBatch',
      params: {
        items: [
          { instanceId: 'inst-1', message: 'msg1' },
          { instanceId: 'inst-2', message: 'msg2' },
          { instanceId: 'inst-1', message: 'msg3' },
        ],
      },
    });

    expect(outputHandler).toHaveBeenCalledTimes(3);
    expect(outputHandler).toHaveBeenNthCalledWith(1, {
      nodeId: 'node-5b',
      instanceId: 'inst-1',
      message: 'msg1',
    });
    expect(outputHandler).toHaveBeenNthCalledWith(2, {
      nodeId: 'node-5b',
      instanceId: 'inst-2',
      message: 'msg2',
    });
    expect(outputHandler).toHaveBeenNthCalledWith(3, {
      nodeId: 'node-5b',
      instanceId: 'inst-1',
      message: 'msg3',
    });
    expect(mockConnection.sendResponse).not.toHaveBeenCalled();
  });

  it('ignores instance.outputBatch with missing items array', () => {
    registry.registerNode(makeNode('node-5c'));
    const outputHandler = vi.fn();
    registry.on('remote:instance-output', outputHandler);

    mockConnection.emit('rpc:notification', 'node-5c', {
      jsonrpc: '2.0',
      method: 'instance.outputBatch',
      params: { broken: true },
    });

    expect(outputHandler).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4: Update the stop() test for the changed output routing**

The existing `stop()` test sends `instance.output` as an rpc:request. Since output is now handled via rpc:notification, update the relevant assertion. Replace:

```typescript
    const outputHandler = vi.fn();
    registry.on('remote:instance-output', outputHandler);
    mockConnection.emit('rpc:request', 'node-9', makeRpcRequest('instance.output', { instanceId: 'x', message: 'y' }));
    expect(outputHandler).not.toHaveBeenCalled();
```

With:

```typescript
    const outputHandler = vi.fn();
    registry.on('remote:instance-output', outputHandler);
    mockConnection.emit('rpc:notification', 'node-9', {
      jsonrpc: '2.0',
      method: 'instance.output',
      params: { instanceId: 'x', message: 'y' },
    });
    expect(outputHandler).not.toHaveBeenCalled();
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/main/remote-node/__tests__/rpc-event-router.spec.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/remote-node/__tests__/rpc-event-router.spec.ts
git commit -m "test(coordinator): update rpc-event-router tests for notification-based output"
```

---

### Task 8: Full Verification

- [ ] **Step 1: TypeScript compilation check (main)**

Run: `npx tsc --noEmit`
Expected: PASS — no errors

- [ ] **Step 2: TypeScript compilation check (spec)**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS — no errors

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS — no new lint errors

- [ ] **Step 4: Run all tests**

Run: `npm run test`
Expected: All tests PASS

- [ ] **Step 5: Final commit (if any lint/test fixes were needed)**

```bash
git add -A
git commit -m "chore: lint and test fixes for remote session latency improvements"
```
