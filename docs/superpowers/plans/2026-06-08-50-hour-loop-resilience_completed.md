# 50-Hour Loop Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI Orchestrator able to run very long loops, targeting 50-hour unattended runs, without optional subsystems, oversized SQLite reads, oversized local file reads, app restarts losing the loop, or crashes losing the user's open chat workspace.

**Architecture:** Keep SQLite for the control plane, but enforce bounded persistence contracts everywhere that can grow with loop duration or workspace size. Move high-risk native/SQLite-heavy subsystems into forked child processes so V8/native aborts degrade that subsystem instead of killing Electron. Bound loop-owned file reads and per-iteration payloads before they reach IPC, JSON serialization, or SQLite. Persist loop checkpoints and top-level chat UI state after every material state transition so an interrupted app can restore a paused loop, reopen the user's last chat workspace, and resume from durable state.

**Tech Stack:** TypeScript 5.9, Electron 40 main process, Node child processes, better-sqlite3, Vitest, Angular IPC contracts.

---

## Non-Negotiable Execution Notes

- Run every shell command with the `rtk` prefix.
- Do not commit unless James explicitly authorizes commits for the execution run.
- Do not touch unrelated dirty renderer files. Current unrelated dirty files exist under `src/renderer/app/features/**`.
- The current codemem crash fix in `src/main/codemem/**` should be treated as the baseline slice for this plan.
- For each task, follow TDD: write the failing test, run it and confirm the expected failure, then implement the minimum code.

## File Structure

| Area | Files | Responsibility |
| --- | --- | --- |
| Shared isolation runtime | `src/main/runtime/isolated-worker-process.ts`, `src/main/runtime/isolated-worker-process.spec.ts` | One reusable child-process handle for codemem, context/RLM, watchdog, and future heavy workers |
| Codemem baseline | `src/main/codemem/index-worker-gateway.ts`, `src/main/codemem/index-worker-main.ts`, `src/main/codemem/cas-store.ts`, `src/main/codemem/code-index-manager.ts`, `src/main/codemem/periodic-scan.ts` | Existing first slice: child-process codemem and bounded manifest reads |
| Context/RLM isolation | `src/main/instance/context-worker-client.ts`, `src/main/instance/context-worker-main.ts`, `src/main/instance/__tests__/context-worker-client.spec.ts`, `src/main/instance/__tests__/context-worker-main.spec.ts` | Move RLM/unified-memory worker out of WorkerThread |
| Bounded persistence | `src/main/orchestration/event-store/orchestration-event-store.ts`, `src/main/orchestration/event-store/__tests__/event-store.spec.ts`, `src/main/orchestration/loop-store.ts`, `src/main/orchestration/loop-store.spec.ts`, `src/main/rlm/session-compactor.ts`, `src/main/rlm/session-compactor.spec.ts` | Remove whole-table/whole-run `.all()` patterns from long-lived stores |
| Loop checkpoints | `src/main/orchestration/loop-checkpoint.ts`, `src/main/orchestration/loop-schema.ts`, `src/main/orchestration/loop-store.ts`, `src/main/orchestration/loop-store.spec.ts` | Persist a restart-safe loop state snapshot plus bounded history tail |
| Loop restore | `src/main/orchestration/loop-coordinator.ts`, `src/main/orchestration/loop-coordinator-restore.spec.ts`, `src/main/ipc/handlers/loop-handlers.ts`, `src/main/ipc/handlers/__tests__/loop-handlers.spec.ts` | Restore a paused/interrupted loop from checkpoint and resume through existing IPC |
| Resource governor | `src/main/runtime/long-run-resource-governor.ts`, `src/main/runtime/long-run-resource-governor.spec.ts`, `src/main/orchestration/loop-coordinator.ts`, `src/main/orchestration/loop-coordinator-resource-governor.spec.ts`, `src/main/app/initialization-steps.ts` | Make loops shed optional subsystems or pause before memory/DB exhaustion |
| Codemem lifecycle | `src/main/codemem/codemem-pruner.ts`, `src/main/codemem/codemem-pruner.spec.ts`, `src/main/codemem/cas-store.ts`, `src/main/codemem/__tests__/cas-store.spec.ts`, `src/main/codemem/index-worker-main.ts` | Workspace-level codemem quotas, pruning, and compaction |
| Loop file-size guards | `src/main/orchestration/bounded-file-read.ts`, `src/main/orchestration/bounded-file-read.spec.ts`, `src/main/orchestration/loop-diff.ts`, `src/main/orchestration/loop-diff.spec.ts`, `src/main/orchestration/loop-workspace-snapshot.ts`, `src/main/orchestration/loop-workspace-snapshot.spec.ts`, `src/main/orchestration/loop-stage-machine.ts`, `src/main/orchestration/loop-completion-detector.ts`, `src/main/orchestration/loop-coordinator-state-helpers.ts`, `src/main/orchestration/loop-coordinator.ts` | Prevent huge workspace files or loop artifact files from being fully materialized in Electron |
| 50-hour contracts | `packages/contracts/src/schemas/loop.schemas.ts`, `packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts`, `src/shared/types/loop.types.ts`, `src/main/orchestration/loop-coordinator-state-helpers.ts`, `src/main/orchestration/loop-coordinator-state-helpers.spec.ts` | Accept 50-hour loop configurations and enforce configured token caps |
| Chat crash restore | `packages/contracts/src/channels/chat.channels.ts`, `packages/contracts/src/channels/__tests__/chat.channels.spec.ts`, `packages/contracts/src/schemas/chat.schemas.ts`, `packages/contracts/src/schemas/__tests__/chat.schemas.spec.ts`, `src/shared/types/chat.types.ts`, `src/main/operator/operator-schema.ts`, `src/main/chats/chat-ui-state-store.ts`, `src/main/chats/chat-ui-state-store.spec.ts`, `src/main/chats/chat-service.ts`, `src/main/chats/chat-service.spec.ts`, `src/main/ipc/handlers/chat-handlers.ts`, `src/preload/domains/chat.preload.ts`, `src/preload/__tests__/chat-domain.spec.ts`, `src/renderer/app/core/services/ipc/chat-ipc.service.ts`, `src/renderer/app/core/services/ipc/chat-ipc.service.spec.ts`, `src/renderer/app/core/state/chat.store.ts`, `src/renderer/app/core/state/chat.store.spec.ts` | Persist and restore the user's selected/open chat workspace across hard app crashes without trusting stale runtime instance ids |
| Soak/chaos | `src/main/orchestration/long-loop-resilience.spec.ts`, `scripts/soak-long-loop.ts`, `package.json` | Simulated long-loop and crash/degrade verification |

---

### Task 1: Shared Isolated Worker Process Runtime

**Files:**
- Create: `src/main/runtime/isolated-worker-process.ts`
- Create: `src/main/runtime/isolated-worker-process.spec.ts`
- Modify: `src/main/codemem/index-worker-gateway.ts`
- Test: `src/main/codemem/__tests__/index-worker-gateway.spec.ts`

- [x] **Step 1: Write the failing shared-runtime test**

Create `src/main/runtime/isolated-worker-process.spec.ts`:

```typescript
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, afterEach } from 'vitest';

describe('createIsolatedWorkerProcess', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('forks a node child process with IPC, env, and tsx support for TypeScript entrypoints', async () => {
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      kill: vi.fn(),
      connected: true,
      exitCode: null,
    });
    const fork = vi.fn(() => child);
    vi.doMock('node:child_process', () => ({ default: { fork }, fork }));

    const { createIsolatedWorkerProcess } = await import('./isolated-worker-process');
    const handle = createIsolatedWorkerProcess<{ type: 'ping' }, { type: 'pong' }>({
      name: 'test-worker',
      entrypoint: '/tmp/test-worker.ts',
      env: { AIO_USER_DATA_PATH: '/tmp/aio' },
    });

    handle.postMessage({ type: 'ping' });
    expect(child.send).toHaveBeenCalledWith({ type: 'ping' });
    expect(fork).toHaveBeenCalledWith('/tmp/test-worker.ts', [], expect.objectContaining({
      env: expect.objectContaining({
        AIO_USER_DATA_PATH: '/tmp/aio',
        ELECTRON_RUN_AS_NODE: '1',
      }),
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }));

    const received: unknown[] = [];
    handle.on('message', (message) => received.push(message));
    child.emit('message', { type: 'pong' });
    expect(received).toEqual([{ type: 'pong' }]);
  });

  it('terminate resolves immediately for already-exited children', async () => {
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      kill: vi.fn(),
      connected: false,
      exitCode: 7,
    });
    const fork = vi.fn(() => child);
    vi.doMock('node:child_process', () => ({ default: { fork }, fork }));

    const { createIsolatedWorkerProcess } = await import('./isolated-worker-process');
    const handle = createIsolatedWorkerProcess({ name: 'done', entrypoint: '/tmp/done.js' });

    await expect(handle.terminate()).resolves.toBe(7);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
rtk npx vitest run src/main/runtime/isolated-worker-process.spec.ts
```

Expected: FAIL with `Cannot find module './isolated-worker-process'`.

- [x] **Step 3: Implement the shared runtime**

Create `src/main/runtime/isolated-worker-process.ts`:

```typescript
import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface IsolatedWorkerProcess<TInbound = unknown, TOutbound = unknown> extends EventEmitter {
  postMessage(message: TInbound): void;
  terminate(): Promise<number>;
  on(event: 'message', listener: (message: TOutbound) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): this;
}

export interface IsolatedWorkerProcessOptions {
  name: string;
  entrypoint: string;
  args?: string[];
  env?: Record<string, string | undefined>;
}

export function createIsolatedWorkerProcess<TInbound = unknown, TOutbound = unknown>(
  options: IsolatedWorkerProcessOptions,
): IsolatedWorkerProcess<TInbound, TOutbound> {
  const child = fork(options.entrypoint, options.args ?? [], {
    env: {
      ...process.env,
      ...options.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    execArgv: options.entrypoint.endsWith('.ts') ? ['--import', 'tsx'] : [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return new ChildProcessWorkerHandle<TInbound, TOutbound>(options.name, child);
}

class ChildProcessWorkerHandle<TInbound, TOutbound>
  extends EventEmitter
  implements IsolatedWorkerProcess<TInbound, TOutbound> {
  constructor(
    private readonly name: string,
    private readonly child: ChildProcess,
  ) {
    super();
    child.on('message', (message) => this.emit('message', message as TOutbound));
    child.on('error', (error) => this.emit('error', error));
    child.on('exit', (code, signal) => this.emit('exit', code, signal));
  }

  postMessage(message: TInbound): void {
    if (!this.child.connected) {
      throw new Error(`${this.name} IPC is disconnected`);
    }
    this.child.send(message);
  }

  async terminate(): Promise<number> {
    if (this.child.exitCode !== null) {
      return this.child.exitCode ?? 0;
    }
    this.child.kill();
    return 0;
  }
}
```

- [x] **Step 4: Refactor codemem gateway onto the shared runtime**

Modify `src/main/codemem/index-worker-gateway.ts` so `makeWorker()` calls `createIsolatedWorkerProcess` instead of owning `ChildProcessIndexWorkerHandle` inline:

```typescript
import { createIsolatedWorkerProcess, type IsolatedWorkerProcess } from '../runtime/isolated-worker-process';

export type IndexWorkerProcessHandle =
  IsolatedWorkerProcess<IndexWorkerInboundMsg, IndexWorkerOutboundMsg>;

function makeWorker(userDataPath: string): IndexWorkerProcessHandle {
  const jsEntry = path.join(__dirname, 'index-worker-main.js');
  const entry = existsSync(jsEntry) ? jsEntry : path.join(__dirname, 'index-worker-main.ts');
  return createIsolatedWorkerProcess<IndexWorkerInboundMsg, IndexWorkerOutboundMsg>({
    name: 'codemem index worker',
    entrypoint: entry,
    env: { AIO_USER_DATA_PATH: userDataPath },
  });
}
```

Delete the now-local `ChildProcessIndexWorkerHandle` class from `index-worker-gateway.ts`.

- [x] **Step 5: Verify shared runtime and codemem gateway**

Run:

```bash
rtk npx vitest run src/main/runtime/isolated-worker-process.spec.ts src/main/codemem/__tests__/index-worker-gateway.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit if authorized**

If James has explicitly authorized commits for this execution run:

```bash
rtk git add src/main/runtime/isolated-worker-process.ts src/main/runtime/isolated-worker-process.spec.ts src/main/codemem/index-worker-gateway.ts src/main/codemem/__tests__/index-worker-gateway.spec.ts
rtk git commit -m "refactor: share isolated worker process runtime"
```

---

### Task 2: Move Context/RLM Worker to a Child Process

**Files:**
- Modify: `src/main/instance/context-worker-client.ts`
- Modify: `src/main/instance/context-worker-main.ts`
- Modify: `src/main/instance/__tests__/context-worker-client.spec.ts`
- Create: `src/main/instance/__tests__/context-worker-main.spec.ts`

- [x] **Step 1: Add failing default-factory test for `ContextWorkerClient`**

Append this test to `src/main/instance/__tests__/context-worker-client.spec.ts`:

```typescript
describe('ContextWorkerClient default process isolation', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:worker_threads');
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('starts the production context worker as a child process instead of a worker_thread', async () => {
    vi.resetModules();
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn((message: { type?: string; id?: number }) => {
        if (message.type === 'shutdown') {
          queueMicrotask(() => child.emit('message', { type: 'rpc-response', id: message.id }));
        }
      }),
      kill: vi.fn(),
      connected: true,
      exitCode: null,
    });
    const fork = vi.fn(() => child);
    const Worker = vi.fn(() => createFakeWorker());

    vi.doMock('node:child_process', () => ({ default: { fork }, fork }));
    vi.doMock('node:worker_threads', () => ({ default: { Worker }, Worker }));
    vi.doMock('node:fs', () => ({ default: { existsSync: vi.fn(() => true) }, existsSync: vi.fn(() => true) }));

    const { ContextWorkerClient } = await import('../context-worker-client');
    const isolated = new ContextWorkerClient({ userDataPath: '/tmp/test', rpcTimeoutMs: 50 });

    expect(fork).toHaveBeenCalledWith(
      expect.stringContaining('context-worker-main.js'),
      [],
      expect.objectContaining({
        env: expect.objectContaining({ AIO_USER_DATA_PATH: '/tmp/test' }),
      }),
    );
    expect(Worker).not.toHaveBeenCalled();

    await isolated.shutdown();
  });
});
```

- [x] **Step 2: Run the failing client test**

Run:

```bash
rtk npx vitest run src/main/instance/__tests__/context-worker-client.spec.ts
```

Expected: FAIL because `fork` is not called and `Worker` is still used.

- [x] **Step 3: Add failing child-process transport test for `context-worker-main`**

Create `src/main/instance/__tests__/context-worker-main.spec.ts`:

```typescript
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
  }
}

