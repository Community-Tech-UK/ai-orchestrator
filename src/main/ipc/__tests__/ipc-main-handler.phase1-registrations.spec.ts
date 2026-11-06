import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan 14b/14c/15b: the quick-ask handlers, the plan-handoff handlers and the
 * live-title source are only reachable if `IpcMainHandler.registerHandlers()`
 * actually calls them. `verify:ipc` checks channel names, not that the
 * registration call exists, so this test runs the real `registerHandlers()`
 * with every collaborator replaced by a recording stub.
 */

const mocks = vi.hoisted(() => {
  const fns = new Map<string, ReturnType<typeof import('vitest').vi.fn>>();
  const results = new Map<string, () => unknown>();
  return { fns, results };
});

// Every export of a stubbed module is a shared recording vi.fn(), keyed by
// export name (names are unique across the modules involved). `results` gives
// a stub a return value where registerHandlers() dereferences it.
function stub(name: string): ReturnType<typeof vi.fn> {
  let fn = mocks.fns.get(name);
  if (!fn) {
    fn = vi.fn(() => mocks.results.get(name)?.());
    mocks.fns.set(name, fn);
  }
  return fn;
}

function stubModule(): Record<string | symbol, unknown> {
  return new Proxy({}, {
    has: (_target, key) => key !== 'then',
    get: (_target, key) => (key === 'then' || typeof key === 'symbol' ? undefined : stub(key)),
  });
}

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock('../ipc-handler-timing', () => stubModule());
vi.mock('../../instance/instance-manager', () => stubModule());
vi.mock('../../instance/auto-title-service', () => stubModule());
vi.mock('../../instance/live-title-source', () => stubModule());
vi.mock('../../window-manager', () => stubModule());
vi.mock('../orchestration-ipc-handler', () => stubModule());
vi.mock('../verification-ipc-handler', () => stubModule());
vi.mock('../cli-verification-ipc-handler', () => stubModule());
vi.mock('../learning-ipc-handler', () => stubModule());
vi.mock('../../instance/context-worker-client', () => stubModule());
vi.mock('../memory-ipc-handler', () => stubModule());
vi.mock('../specialist-ipc-handler', () => stubModule());
vi.mock('../training-ipc-handler', () => stubModule());
vi.mock('../llm-ipc-handler', () => stubModule());
vi.mock('../observation-ipc-handler', () => stubModule());
vi.mock('../governed-proposal-ipc-handler', () => stubModule());
vi.mock('../learning-scan-ipc-handler', () => stubModule());
vi.mock('../cross-model-review-ipc', () => stubModule());
vi.mock('../../memory/token-stats-initialization', () => stubModule());
vi.mock('../../core/system/provider-quota', () => stubModule());
vi.mock('../../secrets/workspace-secret-fill', () => stubModule());
vi.mock('../../core/system/provider-quota-service', () => stubModule());
vi.mock('../../prompt-history/prompt-history-service', () => stubModule());
vi.mock('../ipc-main-runtime-wiring', () => stubModule());
vi.mock('../../event-bus/state-resync-ipc-handler', () => stubModule());
vi.mock('../../event-bus/state-sync-snapshot', () => stubModule());
vi.mock('../../event-bus/thin-client-command-executor', () => stubModule());
vi.mock('../../event-bus/thin-client-ws-server', () => stubModule());
vi.mock('../handlers', () => stubModule());
vi.mock('../handlers/loop-scorecard-handlers', () => stubModule());
vi.mock('../handlers/storage-handlers', () => stubModule());
vi.mock('../handlers/global-pause-handlers', () => stubModule());
vi.mock('../handlers/worktree-leftover-handlers', () => stubModule());
vi.mock('../../codemem/lsp-feedback-registration', () => stubModule());
vi.mock('../../security/circuit-breaker-registration', () => stubModule());
vi.mock('../../core/system/cost-tracker', () => stubModule());
vi.mock('../../rlm/rlm-storage-maintenance-runtime', () => stubModule());

import { IpcMainHandler } from '../ipc-main-handler';
import type { InstanceManager } from '../../instance/instance-manager';
import type { WindowManager } from '../../window-manager';

describe('IpcMainHandler.registerHandlers Phase 1 registrations', () => {
  const instanceManager = { getAllInstances: () => [], getAdapter: () => undefined } as unknown as InstanceManager;
  const windowManager = {} as unknown as WindowManager;

  beforeEach(() => {
    mocks.fns.clear();
    mocks.results.clear();
    // Collaborators whose return value registerHandlers() dereferences.
    mocks.results.set('getAutoTitleService', () => ({ setLiveTitleSource: stub('setLiveTitleSource') }));
    mocks.results.set('getProviderQuotaService', () => ({ startIdleRefresh: vi.fn() }));
    mocks.results.set('getPromptHistoryService', () => ({ pruneOnStart: vi.fn() }));
    mocks.results.set('getContextWorkerClient', () => ({}));
    mocks.results.set('getCostTracker', () => ({}));
  });

  it('registers the quick-ask handlers with the instance manager', () => {
    new IpcMainHandler(instanceManager, windowManager).registerHandlers();
    expect(stub('registerInstanceQuickAskHandlers')).toHaveBeenCalledTimes(1);
    expect(stub('registerInstanceQuickAskHandlers')).toHaveBeenCalledWith(instanceManager);
  });

  it('registers the plan-handoff handlers with the instance manager', () => {
    new IpcMainHandler(instanceManager, windowManager).registerHandlers();
    expect(stub('registerPlanHandoffHandlers')).toHaveBeenCalledTimes(1);
    expect(stub('registerPlanHandoffHandlers')).toHaveBeenCalledWith(instanceManager);
  });

  it('installs a live-title source that asks the resident session through requestLiveTitle', async () => {
    mocks.results.set('requestLiveTitle', () => Promise.resolve('Live title'));
    new IpcMainHandler(instanceManager, windowManager).registerHandlers();

    const setSource = stub('setLiveTitleSource');
    expect(setSource).toHaveBeenCalledTimes(1);
    const source = setSource.mock.calls[0][0] as (id: string, description: string) => Promise<string | null>;
    await expect(source('instance-1', 'describe the work')).resolves.toBe('Live title');
    expect(stub('requestLiveTitle')).toHaveBeenCalledWith(instanceManager, 'instance-1', 'describe the work');
  });

  it('completes registration (sanity check that the stubs reached the end of the method)', () => {
    new IpcMainHandler(instanceManager, windowManager).registerHandlers();
    expect(stub('bridgeCliUpdatePillDeltaToWindow')).toHaveBeenCalledWith(windowManager);
  });
});
