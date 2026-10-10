import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import { RemoteCliAdapter } from '../../cli/adapters/remote-cli-adapter';
import { TestAcpCliAdapter, createInitializedAgentHarness, type FakeAcpProcess } from '../../cli/adapters/acp-cli-adapter.test-helpers';
import { InstanceStateMachine } from '../../instance/instance-state-machine';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import { InstanceSpawnParamsSchema } from '../../remote-node/rpc-schemas';
import { RuntimeReconciler } from '../../instance/lifecycle/runtime-reconciler';
import type { RuntimeReconcilerDeps } from '../../instance/lifecycle/runtime-reconciler.types';
import { attachAccountRoute, stampAccountRouteOnInstance } from '../../instance/lifecycle/account-route-preflight';
import { materializeWorkerAccountRoute } from '../../../worker-agent/worker-account-route';
import type { Instance } from '../../../shared/types/instance.types';
import { defaultProviderAccountPools, type PooledProvider, type ProviderAccountPoolPolicy, type ProviderAccountProfile, type ResolvedAccountRoute } from '../../../shared/types/provider-account.types';
import { AccountFailoverCoordinator, type AccountFailoverParams } from './account-failover-coordinator';
import { ProviderAccountBindingService } from './provider-account-binding-service';
import { ProviderAccountRoutingService, _resetProviderAccountRoutingServiceForTesting } from './provider-account-routing-service';
import { ProviderAccountStore, _resetProviderAccountStoreForTesting } from './provider-account-store';
import { _setProviderAccountEventSinkForTesting, type ProviderAccountEvent } from './provider-account-events';
import type { AccountQuotaEvidence } from './provider-account-selector';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const EMPTY_AUTH_LIST = '┌  Credentials\n└  0 credentials\n';
const WORKER_AUTH_LIST = '┌  Credentials\n●  aio-mimo-worker-only-b api\n└  1 credentials\n';
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  _setProviderAccountEventSinkForTesting(null);
  _resetProviderAccountStoreForTesting();
  _resetProviderAccountRoutingServiceForTesting();
});

/**
 * Exercises the runtime boundary rather than accepting an injected "apply"
 * success: coordinator -> real reconciler -> route preflight -> remote adapter
 * -> RPC schema -> worker materialization -> real node-local binding parser.
 * Only the network and CLI/file reads are synthetic; they contain no keys.
 */