describe('context worker main', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('node:worker_threads', () => ({
      default: { parentPort: null, isMainThread: true, workerData: null },
      parentPort: null,
      isMainThread: true,
      workerData: null,
    }));
    vi.doMock('../instance-context', () => ({
      InstanceContextManager: vi.fn(() => ({
        buildRlmContext: vi.fn().mockResolvedValue({
          context: 'from rlm',
          tokens: 2,
          sectionsAccessed: [],
          durationMs: 1,
          source: 'semantic',
        }),
        initializeRlm: vi.fn().mockResolvedValue(undefined),
        endRlmSession: vi.fn(),
        ingestToRLM: vi.fn(),
        ingestToUnifiedMemory: vi.fn(),
        buildUnifiedMemoryContext: vi.fn().mockResolvedValue(null),
        compactContext: vi.fn().mockResolvedValue(undefined),
        ingestInitialOutputToRlm: vi.fn().mockResolvedValue(undefined),
      })),
    }));
    vi.doMock('../../persistence/rlm-database', () => ({
      RLMDatabase: { getInstance: vi.fn(() => ({})) },
    }));
    vi.doMock('../../memory/wake-context-builder', () => ({
      getWakeContextBuilder: () => ({ getWakeUpText: vi.fn(() => 'wake text') }),
    }));
    vi.doMock('../../mcp/mcp-runtime-tool-context', () => ({
      buildMcpRuntimeToolContextSelection: vi.fn(() => ({
        serverSummaries: [],
        selectedToolIds: [],
        deferredToolCount: 0,
      })),
    }));
    vi.doMock('../../observation/policy-adapter', () => ({
      getPolicyAdapter: () => ({ buildObservationContext: vi.fn().mockResolvedValue(null) }),
    }));
    vi.doMock('../../memory/project-memory-brief-worker', () => ({
      buildProjectMemoryBriefInWorker: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../learning/learning-state-snapshots', () => ({
      loadHabitTrackerStateSnapshot: vi.fn(() => null),
      loadMetricsCollectorStateSnapshot: vi.fn(() => null),
      loadOutcomeTrackerStateSnapshot: vi.fn(() => null),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('node:worker_threads');
  });

  it('accepts child-process IPC when launched outside worker_threads', async () => {
    const send = vi.fn();
    const handlers: Array<(message: unknown) => void> = [];
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const originalOn = process.on.bind(process);
    Object.defineProperty(process, 'send', { configurable: true, value: send });
    vi.spyOn(process, 'on').mockImplementation((eventName, listener) => {
      if (eventName === 'message') {
        handlers.push(listener as (message: unknown) => void);
        return process;
      }
      return originalOn(eventName, listener);
    });
    process.env['AIO_USER_DATA_PATH'] = '/tmp/aio-context-child-test';

    try {
      await import('../context-worker-main');
      expect(handlers).toHaveLength(1);
      handlers[0]?.({
        type: 'build-rlm-context',
        id: 42,
        instanceId: 'inst-1',
        query: 'query',
        maxTokens: 100,
        topK: 3,
      });
      await flushMicrotasks();

      expect(send).toHaveBeenCalledWith({ type: 'ready' });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'rpc-response',
        id: 42,
        result: expect.objectContaining({ context: 'from rlm' }),
      }));
    } finally {
      delete process.env['AIO_USER_DATA_PATH'];
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor);
      } else {
        Reflect.deleteProperty(process, 'send');
      }
    }
  });
});
```

- [x] **Step 4: Run the failing entrypoint test**

Run:

```bash
rtk npx vitest run src/main/instance/__tests__/context-worker-main.spec.ts
```

Expected: FAIL with `context-worker-main must run in a worker thread`.

- [x] **Step 5: Implement child-process gateway in `context-worker-client.ts`**

Change imports and worker handle types:

```typescript
import { createIsolatedWorkerProcess, type IsolatedWorkerProcess } from '../runtime/isolated-worker-process';

type ContextWorkerProcessHandle =
  IsolatedWorkerProcess<ContextWorkerInboundMsg, ContextWorkerOutboundMsg>;

export interface ContextWorkerClientOptions {
  rpcTimeoutMs?: number;
  workerFactory?: (userDataPath: string) => ContextWorkerProcessHandle;
  userDataPath?: string;
}
```

Replace `makeWorker()`:

```typescript
function makeWorker(userDataPath: string): ContextWorkerProcessHandle {
  const jsEntry = path.join(__dirname, 'context-worker-main.js');
  const entry = existsSync(jsEntry) ? jsEntry : path.join(__dirname, 'context-worker-main.ts');
  return createIsolatedWorkerProcess<ContextWorkerInboundMsg, ContextWorkerOutboundMsg>({
    name: 'context worker',
    entrypoint: entry,
    env: { AIO_USER_DATA_PATH: userDataPath },
  });
}
```

Add `private shuttingDown = false;`, set it in `shutdown()`, reset it in `startWorker()`, ignore non-zero exits while shutting down, and unref restart timers:

```typescript
async shutdown(): Promise<void> {
  this.shuttingDown = true;
  this.failAllPending(new Error('shutdown'));
  // existing shutdown body
}

private startWorker(): void {
  if (this.worker) return;
  this.shuttingDown = false;
  // existing worker startup
}
```

Inside the exit handler:

```typescript
if (code !== 0 && !this.shuttingDown) {
  this.handleWorkerError(new Error(`Context worker exited with code ${code}`));
}
```

Inside `handleWorkerError()`:

```typescript
this.worker = null;
if (this.shuttingDown) return;
this.markDegraded(err.message);
const timer = setTimeout(() => {
  this.isDegraded = false;
  this.startWorker();
}, RESTART_BACKOFF_MS);
timer.unref?.();
```

- [x] **Step 6: Add dual transport to `context-worker-main.ts`**

Replace the worker-thread-only guard with a transport identical in shape to codemem:

```typescript
interface ContextWorkerTransport {
  postMessage(message: ContextWorkerOutboundMsg): void;
  onMessage(listener: (message: ContextWorkerInboundMsg) => void): void;
}

function createTransport(): ContextWorkerTransport {
  if (parentPort) {
    const port = parentPort;
    return {
      postMessage: (message) => port.postMessage(message),
      onMessage: (listener) => port.on('message', listener),
    };
  }
  if (isMainThread && typeof process.send === 'function') {
    return {
      postMessage: (message) => process.send?.(message),
      onMessage: (listener) => {
        process.on('message', (message) => listener(message as ContextWorkerInboundMsg));
      },
    };
  }
  throw new Error('context-worker-main must run in a worker thread or child process');
}

const transport = createTransport();
```

Change userData path resolution:

```typescript
const userDataPath =
  (workerData as { userDataPath?: string } | null)?.userDataPath ??
  process.env['AIO_USER_DATA_PATH'] ??
  getElectronUserDataPath() ??
  path.join(os.tmpdir(), 'ai-orchestrator');
```

Replace `parentPort!.postMessage(...)` with `transport.postMessage(...)` and `parentPort!.on('message', ...)` with `transport.onMessage(...)`.

- [x] **Step 7: Verify context isolation**

Run:

```bash
rtk npx vitest run src/main/instance/__tests__/context-worker-client.spec.ts src/main/instance/__tests__/context-worker-main.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit if authorized**

```bash
rtk git add src/main/instance/context-worker-client.ts src/main/instance/context-worker-main.ts src/main/instance/__tests__/context-worker-client.spec.ts src/main/instance/__tests__/context-worker-main.spec.ts
rtk git commit -m "fix: isolate context worker in child process"
```

---

### Task 3: Add Bounded Persistence Contracts

**Files:**
- Modify: `src/main/orchestration/event-store/orchestration-event-store.ts`
- Modify: `src/main/orchestration/event-store/__tests__/event-store.spec.ts`
- Modify: `src/main/orchestration/loop-store.ts`
- Modify: `src/main/orchestration/loop-store.spec.ts`
- Modify: `src/main/rlm/session-compactor.ts`
- Modify: `src/main/rlm/session-compactor.spec.ts`

- [x] **Step 1: Add failing event-store bounded-read tests**

Append to `src/main/orchestration/event-store/__tests__/event-store.spec.ts`:

```typescript
it('caps getAllEvents unless an explicit smaller limit is supplied', () => {
  const db = makeDb();
  const store = new OrchestrationEventStore(db);
  store.initialize();
  for (let index = 0; index < 3; index++) {
    store.append({
      id: `event-${index}`,
      type: 'verification.requested',
      aggregateId: `verify-${index}`,
      timestamp: 100 + index,
      payload: { index },
    });
  }

  expect(store.getAllEvents({ limit: 2 }).map((event) => event.id)).toEqual(['event-0', 'event-1']);
});

it('projects active aggregates from only relevant bounded rows', () => {
  const db = makeDb();
  const store = new OrchestrationEventStore(db);
  store.initialize();
  for (let index = 0; index < 3; index++) {
    store.append({
      id: `noise-${index}`,
      type: 'debate.round_completed',
      aggregateId: `debate-${index}`,
      timestamp: 10 + index,
      payload: {},
    });
  }
  store.append({
    id: 'verification-1',
    type: 'verification.requested',
    aggregateId: 'verification-active',
    timestamp: 20,
    payload: { query: 'check this' },
  });

  expect(store.getActiveVerificationRequests()).toHaveLength(1);
});
```

Run:

```bash
rtk npx vitest run src/main/orchestration/event-store/__tests__/event-store.spec.ts
```

Expected: FAIL because `getAllEvents` does not accept `{ limit }`.

- [x] **Step 2: Implement bounded event-store reads**

In `src/main/orchestration/event-store/orchestration-event-store.ts`, add constants and options:

```typescript
const DEFAULT_EVENT_REPLAY_LIMIT = 50_000;
const MAX_EVENT_REPLAY_LIMIT = 100_000;

function boundedLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(Math.floor(limit ?? fallback), MAX_EVENT_REPLAY_LIMIT));
}
```

Change:

```typescript
getByAggregateId(aggregateId: string, options: { limit?: number } = {}): OrchestrationEvent[] {
  const limit = boundedLimit(options.limit, DEFAULT_EVENT_REPLAY_LIMIT);
  const stmt = this.db.prepareCached(
    'SELECT * FROM orchestration_events WHERE aggregate_id = ? ORDER BY timestamp ASC LIMIT ?',
  );
  return (stmt.all(aggregateId, limit) as EventRow[]).map(rowToEvent);
}

getAllEvents(options: { limit?: number } = {}): OrchestrationEvent[] {
  const limit = boundedLimit(options.limit, DEFAULT_EVENT_REPLAY_LIMIT);
  const stmt = this.db.prepareCached(
    'SELECT * FROM orchestration_events ORDER BY timestamp ASC LIMIT ?',
  );
  return (stmt.all(limit) as EventRow[]).map(rowToEvent);
}
```

Change `projectActiveAggregates()` to load only relevant event types:

```typescript
private getEventsByTypes(types: OrchestrationEventType[], limit = DEFAULT_EVENT_REPLAY_LIMIT): OrchestrationEvent[] {
  if (types.length === 0) return [];
  const placeholders = types.map(() => '?').join(',');
  const stmt = this.db.prepareCached(
    `SELECT * FROM orchestration_events WHERE type IN (${placeholders}) ORDER BY timestamp ASC LIMIT ?`,
  );
  return (stmt.all(...types, boundedLimit(limit, DEFAULT_EVENT_REPLAY_LIMIT)) as EventRow[]).map(rowToEvent);
}
```

Then iterate `this.getEventsByTypes(relevantTypes)` in `projectActiveAggregates()`.

- [x] **Step 3: Add failing loop-store pagination tests**

Append to `src/main/orchestration/loop-store.spec.ts`:

```typescript
it('caps getIterations by default and supports explicit pagination', () => {
  const state = makeLoopState({ id: 'loop-paged' });
  store.upsertRun(state);
  for (let seq = 0; seq < 3; seq++) {
    store.insertIteration(makeLoopIteration({ loopRunId: 'loop-paged', seq }));
  }

  expect(store.getIterations('loop-paged', undefined, undefined, { limit: 2 }).map((i) => i.seq)).toEqual([0, 1]);
  expect(store.getIterations('loop-paged', undefined, undefined, { limit: 2, offset: 1 }).map((i) => i.seq)).toEqual([1, 2]);
  expect(store.countIterations('loop-paged')).toBe(3);
});
```

Run:

```bash
rtk npx vitest run src/main/orchestration/loop-store.spec.ts
```

Expected: FAIL because `getIterations` does not accept pagination options and `countIterations` does not exist.

- [x] **Step 4: Implement loop iteration count and bounded pagination**

In `src/main/orchestration/loop-store.ts`, add:

```typescript
const DEFAULT_LOOP_ITERATION_LIMIT = 500;
const MAX_LOOP_ITERATION_LIMIT = 5_000;

function boundLoopIterationLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(Math.floor(limit ?? DEFAULT_LOOP_ITERATION_LIMIT), MAX_LOOP_ITERATION_LIMIT));
}
```

Change signature:

```typescript
getIterations(
  loopRunId: string,
  fromSeq?: number,
  toSeq?: number,
  options: { limit?: number; offset?: number } = {},
): LoopIteration[] {
  let sql = 'SELECT * FROM loop_iterations WHERE loop_run_id = ?';
  const args: unknown[] = [loopRunId];
  if (fromSeq != null) {
    sql += ' AND seq >= ?';
    args.push(fromSeq);
  }
  if (toSeq != null) {
    sql += ' AND seq <= ?';
    args.push(toSeq);
  }
  sql += ' ORDER BY seq ASC LIMIT ? OFFSET ?';
  args.push(boundLoopIterationLimit(options.limit), Math.max(0, Math.floor(options.offset ?? 0)));
  const rows = this.db.prepare(sql).all<LoopIterationRow>(...args);
  return rows.map(rowToLoopIteration);
}

countIterations(loopRunId: string): number {
  const row = this.db
    .prepare('SELECT COUNT(*) AS count FROM loop_iterations WHERE loop_run_id = ?')
    .get<{ count: number }>(loopRunId);
  return row?.count ?? 0;
}
```

Extract the existing row mapping into:

```typescript
function rowToLoopIteration(r: LoopIterationRow): LoopIteration {
  return {
    id: r.id,
    loopRunId: r.loop_run_id,
    seq: r.seq,
    stage: r.stage as LoopIteration['stage'],
    startedAt: r.started_at,
    endedAt: r.ended_at,
    childInstanceId: r.child_instance_id,
    tokens: r.tokens,
    costCents: r.cost_cents,
    filesChanged: JSON.parse(r.files_changed_json),
    toolCalls: JSON.parse(r.tool_calls_json),
    errors: JSON.parse(r.errors_json),
    testPassCount: r.test_pass_count,
    testFailCount: r.test_fail_count,
    workHash: r.work_hash,
    outputSimilarityToPrev: r.output_similarity_to_prev,
    outputExcerpt: r.output_excerpt,
    progressVerdict: r.progress_verdict as LoopIteration['progressVerdict'],
    progressSignals: JSON.parse(r.progress_signals_json),
    completionSignalsFired: JSON.parse(r.completion_signals_fired_json),
    verifyStatus: r.verify_status as LoopIteration['verifyStatus'],
    verifyOutputExcerpt: r.verify_output_excerpt,
  };
}
```

