import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { createOpenCodeAdapter, OPENCODE_CONFIG_CONTENT_ENV } from './opencode-adapter-factory';
import { createInitializedAgentHarness } from './acp-cli-adapter.test-helpers';
import { projectOpenCodeConfig } from './opencode-config-shapes';
import { openCodeProcessGate, withOpenCodeProcessGate } from './opencode-process-gate';
import { _resetOpenCodeRegionModelMetadataForTesting, getCachedOpenCodeRegionModelMetadata } from '../../providers/opencode-region-model-metadata';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), launch: vi.fn(), probe: vi.fn(), cleanup: vi.fn(), acquire: vi.fn(), release: vi.fn(), worker: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawn, default: { ...actual, spawn: mocks.spawn } };
});
vi.mock('./base-cli-process-utils', () => ({ killProcessGroup: () => false }));
vi.mock('./opencode-cli-launch', () => ({ selectOpenCodeLaunch: mocks.launch }));
vi.mock('./opencode-effective-budget-config', () => ({ readOpenCodeEffectiveBudgetConfig: mocks.probe }));
vi.mock('./opencode-child-progress-source', () => ({ createOpenCodeChildProgressSource: () => ({ source: {}, request: vi.fn(), prepareSpawn: async () => mocks.cleanup }) }));
vi.mock('../provider-concurrency-limiter', () => ({ getProviderConcurrencyLimiter: () => ({ acquire: mocks.acquire }) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  isAccountPoolActive: () => true,
  getProviderAccountStore: () => {
    if (mocks.worker) throw new Error('worker has no settings');
    return { listProfiles: () => [{ id: 'account-b', provider: 'opencode', label: 'B', enabled: true, isLegacy: false, region: 'ams' } as ProviderAccountProfile] };
  },
}));

const verbose = ['xiaomi-token-plan-ams/mimo-v2.6-pro', JSON.stringify({ id: 'mimo-v2.6-pro', api: { npm: '@ai-sdk/openai-compatible', url: 'https://token-plan-ams.xiaomimimo.com/v1' }, limit: { context: 1000000, output: 16384 } })].join('\n');
const model = 'aio-mimo-account-b/mimo-v2.6-pro';
function adapter() {
  const proc = createInitializedAgentHarness();
  proc.onRequest('session/new', (message) => proc.respond(message.id, { sessionId: 'sess-acp-1', configOptions: [{ id: 'model', category: 'model', currentValue: model, options: [{ value: model }] }] }));
  const real = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'xiaomi-token-plan-ams/mimo-v2.6-pro', accountRoute: { provider: 'opencode', profileId: 'account-b', region: 'ams', source: 'default', executionNodeId: mocks.worker ? 'worker' : 'local' } });
  vi.spyOn(real, 'checkStatus').mockResolvedValue({ available: true });
  vi.spyOn(real as unknown as { spawnProcess: () => ChildProcess }, 'spawnProcess').mockImplementation(() => proc as unknown as ChildProcess);
  return { real, proc };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetOpenCodeRegionModelMetadataForTesting();
  mocks.worker = false;
  mocks.acquire.mockResolvedValue(mocks.release);
  mocks.launch.mockResolvedValue({ command: 'opencode', major: 1 });
  mocks.probe.mockImplementation(async (params) => projectOpenCodeConfig(JSON.parse(params.env[OPENCODE_CONFIG_CONTENT_ENV]), params.model));
});
afterEach(() => { _resetOpenCodeRegionModelMetadataForTesting(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('OpenCode account factory and ACP startup with a cold metadata cache', () => {
  it.each([false, true])('loads cold metadata before taking the startup lock (worker=%s), then holds it until initialize', async (worker) => {
    mocks.worker = worker;
    const events: string[] = [];
    let finishMetadata!: () => void;
    mocks.spawn.mockImplementation(() => {
      events.push('metadata-start');
      const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: vi.fn() });
      finishMetadata = () => { events.push('metadata-end'); proc.stdout.write(verbose); proc.emit('close', 0); };
      return proc;
    });
    const { real, proc } = adapter();
    let finishInitialize!: () => void;
    proc.onRequest('initialize', (message) => {
      events.push('initialize');
      finishInitialize = () => proc.respond(message.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
    });
    mocks.launch.mockImplementation(async () => { events.push('config-launch'); return { command: 'opencode', major: 1 }; });
    const spawning = real.spawn();
    // Bound the actual factory path without advancing the gate's 30-second safety timer.
    await vi.waitFor(() => expect(events).toContain('metadata-start'), { timeout: 1000 });
    const competing = withOpenCodeProcessGate(async () => { events.push('other-reader'); });
    await Promise.resolve();
    expect(events).toEqual(['metadata-start']);
    finishMetadata();
    await vi.waitFor(() => expect(events).toContain('initialize'), { timeout: 1000 });
    const afterStart = openCodeProcessGate().then((release) => { events.push('after-start'); release(); });
    await Promise.resolve();
    expect(events).not.toContain('after-start');
    finishInitialize();
    await spawning;
    await competing;
    await afterStart;
    expect(events).toEqual(['metadata-start', 'metadata-end', 'other-reader', 'config-launch', 'initialize', 'after-start']);
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toHaveLength(1);
    proc.exit();
    const warm = adapter();
    await warm.real.spawn();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    warm.proc.exit();
  });

  it('releases locks and concurrency slots after missing metadata, then retries a cold start', async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: vi.fn() });
      queueMicrotask(() => proc.emit('error', new Error('metadata lister failed')));
      return proc;
    });
    const failed = adapter();
    await expect(failed.real.spawn()).rejects.toThrow(/no model metadata/);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
    const release = await openCodeProcessGate();
    release();
    mocks.spawn.mockImplementationOnce(() => {
      const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: vi.fn() });
      queueMicrotask(() => { proc.stdout.write(verbose); proc.emit('close', 0); });
      return proc;
    });
    const retry = adapter();
    await retry.real.spawn();
    retry.proc.exit();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledTimes(2);
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it('keeps timed-out metadata protected until close before allowing config probes or competing readers', async () => {
    vi.useFakeTimers();
    const lister = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(lister);
    const { real } = adapter();
    const spawning = real.spawn().then(() => undefined, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    let competingEntered = false;
    const competing = withOpenCodeProcessGate(async () => { competingEntered = true; });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.launch).not.toHaveBeenCalled();
      expect(competingEntered).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(lister.kill).toHaveBeenCalledWith('SIGKILL');
      expect(mocks.launch).not.toHaveBeenCalled();
    } finally {
      lister.emit('close', null);
      expect(await spawning).toMatchObject({ message: expect.stringContaining('no model metadata') });
      await competing;
    }
    expect(competingEntered).toBe(true);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(getCachedOpenCodeRegionModelMetadata('ams')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

});