async function harness(options: {
  provider?: PooledProvider;
  remote?: boolean;
  cacheNegative?: boolean;
  controllerAuthenticated?: boolean;
  live?: boolean;
  policy?: Partial<ProviderAccountPoolPolicy>;
} = {}) {
  const provider = options.provider ?? 'opencode';
  const model = provider === 'opencode' ? 'xiaomi-token-plan-ams/mimo-v2.6-pro'
    : provider === 'claude' ? 'sonnet' : 'gpt-5.4';
  const profiles: ProviderAccountProfile[] = ['legacy', 'worker-only-b'].map((id, priority) => ({
    id, provider, label: id, priority, expectedIdentity: null, expectedAccountKey: null,
    planLabel: null, enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy',
    ...(provider === 'opencode' ? { region: 'ams' as const } : {}), createdAt: 1, updatedAt: 1,
  }));
  const pools = defaultProviderAccountPools();
  pools[provider] = {
    ...pools[provider], failoverMode: 'automatic', acknowledgedOwnershipAt: 1,
    switchCooldownMs: 300_000, maxSwitchesPerTurn: 1,
    preemptive: { newSessions: true, liveSessionsAtTurnBoundary: true, thresholdPct: 90 },
    ...options.policy,
  };
  const store = new ProviderAccountStore({ read: () => ({ profiles, pools }) });
  _resetProviderAccountStoreForTesting(store);
  const state = {
    controllerReads: 0, workerReads: 0, workerAuthenticated: true, workerUnavailable: false,
    controllerAuthenticated: options.controllerAuthenticated ?? false, controllerUnavailable: false,
    refreshed: [] as string[],
    quota: { legacy: { allowancePct: 95 }, 'worker-only-b': { allowancePct: 10 } } as Record<string, AccountQuotaEvidence>,
    events: [] as ProviderAccountEvent[], notifications: [] as Array<{ kind: string }>,
    notices: [] as string[], runtimeChanged: 0,
    requests: [] as Array<{ nodeId: string; method: string; params: unknown }>,
    routes: [] as ResolvedAccountRoute[], adapters: [] as RemoteCliAdapter[],
    localProcesses: [] as FakeAcpProcess[],
    onRefresh: async (_id: string): Promise<void> => undefined,
    adapter: undefined as CliAdapter | undefined,
    nativeModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
  };
  _setProviderAccountEventSinkForTesting((event) => state.events.push(event));
  const bindings = (workerNode: boolean) => {
    const read = () => {
      if (workerNode) state.workerReads++; else state.controllerReads++;
      return workerNode ? state.workerAuthenticated : state.controllerAuthenticated;
    };
    return new ProviderAccountBindingService({
      resolveHome: () => ({ kind: 'derived', home: '/synthetic/account-profile' }),
      readOpenCodeAuthList: async () => {
        const authenticated = read();
        return (workerNode ? state.workerUnavailable : state.controllerUnavailable) ? null : authenticated ? WORKER_AUTH_LIST : EMPTY_AUTH_LIST;
      },
      readCodexAuthHead: async () => read() ? '{"auth_mode":"chatgpt"}' : null,
      runClaudeAuthStatus: async () => ({
        exitCode: 0, timedOut: false,
        stdout: JSON.stringify({ loggedIn: read(), authMethod: 'claude.ai', configDirectory: '/synthetic/account-profile' }),
      }),
    });
  };
  const controllerBindings = bindings(false);
  const workerBindings = bindings(true);
  if (options.cacheNegative ?? true) await controllerBindings.checkBinding(profiles[1]);
  const routing = new ProviderAccountRoutingService({ store, bindingService: controllerBindings,
    getParkedProfileIds: () => ['legacy'] });
  _resetProviderAccountRoutingServiceForTesting(routing);
  const instance = {
    id: 'remote-mimo', provider, currentModel: model, accountProfileId: 'legacy',
    accountRoutingSource: 'persisted', accountSwitches: 2, status: 'idle', sessionId: 'existing-session',
    yoloMode: false, workingDirectory: '/synthetic/worker/project',
    executionLocation: (options.remote ?? true) ? { type: 'remote', nodeId: 'windows-pc' } : { type: 'local' },
    outputBuffer: [{ type: 'user', content: 'original task' }],
    contextUsage: { used: 0, total: 200000, percentage: 0 },
  } as Instance;
  const connection = { sendRpc: async (nodeId: string, method: string, params: unknown) => {
    state.requests.push({ nodeId, method, params });
    if (method === 'instance.spawn') {
      const parsed = InstanceSpawnParamsSchema.parse(params);
      if (!parsed.accountRoute) throw new Error('Missing worker account route');
      const route = await materializeWorkerAccountRoute(parsed.cliType, parsed.accountRoute,
        (profile, node) => workerBindings.checkBinding(profile, node, { force: true }));
      state.routes.push(route);
      return { instanceId: parsed.instanceId };
    }
    return {};
  } } as unknown as WorkerNodeConnectionServer;
  const stateMachine = new InstanceStateMachine(instance.status);
  const reconciler = new RuntimeReconciler({
    getInstance: () => instance, getAdapter: () => state.adapter,
    setAdapter: (_id, adapter) => { state.adapter = adapter; },
    deleteAdapter: () => { state.adapter = undefined; return true; },
    setupAdapterEvents: () => undefined,
    transitionState: (inst, status) => { stateMachine.transition(status); inst.status = stateMachine.current; },
    resolveCliTypeForInstance: async () => provider,
    getAdapterRuntimeCapabilities: () => ({ supportsResume: false, supportsForkSession: false }),
    assertLocalModelRuntimeAvailable: async () => undefined, residentClaudeForSpawn: () => false,
    createRuntimeAdapter: async (cliType, spawnOptions, location) => {
      const routed = await attachAccountRoute(cliType, spawnOptions, 'interactive', {
        persistedProfileId: instance.accountProfileId,
        executionNodeId: location?.type === 'remote' ? location.nodeId : undefined,
        routingService: routing,
      });
      stampAccountRouteOnInstance(instance, routed);
      if (location?.type === 'local') {
        const proc = createInitializedAgentHarness();
        const accountModel = 'aio-mimo-worker-only-b/mimo-v2.6-pro';
        proc.onRequest('session/new', (request) => proc.respond(request.id, {
          sessionId: 'local-recovered-session', configOptions: [
            { id: 'model', category: 'model', currentValue: accountModel, options: [{ value: accountModel }] },
          ],
        }));
        proc.onRequest('session/prompt', (request) => proc.respond(request.id, { stopReason: 'end_turn' }));
        state.localProcesses.push(proc);
        return new TestAcpCliAdapter(proc, {
          workingDirectory: instance.workingDirectory,
          sessionConfig: { model: accountModel }, requireSessionModelConfirmation: true,
        });
      }
      const adapter = new RemoteCliAdapter(connection, 'windows-pc', cliType, routed);
      state.adapters.push(adapter);
      return adapter;
    },
    evaluateResumeHealth: async () => 'healthy', waitForInputReadinessBoundary: async () => undefined,
    prepareStatusForAdapterInput: () => undefined,
    buildReplayContinuityMessage: () => 'synthetic history', buildFallbackHistory: async () => 'synthetic history',
    emitModelSelectionDegradation: () => undefined,
    emitSystemNotice: (_instance, content) => { state.notices.push(content); },
    emitRuntimeChanged: () => { state.runtimeChanged++; }, emitYoloToggled: () => undefined,
    getSettings: () => ({ defaultCli: provider }) as ReturnType<RuntimeReconcilerDeps['getSettings']>,
    spawnConfigBuilder: {
      getMcpConfig: () => undefined, getChromeDevtoolsMcpOptions: () => undefined,
      getBrowserGatewayMcpOptions: () => undefined, getPermissionHookPath: () => undefined, getRtkSpawnConfig: () => undefined,
    } as unknown as RuntimeReconcilerDeps['spawnConfigBuilder'],
    queueUpdate: () => undefined,
  });
  const coordinator = new AccountFailoverCoordinator({ store: () => store, bindings: () => controllerBindings,
    getParkedProfileIds: () => ['legacy'], getQuotaEvidence: (_provider, id) => state.quota[id] ?? null,
    refreshQuotaEvidence: async (_provider, id) => { state.refreshed.push(id); await state.onRefresh(id); },
    getInstance: () => instance, applyRuntimeChange: (id, desired) => reconciler.applyRuntimeChange(id, desired),
    resendInput: (_id, prompt) => state.adapter!.sendInput(prompt), notify: (input) => state.notifications.push(input),
    sleep: async () => undefined,
  });
  const request: AccountFailoverParams = { instanceId: instance.id, provider, model, exhaustedProfileId: 'legacy',
    resumeAt: null, resumePrompt: 'Continue original task', reason: 'limit' };
  if (options.live) {
    const proc = createInitializedAgentHarness();
    const configOptions = () => [{ id: 'model', category: 'model', currentValue: state.nativeModel,
      options: [{ value: 'xiaomi-token-plan-ams/mimo-v2.6-pro' }, { value: 'aio-mimo-worker-only-b/mimo-v2.6-pro' }] }];
    proc.onRequest('session/new', (request) => proc.respond(request.id, { sessionId: 'existing-session', configOptions: configOptions() }));
    proc.onRequest('session/set_config_option', (request) => {
      state.nativeModel = (request.params as { value: string }).value;
      proc.respond(request.id, { configOptions: configOptions() });
    });
    proc.onRequest('session/prompt', (request) => proc.respond(request.id, { stopReason: 'end_turn' }));
    state.localProcesses.push(proc);
    state.adapter = new TestAcpCliAdapter(proc, { workingDirectory: instance.workingDirectory });
    await state.adapter.spawn();
  }
  cleanups.push(() => state.adapters.forEach((adapter) => adapter.forceCleanup()));
  cleanups.push(() => state.localProcesses.forEach((proc) => proc.exit()));
  return { state, instance, coordinator, request, profiles, reconciler, controllerBindings };
}

