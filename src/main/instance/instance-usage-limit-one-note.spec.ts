/**
 * One refused window, one note: the Claude adapter, the usage-limit stop, the limit handler and the
 * turn-error path all hear about the same refusal. Every writer here is the real one; only the account
 * store, the logger and the outside world are stood in for.
 */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { ResolvedAccountRoute } from '../../shared/types/provider-account.types';

const communicationLoggerMocks = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock('../logging/logger', () => ({ getLogger: () => communicationLoggerMocks }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false, sessionHandoffStateEnabled: false }) }),
}));
vi.mock('../memory/output-storage', () => ({
  getOutputStorageManager: () => ({ storeMessages: vi.fn(() => Promise.resolve()), deleteInstance: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => ({
    triggerHooks: vi.fn().mockResolvedValue(undefined),
    triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
  }),
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../core/error-recovery', () => ({
  getErrorRecoveryManager: () => ({ classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })) }),
}));
vi.mock('../session/session-continuity', () => ({
  getSessionContinuityManagerIfInitialized: () => ({ writeThroughIdentity: vi.fn().mockResolvedValue(undefined), markConversationIncomplete: vi.fn() }),
}));
vi.mock('../session/session-admission-service', () => ({
  getSessionAdmissionService: () => ({ recordUserSend: vi.fn(() => ({ admissionId: 'adm' })), markDelivered: vi.fn(), markFailed: vi.fn() }),
}));
vi.mock('../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({
    getProfile: (_provider: string, id: string) => ({ 'work-1': { label: 'Work' }, 'home-2': { label: 'Home' } } as Record<string, { label: string }>)[id] ?? null,
  }),
}));

import { InstanceCommunicationManager } from './instance-communication';
import { createProviderLimitCommunicationCallbacks } from './instance-provider-limit-runtime';
import { _resetInstanceProviderLimitHandlerForTesting, getInstanceProviderLimitHandler } from './instance-provider-limit-handler';
import { attachUsageOverageStopGuard, configureUsageOverageStop, resetUsageOverageStopForTesting } from './instance-usage-overage-wiring';
import { currentAccountProfileId } from '../providers/account-pool/account-failover-coordinator';
import { rememberAdapterAccountRoute } from '../providers/account-pool/adapter-account-routes';
import { ClaudeCliAdapter } from '../cli/adapters/claude-cli-adapter';

const NOON = new Date(2026, 9, 20, 12);
const THURSDAY_NIGHT = new Date(2026, 9, 22, 23);
const NEXT_THURSDAY_NIGHT = new Date(2026, 9, 29, 23);
const secondsOf = (date: Date) => Math.floor(date.getTime() / 1000);
const rejected = (resetsAt = secondsOf(THURSDAY_NIGHT)) => ({
  type: 'rate_limit_event', timestamp: 1, rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt },
});
const route = (profileId: string, profileLabel: string) =>
  ({ provider: 'claude', profileId, source: 'explicit', executionNodeId: 'local', profileLabel }) as ResolvedAccountRoute;

function buildInstance(provider: Instance['provider'], accountProfileId?: string): Instance {
  return {
    id: 'instance-1', displayName: 'Test Instance', createdAt: Date.now(), historyThreadId: 'thread-1', parentId: null,
    childrenIds: [], supervisorNodeId: '', workerNodeId: undefined, depth: 0, terminationPolicy: 'terminate-children',
    launchMode: 'orchestrated', executionLocation: { type: 'local' }, contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build', agentMode: 'build', planMode: { enabled: false, state: 'off' }, status: 'busy',
    contextUsage: { used: 0, total: 200000, percentage: 0 }, lastActivity: Date.now(), processId: 12345,
    sessionId: 'session-1', providerSessionId: 'session-1', workingDirectory: '/tmp/project', yoloMode: false,
    provider, currentModel: undefined, outputBuffer: [], outputBufferMaxSize: 1000, communicationTokens: new Map(),
    subscribedTo: [], totalTokensUsed: 0, requestCount: 0, errorCount: 0, restartCount: 0, restartEpoch: 0,
    ...(accountProfileId ? { accountProfileId } : {}),
  };
}

interface Setup { provider?: Instance['provider']; account?: string; autoResume?: boolean; switchTo?: string }