- [x] **Step 5: Add bounded RLM compactor tests**

In `src/main/rlm/session-compactor.spec.ts`, add a test that seeds many archived turns and asserts compaction queries pass an explicit limit. Use the existing fake DB/driver style in that file; if no fake exists, add a minimal in-memory better-sqlite3 setup.

Test name:

```typescript
it('loads archived turns through an explicit cap before compacting a session', async () => {
  // Seed 1_200 archived turns for one session.
  // Run compaction with maxArchivedTurns: 500.
  // Expect only 500 turns to be considered and no unbounded SELECT ... WHERE session_id = ? .all(sessionId).
});
```

Run:

```bash
rtk npx vitest run src/main/rlm/session-compactor.spec.ts
```

Expected: FAIL until `session-compactor.ts` accepts and applies a max turn limit.

- [x] **Step 6: Implement RLM compactor caps**

In `src/main/rlm/session-compactor.ts`, add:

```typescript
const DEFAULT_MAX_ARCHIVED_TURNS_PER_COMPACTION = 500;
const MAX_ARCHIVED_TURNS_PER_COMPACTION = 2_000;

function boundedArchivedTurnLimit(limit: number | undefined): number {
  return Math.max(
    1,
    Math.min(Math.floor(limit ?? DEFAULT_MAX_ARCHIVED_TURNS_PER_COMPACTION), MAX_ARCHIVED_TURNS_PER_COMPACTION),
  );
}
```

Change the archived-turn load query from:

```typescript
.all(sessionId)
```

to:

```typescript
.all(sessionId, boundedArchivedTurnLimit(options.maxArchivedTurns))
```

with SQL:

```sql
SELECT ...
FROM archived_turns
WHERE session_id = ?
ORDER BY sequence DESC
LIMIT ?
```

Reverse the rows in memory only after the bounded read if chronological order is needed.

- [x] **Step 7: Verify bounded persistence**

Run:

```bash
rtk npx vitest run src/main/orchestration/event-store/__tests__/event-store.spec.ts src/main/orchestration/loop-store.spec.ts src/main/rlm/session-compactor.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit if authorized**

```bash
rtk git add src/main/orchestration/event-store/orchestration-event-store.ts src/main/orchestration/event-store/__tests__/event-store.spec.ts src/main/orchestration/loop-store.ts src/main/orchestration/loop-store.spec.ts src/main/rlm/session-compactor.ts src/main/rlm/session-compactor.spec.ts
rtk git commit -m "fix: bound long-running persistence reads"
```

---

### Task 4: Persist Durable Loop Checkpoints

**Files:**
- Create: `src/main/orchestration/loop-checkpoint.ts`
- Modify: `src/main/orchestration/loop-schema.ts`
- Modify: `src/main/orchestration/loop-store.ts`
- Modify: `src/main/orchestration/loop-store.spec.ts`
- Modify: `src/main/ipc/handlers/loop-handlers.ts`

- [x] **Step 1: Add checkpoint types and serializer tests**

Create `src/main/orchestration/loop-checkpoint.ts` with the interfaces first:

```typescript
import type { LoopIteration, LoopState } from '../../shared/types/loop.types';

export const LOOP_CHECKPOINT_VERSION = 1 as const;
export const LOOP_CHECKPOINT_HISTORY_TAIL = 25;

export interface LoopCheckpoint {
  version: 1;
  loopRunId: string;
  chatId: string;
  status: LoopState['status'];
  state: LoopState;
  historyTail: LoopIteration[];
  convergenceNote: string | null;
  planRegenerationCount: number;
  pendingContextReset: boolean;
  updatedAt: number;
}

export function buildLoopCheckpoint(input: {
  state: LoopState;
  history: LoopIteration[];
  convergenceNote?: string | null;
  planRegenerationCount?: number;
  pendingContextReset?: boolean;
  now?: number;
}): LoopCheckpoint {
  const historyTail = input.history.slice(-LOOP_CHECKPOINT_HISTORY_TAIL);
  return {
    version: LOOP_CHECKPOINT_VERSION,
    loopRunId: input.state.id,
    chatId: input.state.chatId,
    status: input.state.status,
    state: input.state,
    historyTail,
    convergenceNote: input.convergenceNote ?? null,
    planRegenerationCount: input.planRegenerationCount ?? 0,
    pendingContextReset: input.pendingContextReset ?? false,
    updatedAt: input.now ?? Date.now(),
  };
}
```

Create `src/main/orchestration/loop-checkpoint.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildLoopCheckpoint, LOOP_CHECKPOINT_HISTORY_TAIL } from './loop-checkpoint';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';

function state(): LoopState {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config: { ...defaultLoopConfig, initialPrompt: 'goal', workspaceCwd: '/repo' },
    status: 'running',
    startedAt: 100,
    endedAt: null,
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    currentStage: 'PLAN',
    pendingInterventions: [],
    completedFileRenameObserved: false,
    doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false,
    uncompletedPlanFilesAtStart: [],
    manualReviewOnly: false,
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
  };
}

function iteration(seq: number): LoopIteration {
  return {
    id: `iter-${seq}`,
    loopRunId: 'loop-1',
    seq,
    stage: 'PLAN',
    startedAt: seq,
    endedAt: seq + 1,
    childInstanceId: null,
    tokens: 1,
    costCents: 0,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: `hash-${seq}`,
    outputSimilarityToPrev: null,
    outputExcerpt: '',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
  };
}

it('keeps only a bounded history tail in checkpoints', () => {
  const history = Array.from({ length: LOOP_CHECKPOINT_HISTORY_TAIL + 3 }, (_, index) => iteration(index));
  const checkpoint = buildLoopCheckpoint({ state: state(), history, now: 500 });
  expect(checkpoint.historyTail).toHaveLength(LOOP_CHECKPOINT_HISTORY_TAIL);
  expect(checkpoint.historyTail[0]?.seq).toBe(3);
  expect(checkpoint.updatedAt).toBe(500);
});
```

Run:

```bash
rtk npx vitest run src/main/orchestration/loop-checkpoint.spec.ts
```

Expected: PASS after creating the file.

- [x] **Step 2: Add failing loop schema/store checkpoint tests**

Append to `src/main/orchestration/loop-store.spec.ts`:

```typescript
it('round-trips the latest loop checkpoint', () => {
  const state = makeLoopState({ id: 'loop-checkpoint', status: 'running' });
  store.upsertRun(state);
  store.upsertCheckpoint({
    version: 1,
    loopRunId: state.id,
    chatId: state.chatId,
    status: 'running',
    state,
    historyTail: [],
    convergenceNote: 'verify failed',
    planRegenerationCount: 2,
    pendingContextReset: true,
    updatedAt: 1234,
  });

  expect(store.getCheckpoint(state.id)).toEqual(expect.objectContaining({
    loopRunId: state.id,
    convergenceNote: 'verify failed',
    planRegenerationCount: 2,
    pendingContextReset: true,
  }));
});

it('lists resumable checkpoints for paused and interrupted loops', () => {
  const state = makeLoopState({ id: 'loop-resumable', status: 'paused' });
  store.upsertRun(state);
  store.upsertCheckpoint({
    version: 1,
    loopRunId: state.id,
    chatId: state.chatId,
    status: 'paused',
    state,
    historyTail: [],
    convergenceNote: null,
    planRegenerationCount: 0,
    pendingContextReset: false,
    updatedAt: 1234,
  });

  expect(store.listResumableCheckpoints().map((checkpoint) => checkpoint.loopRunId)).toContain(state.id);
});
```

Run:

```bash
rtk npx vitest run src/main/orchestration/loop-store.spec.ts
```

Expected: FAIL because checkpoint APIs do not exist.

- [x] **Step 3: Add schema migration 006**

In `src/main/orchestration/loop-schema.ts`, increment `LOOP_SCHEMA_VERSION` to `6` and add:

```typescript
{
  version: 6,
  name: '006_loop_checkpoints',
  up: `
    CREATE TABLE IF NOT EXISTS loop_checkpoints (
      loop_run_id TEXT PRIMARY KEY REFERENCES loop_runs(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      status TEXT NOT NULL,
      state_json TEXT NOT NULL,
      history_tail_json TEXT NOT NULL,
      convergence_note TEXT,
      plan_regeneration_count INTEGER NOT NULL DEFAULT 0,
      pending_context_reset INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_loop_checkpoints_status_updated
      ON loop_checkpoints(status, updated_at DESC);
  `,
}
```

- [x] **Step 4: Implement checkpoint store APIs**

In `src/main/orchestration/loop-store.ts`, import `LoopCheckpoint` and add row mapping:

```typescript
interface LoopCheckpointRow {
  loop_run_id: string;
  version: number;
  chat_id: string;
  status: string;
  state_json: string;
  history_tail_json: string;
  convergence_note: string | null;
  plan_regeneration_count: number;
  pending_context_reset: number;
  updated_at: number;
}

function rowToLoopCheckpoint(row: LoopCheckpointRow): LoopCheckpoint {
  return {
    version: 1,
    loopRunId: row.loop_run_id,
    chatId: row.chat_id,
    status: row.status as LoopCheckpoint['status'],
    state: JSON.parse(row.state_json) as LoopCheckpoint['state'],
    historyTail: JSON.parse(row.history_tail_json) as LoopCheckpoint['historyTail'],
    convergenceNote: row.convergence_note,
    planRegenerationCount: row.plan_regeneration_count,
    pendingContextReset: row.pending_context_reset === 1,
    updatedAt: row.updated_at,
  };
}
```

Add methods:

```typescript
upsertCheckpoint(checkpoint: LoopCheckpoint): void {
  this.db.prepare(`
    INSERT INTO loop_checkpoints (
      loop_run_id, version, chat_id, status, state_json, history_tail_json,
      convergence_note, plan_regeneration_count, pending_context_reset, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(loop_run_id) DO UPDATE SET
      version = excluded.version,
      chat_id = excluded.chat_id,
      status = excluded.status,
      state_json = excluded.state_json,
      history_tail_json = excluded.history_tail_json,
      convergence_note = excluded.convergence_note,
      plan_regeneration_count = excluded.plan_regeneration_count,
      pending_context_reset = excluded.pending_context_reset,
      updated_at = excluded.updated_at
  `).run(
    checkpoint.loopRunId,
    checkpoint.version,
    checkpoint.chatId,
    checkpoint.status,
    JSON.stringify(checkpoint.state),
    JSON.stringify(checkpoint.historyTail),
    checkpoint.convergenceNote,
    checkpoint.planRegenerationCount,
    checkpoint.pendingContextReset ? 1 : 0,
    checkpoint.updatedAt,
  );
}

getCheckpoint(loopRunId: string): LoopCheckpoint | null {
  const row = this.db
    .prepare('SELECT * FROM loop_checkpoints WHERE loop_run_id = ?')
    .get<LoopCheckpointRow>(loopRunId);
  return row ? rowToLoopCheckpoint(row) : null;
}