const accountOptions = (selected: string, target: string, previous: string) => [{
  id: 'model', category: 'model', currentValue: selected,
  options: [{ value: previous }, { value: target }],
}];

function successfulMetadataLister(modelId: string) {
  mocks.spawn.mockImplementation(() => {
    const lister = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: vi.fn() });
    queueMicrotask(() => {
      lister.stdout.write([`xiaomi-token-plan-ams/${modelId}`, JSON.stringify({ id: modelId,
        api: { npm: '@ai-sdk/openai-compatible', url: 'https://token-plan-ams.xiaomimimo.com/v1' },
        limit: { context: 1000000, output: 16384 } })].join('\n'));
      lister.emit('close', 0);
    });
    return lister;
  });
}

function routedAdapter(proc: ReturnType<typeof createInitializedAgentHarness>, modelId: string, resume: boolean) {
  const real = createOpenCodeAdapter({ workingDirectory: '/tmp', model: `xiaomi-token-plan-ams/${modelId}`,
    ...(resume ? { resume: true, sessionId: 'sess-acp-1' } : {}),
    accountRoute: { provider: 'opencode', profileId: 'account-b', region: 'ams', source: 'default',
      executionNodeId: mocks.worker ? 'worker' : 'local' } });
  vi.spyOn(real, 'checkStatus').mockResolvedValue({ available: true });
  vi.spyOn(real as unknown as { spawnProcess: () => ChildProcess }, 'spawnProcess').mockImplementation(() => proc as unknown as ChildProcess);
  return real;
}

