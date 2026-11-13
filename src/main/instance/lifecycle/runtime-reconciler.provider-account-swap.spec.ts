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
import { _resetInstanceProviderLimitHandlerForTesting, getInstanceProviderLimitHandler } from '../instance-provider-limit-handler';

const { continuity, queuedInput } = vi.hoisted(() => ({
  continuity: {
    updateState: vi.fn().mockResolvedValue(undefined),
    writeThroughIdentityLocked: vi.fn().mockResolvedValue(undefined),
    takeStoppedHelpers: vi.fn().mockResolvedValue(null),
  },
  queuedInput: { waiting: false },
}));
vi.mock('../../session/session-queue-service', () => ({
  getSessionQueueService: () => ({ hasQueuedMessages: () => queuedInput.waiting }),
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
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({ getPoolPolicy: () => DEFAULT_ACCOUNT_POOL_POLICY, getProfile: () => null }),
}));

function profile(provider: PooledProvider, id: string, priority = 0): ProviderAccountProfile {
  return {
    provider, id, label: id, priority, enabled: true, isLegacy: false,
    automationPolicy: 'allow-routed', expectedIdentity: null, expectedAccountKey: null,
    planLabel: null, createdAt: 1, updatedAt: 1,
    ...(provider === 'opencode' ? { region: 'ams' as const } : {}),
  };
}

function harness(
  overrides: Partial<Instance> = {},
  profiles = [profile('codex', 'example-codex')],
  settings: Partial<ReturnType<RuntimeReconcilerDeps['getSettings']>> = {},
) {
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
      restrictTo: instance.allowedAccountProfileIds, preferences: instance.accountPreferences, routingService: routing,
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
    holdContinuityUntilAnswered: vi.fn(),
    emitModelSelectionDegradation: vi.fn(), emitSystemNotice: vi.fn(),
    emitRuntimeChanged: vi.fn(), emitYoloToggled: vi.fn(),
    getSettings: () => ({ defaultCli: 'auto', ...settings } as ReturnType<RuntimeReconcilerDeps['getSettings']>),
    spawnConfigBuilder: {
      getMcpConfig: () => undefined, getChromeDevtoolsMcpOptions: () => undefined,
      getBrowserGatewayMcpOptions: () => undefined, getPermissionHookPath: () => undefined,
      getRtkSpawnConfig: () => undefined,
    } as unknown as RuntimeReconcilerDeps['spawnConfigBuilder'],
    queueUpdate: vi.fn(),
  } satisfies RuntimeReconcilerDeps;
  return { instance, reconciler: new RuntimeReconciler(deps), adapter, createRuntimeAdapter, routed, snapshot,
    emitSystemNotice: deps.emitSystemNotice, holdContinuity: deps.holdContinuityUntilAnswered };
}