function setup(options: Setup = {}) {
  const provider = options.provider ?? 'claude';
  const instance = buildInstance(provider, options.account);
  const adapters = new Map<string, CliAdapter>();
  const handler = getInstanceProviderLimitHandler();
  const manager = new InstanceCommunicationManager({
    getInstance: id => (id === instance.id ? instance : undefined),
    getAdapter: id => adapters.get(id),
    setAdapter: (id, adapter) => { adapters.set(id, adapter); },
    deleteAdapter: id => adapters.delete(id),
    queueUpdate: vi.fn(),
    processOrchestrationOutput: vi.fn(),
    onInterruptedExit: vi.fn().mockResolvedValue(undefined),
    ingestToRLM: vi.fn(),
    ingestToUnifiedMemory: vi.fn(),
    ...createProviderLimitCommunicationCallbacks(id => (id === instance.id ? instance : undefined)),
  });
  handler.configure({
    isEnabled: () => options.autoResume !== false,
    setWaitReason: () => undefined,
    resendInput: () => undefined,
    getQuotaSnapshot: () => null,
    getWorkspaceCwd: () => '/tmp/project',
    getProviderModel: () => ({ provider: instance.provider, model: null, accountProfileId: currentAccountProfileId(instance) }),
    scheduleResume: () => () => undefined,
    emitSystemMessage: (instanceId, content, metadata) => {
      manager.emitSystemOutput(instanceId, { id: `note-${instance.outputBuffer.length}`, timestamp: Date.now(), type: 'system', content, metadata });
    },
    ...(options.switchTo ? {
      accountFailover: {
        plan: () => ({ kind: 'switch', toProfileId: options.switchTo }),
        perform: () => new Promise(() => undefined),
        offer: vi.fn(),
        shouldSwitchPreemptively: () => false,
        release: vi.fn(),
      },
    } as never : {}),
  });
  configureUsageOverageStop({
    getAllowOverageSetting: () => false,
    interruptInstance: () => true,
    holdOnUsageLimit: (instanceId, signal) => {
      handler.maybeParkOnUsageLimit({ instanceId, resetAtHint: signal.resetAtHint, reason: signal.reason });
    },
  });
  return { instance, adapters, handler, manager };
}

/** A Claude adapter, started for the instance's account and watched by the real stop and manager. */
function startClaude(h: ReturnType<typeof setup>, account?: ResolvedAccountRoute) {
  const adapter = new ClaudeCliAdapter();
  if (account) rememberAdapterAccountRoute(adapter, account);
  (adapter as unknown as { resetResidentTurn(): void }).resetResidentTurn();
  h.adapters.set(h.instance.id, adapter as unknown as CliAdapter);
  h.manager.setupAdapterEvents(h.instance.id, adapter as unknown as CliAdapter);
  const detach = attachUsageOverageStopGuard(adapter, h.instance.id);
  const feed = (adapter as unknown as { processCliMessage(message: unknown): void }).processCliMessage.bind(adapter);
  return { adapter, feed, detach };
}

const LIMIT_ERROR = new Error("You've hit your usage limit. Try again at 11:00 PM. - [codex_error_info: usageLimitExceeded]");

/** A Codex session whose every send is refused by the usage window, as the app-server reports it. */
function startCodex(h: ReturnType<typeof setup>): CliAdapter {
  const adapter = Object.assign(new EventEmitter(), {
    sendInput: vi.fn().mockRejectedValue(LIMIT_ERROR),
    terminate: vi.fn().mockResolvedValue(undefined),
    getName: () => 'codex-cli',
    getSessionId: () => null,
    getCurrentTurnId: () => null,
  }) as unknown as CliAdapter;
  h.adapters.set(h.instance.id, adapter);
  return adapter;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 1));
}

/** What the transcript says about a limit: the notes of the stop, the switch, and the hold. */
const limitNotes = (instance: Instance): OutputMessage[] => instance.outputBuffer.filter(message =>
  message.type === 'system' && (message.metadata?.['providerLimitParked'] === true || message.metadata?.['accountFailover'] === true));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetUsageOverageStopForTesting();
  _resetInstanceProviderLimitHandlerForTesting();
  vi.useRealTimers();
});