describe('routed MiMo factory startup requires confirmed native account selection', () => {
  describe.each([{ resume: false, worker: false }, { resume: true, worker: true }])('startup %j', ({ resume, worker }) => {
    it.each(['rejected', 'rejected-no-options', 'rejected-then-matching-notification', 'unavailable', 'mismatched-response', 'late-notification', 'late-budget-notification'] as const)(
      'refuses startup, releases resources and sends no prompt when %s', async (mode) => {
        mocks.worker = worker;
        const modelId = mode === 'late-budget-notification' ? 'mimo-v2.6-pro' : 'mimo-v2.6-flash';
        const target = `aio-mimo-account-b/${modelId}`;
        const previous = `aio-mimo-account-a/${modelId}`;
        successfulMetadataLister(modelId);
        const proc = createInitializedAgentHarness();
        proc.onRequest(resume ? 'session/load' : 'session/new', (request) => proc.respond(request.id, {
          sessionId: 'sess-acp-1', ...(mode === 'rejected-no-options' ? {} : { configOptions: mode === 'unavailable'
            ? [{ id: 'model', category: 'model', currentValue: previous, options: [{ value: previous }] }]
            : accountOptions(previous, target, previous) }),
        }));
        proc.onRequest('session/set_config_option', (request) => {
          if (mode.startsWith('rejected')) {
            proc.respondError(request.id, -32602, 'Synthetic rejected account model');
            if (mode === 'rejected-then-matching-notification') proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
              sessionUpdate: 'config_option_update', configOptions: accountOptions(target, target, previous),
            } });
          }
          else if (mode === 'mismatched-response') proc.respond(request.id, { configOptions: accountOptions(previous, target, previous) });
          else {
            proc.respond(request.id, { configOptions: accountOptions(target, target, previous) });
            proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
              sessionUpdate: 'config_option_update', configOptions: accountOptions(previous, target, previous),
            } });
          }
        });
        const real = routedAdapter(proc, modelId, resume);
        const statuses: string[] = [];
        real.on('status', (status) => statuses.push(status));
        try {
          await expect(real.spawn()).rejects.toThrow(/Unable to confirm the selected model/);
          expect(statuses).not.toContain('ready');
          expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toEqual([]);
          expect(mocks.release).toHaveBeenCalledOnce();
          expect(mocks.cleanup).toHaveBeenCalledOnce();
          const release = await openCodeProcessGate();
          release();
        } finally { proc.exit(); }
      },
    );

    it.each(['already-selected', 'acknowledged-options', 'acknowledged-no-options', 'effort-rejected', 'foreign-notification'] as const)(
      'accepts confirmed account selection when %s', async (mode) => {
        mocks.worker = worker;
        const modelId = 'mimo-v2.6-flash';
        const target = `aio-mimo-account-b/${modelId}`;
        const previous = `aio-mimo-account-a/${modelId}`;
        successfulMetadataLister(modelId);
        const proc = createInitializedAgentHarness();
        const options = (selected: string) => [...accountOptions(selected, target, previous), {
          id: 'effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }],
        }];
        proc.onRequest(resume ? 'session/load' : 'session/new', (request) => proc.respond(request.id, {
          sessionId: 'sess-acp-1', ...(mode === 'acknowledged-no-options' ? {} : { configOptions: options(mode === 'already-selected' ? target : previous) }),
        }));
        proc.onRequest('session/set_config_option', (request) => {
          if ((request.params as { configId: string }).configId === 'effort') {
            proc.respondError(request.id, -32602, 'Synthetic unsupported effort'); return;
          }
          proc.respond(request.id, mode === 'acknowledged-no-options' ? null : { configOptions: options(target) });
          if (mode === 'foreign-notification') proc.notify('session/update', { sessionId: 'other-session', update: {
            sessionUpdate: 'config_option_update', configOptions: options(previous),
          } });
        });
        const real = routedAdapter(proc, modelId, resume);
        if (mode === 'effort-rejected') {
          (real as unknown as { acpConfig: { sessionConfig: { effort?: string } } }).acpConfig.sessionConfig.effort = 'high';
        }
        try {
          await expect(real.spawn()).resolves.toBe(4242);
          if (mode === 'already-selected') expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/set_config_option')).toEqual([]);
        } finally { proc.exit(); }
      },
    );
  });

  it('retains best-effort startup for unrelated OpenCode models despite an attached MiMo route', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/set_config_option', (request) => proc.respondError(request.id, -32602, 'Synthetic rejected unrelated model'));
    const real = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'openrouter/example-model',
      accountRoute: { provider: 'opencode', profileId: 'account-b', region: 'ams', source: 'default', executionNodeId: 'local' } });
    vi.spyOn(real, 'checkStatus').mockResolvedValue({ available: true });
    vi.spyOn(real as unknown as { spawnProcess: () => ChildProcess }, 'spawnProcess').mockImplementation(() => proc as unknown as ChildProcess);
    try { await expect(real.spawn()).resolves.toBe(4242); expect(mocks.spawn).not.toHaveBeenCalled(); }
    finally { proc.exit(); }
  });
});