listResumableCheckpoints(limit = 50): LoopCheckpoint[] {
  const rows = this.db.prepare(`
    SELECT c.*
    FROM loop_checkpoints c
    JOIN loop_runs r ON r.id = c.loop_run_id
    WHERE r.status IN ('paused', 'provider-limit')
    ORDER BY c.updated_at DESC
    LIMIT ?
  `).all<LoopCheckpointRow>(Math.max(1, Math.min(limit, 200)));
  return rows.map(rowToLoopCheckpoint);
}
```

- [x] **Step 5: Persist checkpoint from loop IPC event wiring**

In `src/main/ipc/handlers/loop-handlers.ts`, import:

```typescript
import { buildLoopCheckpoint } from '../../orchestration/loop-checkpoint';
```

Inside the `loop:state-changed` listener, after `store.upsertRun(data.state)`, save:

```typescript
try {
  store.upsertCheckpoint(buildLoopCheckpoint({
    state: data.state,
    history: data.state.lastIteration ? [data.state.lastIteration] : [],
  }));
} catch (err) {
  logger.warn('Failed to persist loop checkpoint', {
    loopRunId: data.loopRunId,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

Inside the iteration hook, use full persisted history from `state.lastIteration` plus current iteration until the coordinator exposes richer history. After Task 5, replace this with coordinator-provided history tail:

```typescript
store.upsertCheckpoint(buildLoopCheckpoint({
  state,
  history: [iteration],
}));
```

- [x] **Step 6: Verify checkpoint persistence**

Run:

```bash
rtk npx vitest run src/main/orchestration/loop-checkpoint.spec.ts src/main/orchestration/loop-store.spec.ts src/main/ipc/handlers/__tests__/loop-handlers.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit if authorized**

```bash
rtk git add src/main/orchestration/loop-checkpoint.ts src/main/orchestration/loop-checkpoint.spec.ts src/main/orchestration/loop-schema.ts src/main/orchestration/loop-store.ts src/main/orchestration/loop-store.spec.ts src/main/ipc/handlers/loop-handlers.ts src/main/ipc/handlers/__tests__/loop-handlers.spec.ts
rtk git commit -m "feat: persist durable loop checkpoints"
```

---

### Task 5: Restore and Resume Loops From Checkpoints

**Files:**
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Create: `src/main/orchestration/loop-coordinator-restore.spec.ts`
- Modify: `src/main/ipc/handlers/loop-handlers.ts`
- Modify: `src/main/ipc/handlers/__tests__/loop-handlers.spec.ts`
- Modify: `src/main/app/initialization-steps.ts`

- [x] **Step 1: Add failing coordinator restore test**

Create `src/main/orchestration/loop-coordinator-restore.spec.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopCoordinator } from './loop-coordinator';
import { buildLoopCheckpoint } from './loop-checkpoint';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';

describe('LoopCoordinator checkpoint restore', () => {
  let coordinator: LoopCoordinator;
  let workspace: string;

  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    coordinator = new LoopCoordinator();
    workspace = mkdtempSync(join(tmpdir(), 'loop-restore-'));
  });

  afterEach(async () => {
    for (const loop of coordinator.getActiveLoops()) {
      await coordinator.cancelLoop(loop.id).catch(() => undefined);
    }
    rmSync(workspace, { recursive: true, force: true });
    LoopCoordinator._resetForTesting();
  });

  function pausedState(): LoopState {
    return {
      id: 'loop-restore-1',
      chatId: 'chat-restore',
      config: { ...defaultLoopConfig, initialPrompt: 'goal', workspaceCwd: workspace },
      status: 'paused',
      startedAt: 100,
      endedAt: null,
      totalIterations: 3,
      totalTokens: 100,
      totalCostCents: 0,
      currentStage: 'IMPLEMENT',
      pendingInterventions: ['remember this'],
      completedFileRenameObserved: false,
      doneSentinelPresentAtStart: false,
      planChecklistFullyCheckedAtStart: false,
      uncompletedPlanFilesAtStart: [],
      manualReviewOnly: false,
      tokensSinceLastTestImprovement: 0,
      highestTestPassCount: 0,
      iterationsOnCurrentStage: 1,
      recentWarnIterationSeqs: [],
      completionAttempts: 0,
      loopTasksLedgerResolvedAtStart: false,
    };
  }

  it('restores a paused loop without auto-running it', async () => {
    const restored = await coordinator.restoreLoopFromCheckpoint(buildLoopCheckpoint({
      state: pausedState(),
      history: [],
      convergenceNote: 'verify failed',
      planRegenerationCount: 1,
      pendingContextReset: true,
      now: 500,
    }));

    expect(restored.status).toBe('paused');
    expect(coordinator.getLoop('loop-restore-1')?.pendingInterventions).toEqual(['remember this']);
    expect(coordinator.resumeLoop('loop-restore-1')).toBe(true);
    expect(coordinator.getLoop('loop-restore-1')?.status).toBe('running');
  });
});
```

Run:

```bash
rtk npx vitest run src/main/orchestration/loop-coordinator-restore.spec.ts
```

Expected: FAIL because `restoreLoopFromCheckpoint` does not exist.

- [x] **Step 2: Implement coordinator restore API**

In `src/main/orchestration/loop-coordinator.ts`, import `LoopCheckpoint`:

```typescript
import type { LoopCheckpoint } from './loop-checkpoint';
```

Add method:

```typescript
async restoreLoopFromCheckpoint(checkpoint: LoopCheckpoint): Promise<LoopState> {
  const state = checkpoint.state;
  if (this.active.has(state.id)) {
    return this.active.get(state.id)!;
  }
  if (state.status !== 'paused' && state.status !== 'provider-limit') {
    throw new Error(`Cannot restore non-paused loop checkpoint: ${state.status}`);
  }

  const control = await prepareLoopControl(
    state.config.workspaceCwd,
    state.id,
    [...this.active.keys(), state.id],
  );
  state.loopControl = publicLoopControlMetadata(control);
  this.loopControls.set(state.id, control);
  this.active.set(state.id, state);
  this.histories.set(state.id, checkpoint.historyTail);
  if (checkpoint.convergenceNote) {
    this.convergenceNotes.set(state.id, checkpoint.convergenceNote);
  }
  if (checkpoint.planRegenerationCount > 0) {
    this.planRegenerations.set(state.id, checkpoint.planRegenerationCount);
  }
  if (checkpoint.pendingContextReset) {
    this.pendingContextReset.add(state.id);
  }
  this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
  return state;
}
```

Do not call `runLoop()` from restore. Restored loops stay paused until `resumeLoop()` is explicitly called. If a loop was running when the app crashed, startup already marks it paused via `markRunningAsInterruptedOnBoot()`.

- [x] **Step 3: Add failing IPC resume-from-store test**

In `src/main/ipc/handlers/__tests__/loop-handlers.spec.ts`, add:

```typescript
it('restores a paused stored loop from checkpoint when LOOP_RESUME has no live coordinator state', async () => {
  const checkpoint = {
    version: 1,
    loopRunId: 'loop-stored',
    chatId: 'chat-1',
    status: 'paused',
    state: { id: 'loop-stored', chatId: 'chat-1', status: 'paused', config: { workspaceCwd: '/repo' } },
    historyTail: [],
    convergenceNote: null,
    planRegenerationCount: 0,
    pendingContextReset: false,
    updatedAt: 123,
  };
  hoisted.coordinator.resumeLoop.mockReturnValueOnce(false).mockReturnValueOnce(true);
  hoisted.coordinator.getLoop.mockReturnValueOnce(null).mockReturnValueOnce(checkpoint.state);
  hoisted.coordinator.restoreLoopFromCheckpoint = vi.fn().mockResolvedValue(checkpoint.state);
  hoisted.store.getCheckpoint.mockReturnValue(checkpoint);

  const handler = getRegisteredHandler(IPC_CHANNELS.LOOP_RESUME);
  const response = await handler({}, { loopRunId: 'loop-stored' });

  expect(hoisted.coordinator.restoreLoopFromCheckpoint).toHaveBeenCalledWith(checkpoint);
  expect(response.success).toBe(true);
  expect(response.data.ok).toBe(true);
});
```

Run:

```bash
rtk npx vitest run src/main/ipc/handlers/__tests__/loop-handlers.spec.ts
```

Expected: FAIL until `LOOP_RESUME` loads checkpoint when the loop is not live.

- [x] **Step 4: Implement IPC resume restore path**

In `src/main/ipc/handlers/loop-handlers.ts`, inside `LOOP_RESUME` handler:

```typescript
let ok = coordinator.resumeLoop(validated.loopRunId);
let state = coordinator.getLoop(validated.loopRunId);
if (!ok && !state) {
  const checkpoint = store.getCheckpoint(validated.loopRunId);
  if (checkpoint) {
    state = await coordinator.restoreLoopFromCheckpoint(checkpoint);
    ok = coordinator.resumeLoop(validated.loopRunId);
    state = coordinator.getLoop(validated.loopRunId);
  }
}
if (state) {
  try { store.upsertRun(state); } catch { /* noop */ }
}
return { success: true, data: { ok, state } };
```

- [x] **Step 5: Startup discovery remains paused**

In `src/main/app/initialization-steps.ts`, after orphan intent reconciliation, log resumable checkpoint count without auto-resuming:

```typescript
const resumableCheckpoints = service.store.listResumableCheckpoints();
if (resumableCheckpoints.length > 0) {
  logger.info(`Loop store: ${resumableCheckpoints.length} loop checkpoint(s) available for manual resume`);
}
```

Add a unit test in the existing initialization test file if present; otherwise cover this through `loop-store.spec.ts` and `loop-handlers.spec.ts`.

- [x] **Step 6: Verify loop restore**

Run:

```bash
rtk npx vitest run src/main/orchestration/loop-coordinator-restore.spec.ts src/main/ipc/handlers/__tests__/loop-handlers.spec.ts src/main/orchestration/loop-store.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit if authorized**

```bash
rtk git add src/main/orchestration/loop-coordinator.ts src/main/orchestration/loop-coordinator-restore.spec.ts src/main/ipc/handlers/loop-handlers.ts src/main/ipc/handlers/__tests__/loop-handlers.spec.ts src/main/app/initialization-steps.ts
rtk git commit -m "feat: restore paused loops from checkpoints"
```

---

### Task 6: Add Long-Run Resource Governor

**Files:**
- Create: `src/main/runtime/long-run-resource-governor.ts`
- Create: `src/main/runtime/long-run-resource-governor.spec.ts`
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Create: `src/main/orchestration/loop-coordinator-resource-governor.spec.ts`
- Modify: `src/main/app/initialization-steps.ts`

- [x] **Step 1: Write failing pure governor tests**

Create `src/main/runtime/long-run-resource-governor.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { LongRunResourceGovernor } from './long-run-resource-governor';

describe('LongRunResourceGovernor', () => {
  it('allows normal loop progress when resources are healthy', () => {
    const governor = new LongRunResourceGovernor({
      warnRssBytes: 10_000,
      criticalRssBytes: 20_000,
      maxCodememDbBytes: 30_000,
      maxRlmDbBytes: 40_000,
    });
    expect(governor.evaluate({
      rssBytes: 5_000,
      codememDbBytes: 1_000,
      rlmDbBytes: 1_000,
      contextWorkerDegraded: false,
      indexWorkerDegraded: false,
    })).toEqual({ level: 'ok', actions: [], reasons: [] });
  });

  it('degrades optional context when RSS is above warning threshold', () => {
    const governor = new LongRunResourceGovernor({
      warnRssBytes: 10_000,
      criticalRssBytes: 20_000,
      maxCodememDbBytes: 30_000,
      maxRlmDbBytes: 40_000,
    });
    expect(governor.evaluate({
      rssBytes: 12_000,
      codememDbBytes: 1_000,
      rlmDbBytes: 1_000,
      contextWorkerDegraded: false,
      indexWorkerDegraded: false,
    })).toEqual({
      level: 'warn',
      actions: ['disable-warm-start', 'skip-optional-memory-context'],
      reasons: ['rss-above-warning'],
    });
  });

  it('pauses loops before critical memory exhaustion', () => {
    const governor = new LongRunResourceGovernor({
      warnRssBytes: 10_000,
      criticalRssBytes: 20_000,
      maxCodememDbBytes: 30_000,
      maxRlmDbBytes: 40_000,
    });
    expect(governor.evaluate({
      rssBytes: 22_000,
      codememDbBytes: 1_000,
      rlmDbBytes: 1_000,
      contextWorkerDegraded: false,
      indexWorkerDegraded: false,
    })).toEqual({
      level: 'critical',
      actions: ['pause-loop', 'disable-warm-start', 'skip-optional-memory-context'],
      reasons: ['rss-above-critical'],
    });
  });
});
```

Run:

```bash
rtk npx vitest run src/main/runtime/long-run-resource-governor.spec.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 2: Implement pure governor**

Create `src/main/runtime/long-run-resource-governor.ts`:

```typescript
export type LongRunResourceLevel = 'ok' | 'warn' | 'critical';
export type LongRunResourceAction =
  | 'disable-warm-start'
  | 'skip-optional-memory-context'
  | 'pause-loop'
  | 'prune-codemem';

export interface LongRunResourceSnapshot {
  rssBytes: number;
  codememDbBytes: number;
  rlmDbBytes: number;
  contextWorkerDegraded: boolean;
  indexWorkerDegraded: boolean;
}

export interface LongRunResourceGovernorConfig {
  warnRssBytes: number;
  criticalRssBytes: number;
  maxCodememDbBytes: number;
  maxRlmDbBytes: number;
}

export interface LongRunResourceDecision {
  level: LongRunResourceLevel;
  actions: LongRunResourceAction[];
  reasons: string[];
}

export class LongRunResourceGovernor {
  constructor(private readonly config: LongRunResourceGovernorConfig) {}

  evaluate(snapshot: LongRunResourceSnapshot): LongRunResourceDecision {
    const actions = new Set<LongRunResourceAction>();
    const reasons: string[] = [];
    let level: LongRunResourceLevel = 'ok';

    if (snapshot.rssBytes >= this.config.criticalRssBytes) {
      level = 'critical';
      actions.add('pause-loop');
      actions.add('disable-warm-start');
      actions.add('skip-optional-memory-context');
      reasons.push('rss-above-critical');
    } else if (snapshot.rssBytes >= this.config.warnRssBytes) {
      level = 'warn';
      actions.add('disable-warm-start');
      actions.add('skip-optional-memory-context');
      reasons.push('rss-above-warning');
    }

    if (snapshot.codememDbBytes >= this.config.maxCodememDbBytes) {
      if (level === 'ok') level = 'warn';
      actions.add('prune-codemem');
      reasons.push('codemem-db-above-limit');
    }

    if (snapshot.rlmDbBytes >= this.config.maxRlmDbBytes) {
      level = 'critical';
      actions.add('pause-loop');
      actions.add('skip-optional-memory-context');
      reasons.push('rlm-db-above-limit');
    }

    return { level, actions: [...actions], reasons };
  }
}
```

- [x] **Step 3: Add failing coordinator pre-iteration pause test**

Create `src/main/orchestration/loop-coordinator-resource-governor.spec.ts` with a loop test that injects a governor returning `pause-loop` before iteration 1 and asserts the loop moves to `paused` before invoking the child again.

Required test behavior:

```typescript
it('pauses before starting the next iteration when the resource governor returns pause-loop', async () => {
  // Start a loop with maxIterations > 1.
  // First invoke callback returns a normal non-terminal result.
  // Inject coordinator.setResourceGovernor(() => ({ level: 'critical', actions: ['pause-loop'], reasons: ['rss-above-critical'] })).
  // Assert only one child invocation happened and final live state is paused with endReason/resource note absent.
});
```

Run:

```bash
rtk npx vitest run src/main/orchestration/loop-coordinator-resource-governor.spec.ts
```

Expected: FAIL because `setResourceGovernor` does not exist.

- [x] **Step 4: Integrate governor into `LoopCoordinator`**

In `src/main/orchestration/loop-coordinator.ts`, add types:

```typescript
import type { LongRunResourceDecision } from '../runtime/long-run-resource-governor';

type LoopResourceGovernor = (state: LoopState) => LongRunResourceDecision | null;
```

Add field and setter:

```typescript
private resourceGovernor: LoopResourceGovernor | null = null;

setResourceGovernor(governor: LoopResourceGovernor | null): void {
  this.resourceGovernor = governor;
}
```

At the top of the pre-iteration loop boundary in `runLoop()`, before emitting `loop:invoke-iteration`, add:

```typescript
const resourceDecision = this.resourceGovernor?.(state);
if (resourceDecision?.actions.includes('pause-loop')) {
  state.status = 'paused';
  this.convergenceNotes.set(
    state.id,
    `Paused by resource governor: ${resourceDecision.reasons.join(', ')}`,
  );
  this.emit('loop:paused-no-progress', {
    loopRunId: state.id,
    reason: 'resource-governor',
    decision: resourceDecision,
  });
  this.emit('loop:state-changed', { loopRunId: state.id, state: this.cloneStateForBroadcast(state) });
  await this.waitWhilePaused(state);
}
```

Use the existing pause-gate/wait helper if it exists; if no helper exists, extract the existing paused-loop waiting block from `runLoop()` into `private waitWhilePaused(state: LoopState): Promise<void>`.

- [x] **Step 5: Wire production metrics in initialization**

In `src/main/app/initialization-steps.ts`, create a `LongRunResourceGovernor` after the loop coordinator is initialized and wire:

```typescript
coordinator.setResourceGovernor(() => {
  const rssBytes = process.memoryUsage().rss;
  const userDataPath = app.getPath('userData');
  return governor.evaluate({
    rssBytes,
    codememDbBytes: safeFileSize(path.join(userDataPath, 'codemem.sqlite')),
    rlmDbBytes: safeFileSize(path.join(userDataPath, 'rlm', 'rlm.db')),
    contextWorkerDegraded: getContextWorkerClient().getMetrics().degraded,
    indexWorkerDegraded: getCodemem().indexWorkerGateway.getMetrics().degraded,
  });
});
```

Add local helper:

```typescript
function safeFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
```

Use conservative defaults:

```typescript
const governor = new LongRunResourceGovernor({
  warnRssBytes: 12 * 1024 * 1024 * 1024,
  criticalRssBytes: 18 * 1024 * 1024 * 1024,
  maxCodememDbBytes: 25 * 1024 * 1024 * 1024,
  maxRlmDbBytes: 12 * 1024 * 1024 * 1024,
});
```

- [x] **Step 6: Verify resource governor**

Run:

```bash
rtk npx vitest run src/main/runtime/long-run-resource-governor.spec.ts src/main/orchestration/loop-coordinator-resource-governor.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit if authorized**

```bash
rtk git add src/main/runtime/long-run-resource-governor.ts src/main/runtime/long-run-resource-governor.spec.ts src/main/orchestration/loop-coordinator.ts src/main/orchestration/loop-coordinator-resource-governor.spec.ts src/main/app/initialization-steps.ts
rtk git commit -m "feat: add long-run resource governor"
```

---

### Task 7: Codemem Pruning, Quotas, and Compaction

