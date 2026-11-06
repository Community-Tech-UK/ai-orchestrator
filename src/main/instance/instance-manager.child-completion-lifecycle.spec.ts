import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createHarnessShutdownOperations, type HarnessShutdownOperations } from '../process/harness-shutdown-operations';
import { GracefulShutdownManager } from '../process/graceful-shutdown';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceChildCompletionHandler } from './instance-child-completion-handler';
import { InstanceManager } from './instance-manager';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aio-child-lifecycle', isPackaged: false } }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }),
}));
vi.mock('../commands/command-manager', () => ({ getCommandManager: vi.fn() }));
vi.mock('../orchestration/task-manager', () => ({
  getTaskManager: () => ({ stopTimeoutChecker: vi.fn() }),
}));
vi.mock('../session/handoff-state-service', () => ({
  getHandoffStateService: () => ({ removeInstance: vi.fn() }),
}));

const handlers: InstanceChildCompletionHandler[] = [];
afterEach(() => {
  for (const handler of handlers.splice(0)) handler.dispose();
  GracefulShutdownManager._resetForTesting();
});

function fixture() {
  const parent = { id: 'parent', status: 'idle', parentId: null, outputBuffer: [] } as unknown as Instance;
  const instances = new Map<string, Instance>([['parent', parent]]);
  const orchestration = Object.assign(new EventEmitter(), {
    notifyChildTerminated: () => ({ remainingChildren: 0 }),
    deliverChildCompleted: vi.fn(),
    getCompletedChildIds: () => [],
    getActiveChildCount: () => 0,
    notifyAllChildrenCompleted: vi.fn(),
    dispose: vi.fn(), cancelUserActions: vi.fn(), endUserActions: vi.fn(),
  });
  const handler = new InstanceChildCompletionHandler({
    getInstance: (id) => instances.get(id),
    addToOutputBuffer: vi.fn(), publishOutput: vi.fn(),
    terminateInstance: async () => undefined,
    getOrchestrationHandler: () => orchestration,
  });
  handlers.push(handler);
  const lifecycle = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  // Exercise the real manager registration and destroy methods without starting
  // watchdogs, provider processes, persistence, or the unrelated constructor graph.
  const owner = Object.assign(new EventEmitter(), {
    state: Object.assign(new EventEmitter(), {
      getInstance: (id: string) => instances.get(id), destroy: vi.fn(),
    }),
    communication: new EventEmitter(), lifecycle, childCompletion: handler,
    orchestrationMgr: { getOrchestrationHandler: () => orchestration },
    requestReceipts: { setLocalResolutionHandler: vi.fn() },
    continuityRecovery: { removeInstance: vi.fn() },
    providerEventBus: { removeInstance: vi.fn() },
    settledTracker: { clear: vi.fn(), destroy: vi.fn() },
    mcpStartupRecovery: { forget: vi.fn() },
    lifecycleEvents: { recordRemoved: () => ({}) },
    emitObserversSafely: vi.fn(), terminateAll: vi.fn(), handlePause: vi.fn(),
    prepareForShutdown: InstanceManager.prototype.prepareForShutdown,
  });
  Reflect.get(InstanceManager.prototype, 'setupEventForwarding').call(owner);
  const parents = Reflect.get(Reflect.get(handler, 'batcher'), 'parents') as Map<string, unknown>;
  return { parent, instances, orchestration, lifecycle, handler, owner, parents };
}