describe('opening responses and notifications retain native arrival order', () => {
  describe.each([false, true])('resume=%s', (resume) => {
    it.each(['reject-model', 'accept-model', 'already-selected', 'foreign-notification'] as const)(
      'uses the later native selection for %s before startup confirmation', async (mode) => {
        mocks.worker = resume;
        const target = model;
        const previous = 'aio-mimo-account-a/mimo-v2.6-pro';
        let nativeModel = mode === 'already-selected' ? target : previous;
        const initialModel = mode === 'already-selected' ? previous : target;
        successfulMetadataLister('mimo-v2.6-pro');
        const proc = createInitializedAgentHarness();
        proc.onRequest(resume ? 'session/load' : 'session/new', (request) => {
          // These two native lines arrive in one stdout event, before await resumes.
          proc.stdout.write([
            JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'sess-acp-1',
              configOptions: accountOptions(initialModel, target, previous) } }),
            JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: mode === 'foreign-notification' ? 'other-session' : 'sess-acp-1',
              update: { sessionUpdate: 'config_option_update', configOptions: accountOptions(nativeModel, target, previous) },
            } }),
          ].join('\n') + '\n');
          if (mode === 'foreign-notification') nativeModel = target;
        });
        proc.onRequest('session/set_config_option', (request) => {
          if (mode === 'reject-model') proc.respondError(request.id, -32602, 'Synthetic rejected account model');
          else { nativeModel = target; proc.respond(request.id, { configOptions: accountOptions(target, target, previous) }); }
        });
        const real = routedAdapter(proc, 'mimo-v2.6-pro', resume);
        const statuses: string[] = [];
        real.on('status', (status) => statuses.push(status));
        try {
          const error = await real.spawn().then(() => undefined, (err: Error) => err);
          const writes = proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/set_config_option');
          if (mode === 'reject-model') {
            expect(error?.message).toMatch(/Unable to confirm the selected model/);
            expect(nativeModel).toBe(previous);
            expect(statuses).not.toContain('ready');
            expect(mocks.cleanup).toHaveBeenCalledOnce();
            expect(mocks.release).toHaveBeenCalledOnce();
            expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toEqual([]);
          } else {
            expect(error).toBeUndefined();
            expect(nativeModel).toBe(target);
            expect(statuses).toContain('ready');
          }
          expect(writes).toHaveLength(mode === 'reject-model' || mode === 'accept-model' ? 1 : 0);
          expect(real.getSessionId()).toBe('sess-acp-1');
        } finally { proc.exit(); }
      },
    );

    it('refuses an opening request error without adopting a subsequent unsolicited session update', async () => {
      successfulMetadataLister('mimo-v2.6-pro');
      const proc = createInitializedAgentHarness();
      proc.onRequest(resume ? 'session/load' : 'session/new', (request) => {
        proc.respondError(request.id, -32602, 'Synthetic failed opening request');
        proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
          sessionUpdate: 'config_option_update', configOptions: accountOptions(model, model, model),
        } });
      });
      const real = routedAdapter(proc, 'mimo-v2.6-pro', resume);
      const statuses: string[] = [];
      real.on('status', (status) => statuses.push(status));
      try {
        await expect(real.spawn()).rejects.toThrow('Synthetic failed opening request');
        expect(real.getSessionId()).toBeNull();
        expect(statuses).not.toContain('ready');
        expect(mocks.cleanup).toHaveBeenCalledOnce();
        expect(mocks.release).toHaveBeenCalledOnce();
        expect(proc.receivedMessages.filter((message) => 'method' in message
          && ['session/set_config_option', 'session/prompt'].includes(message.method))).toEqual([]);
      } finally { proc.exit(); }
    });
  });

  it.each([undefined, '', ' ', 42])('rejects an invalid fresh session identity (%s)', async (sessionId) => {
    successfulMetadataLister('mimo-v2.6-pro');
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/new', (request) => proc.respond(request.id, {
      sessionId, configOptions: accountOptions(model, model, model),
    }));
    const real = routedAdapter(proc, 'mimo-v2.6-pro', false);
    const statuses: string[] = [];
    real.on('status', (status) => statuses.push(status));
    try {
      await expect(real.spawn()).rejects.toThrow('session/new response requires a sessionId');
      expect(real.getSessionId()).toBeNull();
      expect(statuses).not.toContain('ready');
      expect(mocks.cleanup).toHaveBeenCalledOnce();
      expect(mocks.release).toHaveBeenCalledOnce();
    } finally { proc.exit(); }
  });

  it.each(['null-response', 'foreign-response-identity'] as const)('uses the requested resume identity with %s', async (mode) => {
    successfulMetadataLister('mimo-v2.6-pro');
    const previous = 'aio-mimo-account-a/mimo-v2.6-pro';
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/load', (request) => {
      expect((request.params as { sessionId: string }).sessionId).toBe('sess-acp-1');
      proc.respond(request.id, mode === 'null-response' ? null : {
        sessionId: 'foreign-response-id', configOptions: accountOptions(model, model, previous),
      });
      proc.notify('session/update', { sessionId: 'foreign-response-id', update: {
        sessionUpdate: 'config_option_update', configOptions: accountOptions(previous, model, previous),
      } });
    });
    proc.onRequest('session/set_config_option', (request) => proc.respond(request.id, null));
    const real = routedAdapter(proc, 'mimo-v2.6-pro', true);
    try {
      await expect(real.spawn()).resolves.toBe(4242);
      expect(real.getSessionId()).toBe('sess-acp-1');
      expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/set_config_option'))
        .toHaveLength(mode === 'null-response' ? 1 : 0);
    } finally { proc.exit(); }
  });
});