**Files:**
- Create: `src/main/codemem/codemem-pruner.ts`
- Create: `src/main/codemem/codemem-pruner.spec.ts`
- Modify: `src/main/codemem/cas-store.ts`
- Modify: `src/main/codemem/__tests__/cas-store.spec.ts`
- Modify: `src/main/codemem/index-worker-main.ts`

- [x] **Step 1: Add failing CasStore workspace delete/stat tests**

Append to `src/main/codemem/__tests__/cas-store.spec.ts`:

```typescript
it('lists workspace index stats and deletes one workspace index without deleting shared chunks', () => {
  store.upsertWorkspaceRoot({
    workspaceHash: 'workspace-a',
    absPath: '/repo-a',
    headCommit: null,
    primaryLanguage: 'typescript',
    lastIndexedAt: 100,
    merkleRootHash: null,
    pagerankJson: null,
  });
  store.upsertManifestEntry({
    workspaceHash: 'workspace-a',
    pathFromRoot: 'src/a.ts',
    contentHash: 'c1',
    merkleLeafHash: 'm1',
    mtime: 1,
  });

  expect(store.listWorkspaceIndexStats()).toEqual([
    expect.objectContaining({ workspaceHash: 'workspace-a', manifestEntries: 1 }),
  ]);

  store.deleteWorkspaceIndex('workspace-a');
  expect(store.getWorkspaceRoot('workspace-a')).toBeNull();
  expect(store.countManifestEntries('workspace-a')).toBe(0);
});
```

Run:

```bash
rtk npx vitest run src/main/codemem/__tests__/cas-store.spec.ts
```

Expected: FAIL because `listWorkspaceIndexStats` and `deleteWorkspaceIndex` do not exist.

- [x] **Step 2: Implement CasStore workspace stats/delete**

In `src/main/codemem/cas-store.ts`, add:

```typescript
export interface WorkspaceIndexStats {
  workspaceHash: WorkspaceHash;
  absPath: string;
  lastIndexedAt: number;
  manifestEntries: number;
  workspaceChunks: number;
  workspaceSymbols: number;
}
```

Add:

```typescript
listWorkspaceIndexStats(): WorkspaceIndexStats[] {
  const rows = this.db.prepare(`
    SELECT
      wr.workspace_hash,
      wr.abs_path,
      wr.last_indexed_at,
      COALESCE(m.manifest_entries, 0) AS manifest_entries,
      COALESCE(c.workspace_chunks, 0) AS workspace_chunks,
      COALESCE(s.workspace_symbols, 0) AS workspace_symbols
    FROM workspace_root wr
    LEFT JOIN (
      SELECT workspace_hash, COUNT(*) AS manifest_entries
      FROM workspace_manifest
      GROUP BY workspace_hash
    ) m ON m.workspace_hash = wr.workspace_hash
    LEFT JOIN (
      SELECT workspace_hash, COUNT(*) AS workspace_chunks
      FROM workspace_chunks
      GROUP BY workspace_hash
    ) c ON c.workspace_hash = wr.workspace_hash
    LEFT JOIN (
      SELECT workspace_hash, COUNT(*) AS workspace_symbols
      FROM workspace_symbols
      GROUP BY workspace_hash
    ) s ON s.workspace_hash = wr.workspace_hash
    ORDER BY wr.last_indexed_at ASC
  `).all() as Array<{
    workspace_hash: string;
    abs_path: string;
    last_indexed_at: number;
    manifest_entries: number;
    workspace_chunks: number;
    workspace_symbols: number;
  }>;
  return rows.map((row) => ({
    workspaceHash: row.workspace_hash,
    absPath: row.abs_path,
    lastIndexedAt: row.last_indexed_at,
    manifestEntries: row.manifest_entries,
    workspaceChunks: row.workspace_chunks,
    workspaceSymbols: row.workspace_symbols,
  }));
}

deleteWorkspaceIndex(workspaceHash: WorkspaceHash): void {
  const chunkRows = this.db.prepare(
    'SELECT id FROM workspace_chunks WHERE workspace_hash = ?',
  ).all(workspaceHash) as Array<{ id: number }>;
  const tx = this.db.transaction(() => {
    const deleteFts = this.db.prepare('DELETE FROM code_fts WHERE rowid = ?');
    for (const row of chunkRows) {
      deleteFts.run(row.id);
    }
    this.db.prepare('DELETE FROM workspace_chunks WHERE workspace_hash = ?').run(workspaceHash);
    this.db.prepare('DELETE FROM workspace_symbols WHERE workspace_hash = ?').run(workspaceHash);
    this.db.prepare('DELETE FROM workspace_manifest WHERE workspace_hash = ?').run(workspaceHash);
    this.db.prepare('DELETE FROM code_index_status WHERE workspace_hash = ?').run(workspaceHash);
    this.db.prepare('DELETE FROM workspace_root WHERE workspace_hash = ?').run(workspaceHash);
  });
  tx();
}
```

- [x] **Step 3: Add failing pruner tests**

Create `src/main/codemem/codemem-pruner.spec.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { pruneCodememWorkspaces } from './codemem-pruner';

it('prunes least-recently-indexed workspaces until workspace count is within quota', () => {
  const deleted: string[] = [];
  const store = {
    listWorkspaceIndexStats: vi.fn(() => [
      { workspaceHash: 'old', absPath: '/old', lastIndexedAt: 1, manifestEntries: 10, workspaceChunks: 10, workspaceSymbols: 1 },
      { workspaceHash: 'new', absPath: '/new', lastIndexedAt: 2, manifestEntries: 10, workspaceChunks: 10, workspaceSymbols: 1 },
    ]),
    deleteWorkspaceIndex: vi.fn((workspaceHash: string) => deleted.push(workspaceHash)),
  };

  const result = pruneCodememWorkspaces(store, { maxWorkspaces: 1, maxManifestEntriesPerWorkspace: 100 });

  expect(result.deletedWorkspaceHashes).toEqual(['old']);
  expect(deleted).toEqual(['old']);
});

it('prunes a workspace that exceeds the manifest-entry quota', () => {
  const store = {
    listWorkspaceIndexStats: vi.fn(() => [
      { workspaceHash: 'huge', absPath: '/huge', lastIndexedAt: 2, manifestEntries: 500_001, workspaceChunks: 1, workspaceSymbols: 1 },
    ]),
    deleteWorkspaceIndex: vi.fn(),
  };

  const result = pruneCodememWorkspaces(store, { maxWorkspaces: 10, maxManifestEntriesPerWorkspace: 500_000 });

  expect(result.deletedWorkspaceHashes).toEqual(['huge']);
  expect(store.deleteWorkspaceIndex).toHaveBeenCalledWith('huge');
});
```

Run:

```bash
rtk npx vitest run src/main/codemem/codemem-pruner.spec.ts
```

Expected: FAIL because `codemem-pruner` does not exist.

- [x] **Step 4: Implement pruner**

Create `src/main/codemem/codemem-pruner.ts`:

```typescript
import type { WorkspaceHash } from './types';
import type { WorkspaceIndexStats } from './cas-store';

export interface CodememPrunerStore {
  listWorkspaceIndexStats(): WorkspaceIndexStats[];
  deleteWorkspaceIndex(workspaceHash: WorkspaceHash): void;
}

export interface CodememPruneOptions {
  maxWorkspaces: number;
  maxManifestEntriesPerWorkspace: number;
}

export interface CodememPruneResult {
  deletedWorkspaceHashes: WorkspaceHash[];
  retainedWorkspaceHashes: WorkspaceHash[];
}

export function pruneCodememWorkspaces(
  store: CodememPrunerStore,
  options: CodememPruneOptions,
): CodememPruneResult {
  const stats = store.listWorkspaceIndexStats();
  const deleteSet = new Set<WorkspaceHash>();

  for (const row of stats) {
    if (row.manifestEntries > options.maxManifestEntriesPerWorkspace) {
      deleteSet.add(row.workspaceHash);
    }
  }

  const remaining = stats
    .filter((row) => !deleteSet.has(row.workspaceHash))
    .sort((left, right) => left.lastIndexedAt - right.lastIndexedAt);
  while (remaining.length > options.maxWorkspaces) {
    const row = remaining.shift();
    if (row) deleteSet.add(row.workspaceHash);
  }

  for (const workspaceHash of deleteSet) {
    store.deleteWorkspaceIndex(workspaceHash);
  }

  return {
    deletedWorkspaceHashes: [...deleteSet],
    retainedWorkspaceHashes: stats
      .map((row) => row.workspaceHash)
      .filter((workspaceHash) => !deleteSet.has(workspaceHash)),
  };
}
```

- [x] **Step 5: Run pruner from codemem worker startup**

In `src/main/codemem/index-worker-main.ts`, after store creation and before constructing `CodeIndexManager`, call:

```typescript
pruneCodememWorkspaces(store, {
  maxWorkspaces: Number(process.env['AIO_CODEMEM_MAX_WORKSPACES'] ?? 10),
  maxManifestEntriesPerWorkspace: Number(process.env['AIO_CODEMEM_MAX_MANIFEST_ENTRIES'] ?? 500_000),
});
db.pragma('wal_checkpoint(TRUNCATE)');
```

Wrap in `try/catch` and respond only by logging; codemem pruning failure must not prevent the worker from starting.

- [x] **Step 6: Verify codemem lifecycle**

Run:

```bash
rtk npx vitest run src/main/codemem/__tests__/cas-store.spec.ts src/main/codemem/codemem-pruner.spec.ts src/main/codemem/__tests__/index-worker-main.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit if authorized**

```bash
rtk git add src/main/codemem/cas-store.ts src/main/codemem/__tests__/cas-store.spec.ts src/main/codemem/codemem-pruner.ts src/main/codemem/codemem-pruner.spec.ts src/main/codemem/index-worker-main.ts
rtk git commit -m "feat: prune oversized codemem indexes"
```

---

### Task 8: Bound Loop File Reads and Per-Iteration Payloads

**Files:**
- Create: `src/main/orchestration/bounded-file-read.ts`
- Create: `src/main/orchestration/bounded-file-read.spec.ts`
- Modify: `src/main/orchestration/loop-diff.ts`
- Modify: `src/main/orchestration/loop-diff.spec.ts`
- Modify: `src/main/orchestration/loop-workspace-snapshot.ts`
- Modify: `src/main/orchestration/loop-workspace-snapshot.spec.ts`
- Modify: `src/main/orchestration/loop-stage-machine.ts`
- Modify: `src/main/orchestration/loop-completion-detector.ts`
- Modify: `src/main/orchestration/loop-coordinator-state-helpers.ts`
- Modify: `src/main/orchestration/loop-coordinator.ts`

- [x] **Step 1: Add failing bounded-file reader tests**

Create `src/main/orchestration/bounded-file-read.spec.ts`:

```typescript
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readUtf8FileHead,
  readUtf8FileHeadSync,
  readUtf8FileTail,
} from './bounded-file-read';

describe('bounded file reads', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bounded-file-read-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads only the leading text window for async callers', async () => {
    const file = join(dir, 'large.txt');
    writeFileSync(file, `${'a'.repeat(4096)}TAIL`);

    const result = await readUtf8FileHead(file, 128);

    expect(result.text).toHaveLength(128);
    expect(result.text).toBe('a'.repeat(128));
    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(4100);
  });

  it('reads only the trailing text window for async callers', async () => {
    const file = join(dir, 'large-tail.txt');
    writeFileSync(file, `${'a'.repeat(4096)}TAIL`);

    const result = await readUtf8FileTail(file, 8);

    expect(result.text).toBe('aaaaTAIL');
    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(4100);
  });

  it('supports synchronous bounded reads for termination paths', () => {
    const file = join(dir, 'sync.txt');
    writeFileSync(file, '0123456789');

    const result = readUtf8FileHeadSync(file, 4);

    expect(result).toEqual({ text: '0123', truncated: true, sizeBytes: 10 });
  });
});
```

- [x] **Step 2: Run the failing bounded-file reader test**

Run:

```bash
rtk npx vitest run src/main/orchestration/bounded-file-read.spec.ts
```

Expected: FAIL with `Cannot find module './bounded-file-read'`.

- [x] **Step 3: Implement bounded file reader helpers**

Create `src/main/orchestration/bounded-file-read.ts`:

```typescript
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

export const LOOP_TEXT_FILE_MAX_BYTES = 512 * 1024;

export interface BoundedTextReadResult {
  text: string;
  truncated: boolean;
  sizeBytes: number;
}

function assertPositiveMaxBytes(maxBytes: number): number {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`maxBytes must be positive; got ${maxBytes}`);
  }
  return Math.floor(maxBytes);
}

export async function readUtf8FileHead(
  filePath: string,
  maxBytes = LOOP_TEXT_FILE_MAX_BYTES,
): Promise<BoundedTextReadResult> {
  const limit = assertPositiveMaxBytes(maxBytes);
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a regular file`);
  }
  const bytesToRead = Math.min(stat.size, limit);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await fsp.open(filePath, 'r');
  try {
    const read = await handle.read(buffer, 0, bytesToRead, 0);
    return {
      text: buffer.subarray(0, read.bytesRead).toString('utf8'),
      truncated: stat.size > limit,
      sizeBytes: stat.size,
    };
  } finally {
    await handle.close();
  }
}

export async function readUtf8FileTail(
  filePath: string,
  maxBytes = LOOP_TEXT_FILE_MAX_BYTES,
): Promise<BoundedTextReadResult> {
  const limit = assertPositiveMaxBytes(maxBytes);
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a regular file`);
  }
  const bytesToRead = Math.min(stat.size, limit);
  const position = Math.max(0, stat.size - bytesToRead);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await fsp.open(filePath, 'r');
  try {
    const read = await handle.read(buffer, 0, bytesToRead, position);
    return {
      text: buffer.subarray(0, read.bytesRead).toString('utf8'),
      truncated: stat.size > limit,
      sizeBytes: stat.size,
    };
  } finally {
    await handle.close();
  }
}