describe('AccountFailoverCoordinator worker credential admission', () => {
  it.each([
    ['failover', 'unauthenticated'], ['failover', 'unavailable'],
    ['preemptive', 'unauthenticated'], ['preemptive', 'unavailable'],
  ] as const)('preserves a running local session when %s fresh admission is %s and retries on sign-in', async (handoffKind, failure) => {
    const h = await harness({ remote: false, live: true, cacheNegative: false, controllerAuthenticated: true });
    const previousAdapter = h.state.adapter!;
    const terminate = vi.spyOn(previousAdapter, 'terminate');
    const request = { ...h.request, handoffKind };
    h.state.onRefresh = async () => {
      h.state.controllerAuthenticated = false;
      h.state.controllerUnavailable = failure === 'unavailable';
      // Keep the authenticated cache warm: the actual live guard must force
      // current executing-node evidence instead of trusting the selector.
    };
    expect(await h.coordinator.perform(request)).toMatchObject({ outcome: 'not-switched', reason: 'apply-failed' });
    expect(h.state.controllerReads).toBe(2);
    expect(h.instance).toMatchObject({ accountProfileId: 'legacy', accountRoutingSource: 'persisted',
      accountSwitches: 2, status: 'idle', sessionId: 'existing-session' });
    expect(h.state.adapter).toBe(previousAdapter);
    expect(terminate).not.toHaveBeenCalled();
    expect(h.state.nativeModel).toBe('xiaomi-token-plan-ams/mimo-v2.6-pro');
    expect(h.state.localProcesses).toHaveLength(1);
    expect(h.state.localProcesses[0].receivedMessages.filter((message) => 'method' in message
      && ['session/set_config_option', 'session/cancel', 'session/prompt'].includes(message.method))).toEqual([]);
    expect(h.state.requests).toEqual([]);
    expect(h.state.routes).toEqual([]);
    expect(h.state.notifications).toEqual([]);
    expect(h.state.notices).toEqual([]);
    expect(h.state.runtimeChanged).toBe(0);
    expect(h.state.events.filter((event) => event.event === 'account_failover_performed')).toEqual([]);
    h.state.controllerAuthenticated = true;
    h.state.controllerUnavailable = false;
    h.controllerBindings.invalidate();
    h.state.onRefresh = async () => undefined;
    expect(h.coordinator.plan(request)).toEqual({ kind: 'switch' });
    expect(await h.coordinator.perform(request)).toMatchObject({ outcome: 'switched', continuity: 'native-resume' });
    expect(h.instance).toMatchObject({ accountProfileId: 'worker-only-b', accountSwitches: 3, status: 'idle' });
    expect(h.state.adapter).toBe(previousAdapter);
    expect(terminate).not.toHaveBeenCalled();
    expect(h.state.localProcesses).toHaveLength(1);
    expect(h.state.nativeModel).toBe('aio-mimo-worker-only-b/mimo-v2.6-pro');
    await h.state.localProcesses[0].waitForMessage((message) => 'method' in message && message.method === 'session/prompt');
    const prompts = h.state.localProcesses[0].receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt');
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain('Account switched');
    expect(JSON.stringify(prompts[0])).toContain('Continue original task');
    expect(h.state.notices).toHaveLength(1);
    expect(h.state.runtimeChanged).toBe(1);
    expect(h.state.events.filter((event) => event.event === 'account_failover_performed')).toHaveLength(1);
  });

  it.each(['unauthenticated', 'unavailable'] as const)('refuses an explicit %s local live switch before cancellation or teardown', async (failure) => {
    const h = await harness({ remote: false, live: true, cacheNegative: false, controllerAuthenticated: true });
    expect(await h.controllerBindings.checkBinding(h.profiles[1])).toMatchObject({ state: 'authenticated' });
    h.state.controllerAuthenticated = false;
    h.state.controllerUnavailable = failure === 'unavailable';
    const previousAdapter = h.state.adapter!;
    const terminate = vi.spyOn(previousAdapter, 'terminate');
    await expect(h.reconciler.applyRuntimeChange(h.instance.id, {
      provider: 'opencode', accountProfileId: 'worker-only-b', accountHandoffKind: 'explicit', accountHandoffConfirmed: true,
    })).rejects.toThrow(failure === 'unavailable' ? 'could not be verified' : 'needs sign-in');
    expect(h.instance).toMatchObject({ accountProfileId: 'legacy', accountRoutingSource: 'persisted', accountSwitches: 2, status: 'idle' });
    expect(h.state.adapter).toBe(previousAdapter);
    expect(h.state.controllerReads).toBe(2);
    expect(terminate).not.toHaveBeenCalled();
    expect(h.state.nativeModel).toBe('xiaomi-token-plan-ams/mimo-v2.6-pro');
    expect(h.state.localProcesses[0].receivedMessages.filter((message) => 'method' in message
      && ['session/set_config_option', 'session/cancel', 'session/prompt'].includes(message.method))).toEqual([]);
    expect(h.state.notices).toEqual([]);
    expect(h.state.runtimeChanged).toBe(0);
    expect(h.state.requests).toEqual([]);
  });

  it.each(['opencode', 'claude', 'codex'] as const)('admits remote %s worker-only credentials despite a negative controller cache', async (provider) => {
    const h = await harness({ provider });
    expect(h.coordinator.plan(h.request)).toEqual({ kind: 'switch' });
    expect(await h.coordinator.perform(h.request)).toMatchObject({ outcome: 'switched', toProfileId: 'worker-only-b' });
    expect(h.instance).toMatchObject({ accountProfileId: 'worker-only-b', accountSwitches: 3, status: 'idle' });
    expect(h.state.routes).toEqual([expect.objectContaining({ provider, profileId: 'worker-only-b', executionNodeId: 'worker' })]);
    expect(h.state.controllerReads).toBe(1);
    expect(h.state.workerReads).toBe(1);
    expect(h.state.refreshed).toEqual(['worker-only-b']);
    const inputs = h.state.requests.filter((request) => request.method === 'instance.sendInput');
    // Claude/Codex preserve their existing immediate announcement plus replay;
    // OpenCode queues that context into the single resumed user turn.
    expect(inputs).toHaveLength(provider === 'opencode' ? 1 : 2);
    expect(inputs.at(-1)).toMatchObject({ nodeId: 'windows-pc', params: { message: expect.stringContaining('Continue original task') } });
    expect(h.state.events.filter((event) => event.event === 'account_failover_performed')).toHaveLength(1);
  });

  it('reaches the worker with an empty controller cache without checking controller credentials', async () => {
    const h = await harness({ cacheNegative: false });
    expect(await h.coordinator.perform(h.request)).toMatchObject({ outcome: 'switched' });
    expect(h.state.controllerReads).toBe(0);
    expect(h.state.workerReads).toBe(1);
  });

  it.each([true, false])('keeps local binding verification mandatory (cached signed-out: %s)', async (cacheNegative) => {
    const h = await harness({ remote: false, cacheNegative });
    expect(h.coordinator.plan(h.request)).toEqual(cacheNegative ? { kind: 'none', reason: 'no-candidate' } : { kind: 'switch' });
    expect(await h.coordinator.perform(h.request)).toMatchObject({ outcome: 'not-switched', reason: 'no-candidate' });
    expect(h.state.controllerReads).toBe(1);
    expect(h.state.workerReads).toBe(0);
    expect(h.state.requests).toEqual([]);
    expect(h.instance).toMatchObject({ accountProfileId: 'legacy', accountSwitches: 2 });
  });

  it.each([
    ['failover', 'unauthenticated'], ['failover', 'unavailable'],
    ['preemptive', 'unauthenticated'], ['preemptive', 'unavailable'],
  ] as const)('rolls back local %s %s admission and retries from error without consuming guardrails', async (handoffKind, failure) => {
    const h = await harness({ remote: false, cacheNegative: false, controllerAuthenticated: true });
    const request = { ...h.request, handoffKind };
    // The coordinator verifies sign-in, then quota refresh invalidates that
    // evidence before the real adapter-construction preflight can admit it.
    h.state.onRefresh = async () => {
      h.state.controllerAuthenticated = false;
      h.state.controllerUnavailable = failure === 'unavailable';
      h.controllerBindings.invalidate();
    };
    expect(await h.coordinator.perform(request)).toMatchObject({ outcome: 'not-switched', reason: 'apply-failed' });
    expect(h.state.controllerReads).toBe(2);
    expect(h.state.workerReads).toBe(0);
    expect(h.instance).toMatchObject({ accountProfileId: 'legacy', accountRoutingSource: 'persisted', accountSwitches: 2, status: 'error' });
    expect(h.state.localProcesses).toEqual([]);
    expect(h.state.requests).toEqual([]);
    expect(h.state.events).toContainEqual(expect.objectContaining({ event: 'account_route_blocked', profileId: 'worker-only-b' }));
    expect(h.state.events.filter((event) => event.event === 'account_failover_performed')).toEqual([]);
    expect(h.state.notifications).toEqual([]);
    expect(h.state.notices).toEqual([]);
    expect(h.state.runtimeChanged).toBe(0);
    // Sign-in restoration is the prerequisite. Keep error: the production
    // state machine permits error -> initializing -> idle for the retry.
    h.state.controllerAuthenticated = true;
    h.state.controllerUnavailable = false;
    h.controllerBindings.invalidate();
    h.state.onRefresh = async () => undefined;
    expect(h.coordinator.plan(request)).toEqual({ kind: 'switch' });
    expect(await h.coordinator.perform(request)).toMatchObject({ outcome: 'switched', toProfileId: 'worker-only-b' });
    expect(h.instance).toMatchObject({ accountProfileId: 'worker-only-b', accountSwitches: 3, status: 'idle' });
    expect(h.state.workerReads).toBe(0);
    expect(h.state.requests).toEqual([]);
    await h.state.localProcesses[0].waitForMessage((message) => 'method' in message && message.method === 'session/prompt');
    const prompts = h.state.localProcesses.flatMap((proc) => proc.receivedMessages)
      .filter((message) => 'method' in message && message.method === 'session/prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ params: { prompt: expect.arrayContaining([
      { type: 'text', text: request.resumePrompt },
      { type: 'text', text: expect.stringContaining('Account switched') },
    ]) } });
    expect(h.state.events.filter((event) => event.event === 'account_failover_performed')).toHaveLength(1);
  });

  it.each(['unauthenticated', 'unavailable'] as const)('rolls back explicit local %s admission without success or delivery', async (failure) => {
    const h = await harness({ remote: false, controllerAuthenticated: true });
    h.state.controllerAuthenticated = false;
    h.state.controllerUnavailable = failure === 'unavailable';
    h.controllerBindings.invalidate();
    await expect(h.reconciler.applyRuntimeChange(h.instance.id, {
      provider: 'opencode', accountProfileId: 'worker-only-b',
      accountHandoffKind: 'explicit', accountHandoffConfirmed: true,
    })).rejects.toThrow(failure === 'unavailable' ? 'could not be verified' : 'needs sign-in');
    expect(h.instance).toMatchObject({ accountProfileId: 'legacy', accountRoutingSource: 'persisted', accountSwitches: 2, status: 'error' });
    expect(h.state.controllerReads).toBe(2);
    expect(h.state.workerReads).toBe(0);
    expect(h.state.localProcesses).toEqual([]);
    expect(h.state.requests).toEqual([]);
    expect(h.state.notifications).toEqual([]);
    expect(h.state.notices).toEqual([]);
    expect(h.state.runtimeChanged).toBe(0);
  });

  it.each([{ failoverMode: 'ask' as const }, { acknowledgedOwnershipAt: null }])('offers remote candidates under %j without executing them', async (policy) => {
    const h = await harness({ policy });
    expect(h.coordinator.plan(h.request)).toEqual({ kind: 'offer', toProfileId: 'worker-only-b' });
    expect(await h.coordinator.perform(h.request)).toEqual({ outcome: 'offered', toProfileId: 'worker-only-b' });
    expect(h.state.notifications).toEqual([expect.objectContaining({ kind: 'account-failover-offer' })]);
    expect(h.state.requests).toEqual([]);
    expect(h.state.workerReads).toBe(0);
    expect(h.instance.accountProfileId).toBe('legacy');
  });

  it('preemptively moves a remote session only onto a verified worker account under threshold', async () => {
    const h = await harness();
    expect(h.coordinator.shouldSwitchPreemptively(h.request)).toBe(true);
    h.state.quota['worker-only-b'] = { allowancePct: 90 };
    expect(h.coordinator.shouldSwitchPreemptively(h.request)).toBe(false);
    h.state.quota['worker-only-b'] = { allowancePct: 10 };
    expect(await h.coordinator.perform({ ...h.request, handoffKind: 'preemptive' })).toMatchObject({ outcome: 'switched' });
    expect(h.state.workerReads).toBe(1);
    expect(h.state.events).toContainEqual(expect.objectContaining({ event: 'account_failover_performed', handoffKind: 'preemptive' }));
  });

  it.each(['unauthenticated', 'unavailable'] as const)('rolls back a %s worker refusal without success, resend, or consumed guardrails', async (failure) => {
    const h = await harness();
    h.state.workerAuthenticated = false;
    h.state.workerUnavailable = failure === 'unavailable';
    expect(await h.coordinator.perform(h.request)).toMatchObject({ outcome: 'not-switched', reason: 'apply-failed' });
    expect(h.state.workerReads).toBe(1);
    expect(h.state.routes).toEqual([]);
    expect(h.instance).toMatchObject({ accountProfileId: 'legacy', accountRoutingSource: 'persisted', accountSwitches: 2, status: 'error' });
    expect(h.state.requests.filter((request) => request.method === 'instance.sendInput')).toEqual([]);
    expect(h.state.events.filter((event) => event.event === 'account_failover_performed')).toEqual([]);
    expect(h.state.notifications).toEqual([]);
    expect(h.state.notices).toEqual([]);
    expect(h.state.runtimeChanged).toBe(0);
    // A failed attempt consumes neither the one-switch cap nor five-minute
    // cooldown. A subsequent worker sign-in can immediately recover the turn.
    h.state.workerAuthenticated = true;
    h.state.workerUnavailable = false;
    expect(h.coordinator.plan(h.request)).toEqual({ kind: 'switch' });
    expect(await h.coordinator.perform(h.request)).toMatchObject({ outcome: 'switched' });
    expect(h.instance.accountSwitches).toBe(3);
    expect(h.state.requests.filter((request) => request.method === 'instance.sendInput')).toHaveLength(1);
  });

  it('keeps fresh quota exhaustion vetoes independent of worker key placement', async () => {
    const h = await harness();
    h.state.onRefresh = async (id) => { h.state.quota[id] = { allowancePct: 100 }; };
    expect(await h.coordinator.perform(h.request)).toMatchObject({ outcome: 'not-switched', reason: 'no-candidate',
      considered: expect.arrayContaining([{ profileId: 'worker-only-b', vetoReason: 'exhausted' }]) });
    expect(h.state.refreshed).toEqual(['worker-only-b']);
    expect(h.state.requests).toEqual([]);
  });

  it('retains a known exhausted remote candidate when its quota refresh fails', async () => {
    const h = await harness();
    h.profiles.push({ ...h.profiles[1], id: 'worker-only-c', priority: 2 });
    h.state.quota['worker-only-c'] = { allowancePct: 100 };
    h.state.onRefresh = async (id) => {
      if (id === 'worker-only-b') { h.state.quota[id] = { allowancePct: 100 }; return; }
      delete h.state.quota[id];
      throw new Error('Synthetic console unavailable');
    };
    expect(await h.coordinator.perform(h.request)).toMatchObject({ outcome: 'not-switched', reason: 'no-candidate',
      considered: expect.arrayContaining([{ profileId: 'worker-only-c', vetoReason: 'exhausted' }]) });
    expect(h.state.refreshed).toEqual(['worker-only-b', 'worker-only-c']);
    expect(h.state.requests).toEqual([]);
  });

  it.each([
    ['disabled', { enabled: false }],
    ['automation-disallowed', { automationPolicy: 'manual-only' as const }],
  ])('preserves remote %s eligibility vetoes while omitting controller binding checks', async (_reason, override) => {
    const h = await harness();
    Object.assign(h.profiles[1], override);
    expect(h.coordinator.plan(h.request)).toEqual({ kind: 'none', reason: 'no-candidate' });
    expect(await h.coordinator.perform(h.request)).toMatchObject({ outcome: 'not-switched', reason: 'no-candidate' });
    expect(h.state.requests).toEqual([]);
    expect(h.state.controllerReads).toBe(1);
  });
});