describe.each([false, true])('legacy regional factory startup (resume=%s)', (resume) => {
  describe.each(['mimo-v2.6-pro', 'mimo-v2.6-flash'])('native model %s', (modelId) => {
    describe.each(['ams', 'sgp', 'cn'] as const)('target region %s', (region) => {
      it.each(['confirmed', 'refused', 'mismatched-response', 'superseded-notification'] as const)(
        'requires the derived native regional selection when %s', async (mode) => {
          mocks.worker = resume;
          successfulMetadataLister(modelId);
          const source = region === 'ams' ? 'sgp' : 'ams';
          const logical = `xiaomi-token-plan-${source}/${modelId}`;
          const expected = `xiaomi-token-plan-${region}/${modelId}`;
          let native = logical;
          const options = () => accountOptions(native, expected, logical);
          const proc = createInitializedAgentHarness();
          proc.onRequest(resume ? 'session/load' : 'session/new', (request) => proc.respond(request.id, {
            sessionId: 'sess-acp-1', configOptions: options(),
          }));
          proc.onRequest('session/set_config_option', (request) => {
            if (mode === 'refused') { proc.respondError(request.id, -32602, 'Synthetic refused regional target'); return; }
            if (mode !== 'mismatched-response') native = (request.params as { value: string }).value;
            proc.respond(request.id, { configOptions: options() });
            if (mode === 'superseded-notification') {
              native = logical;
              proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
                sessionUpdate: 'config_option_update', configOptions: options(),
              } });
            }
          });
          const real = createOpenCodeAdapter({ workingDirectory: '/tmp', model: logical,
            ...(resume ? { resume: true, sessionId: 'sess-acp-1' } : {}),
            accountRoute: { provider: 'opencode', profileId: 'legacy', region, source: 'default',
              executionNodeId: resume ? 'worker' : 'local' } });
          vi.spyOn(real, 'checkStatus').mockResolvedValue({ available: true });
          vi.spyOn(real as unknown as { spawnProcess: () => ChildProcess }, 'spawnProcess')
            .mockImplementation(() => proc as unknown as ChildProcess);
          const statuses: string[] = [];
          real.on('status', (status) => statuses.push(status));
          try {
            if (mode === 'confirmed') {
              await expect(real.spawn()).resolves.toBe(4242);
              expect(native).toBe(expected);
              expect(statuses).toContain('ready');
            } else {
              await expect(real.spawn()).rejects.toThrow(/Unable to confirm the selected model/);
              expect(native).toBe(logical);
              expect(statuses).not.toContain('ready');
              expect(mocks.cleanup).toHaveBeenCalledOnce();
              expect(mocks.release).toHaveBeenCalledOnce();
            }
            // The real factory's generation-budget probe must target the routed
            // region; non-budget models keep the usual unscoped config probe.
            expect(mocks.probe.mock.calls.map(([params]) => params.model))
              .toEqual(modelId === 'mimo-v2.6-pro' ? [expected, expected] : [undefined, undefined]);
            const writes = proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/set_config_option');
            expect(writes).toHaveLength(1);
            expect(writes[0]).toMatchObject({ params: { configId: 'model', value: expected } });
            expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toEqual([]);
            expect(real.getSessionId()).toBe('sess-acp-1');
          } finally { proc.exit(); }
        },
      );
    });
  });
});
