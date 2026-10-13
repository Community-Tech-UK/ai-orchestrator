import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { ResumeAttemptResult } from '../../cli/adapters/base-cli-adapter.types';
import { createInstance, type Instance, type InstanceWaitReason } from '../../../shared/types/instance.types';
import type { InstanceStateUpdatePayload, BatchUpdatePayload } from '../../../shared/types/ipc.types';
import type { AppSettings } from '../../../shared/types/settings.types';
import type { LifecycleDependencies } from '../instance-lifecycle.types';
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/aio-readiness-test',
    getAppPath: () => '/tmp/aio-readiness-test', getVersion: () => '0.0.0' },
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../observability/lifecycle-trace', () => ({ recordLifecycleTrace: vi.fn() }));
vi.mock('../../session/session-mutex', () => ({
  getSessionMutex: () => ({ acquire: vi.fn().mockResolvedValue(() => undefined) }),
}));
vi.mock('../../session/session-continuity', () => ({
  getSessionContinuityManager: () => ({
    writeThroughIdentityLocked: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('./create-validation-helpers', () => ({
  getKnownModelsForCli: vi.fn().mockResolvedValue(['sonnet']),
}));

import { InstanceLifecycleManager } from '../instance-lifecycle';
import { InstanceStateManager } from '../instance-state';
import { RuntimeReadinessCoordinator, type ResumeHealthVerdict } from './runtime-readiness';
import { RuntimeReconciler } from './runtime-reconciler';
import { SpawnConfigBuilder } from './spawn-config-builder';
import { _resetAdapterLoansForTesting } from './adapter-loan-registry';

class ControlledAdapter extends EventEmitter {
  confirmed = false;
  spawn = vi.fn().mockResolvedValue(42);
  terminate = vi.fn().mockResolvedValue(undefined);
  sendInput = vi.fn().mockResolvedValue(undefined);
  queueNextPromptContext = vi.fn();
  getName(): string { return 'example-controlled-cli'; }
  getResumeAttemptResult(): ResumeAttemptResult | null {
    return this.confirmed ? { source: 'native', confirmed: true } : null;
  }
}

function asCliAdapter(adapter: ControlledAdapter): CliAdapter {
  // The concrete adapter union includes process internals unrelated to this probe.
  return adapter as unknown as CliAdapter;
}

interface LifecycleProbe {
  deps: Pick<LifecycleDependencies, 'getInstance' | 'getAdapter' | 'queueUpdate'>;
  runtimeReadiness: RuntimeReadinessCoordinator;
  evaluateResumeHealth(id: string, timeoutMs: number, pollIntervalMs: number): Promise<ResumeHealthVerdict>;
}

const states: InstanceStateManager[] = [];
const holds: InstanceWaitReason[] = [
  { kind: 'auth-required', provider: 'claude', since: 1 },
  { kind: 'quota-park', provider: 'claude', resumeAt: 10_000 },
];

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return Object.assign(createInstance({
    workingDirectory: '/tmp/aio-readiness-test', provider: 'claude',
    sessionId: 'example-native-session',
    initialOutputBuffer: [{ id: 'example-user-message', timestamp: 1, type: 'user', content: 'Example request' }],
  }), { id: 'example-instance', status: 'idle' as const, processId: 42, currentModel: 'sonnet' }, overrides);
}

async function startRuntimeChange(crashRecovery = false) {
  const instance = makeInstance(crashRecovery ? { metadata: { reason: 'crash-recovery' } } : {});
  const state = new InstanceStateManager();
  states.push(state);
  state.setInstance(instance);
  state.setAdapter(instance.id, asCliAdapter(new ControlledAdapter()));
  const resume = new ControlledAdapter();
  const updates: InstanceStateUpdatePayload[] = [];
  state.on('batch-update', (batch: BatchUpdatePayload) => updates.push(...structuredClone(batch.updates)));
  const shared = {
    getInstance: state.getRuntimeInstance.bind(state),
    getAdapter: state.getRuntimeAdapter.bind(state),
    queueUpdate: state.queueUpdate.bind(state),
  };
  // Exercise the actual private wrapper without constructing unrelated lifecycle monitors.
  const lifecycle = Object.assign(Object.create(InstanceLifecycleManager.prototype) as LifecycleProbe, {
    deps: shared,
    runtimeReadiness: new RuntimeReadinessCoordinator({ ...shared, getResumeHealthLoadMultiplier: () => 1 }),
  });
  const spawnConfigBuilder = Object.assign(Object.create(SpawnConfigBuilder.prototype) as SpawnConfigBuilder, {
    getMcpConfig: () => undefined,
    getChromeDevtoolsMcpOptions: () => undefined,
    getBrowserGatewayMcpOptions: () => undefined,
    getPermissionHookPath: () => undefined,
    getRtkSpawnConfig: () => undefined,
  });
  const deps: RuntimeReconcilerDeps = {
    ...shared,
    setAdapter: state.setAdapter.bind(state),
    deleteAdapter: state.deleteRuntimeAdapter.bind(state),
    setupAdapterEvents: vi.fn(),
    transitionState: (current, status) => { current.status = status; },
    resolveCliTypeForInstance: async () => 'claude',
    getAdapterRuntimeCapabilities: () => ({ supportsResume: true, supportsForkSession: true }),
    assertLocalModelRuntimeAvailable: vi.fn().mockResolvedValue(undefined),
    residentClaudeForSpawn: () => false,
    createRuntimeAdapter: vi.fn().mockResolvedValue(asCliAdapter(resume)),
    evaluateResumeHealth: id => lifecycle.evaluateResumeHealth(id, 1000, 20),
    waitForInputReadinessBoundary: vi.fn().mockResolvedValue(undefined),
    prepareStatusForAdapterInput: vi.fn(),
    buildReplayContinuityMessage: () => 'Example continuity',
    buildFallbackHistory: vi.fn().mockResolvedValue('Example history'),
    emitModelSelectionDegradation: vi.fn(),
    emitSystemNotice: vi.fn(),
    emitRuntimeChanged: vi.fn(),
    emitYoloToggled: vi.fn(),
    getSettings: () => ({ defaultCli: 'claude' } as AppSettings),
    spawnConfigBuilder,
  };
  const reconciler = new RuntimeReconciler(deps);
  const result = Promise.allSettled([
    reconciler.applyRuntimeChange(instance.id, { provider: 'claude', yoloMode: true }),
  ]).then(([outcome]) => outcome);
  await vi.advanceTimersByTimeAsync(0);
  expect(resume.spawn).toHaveBeenCalledOnce();
  expect(instance.waitReason?.kind).toBe('resume-proof');
  expect(state.getRuntimeAdapter(instance.id)).toBe(resume);
  return { instance, state, resume, lifecycle, updates, result };
}

function publishHold(state: InstanceStateManager, instance: Instance, hold: InstanceWaitReason): void {
  state.queueUpdate(instance.id, instance.status, instance.contextUsage, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, hold, { desiredRuntime: instance.desiredRuntime });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  _resetAdapterLoansForTesting();
});
afterEach(() => {
  for (const state of states.splice(0)) state.destroy();
  _resetAdapterLoansForTesting();
  vi.useRealTimers();
});

describe('runtime-change native proof cleanup through the lifecycle and main batching', () => {
  it.each([false, true])('clears its own proof after success (crash recovery: %s)', async crashRecovery => {
    const h = await startRuntimeChange(crashRecovery);
    if (crashRecovery) expect(h.instance.waitReason).toMatchObject({ sessionId: '[recovery session omitted]' });
    h.resume.confirmed = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(await h.result).toEqual({ status: 'fulfilled', value: h.instance });
    expect(h.instance.waitReason).toBeUndefined();
    expect(h.updates.at(-1)?.waitReason).toBeNull();
    expect(h.state.getRuntimeAdapter(h.instance.id)).toBe(h.resume);
    expect(h.resume.terminate).not.toHaveBeenCalled();
  });

  it.each(holds)('preserves the replacement $kind hold while rejecting the old request', async hold => {
    const expectedHold = structuredClone(hold);
    const h = await startRuntimeChange();
    const replacement = makeInstance({ status: 'busy', processId: 99, currentModel: 'example-new-model',
      desiredRuntime: { provider: 'claude', model: 'example-new-target' } });
    const desired = replacement.desiredRuntime;
    const next = new ControlledAdapter();
    h.state.setInstance(replacement);
    h.state.setAdapter(replacement.id, asCliAdapter(next));
    publishHold(h.state, replacement, hold);
    await vi.advanceTimersByTimeAsync(200);
    expect(await h.result).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
    expect(h.state.getInstance(replacement.id)).toBe(replacement);
    expect(replacement.status).toBe('busy');
    expect(replacement.currentModel).toBe('example-new-model');
    expect(replacement.desiredRuntime).toBe(desired);
    expect(replacement.desiredRuntime).toEqual({ provider: 'claude', model: 'example-new-target' });
    expect(h.state.getRuntimeAdapter(replacement.id)).toBe(next);
    expect(next.terminate).not.toHaveBeenCalled();
    expect(replacement.waitReason).toEqual(expectedHold);
    expect(h.updates.at(-1)).toMatchObject({ status: 'busy', waitReason: expectedHold, desiredRuntime: desired });
  });

  it.each(holds)('preserves a newer $kind hold on the same instance after successful proof', async hold => {
    const expectedHold = structuredClone(hold);
    const h = await startRuntimeChange();
    publishHold(h.state, h.instance, hold);
    h.resume.confirmed = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(await h.result).toEqual({ status: 'fulfilled', value: h.instance });
    expect(h.state.getInstance(h.instance.id)).toBe(h.instance);
    expect(h.instance.waitReason).toEqual(expectedHold);
    expect(h.updates.at(-1)?.waitReason).toEqual(expectedHold);
    expect(h.state.getRuntimeAdapter(h.instance.id)).toBe(h.resume);
    expect(h.resume.terminate).not.toHaveBeenCalled();
  });

  it('does not publish cleanup or resurrect an owner removed during the probe', async () => {
    const h = await startRuntimeChange();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.updates.at(-1)?.waitReason?.kind).toBe('resume-proof');
    const published = structuredClone(h.updates);
    h.state.deleteRuntimeInstance(h.instance.id);
    h.state.deleteRuntimeAdapter(h.instance.id);
    await vi.advanceTimersByTimeAsync(200);
    expect(await h.result).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
    expect(h.state.getRuntimeInstance(h.instance.id)).toBeUndefined();
    expect(h.state.getRuntimeAdapter(h.instance.id)).toBeUndefined();
    expect(h.updates).toEqual(published);
  });

  it('keeps an overlapping same-clock proof until its own later probe finishes', async () => {
    const h = await startRuntimeChange();
    const firstProof = h.instance.waitReason;
    let secondFinished = false;
    const second = h.lifecycle.evaluateResumeHealth(h.instance.id, 1000, 200).then(verdict => {
      secondFinished = true;
      return verdict;
    });
    const secondProof = h.instance.waitReason;
    expect(secondProof).toEqual(firstProof);
    expect(secondProof).not.toBe(firstProof);
    h.resume.confirmed = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(await h.result).toEqual({ status: 'fulfilled', value: h.instance });
    expect(secondFinished).toBe(false);
    expect(h.instance.waitReason).toBe(secondProof);
    expect(h.updates.at(-1)?.waitReason).toEqual(secondProof);
    await vi.advanceTimersByTimeAsync(100);
    expect(await second).toBe('healthy');
    expect(h.instance.waitReason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.updates.at(-1)?.waitReason).toBeNull();
  });
});

function observeFirstProbeTeardown(
  h: Awaited<ReturnType<typeof startRuntimeChange>>,
  onTeardown: () => void,
) {
  const observed = vi.fn(onTeardown);
  let ran = false;
  h.resume.on('removeListener', (eventName: string) => {
    if (eventName !== 'output' || ran) return;
    ran = true;
    observed();
  });
  return observed;
}

describe('native proof retries retain their instance and wait-reason ownership', () => {
  it.each([undefined, ...holds])('keeps a successful retry and its newer hold: %j', async hold => {
    const expectedHold = hold ? structuredClone(hold) : undefined;
    const h = await startRuntimeChange();
    const retry = vi.spyOn(h.lifecycle, 'evaluateResumeHealth');
    const teardown = observeFirstProbeTeardown(h, () => {
      if (hold) publishHold(h.state, h.instance, hold);
      h.resume.confirmed = true;
    });
    await vi.advanceTimersByTimeAsync(1200);
    expect(teardown).toHaveBeenCalledOnce();
    // The first actual probe was already running when the spy was attached.
    expect(retry).toHaveBeenCalledOnce();
    expect(await h.result).toEqual({ status: 'fulfilled', value: h.instance });
    expect(h.state.getRuntimeInstance(h.instance.id)).toBe(h.instance);
    expect(h.state.getRuntimeAdapter(h.instance.id)).toBe(h.resume);
    expect(h.resume.terminate).not.toHaveBeenCalled();
    expect(h.instance.waitReason).toEqual(expectedHold);
    expect(h.updates.at(-1)?.waitReason).toEqual(expectedHold ?? null);
  });

  it.each(holds)('rejects a stale retry before evaluating a replacement with $kind', async hold => {
    const expectedHold = structuredClone(hold);
    const h = await startRuntimeChange();
    const retry = vi.spyOn(h.lifecycle, 'evaluateResumeHealth');
    const replacement = makeInstance({ status: 'busy', processId: 99, currentModel: 'example-new-model',
      desiredRuntime: { provider: 'claude', model: 'example-new-target' } });
    const next = new ControlledAdapter();
    next.confirmed = true;
    const teardown = observeFirstProbeTeardown(h, () => {
      h.state.setInstance(replacement);
      h.state.setAdapter(replacement.id, asCliAdapter(next));
      publishHold(h.state, replacement, hold);
    });
    await vi.advanceTimersByTimeAsync(1200);
    expect(teardown).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(await h.result).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
    expect(h.state.getRuntimeInstance(replacement.id)).toBe(replacement);
    expect(h.state.getRuntimeAdapter(replacement.id)).toBe(next);
    expect(next.terminate).not.toHaveBeenCalled();
    expect(replacement.status).toBe('busy');
    expect(replacement.currentModel).toBe('example-new-model');
    expect(replacement.desiredRuntime).toEqual({ provider: 'claude', model: 'example-new-target' });
    expect(replacement.waitReason).toEqual(expectedHold);
    expect(h.updates.at(-1)).toMatchObject({ status: 'busy', waitReason: expectedHold,
      desiredRuntime: { provider: 'claude', model: 'example-new-target' } });
  });

  it.each(['terminated', 'removed'] as const)('does not retry an owner that becomes %s', async owner => {
    const h = await startRuntimeChange();
    const retry = vi.spyOn(h.lifecycle, 'evaluateResumeHealth');
    const teardown = observeFirstProbeTeardown(h, () => {
      if (owner === 'terminated') h.instance.status = 'terminated';
      else {
        h.state.deleteRuntimeInstance(h.instance.id);
        h.state.deleteRuntimeAdapter(h.instance.id);
      }
    });
    await vi.advanceTimersByTimeAsync(1200);
    expect(teardown).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(await h.result).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
    expect(h.resume.terminate).not.toHaveBeenCalled();
    if (owner === 'terminated') {
      expect(h.state.getRuntimeInstance(h.instance.id)).toBe(h.instance);
      expect(h.instance.status).toBe('terminated');
      expect(h.state.getRuntimeAdapter(h.instance.id)).toBe(h.resume);
    } else {
      expect(h.state.getRuntimeInstance(h.instance.id)).toBeUndefined();
      expect(h.state.getRuntimeAdapter(h.instance.id)).toBeUndefined();
    }
  });

  it.each([...holds, { kind: 'respawning', strategy: 'native-resume', startedAt: 1 } as const])(
    'evaluates health without publishing or clearing an existing $kind reason', async hold => {
      const expectedHold = structuredClone(hold);
      const h = await startRuntimeChange();
      h.resume.confirmed = true;
      await vi.advanceTimersByTimeAsync(200);
      expect(await h.result).toEqual({ status: 'fulfilled', value: h.instance });
      publishHold(h.state, h.instance, hold);
      const publish = vi.spyOn(h.lifecycle.deps, 'queueUpdate');
      await expect(h.lifecycle.evaluateResumeHealth(h.instance.id, 1000, 20)).resolves.toBe('healthy');
      expect(publish).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.instance.waitReason).toEqual(expectedHold);
      expect(h.updates.at(-1)?.waitReason).toEqual(expectedHold);
    },
  );

  it('evaluates health without proof publication when there is no session identity', async () => {
    const h = await startRuntimeChange();
    h.resume.confirmed = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(await h.result).toEqual({ status: 'fulfilled', value: h.instance });
    h.instance.sessionId = '';
    h.instance.providerSessionId = '';
    const before = structuredClone(h.updates);
    const publish = vi.spyOn(h.lifecycle.deps, 'queueUpdate');
    await expect(h.lifecycle.evaluateResumeHealth(h.instance.id, 1000, 20)).resolves.toBe('healthy');
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.instance.waitReason).toBeUndefined();
    expect(h.updates).toEqual(before);
  });
});