describe('a refused usage window is announced once', () => {
  it('says it once when the stop holds the session and the turn then fails with the same refusal', async () => {
    const h = setup({ account: 'work-1' });
    const claude = startClaude(h, route('work-1', 'Work'));
    cleanups.push(claude.detach);

    claude.feed(rejected());
    await settle();
    claude.adapter.emit('error', new Error('Claude stream closed before the turn finished'));
    await settle();

    const notes = limitNotes(h.instance);
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain('Your Work Claude account has used its weekly allowance.');
    expect(notes[0].content).toContain('It resets on Thursday 22 October at 23:00.');
    expect(notes[0].content).toContain('Harness will pick this session up again once the allowance resets.');
    expect(h.instance.outputBuffer.filter(message => message.type === 'error')).toHaveLength(0);
    expect(getInstanceProviderLimitHandler().isParked(h.instance.id)).toBe(true);
  });

  it('says it once when the session is moving to another account', async () => {
    const h = setup({ account: 'work-1', switchTo: 'home-2' });
    const claude = startClaude(h, route('work-1', 'Work'));
    cleanups.push(claude.detach);

    claude.feed(rejected());
    await settle();
    claude.adapter.emit('error', new Error('Claude stream closed before the turn finished'));
    await settle();

    const notes = limitNotes(h.instance);
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain('No action needed: Harness is moving this conversation to another account.');
    expect(notes[0].content).not.toMatch(/Moving the conversation|usage limit\./);
  });

  it('says it once when the refused send is the only thing that reports the limit, and again for a second refusal in that window', async () => {
    const h = setup({ provider: 'codex', account: 'work-1' });
    const codex = startCodex(h);

    await h.manager.sendInput(h.instance.id, 'keep going');
    // The automation's first turn goes straight to the adapter and is refused by the same window.
    const handled = h.manager.providerLimitGateForDirectTurn.handleSendError(h.instance, codex, LIMIT_ERROR, 'run the daily workflow');

    expect(handled).toBe(true);
    const notes = limitNotes(h.instance);
    expect(notes).toHaveLength(1);
    // The handler held the user's message for the auto-resume, so the one note says exactly that.
    expect(notes[0].content).toBe(
      'Your Work Codex account has used its current allowance. It resets at 23:00. '
      + 'What to do: Wait for the allowance to reset, or switch account. '
      + 'Your message will be sent again automatically once the allowance resets.',
    );
    expect(notes[0].content).not.toMatch(/Provider limit reached|quota window|parked/i);
    expect(notes[0].metadata).toMatchObject({ providerLimitParked: true });
    expect(h.instance.outputBuffer.filter(message => message.type === 'error')).toHaveLength(0);
  });

  it('announces a later window again, and says that one once as well', async () => {
    const h = setup({ account: 'work-1' });
    const claude = startClaude(h, route('work-1', 'Work'));
    cleanups.push(claude.detach);

    claude.feed(rejected());
    await settle();
    claude.adapter.emit('error', new Error('Claude stream closed before the turn finished'));
    await settle();
    expect(limitNotes(h.instance)).toHaveLength(1);

    // The window ends, the held message goes out, and the next week's allowance runs out in turn.
    getInstanceProviderLimitHandler().cancel(h.instance.id);
    vi.setSystemTime(new Date(THURSDAY_NIGHT.getTime() + 30 * 60_000));
    claude.feed(rejected(secondsOf(NEXT_THURSDAY_NIGHT)));
    await settle();
    claude.adapter.emit('error', new Error('Claude stream closed before the turn finished'));
    await settle();

    const notes = limitNotes(h.instance);
    expect(notes).toHaveLength(2);
    expect(notes[0].content).toContain('It resets on Thursday 22 October at 23:00.');
    expect(notes[1].content).toContain('It resets on Thursday 29 October at 23:00.');
  });

  it('announces the limit of a second account, even inside the first account\'s window', async () => {
    const h = setup({ provider: 'codex', account: 'work-1' });
    startCodex(h);

    await h.manager.sendInput(h.instance.id, 'keep going');
    // The conversation moves to the Home account, which runs out a little later.
    getInstanceProviderLimitHandler().cancel(h.instance.id);
    h.instance.accountProfileId = 'home-2';
    vi.setSystemTime(new Date(NOON.getTime() + 20 * 60_000));
    await h.manager.sendInput(h.instance.id, 'keep going');

    const notes = limitNotes(h.instance);
    expect(notes).toHaveLength(2);
    expect(notes[0].content).toContain('Your Work Codex account');
    expect(notes[1].content).toContain('Your Home Codex account');
  });
});