beforeEach(() => {
  vi.clearAllMocks();
  queuedInput.waiting = false;
  _resetAdapterLoansForTesting();
});
afterEach(() => {
  _resetAdapterLoansForTesting();
  _resetInstanceProviderLimitHandlerForTesting();
});

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

  it('persists an account-only respawn handoff before reporting success', async () => {
    const h = harness({ provider: 'codex', status: 'idle', currentModel: 'gpt-6-sol', accountProfileId: 'example-codex' }, [
      profile('codex', 'example-codex'), profile('codex', 'example-codex-b', 1),
    ]);
    await h.reconciler.applyRuntimeChange(h.instance.id, {
      provider: 'codex', accountProfileId: 'example-codex-b', accountHandoffKind: 'explicit', accountHandoffConfirmed: true,
    });
    expect(h.routed[0]).toMatchObject({ resume: true, accountRoute: { profileId: 'example-codex-b' } });
    expect(h.snapshot).toMatchObject({ provider: 'codex', accountProfileId: 'example-codex-b', accountRoutingSource: 'persisted', accountSwitches: 3 });
    expect(continuity.writeThroughIdentityLocked).toHaveBeenLastCalledWith(h.instance.id, { sessionId: h.instance.sessionId });
  });

  it('does not persist a rejected account-only respawn handoff', async () => {
    const h = harness({ provider: 'codex', status: 'idle', currentModel: 'gpt-6-sol', accountProfileId: 'example-codex' }, [
      profile('codex', 'example-codex'), profile('codex', 'example-codex-b', 1),
    ]);
    h.createRuntimeAdapter.mockRejectedValueOnce(new Error('Example admission refusal'));
    await expect(h.reconciler.applyRuntimeChange(h.instance.id, {
      provider: 'codex', accountProfileId: 'example-codex-b', accountHandoffKind: 'explicit', accountHandoffConfirmed: true,
    })).rejects.toThrow('Example admission refusal');
    expect(h.instance.accountProfileId).toBe('example-codex');
    expect(h.snapshot.accountProfileId).toBe('example-codex');
    expect(continuity.updateState).not.toHaveBeenCalled();
  });

  it.each(['updateState', 'writeThroughIdentityLocked'] as const)(
    'publishes the actual respawned account and warns when %s fails', async failure => {
      const h = harness({ provider: 'codex', status: 'idle', currentModel: 'gpt-6-sol', accountProfileId: 'example-codex' }, [
        profile('codex', 'example-codex'), profile('codex', 'example-codex-b', 1),
      ]);
      continuity[failure].mockRejectedValueOnce(new Error('Example session storage failure'));
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, {
        provider: 'codex', accountProfileId: 'example-codex-b', accountHandoffKind: 'explicit', accountHandoffConfirmed: true,
      })).resolves.toBe(h.instance);
      expect(h.instance).toMatchObject({ accountProfileId: 'example-codex-b', status: 'idle' });
      expect(h.emitSystemNotice).toHaveBeenCalledWith(h.instance, expect.stringContaining('could not save'));
    },
  );

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

  describe('never-use and use-last lists', () => {
    const rules = { planQueueAccountRules: { never: [{ provider: 'codex' as const, accountId: 'example-codex' }], last: [] } };
    const codexPool = [profile('codex', 'example-codex'), profile('codex', 'example-codex-b', 1)];

    it('gives a session that carries lists the destination provider\'s lists, so it avoids its never-use account', async () => {
      const h = harness({ accountPreferences: { avoid: [], last: [] } }, codexPool, rules);
      await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-6-sol' });
      expect(h.instance.accountPreferences).toEqual({ avoid: ['example-codex'], last: [] });
      expect(h.instance.accountProfileId).toBe('example-codex-b');
      // Saved too, so a wake does not bring back the old provider's lists.
      expect(h.snapshot.accountPreferences).toEqual({ avoid: ['example-codex'], last: [] });
    });

    it('gives back the source provider\'s lists, from the rules as they are now, when the destination spawn fails', async () => {
      const current = { planQueueAccountRules: { ...rules.planQueueAccountRules,
        never: [...rules.planQueueAccountRules.never, { provider: 'opencode' as const, accountId: 'example-other-mimo' }] } };
      const h = harness({ accountPreferences: { avoid: [], last: [] } }, codexPool, current);
      vi.mocked(h.adapter.spawn).mockRejectedValue(new Error('Example spawn failure'));
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-6-sol' })).rejects.toThrow('Example spawn failure');
      expect(h.instance.accountPreferences).toEqual({ avoid: ['example-other-mimo'], last: [] });
      expect(h.snapshot.accountPreferences).toBeUndefined();
    });

    it('keeps a rule change made during a failed account-only switch', async () => {
      const h = harness({ provider: 'codex', status: 'idle', currentModel: 'gpt-6-sol', accountProfileId: 'example-codex',
        accountPreferences: { avoid: [], last: [] } }, codexPool, rules);
      const construct = h.createRuntimeAdapter.getMockImplementation();
      if (!construct) throw new Error('Missing adapter construction fixture');
      h.createRuntimeAdapter.mockImplementationOnce(async (cliType, options) => {
        h.instance.accountPreferences = { avoid: ['example-codex'], last: [] };
        await construct(cliType, options);
        throw new Error('Example construction failure');
      });
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, {
        provider: 'codex', model: 'gpt-6-sol', accountProfileId: 'example-codex-b', accountHandoffKind: 'failover',
      })).rejects.toThrow('Example construction failure');
      expect(h.instance.accountProfileId).toBe('example-codex');
      expect(h.instance.accountPreferences).toEqual({ avoid: ['example-codex'], last: [] });
    });

    it('leaves a session that carries no lists without them', async () => {
      const h = harness({}, codexPool, rules);
      await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-6-sol' });
      expect(h.instance.accountPreferences).toBeUndefined();
      expect(h.instance.accountProfileId).toBe('example-codex');
    });
  });
});

describe('the context-evidence mode follows the provider (LT-728)', () => {
  const evidenceSettings = { contextEvidenceModeByProvider: { codex: 'enforce', claude: 'off' } } as const;
  const enforcedCodex = (): Partial<Instance> => ({
    provider: 'codex', currentModel: 'gpt-6-sol', accountProfileId: 'example-codex',
    contextEvidence: { mode: 'enforce', conversationId: 'example-conversation', captureFailureCount: 0 },
  });

  it('drops the source provider\'s enforce mode when the destination has evidence off', async () => {
    const h = harness(enforcedCodex(), [profile('codex', 'example-codex')], evidenceSettings);
    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'opus' });
    expect(h.instance.provider).toBe('claude');
    expect(h.instance.contextEvidence).toEqual({ mode: 'off', captureFailureCount: 0 });
  });

  it('restores the source provider\'s evidence state when the destination spawn fails', async () => {
    const h = harness(enforcedCodex(), [profile('codex', 'example-codex')], evidenceSettings);
    const original = h.instance.contextEvidence;
    vi.mocked(h.adapter.spawn).mockRejectedValue(new Error('Example spawn failure'));
    await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'opus' }))
      .rejects.toThrow('Example spawn failure');
    expect(h.instance.provider).toBe('codex');
    expect(h.instance.contextEvidence).toBe(original);
  });
});