describe('InstanceManager child-completion lifetime wiring', () => {
  it('removes retained parent state at the actual removed event, before the record is deleted', () => {
    const f = fixture();
    f.orchestration.emit('child-spawned', 'parent', 'a');
    expect(f.parents.size).toBe(1);
    f.lifecycle.emit('removed', 'parent');
    expect(f.instances.get('parent')).toBe(f.parent);
    expect(f.parents.size).toBe(0);
    f.orchestration.emit('child-spawned', 'parent', 'late');
    expect(f.parents.size).toBe(0);
  });

  it('disposes batch state and unsubscribes spawns before manager shutdown tears down state', () => {
    const f = fixture();
    f.orchestration.emit('child-spawned', 'parent', 'a');
    const unrelatedListener = vi.fn();
    f.orchestration.on('child-spawned', unrelatedListener);
    f.owner.state.destroy.mockImplementation(() => {
      expect(f.parents.size).toBe(0);
      expect(f.orchestration.listenerCount('child-spawned')).toBe(1);
    });
    InstanceManager.prototype.destroy.call(f.owner as unknown as InstanceManager);
    f.orchestration.emit('child-spawned', 'parent', 'late');
    expect(f.parents.size).toBe(0);
    expect(unrelatedListener).toHaveBeenCalledOnce();
    expect(f.owner.terminateAll).toHaveBeenCalledOnce();
    f.handler.dispose();
    expect(f.orchestration.listenerCount('child-spawned')).toBe(1);
  });

  it.each(['sync', 'async'] as const)('disposes through the registered main-entry %s shutdown callback', async (mode) => {
    const f = fixture();
    f.orchestration.emit('child-spawned', 'parent', 'a');
    let shutdown: HarnessShutdownOperations | undefined;
    const sizesAtTermination: number[] = [];
    f.owner.terminateAll.mockImplementation(() => { sizesAtTermination.push(f.parents.size); });
    const noop = (): undefined => undefined;
    const app = Object.assign(new EventEmitter(), {
      isPackaged: false, setPath: noop, getPath: () => '/inert', setName: noop,
      setAppUserModelId: noop, commandLine: { appendSwitch: noop },
      requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit: noop, exit: noop,
    });
    const inertProcess = Object.assign(new EventEmitter(), {
      platform: 'linux', env: {}, argv: [], pid: 1, ppid: 1,
    });
    // Execute the real entry point and real shutdown composition. Only external
    // app/process/filesystem and unrelated services are inert; no window opens.
    const modules: Record<string, unknown> = {
      './register-aliases': {}, electron: { app, BrowserWindow: { getAllWindows: () => [] } },
      fs: { mkdirSync: noop, appendFileSync: noop, writeFileSync: noop },
      path: { join: (...parts: string[]) => parts.join('/') },
      './window-manager': { WindowManager: class { createMainWindow = async () => undefined; } },
      './instance/instance-manager': { InstanceManager: function () { return f.owner; } },
      './instance/context-worker-client': {
        getContextWorkerClient: () => ({ signalAppReady: noop, beginShutdown: noop, shutdown: async () => undefined }),
      },
      './logging/logger': { getLogger: () => ({ info: noop, warn: noop, error: noop }) },
      './app/initialization-steps': {
        createInitializationSteps: () => [],
        createWindowAndStartEvidenceMaintenance: async (create: () => Promise<void>, ready: () => void) => {
          await create(); ready();
        },
      },
      './process/harness-shutdown-operations': {
        createHarnessShutdownOperations: (deps: Parameters<typeof createHarnessShutdownOperations>[0]) => {
          shutdown = createHarnessShutdownOperations(deps);
          return shutdown;
        },
      },
      './cli/adapters/base-cli-adapter': {
        BaseCliAdapter: {
          killAllActiveProcesses: () => { sizesAtTermination.push(f.parents.size); },
          killAllActiveProcessesGraceful: noop,
        },
      },
      './plan-queue/plan-queue-coordinator': { getPlanQueueCoordinator: () => ({ shutdown: noop }) },
    };
    const fallback = new Proxy({}, { get: () => noop });
    const compiled = ts.transpileModule(readFileSync(resolve('src/main/index.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(compiled, {
      require: (name: string) => modules[name] ?? fallback,
      exports: {}, process: inertProcess, __dirname: '/inert', setImmediate,
    });
    await vi.waitFor(() => expect(shutdown).toBeDefined());
    if (mode === 'sync') shutdown!.cleanupSync();
    else await shutdown!.cleanup();
    expect(sizesAtTermination).toEqual([0]);
    expect(f.parents.size).toBe(0);
    expect(f.orchestration.listenerCount('child-spawned')).toBe(0);
  });

});
