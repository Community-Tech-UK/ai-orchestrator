import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter, UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory';
import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
import type { CopilotRouteOutcome } from '../../../shared/types/copilot-account.types';
import type { CopilotRouteRequest } from '../../providers/copilot/copilot-account-routing-service';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings-defaults';
import { DesiredRuntimeQueue } from './desired-runtime-queue';
import { RuntimeReconciler } from './runtime-reconciler';
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';
import { _resetAdapterLoansForTesting } from './adapter-loan-registry';

const pool = vi.hoisted(() => ({ continuation: 'replay' as 'replay' | 'shared-store' }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../session/session-continuity', () => ({
  getSessionContinuityManager: () => ({ writeThroughIdentityLocked: vi.fn(), updateState: vi.fn() }),
  getSessionContinuityManagerIfInitialized: () => undefined,
}));
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({ getPoolPolicy: () => ({ continuation: pool.continuation }),
    getProfile: (_provider: string, id: string) => ({ id, label: id }) }),
}));
vi.mock('../../providers/copilot/copilot-account-routing-service', () => ({
  getCopilotAccountRoutingService: () => ({
    resolveRouteForSpawn: async (request: CopilotRouteRequest): Promise<CopilotRouteOutcome> => ({
      ok: true,
      route: { profileId: request.persistedProfileId ?? 'seat-a', source: 'persisted',
        executionNodeId: request.executionNodeId ?? 'local' },
    }),
  }),
}));

function harness(provider: 'claude' | 'codex' | 'copilot', enable: boolean, deferred = false) {
  const instance = {
    id: 'combined-account-permission', provider, status: deferred ? 'busy' : 'idle',
    sessionId: 'original-native-session', accountProfileId: 'account-a', copilotAccountProfileId: 'seat-a',
    workingDirectory: '/tmp/combined-account-permission-fixture', yoloMode: !enable, executionLocation: { type: 'local' },
    contextUsage: { used: 230_000, total: 1_000_000, percentage: 23 },
    outputBuffer: [{ id: 'user', type: 'user', content: 'Continue the task', timestamp: 1 }],
  } as Instance;
  const adapter = Object.assign(new EventEmitter(), {
    spawn: vi.fn().mockResolvedValue(42), terminate: vi.fn().mockResolvedValue(undefined),
    sendInput: vi.fn().mockResolvedValue(undefined), queueNextPromptContext: vi.fn(),
  }) as unknown as CliAdapter;
  const createRuntimeAdapter = vi.fn(async (_cliType: string, _options: UnifiedSpawnOptions) => adapter);
  const emitRuntimeChanged = vi.fn();
  const emitSystemNotice = vi.fn();
  const reconciler = new RuntimeReconciler({
    getInstance: () => instance, getAdapter: () => adapter, setAdapter: vi.fn(), deleteAdapter: vi.fn(),
    setupAdapterEvents: vi.fn(), transitionState: (target: Instance, status: Instance['status']) => { target.status = status; },
    resolveCliTypeForInstance: async () => provider,
    getAdapterRuntimeCapabilities: () => ({ supportsResume: true, supportsForkSession: true }),
    assertLocalModelRuntimeAvailable: vi.fn(), residentClaudeForSpawn: () => false, createRuntimeAdapter,
    evaluateResumeHealth: async () => 'healthy', waitForInputReadinessBoundary: vi.fn(), prepareStatusForAdapterInput: vi.fn(),
    buildReplayContinuityMessage: () => 'carried replay context', buildFallbackHistory: async () => 'fallback context',
    holdContinuityUntilAnswered: vi.fn(), emitModelSelectionDegradation: vi.fn(), emitSystemNotice,
    emitRuntimeChanged, emitYoloToggled: vi.fn(), getSettings: () => DEFAULT_SETTINGS,
    spawnConfigBuilder: { getMcpConfig: () => [], getChromeDevtoolsMcpOptions: () => null,
      getBrowserGatewayMcpOptions: () => null, getPermissionHookPath: () => undefined, getRtkSpawnConfig: () => undefined },
    queueUpdate: vi.fn(),
  } as unknown as RuntimeReconcilerDeps);
  const queue = new DesiredRuntimeQueue({
    getInstance: () => instance, isAdapterOnLoan: () => false,
    applyChange: (id, desired) => reconciler.applyRuntimeChange(id, desired),
    publishPendingState: vi.fn(), notifyApplyFailure: vi.fn(),
  });
  instance.desiredRuntime = provider === 'copilot'
    ? { provider, copilotAccountProfileId: 'seat-b', copilotAccountHandoffConfirmed: true }
    : { provider, accountProfileId: 'account-b', accountHandoffConfirmed: true };
  return { instance, queue, adapter, createRuntimeAdapter, emitSystemNotice, emitRuntimeChanged };
}

describe('queued account handoff combined with a permission flip', () => {
  beforeEach(() => { pool.continuation = 'replay'; _resetAdapterLoansForTesting(); });

  it.each(['claude', 'codex', 'copilot'] as const)(
    'preserves %s account policy through the actual desired-runtime queue', async provider => {
      for (const enable of [true, false]) {
        const h = harness(provider, enable);
        // requestYoloModeToggle preserves this exact queued handoff while flipping the live permission choice.
        await h.queue.requestChange(h.instance.id, { ...h.instance.desiredRuntime, provider, yoloMode: enable });
        expect(h.createRuntimeAdapter).toHaveBeenCalledOnce();
        expect(h.createRuntimeAdapter.mock.calls[0][1]).toMatchObject({ resume: false, forkSession: false, yoloMode: enable });
        if (provider === 'copilot') {
          expect(h.createRuntimeAdapter.mock.calls[0][1].copilotAccountRoute).toMatchObject({ profileId: 'seat-b' });
        }
        expect(h.adapter.sendInput).toHaveBeenCalledWith(expect.stringContaining('carried replay context'));
        expect(h.emitRuntimeChanged).toHaveBeenCalledOnce();
        expect(h.emitSystemNotice).toHaveBeenCalledWith(h.instance, expect.any(String),
          { kind: provider === 'copilot' ? 'copilot-account-changed' : 'account-changed' });
      }
    },
  );

  it('keeps the combined confirmed account request intact while queued until idle', async () => {
    const h = harness('claude', true, true);
    const pending = h.queue.requestChange(h.instance.id, { ...h.instance.desiredRuntime, provider: 'claude', yoloMode: true });
    expect(h.instance.desiredRuntime).toMatchObject({ accountProfileId: 'account-b', accountHandoffConfirmed: true, yoloMode: true });
    expect(h.createRuntimeAdapter).not.toHaveBeenCalled();
    h.instance.status = 'idle';
    h.queue.onSettled(h.instance);
    await pending;
    expect(h.createRuntimeAdapter.mock.calls[0][1]).toMatchObject({ resume: false, forkSession: false });
    expect(h.instance.desiredRuntime).toBeUndefined();
  });

  it('keeps native continuation for a shared-store account with a permission flip', async () => {
    pool.continuation = 'shared-store';
    const h = harness('claude', true);
    await h.queue.requestChange(h.instance.id, { ...h.instance.desiredRuntime, provider: 'claude', yoloMode: true } as DesiredRuntime);
    expect(h.createRuntimeAdapter.mock.calls[0][1]).toMatchObject({ resume: true, forkSession: true, sessionId: 'original-native-session' });
    expect(h.emitRuntimeChanged).toHaveBeenCalledOnce();
  });
});