describe('a session parked on a provider limit', () => {
  const codexSession = { provider: 'codex', currentModel: 'gpt-6-sol', accountProfileId: 'example-codex' } as const;

  function parkOnLimit(h: ReturnType<typeof harness>, resumePrompt: string | null) {
    const cancelResume = vi.fn();
    const setWaitReason = vi.fn();
    const clearActive = vi.fn(() => 0);
    const resentOn: [string, string][] = [];
    const limits = getInstanceProviderLimitHandler();
    limits.configure({
      isEnabled: () => true,
      setWaitReason,
      resendInput: (_id, prompt) => { resentOn.push([h.instance.provider, prompt]); },
      getQuotaSnapshot: () => null,
      getWorkspaceCwd: () => h.instance.workingDirectory,
      getProviderModel: () => ({ provider: h.instance.provider, model: h.instance.currentModel ?? null }),
      providerLimitLedger: { record: vi.fn(), getActive: () => null, clearActive },
      scheduleResume: () => cancelResume,
    });
    expect(limits.maybePark({
      instanceId: h.instance.id, provider: h.instance.provider, model: h.instance.currentModel,
      resetAtHint: Date.now() + 3_600_000, reason: 'Example limit', resumePrompt,
    })).toBe('parked');
    setWaitReason.mockClear();
    return { limits, cancelResume, setWaitReason, clearActive, resentOn };
  }

  it('stops waiting once it moves to another provider', async () => {
    const h = harness(codexSession);
    const park = parkOnLimit(h, null);

    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'sonnet' });

    expect(h.instance.provider).toBe('claude');
    expect(park.limits.isParked(h.instance.id)).toBe(false);
    expect(park.setWaitReason).toHaveBeenCalledWith(h.instance.id, null);
    expect(park.cancelResume).toHaveBeenCalledOnce();
    expect(park.resentOn).toEqual([]);
  });

  it('keeps the old provider limit recorded for other sessions', async () => {
    const h = harness(codexSession);
    const park = parkOnLimit(h, null);

    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'sonnet' });

    expect(park.clearActive).not.toHaveBeenCalled();
  });

  it('sends the held turn on the new provider', async () => {
    const h = harness(codexSession);
    const park = parkOnLimit(h, 'Example held turn');

    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'sonnet' });

    expect(park.resentOn).toEqual([['claude', 'Example held turn']]);
  });

  it('carries the change with the held turn so the model only gets that request once', async () => {
    const h = harness(codexSession);
    const park = parkOnLimit(h, 'Example held turn');

    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'sonnet' });

    expect(h.adapter.sendInput).not.toHaveBeenCalled();
    expect(h.holdContinuity).toHaveBeenCalledWith(h.instance.id, expect.stringContaining('Example conversation continuity'), undefined);
    expect(h.holdContinuity).toHaveBeenCalledWith(h.instance.id, expect.stringContaining('Provider changed from codex'), undefined);
    expect(park.resentOn).toEqual([['claude', 'Example held turn']]);
  });

  it('carries the change with a queued message so the model only gets that request once', async () => {
    const h = harness(codexSession);
    parkOnLimit(h, null);
    queuedInput.waiting = true;

    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'sonnet' });

    expect(h.adapter.sendInput).not.toHaveBeenCalled();
    expect(h.holdContinuity).toHaveBeenCalledWith(h.instance.id, expect.stringContaining('Provider changed from codex'), undefined);
  });

  it('tells the model straight away when no turn is waiting', async () => {
    const h = harness(codexSession);
    parkOnLimit(h, null);

    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'sonnet' });

    expect(h.adapter.sendInput).toHaveBeenCalledWith(expect.stringContaining('Example conversation continuity'));
  });

  it('stops waiting once it moves to another account on the same provider', async () => {
    const h = harness(codexSession, [profile('codex', 'example-codex'), profile('codex', 'example-codex-two', 1)]);
    const park = parkOnLimit(h, null);

    await h.reconciler.applyRuntimeChange(h.instance.id, {
      provider: 'codex', accountProfileId: 'example-codex-two',
      accountHandoffKind: 'explicit', accountHandoffConfirmed: true,
    });

    expect(h.instance.accountProfileId).toBe('example-codex-two');
    expect(park.limits.isParked(h.instance.id)).toBe(false);
  });

  it('keeps waiting when only the model changes', async () => {
    const h = harness(codexSession);
    const park = parkOnLimit(h, 'Example held turn');

    await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-6-astra' });

    expect(h.instance.currentModel).toBe('gpt-6-astra');
    expect(park.limits.isParked(h.instance.id)).toBe(true);
    expect(park.resentOn).toEqual([]);
  });

  it('keeps waiting when the switch fails', async () => {
    const h = harness(codexSession);
    const park = parkOnLimit(h, 'Example held turn');
    vi.mocked(h.adapter.spawn).mockRejectedValue(new Error('Example spawn failure'));

    await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'sonnet' }))
      .rejects.toThrow('Example spawn failure');

    expect(h.instance.provider).toBe('codex');
    expect(park.limits.isParked(h.instance.id)).toBe(true);
    expect(park.cancelResume).not.toHaveBeenCalled();
    expect(park.resentOn).toEqual([]);
  });
});
