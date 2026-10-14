import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter, UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory';
import type { Instance } from '../../../shared/types/instance.types';
import type { PooledProvider, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { DEFAULT_ACCOUNT_POOL_POLICY } from '../../../shared/types/provider-account.types';
import type { ProviderAccountStore } from '../../providers/account-pool/provider-account-store';
import type { ProviderAccountBindingService } from '../../providers/account-pool/provider-account-binding-service';
import { ProviderAccountRoutingService } from '../../providers/account-pool/provider-account-routing-service';
import { RuntimeReconciler } from './runtime-reconciler';
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';
import { attachAccountRoute, persistedAccountProfileId, stampAccountRouteOnInstance } from './account-route-preflight';
import { _resetAdapterLoansForTesting } from './adapter-loan-registry';

const { continuity } = vi.hoisted(() => ({
  continuity: {
    updateState: vi.fn().mockResolvedValue(undefined),
    writeThroughIdentityLocked: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../session/session-continuity', () => ({
  getSessionContinuityManager: () => continuity,
  getSessionContinuityManagerIfInitialized: () => continuity,
}));
vi.mock('./model-change-provider-swap', async (original) => ({
  ...await original<typeof import('./model-change-provider-swap')>(),
  assertSwapTargetCliAvailable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./create-validation-helpers', () => ({
  getKnownModelsForCli: async () => ['gpt-6-sol', 'gpt-6-astra', 'sonnet', 'xiaomi-token-plan-ams/mimo-v2.6-pro'],
}));

function profile(provider: PooledProvider, id: string, priority = 0): ProviderAccountProfile {
  return {
    provider, id, label: id, priority, enabled: true, isLegacy: false,
    automationPolicy: 'allow-routed', expectedIdentity: null, expectedAccountKey: null,
    planLabel: null, createdAt: 1, updatedAt: 1,
    ...(provider === 'opencode' ? { region: 'ams' as const } : {}),
  };
}

function harness(overrides: Partial<Instance> = {}, profiles = [profile('codex', 'example-codex')]) {
  const instance = {
    id: 'example-instance', status: 'error', provider: 'opencode',
    currentModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
    accountProfileId: 'example-mimo', accountRoutingSource: 'persisted', accountSwitches: 2,
    accountRouteOrigin: 'interactive', sessionId: 'example-old-session',
    workingDirectory: '/tmp/aio-example', executionLocation: { type: 'local' },
    yoloMode: false, contextUsage: { used: 0, total: 200000, percentage: 0 },
    outputBuffer: [{ type: 'user', content: 'Example request' }],
    ...overrides,
  } as Instance;
  const routing = new ProviderAccountRoutingService({
    store: {
      listProfiles: (provider: PooledProvider) => profiles.filter(p => p.provider === provider),
      getPoolPolicy: () => DEFAULT_ACCOUNT_POOL_POLICY,
    } as unknown as ProviderAccountStore,
    bindingService: {
      checkBinding: async (p: ProviderAccountProfile, nodeId: string) => ({
        provider: p.provider, profileId: p.id, nodeId, state: 'authenticated', checkedAt: 1,
      }),
    } as unknown as ProviderAccountBindingService,
  });
  const adapter = Object.assign(new EventEmitter(), {
    spawn: vi.fn().mockResolvedValue(42), terminate: vi.fn().mockResolvedValue(undefined),
    sendInput: vi.fn().mockResolvedValue(undefined), queueNextPromptContext: vi.fn(),
  }) as unknown as CliAdapter;
  let active: CliAdapter | undefined;
  const routed: UnifiedSpawnOptions[] = [];
  const snapshot: Partial<Instance> = {
    provider: instance.provider, accountProfileId: instance.accountProfileId,
    accountRoutingSource: instance.accountRoutingSource, accountSwitches: instance.accountSwitches,
  };
  continuity.updateState.mockImplementation(async (_id, update) => { Object.assign(snapshot, update); });
  const createRuntimeAdapter = vi.fn(async (cliType, options: UnifiedSpawnOptions) => {
    // Keep the executing lifecycle's account preflight and stamping real.
    const resolved = await attachAccountRoute(cliType, options, instance.accountRouteOrigin ?? 'interactive', {
      persistedProfileId: persistedAccountProfileId(instance, options.resume),
      restrictTo: instance.allowedAccountProfileIds, routingService: routing,
    });
    stampAccountRouteOnInstance(instance, resolved);
    routed.push(resolved);
    return adapter;
  });
  const deps = {
    getInstance: () => instance, getAdapter: () => active,
    setAdapter: (_id, next) => { active = next; },
    deleteAdapter: () => { active = undefined; return true; }, setupAdapterEvents: vi.fn(),
    transitionState: (inst, status) => { inst.status = status; },
    resolveCliTypeForInstance: async inst => inst.provider as 'codex',
    getAdapterRuntimeCapabilities: () => ({ supportsResume: true, supportsForkSession: false }),
    assertLocalModelRuntimeAvailable: vi.fn(), residentClaudeForSpawn: () => false,
    createRuntimeAdapter, evaluateResumeHealth: async () => 'healthy',
    waitForInputReadinessBoundary: vi.fn().mockResolvedValue(undefined), prepareStatusForAdapterInput: vi.fn(),
    buildReplayContinuityMessage: () => 'Example conversation continuity',
    buildFallbackHistory: async () => 'Example fallback continuity',
    emitModelSelectionDegradation: vi.fn(), emitSystemNotice: vi.fn(),
    emitRuntimeChanged: vi.fn(), emitYoloToggled: vi.fn(),
    getSettings: () => ({ defaultCli: 'auto' } as ReturnType<RuntimeReconcilerDeps['getSettings']>),
    spawnConfigBuilder: {
      getMcpConfig: () => undefined, getChromeDevtoolsMcpOptions: () => undefined,
      getBrowserGatewayMcpOptions: () => undefined, getPermissionHookPath: () => undefined,
      getRtkSpawnConfig: () => undefined,
    } as unknown as RuntimeReconcilerDeps['spawnConfigBuilder'],
    queueUpdate: vi.fn(),
  } satisfies RuntimeReconcilerDeps;
  return { instance, reconciler: new RuntimeReconciler(deps), adapter, createRuntimeAdapter, routed, snapshot };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAdapterLoansForTesting();
});
afterEach(() => _resetAdapterLoansForTesting());

describe('provider swaps scope account profiles to the destination', () => {
  it('switches a failed MiMo session to Codex and persists the selected Codex account', async () => {
    const h = harness();
    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-6-sol' });
    expect(h.instance).toMatchObject({ provider: 'codex', status: 'idle', accountProfileId: 'example-codex', accountRoutingSource: 'default' });
    expect(h.routed[0]).toMatchObject({ resume: false, accountRoute: { provider: 'codex', profileId: 'example-codex', source: 'default' } });
    expect(h.snapshot).toMatchObject({ provider: 'codex', accountProfileId: 'example-codex', accountRoutingSource: 'default' });
    expect(h.instance.accountSwitches).toBeUndefined();
    expect(h.snapshot.accountSwitches).toBeUndefined();
    expect(h.adapter.sendInput).toHaveBeenCalledWith(expect.stringContaining('Example conversation continuity'));
  });

  it('does not pin a colliding source ID in the destination pool', async () => {
    const h = harness({}, [profile('codex', 'example-codex'), profile('codex', 'example-mimo', 1)]);
    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-6-sol' });
    expect(h.instance.accountProfileId).toBe('example-codex');
  });

  it.each(['gemini', 'codex'] as const)('clears source account metadata for a %s destination without a pool', async provider => {
    const h = harness({}, []);
    await h.reconciler.applyRuntimeChange(h.instance.id, { provider });
    expect(h.instance.provider).toBe(provider);
    for (const state of [h.instance, h.snapshot]) {
      expect(state.accountProfileId).toBeUndefined();
      expect(state.accountRoutingSource).toBeUndefined();
      expect(state.accountSwitches).toBeUndefined();
    }
  });

  it('restores the complete source stamp when destination spawn fails after routing', async () => {
    const h = harness();
    vi.mocked(h.adapter.spawn).mockRejectedValue(new Error('Example spawn failure'));
    await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-6-sol' })).rejects.toThrow('Example spawn failure');
    expect(h.routed[0].accountRoute?.profileId).toBe('example-codex');
    expect(h.instance).toMatchObject({ provider: 'opencode', status: 'error', accountProfileId: 'example-mimo', accountRoutingSource: 'persisted', accountSwitches: 2 });
    expect(h.snapshot).toMatchObject({ provider: 'opencode', accountProfileId: 'example-mimo' });
  });

  it('restores the source stamp when construction fails after destination routing', async () => {
    const h = harness();
    const construct = h.createRuntimeAdapter.getMockImplementation();
    if (!construct) throw new Error('Missing adapter construction fixture');
    h.createRuntimeAdapter.mockImplementationOnce(async (cliType, options) => {
      await construct(cliType, options);
      throw new Error('Example construction failure');
    });
    await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-6-sol' })).rejects.toThrow('Example construction failure');
    expect(h.instance).toMatchObject({ provider: 'opencode', status: 'error', accountProfileId: 'example-mimo', accountRoutingSource: 'persisted', accountSwitches: 2 });
    expect(h.snapshot.provider).toBe('opencode');
  });

  it('selects a MiMo account when switching back from Codex', async () => {
    const h = harness({ provider: 'codex', accountProfileId: 'example-codex', currentModel: 'gpt-6-sol' }, [profile('opencode', 'example-mimo')]);
    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'opencode', model: 'xiaomi-token-plan-ams/mimo-v2.6-pro' });
    expect(h.instance).toMatchObject({ provider: 'opencode', status: 'idle', accountProfileId: 'example-mimo', accountRoutingSource: 'default' });
    expect(h.snapshot).toMatchObject({ provider: 'opencode', accountProfileId: 'example-mimo' });
    expect(h.routed[0].resume).toBe(false);
  });

  it('keeps a same-provider model change pinned to its existing account', async () => {
    const h = harness({ provider: 'codex', status: 'idle', currentModel: 'gpt-6-sol', accountProfileId: 'example-codex-b' }, [
      profile('codex', 'example-codex'), profile('codex', 'example-codex-b', 1),
    ]);
    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-6-astra' });
    expect(h.routed[0]).toMatchObject({ resume: true, accountRoute: { profileId: 'example-codex-b', source: 'persisted' } });
    expect(h.instance.accountSwitches).toBe(2);
  });

  it('enforces the existing account fence after switching providers', async () => {
    const h = harness({ allowedAccountProfileIds: ['example-mimo'] });
    await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-6-sol' })).rejects.toMatchObject({ code: 'no-profiles' });
    expect(h.instance).toMatchObject({ provider: 'opencode', accountProfileId: 'example-mimo', allowedAccountProfileIds: ['example-mimo'] });
  });

  it('retains automation policy when selecting the destination account', async () => {
    const h = harness({ accountRouteOrigin: 'automation' }, [{ ...profile('codex', 'example-codex'), automationPolicy: 'manual-only' }]);
    await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-6-sol' })).rejects.toMatchObject({ code: 'automation-disallowed' });
    expect(h.instance.accountRouteOrigin).toBe('automation');
    expect(h.instance.accountProfileId).toBe('example-mimo');
  });
});