export function readUtf8FileHeadSync(
  filePath: string,
  maxBytes = LOOP_TEXT_FILE_MAX_BYTES,
): BoundedTextReadResult {
  const limit = assertPositiveMaxBytes(maxBytes);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a regular file`);
  }
  const bytesToRead = Math.min(stat.size, limit);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: stat.size > limit,
      sizeBytes: stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}
```

- [x] **Step 4: Add failing huge-untracked-diff regression test**

Append to `src/main/orchestration/loop-diff.spec.ts`:

```typescript
it('does not read an entire huge untracked text file before truncating the review diff', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'loop-diff-huge-'));
  try {
    const hugeFile = join(workspace, 'huge.txt');
    writeFileSync(hugeFile, 'a'.repeat(2 * 1024 * 1024));
    const runner: GitRunner = (args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'true\n' };
      if (args.includes('diff')) return { status: 0, stdout: '' };
      if (args[0] === 'ls-files') return { status: 0, stdout: 'huge.txt\n' };
      return { status: 1, stdout: '' };
    };
    const originalReadFileSync = fs.readFileSync;
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...args) => {
      if (String(target) === hugeFile) {
        throw new Error('full-file read attempted');
      }
      return originalReadFileSync(target, ...args);
    });

    try {
      const diff = collectWorkspaceDiff(workspace, {
        maxChars: 4_000,
        maxUntrackedFileChars: 256,
      }, runner);

      expect(diff.diff).toContain('+++ new file: huge.txt');
      expect(diff.diff).toContain('untracked file truncated');
      expect(diff.diff.length).toBeLessThanOrEqual(4_100);
    } finally {
      readFileSyncSpy.mockRestore();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
```

Run:

```bash
rtk npx vitest run src/main/orchestration/loop-diff.spec.ts
```

Expected: FAIL because `readUntrackedHead()` currently calls `fs.readFileSync()` for untracked files.

- [x] **Step 5: Replace full untracked-file reads in `loop-diff.ts`**

In `src/main/orchestration/loop-diff.ts`, import the sync helper:

```typescript
import { readUtf8FileHeadSync } from './bounded-file-read';
```

Change `readUntrackedHead()` to this implementation:

```typescript
function readUntrackedHead(absPath: string, maxChars: number): { text: string; truncated: boolean } | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    const read = readUtf8FileHeadSync(absPath, Math.max(maxChars, 8_000));
    const probe = read.text.slice(0, 8_000);
    if (probe.includes('\0')) return { text: '(binary file omitted)', truncated: false };
    if (read.text.length <= maxChars) return { text: read.text, truncated: read.truncated };
    return { text: read.text.slice(0, maxChars), truncated: true };
  } catch {
    return null;
  }
}
```

- [x] **Step 6: Add failing workspace snapshot test for huge git-changed files**

Append to `src/main/orchestration/loop-workspace-snapshot.spec.ts`:

```typescript
it('uses metadata hashing for changed git files larger than the snapshot byte cap', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'loop-snapshot-huge-'));
  const hugePath = join(workspace, 'huge.bin');
  try {
    writeFileSync(hugePath, Buffer.alloc(6 * 1024 * 1024, 65));

    const changes = snapshotFileChangesViaGit(workspace, (args) => {
      if (args[0] === 'diff') {
        return { status: 0, stdout: `1\t1\thuge.bin\n` };
      }
      return { status: 1, stdout: '' };
    });

    expect(changes).toEqual([
      expect.objectContaining({
        path: 'huge.bin',
        contentHash: expect.any(String),
      }),
    ]);
    expect(changes[0]?.contentHash).toHaveLength(16);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
```

If `snapshotFileChangesViaGit` does not yet accept an injected runner, add this type before the test compiles:

```typescript
export type WorkspaceGitRunner = (args: string[], cwd: string) => { status: number | null; stdout: string };
```

Run:

```bash
rtk npx vitest run src/main/orchestration/loop-workspace-snapshot.spec.ts
```

Expected: FAIL until `snapshotFileChangesViaGit` accepts a runner and uses `hashWorkspaceFile()` for large files.

- [x] **Step 7: Bound git snapshot content hashing**

In `src/main/orchestration/loop-workspace-snapshot.ts`, add an injectable runner:

```typescript
export type WorkspaceGitRunner = (args: string[], cwd: string) => { status: number | null; stdout: string };

const defaultWorkspaceGitRunner: WorkspaceGitRunner = (args, cwd) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
};
```

Change the function signature:

```typescript
export function snapshotFileChangesViaGit(
  cwd: string,
  runner: WorkspaceGitRunner = defaultWorkspaceGitRunner,
): LoopFileChange[] {
```

Replace the direct `spawnSync` call with:

```typescript
const numstat = runner(['diff', '--numstat', 'HEAD'], cwd);
```

Replace the content-hash block with the already-bounded helper:

```typescript
if (fs.existsSync(abs)) {
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    contentHash = hashWorkspaceFile(abs, stat);
  }
}
```

- [x] **Step 8: Bound loop artifact reads**

In `src/main/orchestration/loop-stage-machine.ts`, import:

```typescript
import {
  LOOP_TEXT_FILE_MAX_BYTES,
  readUtf8FileHead,
  readUtf8FileTail,
} from './bounded-file-read';
```

Use these constants in the module:

```typescript
const LOOP_ARTIFACT_HEAD_BYTES = LOOP_TEXT_FILE_MAX_BYTES;
const LOOP_NOTES_TAIL_BYTES = 64 * 1024;
```

Change `readPlan`, `readTaskLedger`, `looksLikePlanDoc`, `readNotes`, `readOutstanding`, and `curateNotesIfNeeded` so they do not call `fsp.readFile()` on loop-controlled markdown files. Use this shape:

```typescript
async readNotes(): Promise<string> {
  try {
    return (await readUtf8FileTail(this.paths.notes, LOOP_NOTES_TAIL_BYTES)).text;
  } catch {
    return '';
  }
}
```

For `curateNotesIfNeeded`, use:

```typescript
const read = await readUtf8FileTail(notesPath, opts.keepTailChars ?? NOTES_CURATION_KEEP_TAIL_CHARS);
const content = read.truncated
  ? `# Loop Notes\n\n_[loop] NOTES.md exceeded the bounded read cap; preserving the newest entries._\n\n${read.text}`
  : read.text;
const result = curateNotesContent(content, opts);
```

In `src/main/orchestration/loop-completion-detector.ts`, import `readUtf8FileHead` and replace full reads of `planPath`, `artifactPaths.tasks`, and `reportPath` with:

```typescript
const text = (await readUtf8FileHead(planPath)).text;
```

In `src/main/orchestration/loop-coordinator-state-helpers.ts`, replace the full `BLOCKED.md` read with:

```typescript
const { text } = await readUtf8FileHead(target, 8 * 1024);
const trimmed = text.trim();
```

In `src/main/orchestration/loop-coordinator.ts`, replace `readFileSync(paths.outstanding, 'utf8')` inside `captureOutstanding()` with:

```typescript
const raw = readUtf8FileHeadSync(paths.outstanding, LOOP_TEXT_FILE_MAX_BYTES).text;
```

- [x] **Step 9: Verify loop file-size hardening**

Run:

```bash
rtk npx vitest run src/main/orchestration/bounded-file-read.spec.ts src/main/orchestration/loop-diff.spec.ts src/main/orchestration/loop-workspace-snapshot.spec.ts src/main/orchestration/loop-stage-machine.spec.ts src/main/orchestration/loop-completion-detector.spec.ts
rtk npx vitest run src/main/orchestration/loop-coordinator-state-helpers.spec.ts src/main/orchestration/loop-outstanding-export.spec.ts
```

Expected: PASS.

- [ ] **Step 10: Commit if authorized**

```bash
rtk git add src/main/orchestration/bounded-file-read.ts src/main/orchestration/bounded-file-read.spec.ts src/main/orchestration/loop-diff.ts src/main/orchestration/loop-diff.spec.ts src/main/orchestration/loop-workspace-snapshot.ts src/main/orchestration/loop-workspace-snapshot.spec.ts src/main/orchestration/loop-stage-machine.ts src/main/orchestration/loop-completion-detector.ts src/main/orchestration/loop-coordinator-state-helpers.ts src/main/orchestration/loop-coordinator.ts
rtk git commit -m "fix: bound loop file reads"
```

---

### Task 9: Lift 50-Hour Loop Contracts and Enforce Token Caps

**Files:**
- Modify: `packages/contracts/src/schemas/loop.schemas.ts`
- Modify: `packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts`
- Modify: `src/shared/types/loop.types.ts`
- Modify: `src/main/orchestration/loop-coordinator-state-helpers.ts`
- Modify: `src/main/orchestration/loop-coordinator-state-helpers.spec.ts`

- [x] **Step 1: Add failing contract test for 50-hour wall-time caps**

Add `LoopConfigSchema` to the existing schema import list in
`packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts`, then append:

```typescript
describe('LoopConfigSchema long-run caps', () => {
  it('accepts a 50-hour maxWallTimeMs loop cap', () => {
    const config = {
      initialPrompt: 'run for a long time',
      workspaceCwd: '/repo',
      provider: 'claude',
      reviewStyle: 'single',
      contextStrategy: 'fresh-child',
      caps: {
        maxIterations: null,
        maxWallTimeMs: 50 * 60 * 60 * 1000,
        maxTokens: null,
        maxCostCents: null,
        maxToolCallsPerIteration: 200,
      },
      progressThresholds: {
        identicalHashWarnConsecutive: 2,
        identicalHashCriticalConsecutive: 3,
        identicalHashCriticalWindow: 3,
        similarityWarnMean: 0.85,
        similarityCriticalMean: 0.92,
        stageWarnIterations: { PLAN: 3, REVIEW: 3, IMPLEMENT: 8 },
        stageCriticalIterations: { PLAN: 5, REVIEW: 5, IMPLEMENT: 12 },
        errorRepeatWarnInWindow: 3,
        errorRepeatCriticalInWindow: 4,
        tokensWithoutProgressWarn: 25_000,
        tokensWithoutProgressCritical: 60_000,
        pauseOnTokenBurn: false,
        toolRepeatWarnPerIteration: 5,
        toolRepeatCriticalPerIteration: 8,
        testStagnationWarnIterations: 3,
        testStagnationCriticalIterations: 5,
        churnRatioWarn: 0.3,
        churnRatioCritical: 0.5,
        warnEscalationWindow: 5,
        warnEscalationCount: 3,
      },
      completion: {
        completedFilenamePattern: '*_[Cc]ompleted.md',
        donePromiseRegex: '<promise>\\s*DONE\\s*</promise>',
        doneSentinelFile: 'DONE.txt',
        verifyCommand: 'true',
        allowOperatorReviewedCompletion: false,
        verifyTimeoutMs: 600_000,
        runVerifyTwice: true,
        requireCompletedFileRename: false,
      },
      initialStage: 'IMPLEMENT',
      allowDestructiveOps: false,
    };

    expect(LoopConfigSchema.safeParse(config).success).toBe(true);
  });
});
```

Run:

```bash
rtk npx vitest run packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts
```

Expected: FAIL because `maxWallTimeMs` is capped at 24 hours.

- [x] **Step 2: Lift the wall-time schema and default loop cap**

In `packages/contracts/src/schemas/loop.schemas.ts`, add:

```typescript
const LOOP_MAX_WALL_TIME_MS_SCHEMA_CAP = 7 * 24 * 60 * 60 * 1000;
```

Change:

```typescript
maxWallTimeMs: z.number().int().positive().max(LOOP_MAX_WALL_TIME_MS_SCHEMA_CAP),
```

In `src/shared/types/loop.types.ts`, add:

```typescript
export const DEFAULT_LOOP_MAX_WALL_TIME_MS = 50 * 60 * 60 * 1000;
```

Change the default config:

```typescript
maxWallTimeMs: DEFAULT_LOOP_MAX_WALL_TIME_MS,
```

- [x] **Step 3: Replace token-cap helper tests**

In `src/main/orchestration/loop-coordinator-state-helpers.spec.ts`, replace:

```typescript
it('normalizes legacy numeric maxTokens inputs to no token cap', () => {
  const config = materializeLoopConfig({
    initialPrompt: 'do work',
    workspaceCwd: '/tmp/workspace',
    caps: { ...defaultLoopConfig('/tmp/workspace', 'do work').caps, maxTokens: 1_000_000 },
  });

  expect(config.caps.maxTokens).toBeNull();
});
```

with:

```typescript
it('preserves explicit numeric maxTokens inputs as a token cap', () => {
  const config = materializeLoopConfig({
    initialPrompt: 'do work',
    workspaceCwd: '/tmp/workspace',
    caps: { ...defaultLoopConfig('/tmp/workspace', 'do work').caps, maxTokens: 1_000_000 },
  });

  expect(config.caps.maxTokens).toBe(1_000_000);
});
```

Replace:

```typescript
it('does not stop on token usage even when an old numeric maxTokens cap is present', () => {
  expect(checkLoopHardCaps(stateWithTokens(7_242_440, 1_000_000))).toBeNull();
});
```

with:

```typescript
it('stops on token usage when maxTokens is configured', () => {
  expect(checkLoopHardCaps(stateWithTokens(7_242_440, 1_000_000))).toBe('tokens');
});
```

Add:

```typescript
it('defaults to a 50-hour wall-time cap', () => {
  const config = defaultLoopConfig('/tmp/workspace', 'do work');
  expect(config.caps.maxWallTimeMs).toBe(50 * 60 * 60 * 1000);
});
```

Run:

```bash
rtk npx vitest run src/main/orchestration/loop-coordinator-state-helpers.spec.ts
```

Expected: FAIL until token caps are preserved and enforced.

- [x] **Step 4: Preserve token caps in `materializeLoopConfig`**

In `src/main/orchestration/loop-coordinator-state-helpers.ts`, replace:

```typescript
caps: { ...base.caps, ...(p.caps ?? {}), maxTokens: null },
```

with:

```typescript
caps: normalizeLoopCaps(base.caps, p.caps),
```

Add this helper above `materializeLoopConfig`:

```typescript
function normalizeLoopCaps(
  base: LoopConfig['caps'],
  patch: Partial<LoopConfig['caps']> | undefined,
): LoopConfig['caps'] {
  const merged = { ...base, ...(patch ?? {}) };
  const maxTokens = merged.maxTokens == null
    ? null
    : Math.max(1, Math.floor(merged.maxTokens));
  return {
    ...merged,
    maxTokens,
    maxWallTimeMs: Math.max(1, Math.floor(merged.maxWallTimeMs)),
    maxToolCallsPerIteration: Math.max(1, Math.floor(merged.maxToolCallsPerIteration)),
  };
}
```

- [x] **Step 5: Enforce token caps in hard-cap checks**

In `src/main/orchestration/loop-coordinator-state-helpers.ts`, change `checkLoopHardCaps()`:

```typescript
export function checkLoopHardCaps(state: LoopState): null | 'iterations' | 'wall-time' | 'tokens' | 'cost' {
  const caps = state.config.caps;
  if (caps.maxIterations !== null && state.totalIterations >= caps.maxIterations) return 'iterations';
  if (Date.now() - state.startedAt >= caps.maxWallTimeMs) return 'wall-time';
  if (caps.maxTokens !== null && state.totalTokens >= caps.maxTokens) return 'tokens';
  if (caps.maxCostCents !== null && state.totalCostCents >= caps.maxCostCents) return 'cost';
  return null;
}
```

- [x] **Step 6: Verify 50-hour contracts and token cap enforcement**

Run:

```bash
rtk npx vitest run packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts src/main/orchestration/loop-coordinator-state-helpers.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit if authorized**

```bash
rtk git add packages/contracts/src/schemas/loop.schemas.ts packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts src/shared/types/loop.types.ts src/main/orchestration/loop-coordinator-state-helpers.ts src/main/orchestration/loop-coordinator-state-helpers.spec.ts
rtk git commit -m "fix: support 50-hour loop caps"
```

---

### Task 10: Persist and Restore Open Chat Workspace State

**Files:**
- Modify: `packages/contracts/src/channels/chat.channels.ts`
- Modify: `packages/contracts/src/channels/__tests__/chat.channels.spec.ts`
- Modify: `packages/contracts/src/schemas/chat.schemas.ts`
- Modify: `packages/contracts/src/schemas/__tests__/chat.schemas.spec.ts`
- Modify: `src/shared/types/chat.types.ts`
- Modify: `src/main/operator/operator-schema.ts`
- Create: `src/main/chats/chat-ui-state-store.ts`
- Create: `src/main/chats/chat-ui-state-store.spec.ts`
- Modify: `src/main/chats/chat-service.ts`
- Modify: `src/main/chats/chat-service.spec.ts`
- Modify: `src/main/ipc/handlers/chat-handlers.ts`
- Modify: `src/preload/generated/channels.ts`
- Modify: `src/preload/domains/chat.preload.ts`
- Modify: `src/preload/__tests__/chat-domain.spec.ts`
- Modify: `src/renderer/app/core/services/ipc/chat-ipc.service.ts`
- Modify: `src/renderer/app/core/services/ipc/chat-ipc.service.spec.ts`
- Modify: `src/renderer/app/core/state/chat.store.ts`
- Modify: `src/renderer/app/core/state/chat.store.spec.ts`

- [x] **Step 1: Add failing chat UI-state contract tests**

In `packages/contracts/src/channels/__tests__/chat.channels.spec.ts`, extend the expected channel map:

```typescript
expect(CHAT_CHANNELS).toEqual({
  CHAT_LIST: 'chat:list',
  CHAT_GET: 'chat:get',
  CHAT_CREATE: 'chat:create',
  CHAT_RENAME: 'chat:rename',
  CHAT_ARCHIVE: 'chat:archive',
  CHAT_SET_CWD: 'chat:set-cwd',
  CHAT_SET_PROVIDER: 'chat:set-provider',
  CHAT_SET_MODEL: 'chat:set-model',
  CHAT_SET_REASONING: 'chat:set-reasoning',
  CHAT_SET_YOLO: 'chat:set-yolo',
  CHAT_LOAD_OLDER_MESSAGES: 'chat:load-older-messages',
  CHAT_SEND_MESSAGE: 'chat:send-message',
  CHAT_UI_STATE_GET: 'chat:ui-state-get',
  CHAT_UI_STATE_SET: 'chat:ui-state-set',
  CHAT_EVENT: 'chat:event',
});
```

In `packages/contracts/src/schemas/__tests__/chat.schemas.spec.ts`, add `ChatUiStatePayloadSchema` to the import list and append:

```typescript
it('validates bounded chat UI-state payloads for crash restore', () => {
  expect(ChatUiStatePayloadSchema.parse({
    selectedChatId: 'chat-2',
    openChatIds: ['chat-1', 'chat-2'],
  })).toEqual({
    selectedChatId: 'chat-2',
    openChatIds: ['chat-1', 'chat-2'],
  });

  expect(ChatUiStatePayloadSchema.safeParse({
    selectedChatId: null,
    openChatIds: [],
  }).success).toBe(true);

  expect(ChatUiStatePayloadSchema.safeParse({
    selectedChatId: 'chat-1',
    openChatIds: Array.from({ length: 21 }, (_, index) => `chat-${index}`),
  }).success).toBe(false);
});
```

Run:

```bash
rtk npx vitest run packages/contracts/src/channels/__tests__/chat.channels.spec.ts packages/contracts/src/schemas/__tests__/chat.schemas.spec.ts
```

Expected: FAIL because the channels and schema do not exist yet.

- [x] **Step 2: Add chat UI-state contracts and regenerate preload channels**

In `packages/contracts/src/channels/chat.channels.ts`, add:

```typescript
CHAT_UI_STATE_GET: 'chat:ui-state-get',
CHAT_UI_STATE_SET: 'chat:ui-state-set',
```

In `packages/contracts/src/schemas/chat.schemas.ts`, extract the chat-id schema and add the UI-state payload:

```typescript
const ChatIdStringSchema = z.string().min(1).max(200);

export const ChatIdPayloadSchema = z.object({
  chatId: ChatIdStringSchema,
});

export const ChatUiStatePayloadSchema = z.object({
  selectedChatId: ChatIdStringSchema.nullable(),
  openChatIds: z.array(ChatIdStringSchema).max(20),
});

export type ChatUiStatePayload = z.infer<typeof ChatUiStatePayloadSchema>;
```

In `src/shared/types/chat.types.ts`, add:

```typescript
export interface ChatUiState {
  selectedChatId: string | null;
  openChatIds: string[];
  updatedAt: number;
}
```

Regenerate the preload channel map:

```bash
rtk npm run generate:ipc
```

Then run:

```bash
rtk npx vitest run packages/contracts/src/channels/__tests__/chat.channels.spec.ts packages/contracts/src/schemas/__tests__/chat.schemas.spec.ts
```

Expected: PASS.

- [x] **Step 3: Add failing durable chat UI-state store tests**

Create `src/main/chats/chat-ui-state-store.spec.ts`:

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { ChatUiStateStore } from './chat-ui-state-store';

interface TableInfoRow { name: string; }

describe('ChatUiStateStore', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function freshDb(): SqliteDriver {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    return db;
  }

  it('creates the chat_ui_state table with the operator schema', () => {
    const db = freshDb();
    const columns = db
      .prepare('PRAGMA table_info(chat_ui_state)')
      .all() as TableInfoRow[];

    expect(columns.map((column) => column.name)).toEqual([
      'scope',
      'selected_chat_id',
      'open_chat_ids_json',
      'updated_at',
    ]);
  });

  it('round-trips selected and open chat ids for crash restore', () => {
    const store = new ChatUiStateStore(freshDb());

    const saved = store.set({
      selectedChatId: 'chat-2',
      openChatIds: ['chat-1', 'chat-2', 'chat-1'],
      updatedAt: 1234,
    });

    expect(saved).toEqual({
      selectedChatId: 'chat-2',
      openChatIds: ['chat-1', 'chat-2'],
      updatedAt: 1234,
    });
    expect(store.get()).toEqual(saved);
  });

  it('includes the selected chat in openChatIds even when the renderer omits it', () => {
    const store = new ChatUiStateStore(freshDb());

    expect(store.set({
      selectedChatId: 'chat-3',
      openChatIds: ['chat-1'],
      updatedAt: 10,
    })).toEqual({
      selectedChatId: 'chat-3',
      openChatIds: ['chat-3', 'chat-1'],
      updatedAt: 10,
    });
  });
});
```

Run:

```bash
rtk npx vitest run src/main/chats/chat-ui-state-store.spec.ts
```

Expected: FAIL because `chat-ui-state-store` and the table do not exist.

- [x] **Step 4: Implement the operator table and durable chat UI-state store**

In `src/main/operator/operator-schema.ts`, add this table inside `createOperatorTables()`:

```sql
CREATE TABLE IF NOT EXISTS chat_ui_state (
  scope TEXT PRIMARY KEY,
  selected_chat_id TEXT,
  open_chat_ids_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Create `src/main/chats/chat-ui-state-store.ts`:

```typescript
import type { ChatUiState } from '../../shared/types/chat.types';
import type { SqliteDriver } from '../db/sqlite-driver';

const DEFAULT_SCOPE = 'default';
const MAX_OPEN_CHAT_IDS = 20;

interface ChatUiStateRow {
  scope: string;
  selected_chat_id: string | null;
  open_chat_ids_json: string;
  updated_at: number;
}

export type ChatUiStateInput =
  Pick<ChatUiState, 'selectedChatId' | 'openChatIds'> & { updatedAt?: number };

export class ChatUiStateStore {
  constructor(private readonly db: SqliteDriver) {}

  get(): ChatUiState {
    const row = this.db
      .prepare('SELECT * FROM chat_ui_state WHERE scope = ?')
      .get<ChatUiStateRow>(DEFAULT_SCOPE);
    if (!row) {
      return { selectedChatId: null, openChatIds: [], updatedAt: 0 };
    }
    return {
      selectedChatId: row.selected_chat_id,
      openChatIds: parseOpenChatIds(row.open_chat_ids_json),
      updatedAt: row.updated_at,
    };
  }

  set(input: ChatUiStateInput): ChatUiState {
    const normalized = normalizeChatUiState(input);
    const updatedAt = input.updatedAt ?? Date.now();
    this.db.prepare(`
      INSERT INTO chat_ui_state (
        scope, selected_chat_id, open_chat_ids_json, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        selected_chat_id = excluded.selected_chat_id,
        open_chat_ids_json = excluded.open_chat_ids_json,
        updated_at = excluded.updated_at
    `).run(
      DEFAULT_SCOPE,
      normalized.selectedChatId,
      JSON.stringify(normalized.openChatIds),
      updatedAt,
    );
    return { ...normalized, updatedAt };
  }
}

function normalizeChatUiState(input: ChatUiStateInput): Pick<ChatUiState, 'selectedChatId' | 'openChatIds'> {
  const seen = new Set<string>();
  const openChatIds: string[] = [];
  const push = (id: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed) || openChatIds.length >= MAX_OPEN_CHAT_IDS) {
      return;
    }
    seen.add(trimmed);
    openChatIds.push(trimmed);
  };
  push(input.selectedChatId);
  for (const id of input.openChatIds) {
    push(id);
  }
  return {
    selectedChatId: input.selectedChatId?.trim() || null,
    openChatIds,
  };
}

function parseOpenChatIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .slice(0, MAX_OPEN_CHAT_IDS);
  } catch {
    return [];
  }
}
```

Run:

```bash
rtk npx vitest run src/main/chats/chat-ui-state-store.spec.ts src/main/chats/chat-store.spec.ts
```

Expected: PASS.

- [x] **Step 5: Add failing service-level crash-restore tests**

In `src/main/chats/chat-service.spec.ts`, add this test inside the main `describe('ChatService', ...)` block:

```typescript
it('persists selected/open chat UI state and filters stale ids on restore', async () => {
  const { service } = createHarness();
  const first = await service.createChat({
    provider: 'claude',
    currentCwd: '/work/first',
    name: 'First',
  });
  const second = await service.createChat({
    provider: 'codex',
    currentCwd: '/work/second',
    name: 'Second',
  });

  expect(service.setUiState({
    selectedChatId: second.chat.id,
    openChatIds: [first.chat.id, second.chat.id, 'missing-chat'],
  })).toMatchObject({
    selectedChatId: second.chat.id,
    openChatIds: [first.chat.id, second.chat.id],
  });

  await service.archiveChat(second.chat.id);

  expect(service.getUiState()).toMatchObject({
    selectedChatId: first.chat.id,
    openChatIds: [first.chat.id],
  });
});
```

Run:

```bash
rtk npx vitest run src/main/chats/chat-service.spec.ts
```

Expected: FAIL because `getUiState()` and `setUiState()` do not exist.

- [x] **Step 6: Wire chat UI state through `ChatService`**

In `src/main/chats/chat-service.ts`, import `ChatUiState` and `ChatUiStateStore`:

```typescript
import type { ChatCreateInput, ChatDetail, ChatEvent, ChatProvider, ChatRecord, ChatSendMessageInput, ChatUiState } from '../../shared/types/chat.types';
import { ChatUiStateStore } from './chat-ui-state-store';
```

Add a store field in the constructor path:

```typescript
private readonly uiStateStore: ChatUiStateStore;
```

Inside the constructor, after `this.store = new ChatStore(...)`, create the UI-state store from the same database:

```typescript
const db = config.db ?? getOperatorDatabase().db;
this.store = new ChatStore(db);
this.uiStateStore = new ChatUiStateStore(db);
```

Add public methods:

```typescript
getUiState(): ChatUiState {
  this.initialize();
  return this.filterUiState(this.uiStateStore.get());
}

setUiState(input: Pick<ChatUiState, 'selectedChatId' | 'openChatIds'>): ChatUiState {
  this.initialize();
  this.uiStateStore.set(input);
  return this.getUiState();
}
```

Add the filtering helper:

```typescript
private filterUiState(state: ChatUiState): ChatUiState {
  const activeChatIds = new Set(this.store.list().map((chat) => chat.id));
  const openChatIds = state.openChatIds.filter((id) => activeChatIds.has(id));
  const selectedChatId = state.selectedChatId && activeChatIds.has(state.selectedChatId)
    ? state.selectedChatId
    : openChatIds[0] ?? null;
  const filtered = { selectedChatId, openChatIds, updatedAt: state.updatedAt };
  if (
    filtered.selectedChatId !== state.selectedChatId
    || filtered.openChatIds.length !== state.openChatIds.length
  ) {
    return this.uiStateStore.set(filtered);
  }
  return filtered;
}
```

Run:

```bash
rtk npx vitest run src/main/chats/chat-service.spec.ts
```

Expected: PASS.

- [x] **Step 7: Add IPC/preload/renderer IPC tests for UI state**

In `src/preload/__tests__/chat-domain.spec.ts`, add calls before `onChatEvent` assertions:

```typescript
await domain.chatGetUiState();
await domain.chatSetUiState({ selectedChatId: 'chat-2', openChatIds: ['chat-1', 'chat-2'] });
```

Add expectations:

```typescript
expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(13, IPC_CHANNELS.CHAT_UI_STATE_GET, {});
expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(14, IPC_CHANNELS.CHAT_UI_STATE_SET, {
  selectedChatId: 'chat-2',
  openChatIds: ['chat-1', 'chat-2'],
});
```

In `src/renderer/app/core/services/ipc/chat-ipc.service.spec.ts`, add fake API methods:

```typescript
chatGetUiState: vi.fn(),
chatSetUiState: vi.fn(),
```

Include them in the mocked-resolved method list, call the service methods, and assert:

```typescript
await service.getUiState();
await service.setUiState({ selectedChatId: 'chat-2', openChatIds: ['chat-1', 'chat-2'] });

expect(api.chatGetUiState).toHaveBeenCalledWith();
expect(api.chatSetUiState).toHaveBeenCalledWith({
  selectedChatId: 'chat-2',
  openChatIds: ['chat-1', 'chat-2'],
});
```

Run:

```bash
rtk npx vitest run src/preload/__tests__/chat-domain.spec.ts src/renderer/app/core/services/ipc/chat-ipc.service.spec.ts
```

Expected: FAIL until the IPC surfaces exist.

- [x] **Step 8: Implement chat UI-state IPC from main to renderer**

In `src/main/ipc/handlers/chat-handlers.ts`, import `ChatUiStatePayloadSchema` and register handlers:

```typescript
ipcMain.handle(IPC_CHANNELS.CHAT_UI_STATE_GET, async (): Promise<IpcResponse> => {
  try {
    return { success: true, data: service.getUiState() };
  } catch (error) {
    return chatError(error, 'CHAT_UI_STATE_GET_FAILED');
  }
});

ipcMain.handle(IPC_CHANNELS.CHAT_UI_STATE_SET, async (_event, payload: unknown): Promise<IpcResponse> => {
  try {
    const validated = validateIpcPayload(ChatUiStatePayloadSchema, payload, 'CHAT_UI_STATE_SET');
    return { success: true, data: service.setUiState(validated) };
  } catch (error) {
    return chatError(error, 'CHAT_UI_STATE_SET_FAILED');
  }
});
```

In `src/preload/domains/chat.preload.ts`, add:

```typescript
chatGetUiState: (): Promise<IpcResponse> =>
  ipcRenderer.invoke(ch.CHAT_UI_STATE_GET, {}),

chatSetUiState: (payload: unknown): Promise<IpcResponse> =>
  ipcRenderer.invoke(ch.CHAT_UI_STATE_SET, payload),
```

In `src/renderer/app/core/services/ipc/chat-ipc.service.ts`, import `ChatUiState` and add:

```typescript
async getUiState(): Promise<IpcResponse<ChatUiState>> {
  if (!this.api) {
    return { success: false, error: { message: 'Not in Electron' } };
  }
  return this.api.chatGetUiState() as Promise<IpcResponse<ChatUiState>>;
}

async setUiState(
  state: Pick<ChatUiState, 'selectedChatId' | 'openChatIds'>,
): Promise<IpcResponse<ChatUiState>> {
  if (!this.api) {
    return { success: false, error: { message: 'Not in Electron' } };
  }
  return this.api.chatSetUiState(state) as Promise<IpcResponse<ChatUiState>>;
}
```

Run:

```bash
rtk npx vitest run src/preload/__tests__/chat-domain.spec.ts src/renderer/app/core/services/ipc/chat-ipc.service.spec.ts
```

Expected: PASS.

- [x] **Step 9: Add failing renderer restore/persist tests**

In `src/renderer/app/core/state/chat.store.spec.ts`, add `getUiState` and `setUiState` to the fake `ipc`, then append:

```typescript
it('restores the last selected chat during initialization after an app crash', async () => {
  ipc.getUiState.mockResolvedValueOnce({
    success: true,
    data: {
      selectedChatId: 'chat-2',
      openChatIds: ['chat-1', 'chat-2'],
      updatedAt: 1234,
    },
  });
  const store = TestBed.inject(ChatStore);

  await store.initialize();

  expect(store.selectedChatId()).toBe('chat-2');
  expect(ipc.get).toHaveBeenCalledWith('chat-2');
  expect(store.selectedDetail()?.chat.id).toBe('chat-2');
});

it('persists selected and deselected chat UI state through IPC', async () => {
  ipc.getUiState.mockResolvedValueOnce({
    success: true,
    data: { selectedChatId: null, openChatIds: [], updatedAt: 0 },
  });
  ipc.setUiState.mockResolvedValue({ success: true, data: { selectedChatId: 'chat-1', openChatIds: ['chat-1'], updatedAt: 10 } });
  const store = TestBed.inject(ChatStore);

  await store.initialize();
  await store.select('chat-1');
  store.deselect();

  expect(ipc.setUiState).toHaveBeenNthCalledWith(1, {
    selectedChatId: 'chat-1',
    openChatIds: ['chat-1'],
  });
  expect(ipc.setUiState).toHaveBeenNthCalledWith(2, {
    selectedChatId: null,
    openChatIds: [],
  });
});
```

Run:

```bash
rtk npx vitest run src/renderer/app/core/state/chat.store.spec.ts
```

Expected: FAIL until `ChatStore.initialize()`, `select()`, and `deselect()` use UI-state IPC.

- [x] **Step 10: Restore and persist selected chat state in `ChatStore`**

In `src/renderer/app/core/state/chat.store.ts`, add:

```typescript
private restoredUiState = false;
```

Change `initialize()` so it restores the selected chat after the list loads:

```typescript
this.initializationPromise = this.loadChats().then(async () => {
  await this.restoreUiState();
  this.initialized = true;
}).finally(() => {
  this.initializationPromise = null;
});
```

Change `select()`, `deselect()`, and successful `create()` selection paths:

```typescript
this._selectedChatId.set(chatId);
void this.persistUiState(chatId);
await this.loadDetail(chatId);
```

```typescript
this._selectedChatId.set(null);
void this.persistUiState(null);
```

```typescript
this._selectedChatId.set(response.data.chat.id);
void this.persistUiState(response.data.chat.id);
```

When an archived chat clears the selected id, call `void this.persistUiState(null);`.

In `disposeForTesting()`, reset the restore guard:

```typescript
this.restoredUiState = false;
```

Add helpers:

```typescript
private async restoreUiState(): Promise<void> {
  if (this.restoredUiState) {
    return;
  }
  this.restoredUiState = true;
  const response = await this.ipc.getUiState();
  if (!response.success || !response.data?.selectedChatId) {
    return;
  }
  const chatId = response.data.selectedChatId;
  if (!this._chats().some((chat) => chat.id === chatId)) {
    void this.persistUiState(null);
    return;
  }
  this._selectedChatId.set(chatId);
  await this.loadDetail(chatId);
}

private async persistUiState(selectedChatId: string | null): Promise<void> {
  const openChatIds = selectedChatId ? [selectedChatId] : [];
  const response = await this.ipc.setUiState({ selectedChatId, openChatIds });
  if (!response.success) {
    this._error.set(response.error?.message ?? 'Failed to persist chat restore state');
  }
}
```

Run:

```bash
rtk npx vitest run src/renderer/app/core/state/chat.store.spec.ts
```

Expected: PASS.

- [x] **Step 11: Verify chat crash restore end to end**

Run:

```bash
rtk npx vitest run packages/contracts/src/channels/__tests__/chat.channels.spec.ts packages/contracts/src/schemas/__tests__/chat.schemas.spec.ts
rtk npx vitest run src/main/chats/chat-ui-state-store.spec.ts src/main/chats/chat-service.spec.ts src/main/chats/chat-store.spec.ts
rtk npx vitest run src/preload/__tests__/chat-domain.spec.ts src/renderer/app/core/services/ipc/chat-ipc.service.spec.ts src/renderer/app/core/state/chat.store.spec.ts
```

Expected: PASS.

- [ ] **Step 12: Commit if authorized**

```bash
rtk git add packages/contracts/src/channels/chat.channels.ts packages/contracts/src/channels/__tests__/chat.channels.spec.ts packages/contracts/src/schemas/chat.schemas.ts packages/contracts/src/schemas/__tests__/chat.schemas.spec.ts src/shared/types/chat.types.ts src/main/operator/operator-schema.ts src/main/chats/chat-ui-state-store.ts src/main/chats/chat-ui-state-store.spec.ts src/main/chats/chat-service.ts src/main/chats/chat-service.spec.ts src/main/ipc/handlers/chat-handlers.ts src/preload/generated/channels.ts src/preload/domains/chat.preload.ts src/preload/__tests__/chat-domain.spec.ts src/renderer/app/core/services/ipc/chat-ipc.service.ts src/renderer/app/core/services/ipc/chat-ipc.service.spec.ts src/renderer/app/core/state/chat.store.ts src/renderer/app/core/state/chat.store.spec.ts
rtk git commit -m "fix: restore open chat workspace after crashes"
```

---

### Task 11: Add Long-Loop Soak and Chaos Harness

**Files:**
- Create: `src/main/orchestration/long-loop-resilience.spec.ts`
- Create: `scripts/soak-long-loop.ts`
- Modify: `package.json`

- [x] **Step 1: Add failing integration spec for loop survival through subsystem degradation**

Create `src/main/orchestration/long-loop-resilience.spec.ts`:

```typescript
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { defaultLoopConfig } from '../../shared/types/loop.types';

describe('long-loop resilience', () => {
  let workspace: string;
  let coordinator: LoopCoordinator;

  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    workspace = mkdtempSync(join(tmpdir(), 'long-loop-resilience-'));
    writeFileSync(join(workspace, 'package.json'), '{"scripts":{"test":"true"}}\n');
    coordinator = new LoopCoordinator();
  });

  afterEach(async () => {
    for (const loop of coordinator.getActiveLoops()) {
      await coordinator.cancelLoop(loop.id).catch(() => undefined);
    }
    rmSync(workspace, { recursive: true, force: true });
    LoopCoordinator._resetForTesting();
  });

  it('continues loop iterations when optional context and codemem workers are degraded', async () => {
    let invocations = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult) => void };
      invocations++;
      p.callback({
        childInstanceId: `child-${invocations}`,
        output: invocations < 3 ? 'still working' : 'TASK COMPLETE',
        tokens: 1,
        costCents: 0,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        verify: { status: 'passed', output: 'ok' },
      });
    });

    const state = await coordinator.startLoop('chat-long', {
      ...defaultLoopConfig,
      initialPrompt: 'finish the work',
      workspaceCwd: workspace,
      maxIterations: 4,
      verifyCommand: 'true',
      completion: { ...defaultLoopConfig.completion, requireFreshEyesReview: false },
    });

    await new Promise((resolve) => coordinator.on('loop:completed', resolve));
    expect(coordinator.getLoop(state.id)?.status).toBeUndefined();
    expect(invocations).toBeGreaterThanOrEqual(3);
  });
});
```

Run:

```bash
rtk npx vitest run src/main/orchestration/long-loop-resilience.spec.ts
```

Expected: PASS once existing loop behavior is healthy; if it fails, fix the failure before adding the script.

- [x] **Step 2: Add soak script**

Create `scripts/soak-long-loop.ts`:

```typescript
import { spawnSync } from 'node:child_process';

const durationHours = Number(process.env['AIO_SOAK_HOURS'] ?? 1);
const startedAt = Date.now();
const deadline = startedAt + durationHours * 60 * 60 * 1000;
let runs = 0;

while (Date.now() < deadline) {
  const result = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', 'src/main/orchestration/long-loop-resilience.spec.ts'],
    { stdio: 'inherit' },
  );
  runs++;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`long-loop soak completed ${runs} run(s) in ${durationHours} hour(s)`);
```

Add to `package.json` scripts:

```json
"soak:long-loop": "tsx scripts/soak-long-loop.ts"
```

- [x] **Step 3: Verify soak harness**

Run a short smoke soak:

```bash
rtk AIO_SOAK_HOURS=0.01 npm run soak:long-loop
```

Expected: PASS and prints `long-loop soak completed`.

- [ ] **Step 4: Commit if authorized**

```bash
rtk git add src/main/orchestration/long-loop-resilience.spec.ts scripts/soak-long-loop.ts package.json
rtk git commit -m "test: add long-loop resilience soak harness"
```

---

## Final Verification

After all tasks are implemented:

```bash
npx vitest run src/main/orchestration/bounded-file-read.spec.ts src/main/orchestration/loop-diff.spec.ts src/main/orchestration/loop-workspace-snapshot.spec.ts src/main/orchestration/loop-stage-machine.spec.ts src/main/orchestration/loop-completion-detector.spec.ts
npx vitest run src/main/orchestration/loop-outstanding-export.spec.ts
npx vitest run packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts src/main/orchestration/loop-coordinator-state-helpers.spec.ts
npx vitest run packages/contracts/src/channels/__tests__/chat.channels.spec.ts packages/contracts/src/schemas/__tests__/chat.schemas.spec.ts
npx vitest run src/main/chats/chat-ui-state-store.spec.ts src/main/chats/chat-service.spec.ts src/main/chats/chat-store.spec.ts
npx vitest run src/preload/__tests__/chat-domain.spec.ts src/renderer/app/core/services/ipc/chat-ipc.service.spec.ts src/renderer/app/core/state/chat.store.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test
AIO_SOAK_HOURS=0.01 npm run soak:long-loop
```

Expected:

- TypeScript main project passes.
- TypeScript spec project passes.
- Targeted loop file-read regressions pass without full-file reads before truncation.
- 50-hour schema/defaults and token hard-cap tests pass.
- Chat UI-state persistence restores the last selected chat after restart and filters stale archived chat ids.
- Lint passes.
- TypeScript line-count ratchet passes or reports only existing allowlist tolerance warnings.
- Full Vitest suite passes.
- Short soak passes.

Fresh verification evidence (2026-06-09, run without `rtk` prefix):

- Checkpoint regression was red/green verified: `history: []` fails `does not overwrite the latest checkpoint history tail...`; restoring `state.lastIteration ? [state.lastIteration] : []` passes it.
- Targeted suites for worker isolation, context isolation, bounded persistence, checkpoint/restore, resource governor, codemem lifecycle, bounded file reads, contracts, chat UI-state, and long-loop resilience passed.
- `npx tsc --noEmit` passed.
- `npx tsc --noEmit -p tsconfig.spec.json` passed.
- `npm run lint` passed.
- `npm run check:ts-max-loc` passed with only existing allowlisted files inside the +50-line tolerance.
- `npm run test` passed: 946 files, 9374 tests.
- `AIO_SOAK_HOURS=0.01 npm run soak:long-loop` passed: 9 runs in 0.01 hours.
- All implementation/verification step checkboxes are marked complete; commit-only steps remain unchecked because no commit was authorized.

Security and abuse-case review (2026-06-09):

- Chat UI-state IPC uses Zod validation, caps open chat IDs at 20, caps each chat ID at 200 chars, and persists only chat IDs.
- Chat UI-state restore filters persisted IDs against active chats before returning state to the renderer, so stale archived IDs and stale `currentInstanceId` values are not treated as live runtimes.
- Checkpoint persistence stores loop state plus bounded iteration history; the state-change write now preserves the last iteration instead of erasing the history tail.
- Windows CLI spawn resolution moves known npm shim launches to `shell:false` and falls back to the existing shell path only when resolution fails.
- Clipboard image fallback converts an in-memory `Blob` to a data URL through `arrayBuffer()` or `FileReader`; it does not add filesystem, network, or shell access.
- Filename-only secret-keyword scan over changed tracked files found only benign code/channel/schema names, not credential values.
- No new credential, path traversal, IPC validation bypass, or command-injection issue was found in the reviewed diffs.

## Completion Checklist

- [x] Codemem remains bounded and child-process isolated.
- [x] Context/RLM is child-process isolated.
- [x] Long-lived persistence APIs have explicit row limits or pagination.
- [x] Loop checkpoints persist after state changes and completed iterations.
- [x] Paused/interrupted loops can restore from checkpoints and resume manually.
- [x] Resource governor pauses loops before critical memory/DB pressure.
- [x] Codemem can prune oversized or stale workspace indexes.
- [x] Loop-owned workspace/artifact reads are bounded before truncation, IPC, or SQLite persistence.
- [x] 50-hour loop configs parse through contracts and default config.
- [x] Explicit token caps are preserved and stop loops when reached.
- [x] Last selected/open chat workspace state persists in the main database and restores on renderer initialization after a crash.
- [x] Chat crash restore never treats stale `currentInstanceId` values as live runtimes.
- [x] Soak harness can repeatedly exercise long-loop behavior.

## Self-Review Notes

- Spec coverage: covers all remaining work named after the first codemem fix: context/RLM process isolation, durable loop resume checkpoints, resource governor, codemem pruning/compaction, bounded persistence, bounded loop file reads, 50-hour wall-time contracts, token-cap enforcement, and crash-resilient chat UI-state restore.
- Placeholder scan: no unresolved placeholder markers from the writing-plans checklist; where code depends on existing helper names, the plan names the file and method to add.
- Type consistency: `LoopCheckpoint`, `LongRunResourceGovernor`, and `IsolatedWorkerProcess` names are consistent across tasks.
- Scope note: database replacement is intentionally excluded. SQLite remains the control-plane database; only codemem/search lifecycle is treated as a separate bounded subsystem.
