import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, type ChildProcess } from 'child_process';
import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
import { TestAcpCliAdapter, createInitializedAgentHarness } from '../../cli/adapters/acp-cli-adapter.test-helpers';
import { mapAcpEffort } from '../../cli/adapters/acp-session-config-options';
import type { ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { ProviderAccountBindingService } from '../../providers/account-pool/provider-account-binding-service';
import { ProviderAccountRoutingService, _resetProviderAccountRoutingServiceForTesting } from '../../providers/account-pool/provider-account-routing-service';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn();
  return { ...actual, execFile, default: { ...actual, execFile } };
});
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({
    getProfile: (provider: string, profileId: string) => {
      const found = mocks.profiles.find((entry) => entry.provider === provider && entry.id === profileId);
      return found ?? null;
    },
  }),
}));

import {
  isAccountOnlyChange,
  tryAccountSwitchInPlace,
  type AccountHandoffSnapshot,
} from './runtime-reconciler-account-handoff';

const mocks = vi.hoisted(() => ({
  profiles: [] as ProviderAccountProfile[],
  authList: undefined as string | null | undefined,
  reads: 0,
}));

beforeEach(() => {
  vi.mocked(execFile).mockReset();
  mocks.authList = undefined;
  mocks.reads = 0;
  _resetProviderAccountRoutingServiceForTesting(new ProviderAccountRoutingService({
    bindingService: new ProviderAccountBindingService({ readOpenCodeAuthList: async () => {
      mocks.reads++;
      if (mocks.authList !== undefined) return mocks.authList;
      const names = ['xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-cn',
        ...mocks.profiles.filter((profile) => !profile.isLegacy).map((profile) => `aio-mimo-${profile.id}`)];
      return `┌  Credentials\n${names.map((name) => `●  ${name} api`).join('\n')}\n└  ${names.length} credentials\n`;
    } }),
  }));
});

afterEach(() => _resetProviderAccountRoutingServiceForTesting());

function mimoProfile(id: string, region: 'ams' | 'sgp' | 'cn' = 'ams'): ProviderAccountProfile {
  return {
    id,
    provider: 'opencode',
    label: `MiMo ${id}`,
    expectedIdentity: null,
    expectedAccountKey: null,
    planLabel: null,
    priority: 1,
    enabled: true,
    automationPolicy: 'allow-routed',
    isLegacy: id === 'legacy',
    region,
    createdAt: 1,
    updatedAt: 1,
  };
}

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    provider: 'opencode',
    currentModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
    reasoningEffort: undefined,
    yoloMode: true,
    status: 'idle',
    accountProfileId: 'max-a-1a2b',
    accountRoutingSource: 'failover',
    accountSwitches: 0,
    contextUsage: { used: 100, total: 1000 },
    executionLocation: undefined,
    ...overrides,
  } as unknown as Instance;
}

const oldAccount = (overrides: Partial<AccountHandoffSnapshot> = {}): AccountHandoffSnapshot => ({
  accountProfileId: 'max-a-1a2b',
  accountRoutingSource: 'failover',
  accountSwitches: 0,
  ...overrides,
});

function desired(overrides: Partial<DesiredRuntime> = {}): DesiredRuntime {
  return {
    provider: 'opencode',
    accountProfileId: 'max-b-2b3c',
    accountHandoffKind: 'failover',
    accountHandoffReason: 'usage limit; resets 13:00',
    ...overrides,
  } as DesiredRuntime;
}

function liveAdapter(overrides: { applyLiveSessionConfig?: () => Promise<void> } = {}) {
  return {
    applyLiveSessionConfig: overrides.applyLiveSessionConfig ?? vi.fn(async () => undefined),
    sendInput: vi.fn(async () => undefined),
    queueNextPromptContext: vi.fn(),
  };
}

function deps() {
  return {
    emitSystemNotice: vi.fn(),
    queueUpdate: vi.fn(),
    emitRuntimeChanged: vi.fn(),
  };
}

describe('isAccountOnlyChange', () => {
  const none = {
    accountProfileChanged: true,
    providerChanged: false,
    modelChanged: false,
    reasoningChanged: false,
    runtimeTargetChanged: false,
    yoloModeChanged: false,
    copilotAccountChanged: false,
  };
  it('is true only for a pure account change', () => {
    expect(isAccountOnlyChange(none)).toBe(true);
    expect(isAccountOnlyChange({ ...none, modelChanged: true })).toBe(false);
    expect(isAccountOnlyChange({ ...none, providerChanged: true })).toBe(false);
    expect(isAccountOnlyChange({ ...none, copilotAccountChanged: true })).toBe(false);
    expect(isAccountOnlyChange({ ...none, accountProfileChanged: false })).toBe(false);
  });
});

describe('tryAccountSwitchInPlace (MiMo multi-account live switch)', () => {
  it.each([{ code: 7 }, { killed: true, signal: 'SIGTERM' as const }])('refuses actual failed auth-list output %j before live mutation', async (properties) => {
    mocks.profiles = [mimoProfile('max-b-2b3c')];
    vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
      expect(file).toBe('opencode');
      expect(args).toEqual(['auth', 'list']);
      expect(options).toMatchObject({ timeout: 8_000, maxBuffer: 256 * 1024 });
      if (!callback) throw new Error('Missing auth-list callback');
      queueMicrotask(() => callback(Object.assign(new Error('error-placeholder'), properties),
        '┌  Credentials\n●  aio-mimo-max-b-2b3c api\n└  1 credentials\n', 'stderr-placeholder'));
      return {} as ChildProcess;
    });
    _resetProviderAccountRoutingServiceForTesting(new ProviderAccountRoutingService({ bindingService: new ProviderAccountBindingService() }));
    const target = instance();
    const adapter = liveAdapter();
    const calls = deps();
    await expect(tryAccountSwitchInPlace({ instance: target, desired: desired(), adapter, oldAccount: oldAccount(), ...calls }))
      .rejects.toMatchObject({ name: 'AccountRoutingError', code: 'profile-not-bound-on-node',
        message: expect.stringContaining('auth-list-unreadable') });
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith('opencode', ['auth', 'list'],
      expect.objectContaining({ timeout: 8_000, maxBuffer: 256 * 1024 }), expect.any(Function));
    expect(target).toMatchObject({ accountProfileId: 'max-a-1a2b', accountRoutingSource: 'failover', accountSwitches: 0, status: 'idle' });
    expect(adapter.applyLiveSessionConfig).not.toHaveBeenCalled();
    expect(adapter.sendInput).not.toHaveBeenCalled();
    expect(adapter.queueNextPromptContext).not.toHaveBeenCalled();
    expect(calls.emitSystemNotice).not.toHaveBeenCalled();
    expect(calls.queueUpdate).not.toHaveBeenCalled();
    expect(calls.emitRuntimeChanged).not.toHaveBeenCalled();
  });

  it.each(['explicit', 'failover', 'preemptive'] as const)(
    'refuses %s admission before native writes or success when sign-in cannot be verified', async (kind) => {
      mocks.profiles = [mimoProfile('max-b-2b3c')];
      for (const authList of ['┌  Credentials\n└  0 credentials\n', null, 'unrecognized output']) {
        mocks.authList = authList;
        const target = instance();
        const adapter = liveAdapter();
        const calls = deps();
        await expect(tryAccountSwitchInPlace({ instance: target,
          desired: desired({ accountHandoffKind: kind, accountHandoffConfirmed: true }),
          adapter, oldAccount: oldAccount(), ...calls })).rejects.toMatchObject({ name: 'AccountRoutingError' });
        expect(target).toMatchObject({ accountProfileId: 'max-a-1a2b', accountRoutingSource: 'failover',
          accountSwitches: 0, status: 'idle', currentModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro' });
        expect(adapter.applyLiveSessionConfig).not.toHaveBeenCalled();
        expect(adapter.sendInput).not.toHaveBeenCalled();
        expect(adapter.queueNextPromptContext).not.toHaveBeenCalled();
        expect(calls.emitSystemNotice).not.toHaveBeenCalled();
        expect(calls.queueUpdate).not.toHaveBeenCalled();
        expect(calls.emitRuntimeChanged).not.toHaveBeenCalled();
      }
      expect(mocks.reads).toBe(3);
    },
  );

  it.each(['manual-only', 'disabled'] as const)('permits a confirmed explicit switch to a signed-in %s account', async (automationPolicy) => {
    mocks.profiles = [{ ...mimoProfile('max-b-2b3c'), automationPolicy }];
    const target = instance();
    expect(await tryAccountSwitchInPlace({ instance: target,
      desired: desired({ accountHandoffKind: 'explicit', accountHandoffConfirmed: true }),
      adapter: liveAdapter(), oldAccount: oldAccount(), ...deps() })).toBe(true);
    expect(target.accountProfileId).toBe('max-b-2b3c');
    expect(mocks.reads).toBe(1);
  });

  it('leaves remote admission to the executing worker even for an adapter with live-looking methods', async () => {
    mocks.profiles = [mimoProfile('max-b-2b3c')];
    const target = instance({ executionLocation: { type: 'remote', nodeId: 'windows-pc' } });
    const adapter = liveAdapter();
    expect(await tryAccountSwitchInPlace({ instance: target, desired: desired(), adapter, oldAccount: oldAccount(), ...deps() })).toBe(false);
    expect(mocks.reads).toBe(0);
    expect(adapter.applyLiveSessionConfig).not.toHaveBeenCalled();
    expect(target.accountProfileId).toBe('max-a-1a2b');
  });

  it.each([
    ['minimal', 'low'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'],
    ['xhigh', 'high'], ['max', 'high'], ['ultra', 'high'],
  ] as const)('restores mapped %s effort after the real native model resets it', async (requested, mapped) => {
    mocks.profiles = [mimoProfile('max-b-2b3c')];
    const modelA = 'aio-mimo-max-a-1a2b/mimo-v2.6-pro';
    const modelB = 'aio-mimo-max-b-2b3c/mimo-v2.6-pro';
    let model = modelA;
    let effort: string = mapped;
    const options = () => [
      { id: 'model', category: 'model', currentValue: model, options: [{ value: modelA }, { value: modelB }] },
      { id: 'effort', category: 'thought_level', currentValue: effort, options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
    ];
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/new', (message) => proc.respond(message.id, { sessionId: 'sess-acp-1', configOptions: options() }));
    proc.onRequest('session/set_config_option', (message) => {
      const params = message.params as { configId: string; value: string };
      if (params.configId === 'model') { model = params.value; effort = 'low'; }
      else effort = params.value;
      proc.respond(message.id, { configOptions: options() });
    });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const target = instance({ reasoningEffort: requested });
    const calls = deps();
    try {
      await adapter.spawn();
      expect(await tryAccountSwitchInPlace({ instance: target, desired: desired(), adapter, oldAccount: oldAccount(), ...calls })).toBe(true);
      expect(model).toBe(modelB);
      expect(effort).toBe(mapped);
      expect(target.reasoningEffort).toBe(requested);
      expect(calls.emitRuntimeChanged).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: requested }));
    } finally { proc.exit(); }
  });

  it.each([undefined, 'none', 'workflow'] as const satisfies readonly Instance['reasoningEffort'][])(
    'leaves native defaults when effort is %s', async (reasoningEffort) => {
      mocks.profiles = [mimoProfile('max-b-2b3c')];
      const adapter = liveAdapter();
      expect(await tryAccountSwitchInPlace({ instance: instance({ reasoningEffort }), desired: desired(), adapter, oldAccount: oldAccount(), ...deps() })).toBe(true);
      expect(adapter.applyLiveSessionConfig).toHaveBeenCalledWith({ model: 'aio-mimo-max-b-2b3c/mimo-v2.6-pro' });
    },
  );

  it('accepts null at the nullable ACP mapping boundary as native default', () => {
    // Instance permits an absent override, while incoming configuration and
    // the mapping helper also accept null; do not put null on a live Instance.
    expect(mapAcpEffort(null)).toBeUndefined();
  });

  it('switches the running session to the next account with no respawn', async () => {
    mocks.profiles = [mimoProfile('max-a-1a2b'), mimoProfile('max-b-2b3c')];
    const instance1 = instance();
    const adapter = liveAdapter();
    const calls = deps();

    const switched = await tryAccountSwitchInPlace({
      instance: instance1,
      desired: desired(),
      adapter,
      oldAccount: oldAccount(),
      ...calls,
    });

    expect(switched).toBe(true);
    // Decision 4: the instance keeps the logical model; the session model gets
    // the routed account's provider prefix.
    expect(adapter.applyLiveSessionConfig).toHaveBeenCalledWith({
      model: 'aio-mimo-max-b-2b3c/mimo-v2.6-pro',
    });
    expect(instance1.currentModel).toBe('xiaomi-token-plan-ams/mimo-v2.6-pro');
    expect(instance1.accountProfileId).toBe('max-b-2b3c');
    expect(instance1.accountRoutingSource).toBe('failover');
    expect(instance1.accountSwitches).toBe(1);
    expect(instance1.recoveryMethod).toBe('native');
    // Same transcript note and announcement as a respawn handoff.
    const notice = calls.emitSystemNotice.mock.calls[0]?.[1] as string;
    expect(notice).toMatch(/\[System: Account switched: MiMo max-a-1a2b → MiMo max-b-2b3c \(usage limit; resets 13:00\)\./);
    expect(adapter.queueNextPromptContext).toHaveBeenCalledWith(expect.stringContaining('Account switched'));
    expect(adapter.sendInput).not.toHaveBeenCalled();
    // Renderer updates the respawn path performs are performed too.
    expect(calls.queueUpdate).toHaveBeenCalledOnce();
    expect(calls.emitRuntimeChanged).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'inst-1' }));
  });

  it.each(['failover', 'explicit'] as const)('keeps %s notices visible without starting a turn before interrupted work', async (kind) => {
    mocks.profiles = [mimoProfile('max-b-2b3c')];
    const proc = createInitializedAgentHarness();
    const modelA = 'aio-mimo-max-a-1a2b/mimo-v2.6-pro';
    const modelB = 'aio-mimo-max-b-2b3c/mimo-v2.6-pro';
    const configOptions = (currentValue: string) => [{ id: 'model', category: 'model', currentValue, options: [{ value: modelA }, { value: modelB }] }];
    proc.onRequest('session/new', (message) => proc.respond(message.id, { sessionId: 'sess-acp-1', configOptions: configOptions(modelA) }));
    proc.onRequest('session/set_config_option', (message) => proc.respond(message.id, { configOptions: configOptions((message.params as { value: string }).value) }));
    proc.onRequest('session/prompt', () => { /* The actual turn stays active. */ });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const calls = deps();
    await adapter.spawn();
    vi.useFakeTimers();
    try {
      const switching = tryAccountSwitchInPlace({ instance: instance(), desired: desired({ accountHandoffKind: kind, accountHandoffConfirmed: true }), adapter, oldAccount: oldAccount(), ...calls });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await switching).toBe(true);
      expect(calls.emitSystemNotice).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Account switched'), { kind: 'account-changed' });
      expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toHaveLength(0);
      vi.useRealTimers();
      const work = adapter.sendMessage({ role: 'user', content: 'Resume interrupted work' });
      await proc.waitForMessage((message) => 'method' in message && message.method === 'session/prompt');
      const prompts = proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt');
      expect(prompts).toHaveLength(1);
      expect(JSON.stringify(prompts[0])).toContain('Account switched');
      expect(JSON.stringify(prompts[0])).toContain('Resume interrupted work');
      const prompt = prompts[0] as { id: string };
      proc.respond(prompt.id, { stopReason: 'end_turn' });
      await work;
    } finally { proc.exit(); vi.useRealTimers(); }
  });

  it('refuses to stamp a MiMo account switch on an unrelated OpenCode backend', async () => {
    mocks.profiles = [mimoProfile('max-b-2b3c')];
    const target = instance({ currentModel: 'opencode/big-pickle' });
    const adapter = liveAdapter();
    expect(await tryAccountSwitchInPlace({ instance: target, desired: desired(), adapter, oldAccount: oldAccount(), ...deps() })).toBe(false);
    expect(target.accountProfileId).toBe('max-a-1a2b');
    expect(adapter.applyLiveSessionConfig).not.toHaveBeenCalled();
  });

  it('keeps the session model when the target account is the legacy region provider', async () => {
    mocks.profiles = [mimoProfile('legacy')];
    const adapter = liveAdapter();
    const calls = deps();
    const switched = await tryAccountSwitchInPlace({
      instance: instance(),
      desired: desired({ accountProfileId: 'legacy' }),
      adapter,
      oldAccount: oldAccount(),
      ...calls,
    });
    expect(switched).toBe(true);
    expect(adapter.applyLiveSessionConfig).toHaveBeenCalledWith({
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
    });
  });

  describe.each(['ams', 'sgp', 'cn'] as const)('actual legacy %s live handoff', (region) => {
    it.each(['xiaomi-token-plan', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-cn'])(
      'selects the native target for logical provider %s', async (logicalProvider) => {
        mocks.profiles = [mimoProfile('legacy', region)];
        const expected = `xiaomi-token-plan-${region}/mimo-v2.6-pro`;
        let native = 'aio-mimo-max-a-1a2b/mimo-v2.6-pro';
        const options = () => [{ id: 'model', category: 'model', currentValue: native,
          options: [{ value: native }, { value: expected }] }];
        const proc = createInitializedAgentHarness();
        proc.onRequest('session/new', (message) => proc.respond(message.id, { sessionId: 'sess-acp-1', configOptions: options() }));
        proc.onRequest('session/set_config_option', (message) => {
          native = (message.params as { value: string }).value;
          proc.respond(message.id, { configOptions: options() });
        });
        const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
        const target = instance({ currentModel: `${logicalProvider}/mimo-v2.6-pro` });
        const calls = deps();
        try {
          await adapter.spawn();
          expect(await tryAccountSwitchInPlace({ instance: target, desired: desired({ accountProfileId: 'legacy' }),
            adapter, oldAccount: oldAccount(), ...calls })).toBe(true);
          expect(native).toBe(expected);
          expect(target.currentModel).toBe(`${logicalProvider}/mimo-v2.6-pro`);
          expect(target.accountProfileId).toBe('legacy');
          expect(target.accountSwitches).toBe(1);
          expect(calls.emitSystemNotice).toHaveBeenCalledOnce();
          expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toEqual([]);
        } finally { proc.exit(); }
      },
    );

    it.each(['refused', 'unavailable', 'mismatched-response', 'superseded-notification'] as const)(
      'leaves account and announcements untouched when native selection is %s', async (mode) => {
        mocks.profiles = [mimoProfile('legacy', region)];
        const expected = `xiaomi-token-plan-${region}/mimo-v2.6-pro`;
        const previous = 'aio-mimo-max-a-1a2b/mimo-v2.6-pro';
        let native = previous;
        const options = () => [{ id: 'model', category: 'model', currentValue: native,
          options: [{ value: previous }, ...(mode === 'unavailable' ? [] : [{ value: expected }])] }];
        const proc = createInitializedAgentHarness();
        proc.onRequest('session/new', (message) => proc.respond(message.id, { sessionId: 'sess-acp-1', configOptions: options() }));
        proc.onRequest('session/set_config_option', (message) => {
          if (mode === 'refused') proc.respondError(message.id, -32602, 'Synthetic refused regional target');
          else {
            if (mode === 'superseded-notification') native = expected;
            proc.respond(message.id, { configOptions: options() });
            if (mode === 'superseded-notification') {
              native = previous;
              proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
                sessionUpdate: 'config_option_update', configOptions: options(),
              } });
            }
          }
        });
        const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
        const target = instance();
        const calls = deps();
        try {
          await adapter.spawn();
          expect(await tryAccountSwitchInPlace({ instance: target, desired: desired({ accountProfileId: 'legacy' }),
            adapter, oldAccount: oldAccount(), ...calls })).toBe(false);
          expect(native).toBe(previous);
          expect(target.accountProfileId).toBe('max-a-1a2b');
          expect(target.accountSwitches).toBe(0);
          expect(calls.emitSystemNotice).not.toHaveBeenCalled();
          expect(calls.queueUpdate).not.toHaveBeenCalled();
          expect(calls.emitRuntimeChanged).not.toHaveBeenCalled();
          expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toEqual([]);
        } finally { proc.exit(); }
      },
    );
  });

  it('falls back to the respawn handoff when the adapter is not running or cannot switch live', async () => {
    mocks.profiles = [mimoProfile('max-b-2b3c')];
    const calls = deps();
    for (const adapter of [undefined, {}, { sendInput: vi.fn() }]) {
      const target = instance();
      expect(await tryAccountSwitchInPlace({
        instance: target,
        desired: desired(),
        adapter,
        oldAccount: oldAccount(),
        ...calls,
      })).toBe(false);
      // Untouched: the respawn handoff owns the change.
      expect(target.accountProfileId).toBe('max-a-1a2b');
      expect(target.accountSwitches).toBe(0);
    }
  });

  it('falls back (and leaves the instance untouched) when the agent refuses the model switch', async () => {
    mocks.profiles = [mimoProfile('max-b-2b3c')];
    const target = instance();
    const calls = deps();
    const adapter = liveAdapter({
      applyLiveSessionConfig: vi.fn(async () => {
        throw new Error('The agent did not switch the session model: not offered');
      }),
    });

    expect(await tryAccountSwitchInPlace({
      instance: target,
      desired: desired(),
      adapter,
      oldAccount: oldAccount(),
      ...calls,
    })).toBe(false);
    expect(target.accountProfileId).toBe('max-a-1a2b');
    expect(calls.emitSystemNotice).not.toHaveBeenCalled();
  });

  it('falls back for non-OpenCode sessions, missing profiles and unconfirmed explicit switches', async () => {
    const calls = deps();
    const adapter = liveAdapter();
    mocks.profiles = [mimoProfile('max-b-2b3c')];

    expect(await tryAccountSwitchInPlace({
      instance: instance({ provider: 'claude' }),
      desired: desired(),
      adapter,
      oldAccount: oldAccount(),
      ...calls,
    })).toBe(false);

    mocks.profiles = [];
    expect(await tryAccountSwitchInPlace({
      instance: instance(),
      desired: desired(),
      adapter,
      oldAccount: oldAccount(),
      ...calls,
    })).toBe(false);

    mocks.profiles = [mimoProfile('max-b-2b3c')];
    expect(await tryAccountSwitchInPlace({
      instance: instance(),
      desired: desired({ accountHandoffKind: 'explicit' }),
      adapter,
      oldAccount: oldAccount(),
      ...calls,
    })).toBe(false);
    expect(adapter.applyLiveSessionConfig).not.toHaveBeenCalled();
  });
});
