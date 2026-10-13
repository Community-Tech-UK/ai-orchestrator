import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DesiredRuntimeQueue, type DesiredRuntimeQueueDeps } from './desired-runtime-queue';
import { AdapterOnLoanError, beginAdapterLoan, endAdapterLoan, isAdapterOnLoan, onAdapterLoanReleased, type AdapterLoan } from './adapter-loan-registry';
import { computeRuntimeDiff, planContinuity } from './runtime-reconciler-plan';
import { getModelSwitchUnavailableReason } from '../../../shared/types/instance-status-policy';
import type { DesiredRuntime, Instance, InstanceStatus } from '../../../shared/types/instance.types';
import type { BatchUpdatePayload } from '../../../shared/types/ipc.types';
import { LIMITS } from '../../../shared/constants/limits';
import { InstanceStateManager } from '../instance-state';

/** Flush pending setImmediate callbacks. */
const flushMacrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeInstance(status: InstanceStatus, overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    status,
    provider: 'claude',
    currentModel: 'opus',
    reasoningEffort: 'high',
    desiredRuntime: undefined,
    ...overrides,
  } as unknown as Instance;
}

interface Harness {
  instance: Instance;
  queue: DesiredRuntimeQueue;
  applyChange: ReturnType<typeof vi.fn>;
  publishPendingState: ReturnType<typeof vi.fn>;
  notifyApplyFailure: ReturnType<typeof vi.fn>;
}

function makeHarness(
  instance: Instance,
  applyImpl?: (id: string, desired: DesiredRuntime) => Promise<Instance>,
): Harness {
  const applyChange = vi.fn(
    applyImpl ??
      (async (_id: string, desired: DesiredRuntime) => {
        // Mirror the real reconciler: adopt the desired config.
        instance.provider = desired.provider;
        if (desired.model !== undefined) instance.currentModel = desired.model;
        if (desired.reasoningEffort !== undefined) {
          instance.reasoningEffort = desired.reasoningEffort ?? undefined;
        }
        return instance;
      }),
  );
  const publishPendingState = vi.fn();
  const notifyApplyFailure = vi.fn();
  const deps: DesiredRuntimeQueueDeps = {
    getInstance: (id) => (id === instance.id ? instance : undefined),
    isAdapterOnLoan: () => false,
    applyChange: applyChange as unknown as DesiredRuntimeQueueDeps['applyChange'],
    publishPendingState,
    notifyApplyFailure,
  };
  return { instance, queue: new DesiredRuntimeQueue(deps), applyChange, publishPendingState, notifyApplyFailure };
}

describe('computeRuntimeDiff', () => {
  it('reports no changes when the desired runtime equals the live config', () => {
    const instance = makeInstance('idle');
    expect(
      computeRuntimeDiff(instance, { provider: 'claude', model: 'opus', reasoningEffort: 'high' }).hasChanges,
    ).toBe(false);
  });

  it('treats omitted fields as "unchanged"', () => {
    const instance = makeInstance('idle');
    expect(computeRuntimeDiff(instance, { provider: 'claude' }).hasChanges).toBe(false);
    expect(computeRuntimeDiff(instance, { provider: 'claude', model: 'opus' }).hasChanges).toBe(false);
  });

  it('flags a cross-provider change', () => {
    const instance = makeInstance('idle');
    const diff = computeRuntimeDiff(instance, { provider: 'codex', model: 'gpt-5.5' });
    expect(diff.providerChanged).toBe(true);
    expect(diff.hasChanges).toBe(true);
  });

  it('flags a local-model target change against a CLI instance', () => {
    const instance = makeInstance('idle');
    const diff = computeRuntimeDiff(instance, {
      provider: 'claude',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'this-device',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
        selectorId: 'lm://this-device/ollama/ollama/qwen',
      },
    });
    expect(diff.runtimeTargetChanged).toBe(true);
    expect(diff.providerChanged).toBe(false);
  });

  it('flags leaving a local-model runtime for a CLI provider', () => {
    const instance = makeInstance('idle', {
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'this-device',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
        selectorId: 'lm://this-device/ollama/ollama/qwen',
      },
    });
    const diff = computeRuntimeDiff(instance, { provider: 'claude', model: 'opus' });
    expect(diff.runtimeTargetChanged).toBe(true);
  });
});

describe('planContinuity', () => {
  const caps = { supportsResume: true, supportsForkSession: true };
  const noDiff = { providerChanged: false, modelChanged: true, reasoningChanged: false, runtimeTargetChanged: false, yoloModeChanged: false, copilotAccountChanged: false, accountProfileChanged: false, hasChanges: true };

  it('forces replay for cross-provider changes', () => {
    expect(planContinuity({
      diff: { ...noDiff, providerChanged: true },
      capabilities: caps,
      hasConversation: true,
      cliType: 'codex',
      isLocalModelTarget: false,
    })).toBe('replay');
  });

  it('forces replay for Claude model changes (native resume keeps the old model binding)', () => {
    expect(planContinuity({
      diff: noDiff,
      capabilities: caps,
      hasConversation: true,
      cliType: 'claude',
      isLocalModelTarget: false,
    })).toBe('replay');
  });

  it('prefers a forked native resume when supported', () => {
    expect(planContinuity({
      diff: noDiff,
      capabilities: caps,
      hasConversation: true,
      cliType: 'codex',
      isLocalModelTarget: false,
    })).toBe('native-resume-fork');
  });

  it('falls back to in-place native resume when forking is unsupported', () => {
    expect(planContinuity({
      diff: noDiff,
      capabilities: { supportsResume: true, supportsForkSession: false },
      hasConversation: true,
      cliType: 'codex',
      isLocalModelTarget: false,
    })).toBe('native-resume');
  });

  it('replays when there is no conversation or no resume support', () => {
    expect(planContinuity({
      diff: noDiff,
      capabilities: caps,
      hasConversation: false,
      cliType: 'codex',
      isLocalModelTarget: false,
    })).toBe('replay');
    expect(planContinuity({
      diff: noDiff,
      capabilities: { supportsResume: false, supportsForkSession: false },
      hasConversation: true,
      cliType: 'codex',
      isLocalModelTarget: false,
    })).toBe('replay');
  });
});

describe('DesiredRuntimeQueue', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['idle', 'ready', 'waiting_for_input', 'error'] as const)(
    'applies immediately from %s',
    async (status) => {
      const h = makeHarness(makeInstance(status));
      await h.queue.requestChange('inst-1', { provider: 'codex', model: 'gpt-5.5' });
      expect(h.applyChange).toHaveBeenCalledWith('inst-1', { provider: 'codex', model: 'gpt-5.5' });
      expect(h.instance.provider).toBe('codex');
      expect(h.instance.desiredRuntime).toBeUndefined();
    },
  );

  it('queues (does not apply) while busy and publishes the pending state', async () => {
    const h = makeHarness(makeInstance('busy'));
    await h.queue.requestChange('inst-1', { provider: 'codex', model: 'gpt-5.5' });
    expect(h.applyChange).not.toHaveBeenCalled();
    expect(h.instance.desiredRuntime).toEqual({ provider: 'codex', model: 'gpt-5.5' });
    expect(h.publishPendingState).toHaveBeenCalledWith(h.instance);
  });

  it('re-selecting the live config cancels a queued change', async () => {
    const h = makeHarness(makeInstance('busy'));
    await h.queue.requestChange('inst-1', { provider: 'codex', model: 'gpt-5.5' });
    expect(h.instance.desiredRuntime).toBeDefined();
    await h.queue.requestChange('inst-1', { provider: 'claude', model: 'opus' });
    expect(h.instance.desiredRuntime).toBeUndefined();
    expect(h.applyChange).not.toHaveBeenCalled();
  });

  it('re-selecting the live config from settled is a no-op (no respawn)', async () => {
    const h = makeHarness(makeInstance('idle'));
    await h.queue.requestChange('inst-1', { provider: 'claude', model: 'opus', reasoningEffort: 'high' });
    expect(h.applyChange).not.toHaveBeenCalled();
  });

  it('auto-applies the queued change when the instance settles', async () => {
    const h = makeHarness(makeInstance('busy'));
    await h.queue.requestChange('inst-1', { provider: 'codex', model: 'gpt-5.5' });

    h.instance.status = 'idle';
    h.queue.onSettled(h.instance);
    await flushMacrotasks();

    expect(h.applyChange).toHaveBeenCalledWith('inst-1', { provider: 'codex', model: 'gpt-5.5' });
    expect(h.instance.provider).toBe('codex');
    expect(h.instance.desiredRuntime).toBeUndefined();
  });

  it('does not double-apply when multiple settle transitions fire', async () => {
    const h = makeHarness(makeInstance('busy'));
    await h.queue.requestChange('inst-1', { provider: 'codex', model: 'gpt-5.5' });

    h.instance.status = 'idle';
    h.queue.onSettled(h.instance);
    h.queue.onSettled(h.instance);
    await flushMacrotasks();
    // The apply itself transitions through settled states; simulate that too.
    h.queue.onSettled(h.instance);
    await flushMacrotasks();

    expect(h.applyChange).toHaveBeenCalledTimes(1);
  });

  it('skips a scheduled apply that raced back into a busy state', async () => {
    const h = makeHarness(makeInstance('busy'));
    await h.queue.requestChange('inst-1', { provider: 'claude', model: 'sonnet' });

    h.instance.status = 'idle';
    h.queue.onSettled(h.instance);
    h.instance.status = 'busy'; // new turn started before the macrotask ran
    await flushMacrotasks();

    expect(h.applyChange).not.toHaveBeenCalled();
    expect(h.instance.desiredRuntime).toEqual({ provider: 'claude', model: 'sonnet' });
  });

  it('drops the queued request and notifies on a failed deferred apply', async () => {
    const instance = makeInstance('busy');
    const h = makeHarness(instance, async () => {
      throw new Error('Codex CLI is not installed');
    });
    await h.queue.requestChange('inst-1', { provider: 'codex' });

    instance.status = 'idle';
    h.queue.onSettled(instance);
    await flushMacrotasks();

    expect(instance.desiredRuntime).toBeUndefined();
    expect(h.notifyApplyFailure).toHaveBeenCalledWith(
      instance,
      expect.objectContaining({
        type: 'system',
        content: expect.stringContaining('Codex CLI is not installed'),
      }),
    );
  });

  it('re-queues a deferred apply that lost the status race under the session mutex', async () => {
    // Regression: a queued swap fired on a settled transition, then blocked on
    // the session mutex behind a restart. By the time the reconciler ran, the
    // instance had left the allowed set, so its status gate threw — and the
    // queue dropped the user's swap for good with a misleading transcript note.
    const instance = makeInstance('busy');
    const h = makeHarness(instance, async () => {
      instance.status = 'respawning';
      throw new Error('Model changes are only available while the instance is waiting for user input.');
    });
    await h.queue.requestChange('inst-1', { provider: 'codex', model: 'gpt-5.5' });

    instance.status = 'idle';
    h.queue.onSettled(instance);
    await flushMacrotasks();

    expect(instance.desiredRuntime).toEqual({ provider: 'codex', model: 'gpt-5.5' });
    expect(h.notifyApplyFailure).not.toHaveBeenCalled();
  });

  it('applies a queued change once the instance settles into error (dead provider)', async () => {
    // The escape hatch from a provider that is 503ing: `error` is settled, so
    // the swap must actually run rather than park forever waiting for an idle
    // that only a successful restart of the failing provider could produce.
    const instance = makeInstance('busy');
    const h = makeHarness(instance);
    await h.queue.requestChange('inst-1', { provider: 'codex', model: 'gpt-5.5' });

    instance.status = 'error';
    h.queue.onSettled(instance);
    await flushMacrotasks();

    expect(h.applyChange).toHaveBeenCalledWith('inst-1', { provider: 'codex', model: 'gpt-5.5' });
    expect(instance.desiredRuntime).toBeUndefined();
  });

  it('queues when a settled apply loses the race to a new turn', async () => {
    const instance = makeInstance('idle');
    const h = makeHarness(instance, async () => {
      // The reconciler's status gate rejects because a turn started mid-flight.
      instance.status = 'busy';
      throw new Error('Model changes are only available while the instance is waiting for user input.');
    });
    await h.queue.requestChange('inst-1', { provider: 'codex', model: 'gpt-5.5' });

    expect(instance.desiredRuntime).toEqual({ provider: 'codex', model: 'gpt-5.5' });
    expect(h.publishPendingState).toHaveBeenCalled();
  });

  it('rethrows an immediate apply failure when the instance stayed settled', async () => {
    const instance = makeInstance('idle');
    const h = makeHarness(instance, async () => {
      throw new Error('Cannot switch provider: the Codex CLI is not installed or not available.');
    });
    await expect(h.queue.requestChange('inst-1', { provider: 'codex' })).rejects.toThrow(
      'Codex CLI is not installed',
    );
    expect(instance.desiredRuntime).toBeUndefined();
  });
});

/**
 * LT-020. A `same-session` loop runs on the parent instance's adapter, so the
 * instance can read `idle` between two turns of one in-flight iteration.
 * Applying then SIGTERMs the loop's CLI and kills the loop, so the queue must
 * treat a declared adapter loan as "not a boundary" and wait for its release.
 */
describe('DesiredRuntimeQueue — loop adapter loans (LT-020)', () => {
  function makeLoanHarness(instance: Instance, onLoan: { value: boolean }) {
    const applyChange = vi.fn(async (_id: string, desired: DesiredRuntime) => {
      instance.provider = desired.provider;
      if (desired.model !== undefined) instance.currentModel = desired.model;
      return instance;
    });
    const publishPendingState = vi.fn();
    const deps: DesiredRuntimeQueueDeps = {
      getInstance: (id) => (id === instance.id ? instance : undefined),
      isAdapterOnLoan: () => onLoan.value,
      applyChange: applyChange as unknown as DesiredRuntimeQueueDeps['applyChange'],
      publishPendingState,
      notifyApplyFailure: vi.fn(),
    };
    return { queue: new DesiredRuntimeQueue(deps), applyChange, publishPendingState };
  }

  it('queues rather than applying while the adapter is on loan, even at an idle status', async () => {
    const instance = makeInstance('idle');
    const onLoan = { value: true };
    const h = makeLoanHarness(instance, onLoan);

    await h.queue.requestChange('inst-1', { provider: 'codex', model: 'gpt-5.6-sol' });

    expect(h.applyChange).not.toHaveBeenCalled();
    expect(instance.desiredRuntime).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' });
    expect(instance.provider).toBe('claude');
  });

  it('does not apply on a settle transition that lands mid-loan', async () => {
    const instance = makeInstance('busy');
    const onLoan = { value: true };
    const h = makeLoanHarness(instance, onLoan);
    await h.queue.requestChange('inst-1', { provider: 'codex' });

    instance.status = 'idle';
    h.queue.onSettled(instance);
    await flushMacrotasks();

    expect(h.applyChange).not.toHaveBeenCalled();
    expect(instance.desiredRuntime).toEqual({ provider: 'codex' });
  });

  it('applies when the loan is released — the real iteration boundary', async () => {
    const instance = makeInstance('busy');
    const onLoan = { value: true };
    const h = makeLoanHarness(instance, onLoan);
    await h.queue.requestChange('inst-1', { provider: 'codex', model: 'gpt-5.6-sol' });

    instance.status = 'idle';
    onLoan.value = false;
    h.queue.onAdapterLoanReleased('inst-1');
    await flushMacrotasks();

    expect(h.applyChange).toHaveBeenCalledTimes(1);
    expect(instance.provider).toBe('codex');
    expect(instance.desiredRuntime).toBeUndefined();
  });

  /**
   * The reconciler re-checks the loan after taking the session mutex, so it can
   * reject a change the queue thought was applyable. If that iteration then
   * finishes before the rejection is handled, `canApplyNow` reads true again —
   * and without the typed error the change would be dropped and reported to the
   * user as a permanent failure quoting a transient condition.
   */
  it('re-parks (never drops) a loan rejection even if the loan has already cleared', async () => {
    const instance = makeInstance('idle');
    const onLoan = { value: false };
    const applyChange = vi.fn(async () => { throw new AdapterOnLoanError('inst-1'); });
    const publishPendingState = vi.fn();
    const notifyApplyFailure = vi.fn();
    const queue = new DesiredRuntimeQueue({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      isAdapterOnLoan: () => onLoan.value,
      applyChange: applyChange as unknown as DesiredRuntimeQueueDeps['applyChange'],
      publishPendingState,
      notifyApplyFailure,
    });

    await queue.requestChange('inst-1', { provider: 'codex', model: 'gpt-5.6-sol' });

    expect(notifyApplyFailure).not.toHaveBeenCalled();
    expect(instance.desiredRuntime).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' });
    expect(instance.provider).toBe('claude');
  });

  it('still surfaces a genuine apply failure as a permanent failure', async () => {
    const instance = makeInstance('busy');
    const applyChange = vi.fn(async () => {
      throw new Error('Cannot switch provider: the Codex CLI is not installed.');
    });
    const notifyApplyFailure = vi.fn();
    const queue = new DesiredRuntimeQueue({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      isAdapterOnLoan: () => false,
      applyChange: applyChange as unknown as DesiredRuntimeQueueDeps['applyChange'],
      publishPendingState: vi.fn(),
      notifyApplyFailure,
    });
    await queue.requestChange('inst-1', { provider: 'codex' });

    instance.status = 'idle';
    queue.onSettled(instance);
    await flushMacrotasks();

    expect(notifyApplyFailure).toHaveBeenCalledTimes(1);
    expect(instance.desiredRuntime).toBeUndefined();
  });

  it('ignores a loan release when the instance is still busy', async () => {
    const instance = makeInstance('busy');
    const onLoan = { value: true };
    const h = makeLoanHarness(instance, onLoan);
    await h.queue.requestChange('inst-1', { provider: 'codex' });

    onLoan.value = false;
    h.queue.onAdapterLoanReleased('inst-1');
    await flushMacrotasks();

    expect(h.applyChange).not.toHaveBeenCalled();
    expect(instance.desiredRuntime).toEqual({ provider: 'codex' });
  });
});

describe('DesiredRuntimeQueue — confirmed account completion', () => {
  const accountChange = (profileId = 'example-picked'): DesiredRuntime => ({
    provider: 'claude', accountProfileId: profileId,
    accountHandoffKind: 'explicit', accountHandoffConfirmed: true,
  });
  const accountInstance = (status: InstanceStatus = 'busy') =>
    makeInstance(status, { accountProfileId: 'example-original' });
  function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((onSuccess, onFailure) => { resolve = onSuccess; reject = onFailure; });
    return { promise, resolve, reject };
  }

  it('keeps deferred account ownership visible and pending until the actual handoff finishes', async () => {
    const held = deferred();
    const instance = accountInstance();
    const h = makeHarness(instance, async (_id, desired) => {
      await held.promise;
      instance.accountProfileId = desired.accountProfileId;
      return instance;
    });
    let complete = false;
    const request = h.queue.requestChange(instance.id, accountChange()).then(result => { complete = true; return result; });
    await flushMacrotasks();
    expect(complete).toBe(false);
    expect(h.applyChange).not.toHaveBeenCalled();
    instance.status = 'idle';
    h.queue.onSettled(instance);
    await flushMacrotasks();
    expect(instance.desiredRuntime).toEqual(accountChange());
    expect(instance.accountProfileId).toBe('example-original');
    expect(complete).toBe(false);
    held.resolve();
    await expect(request).resolves.toBe(instance);
    expect(instance.accountProfileId).toBe('example-picked');
    expect(instance.desiredRuntime).toBeUndefined();
  });

  it('rejects a permanent deferred handoff failure instead of returning a queued acknowledgement', async () => {
    const failure = new Error('Example account startup failed');
    const h = makeHarness(accountInstance(), async () => { throw failure; });
    const result = h.queue.requestChange(h.instance.id, accountChange()).catch(error => error);
    h.instance.status = 'idle';
    h.queue.onSettled(h.instance);
    await flushMacrotasks();
    expect(await result).toBe(failure);
    expect(h.instance.desiredRuntime).toBeUndefined();
    expect(h.notifyApplyFailure).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'supersede'] as const)('rejects an unapplied account request on %s and keeps ordinary queue acknowledgements', async action => {
    const h = makeHarness(accountInstance());
    const result = h.queue.requestChange(h.instance.id, accountChange()).catch(error => error);
    const desired: DesiredRuntime = { provider: 'claude', model: action === 'cancel' ? 'opus' : 'sonnet' };
    await expect(h.queue.requestChange(h.instance.id, desired)).resolves.toBe(h.instance);
    expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('superseded or cancelled') }));
    expect(h.instance.desiredRuntime).toEqual(action === 'cancel' ? undefined : desired);
    expect(h.applyChange).not.toHaveBeenCalled();
  });

  it.each(['terminated', 'failed', 'superseded'] as const)('rejects and clears a queued handoff on the wired %s transition', async status => {
    const h = makeHarness(accountInstance());
    const result = h.queue.requestChange(h.instance.id, accountChange()).catch(error => error);
    h.instance.status = status;
    h.queue.onSettled(h.instance);
    expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('no longer change accounts') }));
    expect(h.instance.desiredRuntime).toBeUndefined();
    await flushMacrotasks();
    expect(h.applyChange).not.toHaveBeenCalled();
  });

  describe.each(['coalesced', 'already-published'] as const)('terminal public cleanup with %s pending state', timing => {
    it.each(['terminated', 'failed', 'superseded'] as const)('broadcasts the cleared account target on %s without applying it', async status => {
      vi.useFakeTimers();
      const instance = accountInstance();
      const state = new InstanceStateManager();
      state.setInstance(instance);
      const updates: BatchUpdatePayload['updates'] = [];
      state.on('batch-update', (batch: BatchUpdatePayload) => updates.push(...batch.updates));
      const applyChange = vi.fn(async () => instance);
      const publishPendingState = vi.fn((current: Instance) => state.queueUpdate(current.id, current.status, current.contextUsage,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        { desiredRuntime: current.desiredRuntime ?? null }));
      const queue = new DesiredRuntimeQueue({
        getInstance: () => state.getInstance(instance.id), isAdapterOnLoan: () => false,
        applyChange, publishPendingState, notifyApplyFailure: vi.fn(),
      });
      const request = queue.requestChange(instance.id, accountChange()).catch(error => error);
      try {
        if (timing === 'already-published') {
          await vi.advanceTimersByTimeAsync(LIMITS.OUTPUT_BATCH_INTERVAL_MS);
          expect(updates.at(-1)?.desiredRuntime).toEqual(accountChange());
        }
        instance.status = status;
        state.queueUpdate(instance.id, status, instance.contextUsage);
        queue.onSettled(instance);
        state.queueUpdate(instance.id, status, instance.contextUsage);
        await vi.advanceTimersByTimeAsync(LIMITS.OUTPUT_BATCH_INTERVAL_MS);
        expect(await request).toEqual(expect.objectContaining({ message: expect.stringContaining('no longer change accounts') }));
        expect(instance.desiredRuntime).toBeUndefined();
        expect(instance.accountProfileId).toBe('example-original');
        expect(applyChange).not.toHaveBeenCalled();
        expect(updates.at(-1)).toMatchObject({ instanceId: instance.id, status, desiredRuntime: null });
        queue.onSettled(instance);
        expect(publishPendingState).toHaveBeenCalledTimes(2);
      } finally {
        state.destroy();
        vi.useRealTimers();
      }
    });
  });

  it.each(['status', 'loan'] as const)('preserves the same pending completion through a transient %s requeue', async reason => {
    const instance = accountInstance();
    let attempts = 0;
    const h = makeHarness(instance, async (_id, desired) => {
      if (++attempts === 1) {
        if (reason === 'status') instance.status = 'busy';
        throw reason === 'loan' ? new AdapterOnLoanError(instance.id) : new Error('Example status race');
      }
      instance.accountProfileId = desired.accountProfileId;
      return instance;
    });
    let complete = false;
    const request = h.queue.requestChange(instance.id, accountChange()).then(result => { complete = true; return result; });
    instance.status = 'idle';
    h.queue.onSettled(instance);
    await flushMacrotasks();
    expect(complete).toBe(false);
    expect(instance.desiredRuntime).toEqual(accountChange());
    expect(h.notifyApplyFailure).not.toHaveBeenCalled();
    expect(h.applyChange).toHaveBeenCalledOnce();
    instance.status = 'idle';
    h.queue.onSettled(instance);
    await flushMacrotasks();
    await expect(request).resolves.toBe(instance);
    expect(instance.accountProfileId).toBe('example-picked');
    expect(h.applyChange).toHaveBeenCalledTimes(2);
  });

  it('keeps an immediate account request pending when a loan race moves it into the queue', async () => {
    const instance = accountInstance('idle');
    const h = makeHarness(instance, async (_id, desired) => {
      if (h.applyChange.mock.calls.length === 1) throw new AdapterOnLoanError(instance.id);
      instance.accountProfileId = desired.accountProfileId;
      return instance;
    });
    let complete = false;
    const request = h.queue.requestChange(instance.id, accountChange()).then(result => { complete = true; return result; });
    await flushMacrotasks();
    expect(complete).toBe(false);
    expect(instance.desiredRuntime).toEqual(accountChange());
    h.queue.onAdapterLoanReleased(instance.id);
    await flushMacrotasks();
    await expect(request).resolves.toBe(instance);
  });

  it('does not reject active write ownership early when termination arrives during the apply', async () => {
    const held = deferred();
    const instance = accountInstance();
    const h = makeHarness(instance, async () => { await held.promise; return instance; });
    let complete = false;
    const result = h.queue.requestChange(instance.id, accountChange()).catch(error => error).then(value => { complete = true; return value; });
    instance.status = 'idle';
    h.queue.onSettled(instance);
    await flushMacrotasks();
    instance.status = 'terminated';
    h.queue.onSettled(instance);
    await flushMacrotasks();
    expect(complete).toBe(false);
    held.resolve();
    expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('no longer available') }));
  });

  it('rejects a scheduled account request if the instance was removed before its callback', async () => {
    const instance = accountInstance();
    let removed = false;
    const applyChange = vi.fn();
    const queue = new DesiredRuntimeQueue({
      getInstance: () => removed ? undefined : instance, isAdapterOnLoan: () => false,
      applyChange, publishPendingState: vi.fn(), notifyApplyFailure: vi.fn(),
    });
    const result = queue.requestChange(instance.id, accountChange()).catch(error => error);
    instance.status = 'idle';
    queue.onSettled(instance);
    removed = true;
    await flushMacrotasks();
    expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('not found') }));
    expect(applyChange).not.toHaveBeenCalled();
  });

  it('serializes a matching-original reset behind an active future account write', async () => {
    const held = deferred();
    const instance = accountInstance('idle');
    const h = makeHarness(instance, async (_id, desired) => {
      if (desired.accountProfileId === 'example-picked') await held.promise;
      instance.accountProfileId = desired.accountProfileId;
      return instance;
    });
    const earlier = h.queue.requestChange(instance.id, accountChange());
    let resetComplete = false;
    const reset = h.queue.requestChange(instance.id, accountChange('example-original')).then(result => { resetComplete = true; return result; });
    await flushMacrotasks();
    expect(resetComplete).toBe(false);
    expect(h.applyChange).toHaveBeenCalledOnce();
    expect(instance.desiredRuntime).toEqual(accountChange('example-original'));
    held.resolve();
    await earlier;
    expect(instance.desiredRuntime).toEqual(accountChange('example-original'));
    await flushMacrotasks();
    await expect(reset).resolves.toBe(instance);
    expect(instance.accountProfileId).toBe('example-original');
    expect(h.applyChange).toHaveBeenCalledTimes(2);
    expect(instance.desiredRuntime).toBeUndefined();
  });

  it('never overwrites a newer queued request when an active apply loses a transient race', async () => {
    const held = deferred();
    const instance = accountInstance();
    const h = makeHarness(instance, async () => { await held.promise; throw new AdapterOnLoanError(instance.id); });
    const result = h.queue.requestChange(instance.id, accountChange()).catch(error => error);
    instance.status = 'idle';
    h.queue.onSettled(instance);
    await flushMacrotasks();
    instance.status = 'busy';
    const newer: DesiredRuntime = { provider: 'claude', model: 'sonnet' };
    await h.queue.requestChange(instance.id, newer);
    held.resolve();
    await flushMacrotasks();
    expect(await result).toBeInstanceOf(AdapterOnLoanError);
    expect(instance.desiredRuntime).toEqual(newer);
    expect(h.applyChange).toHaveBeenCalledOnce();
  });

  it('does not run a stale scheduled callback alongside a newer immediate apply', async () => {
    const held = deferred();
    const instance = accountInstance();
    const h = makeHarness(instance, async (_id, desired) => {
      if (desired.model === 'sonnet') { await held.promise; instance.currentModel = desired.model; }
      if (desired.accountProfileId) instance.accountProfileId = desired.accountProfileId;
      return instance;
    });
    const superseded = h.queue.requestChange(instance.id, accountChange()).catch(error => error);
    instance.status = 'idle';
    h.queue.onSettled(instance);
    const immediate = h.queue.requestChange(instance.id, { provider: 'claude', model: 'sonnet' });
    const latest = h.queue.requestChange(instance.id, accountChange('example-latest'));
    await flushMacrotasks();
    expect(await superseded).toBeInstanceOf(Error);
    expect(h.applyChange).toHaveBeenCalledOnce();
    expect(instance.desiredRuntime).toEqual(accountChange('example-latest'));
    held.resolve();
    await immediate;
    await flushMacrotasks();
    await expect(latest).resolves.toBe(instance);
    expect(instance.currentModel).toBe('sonnet');
    expect(instance.accountProfileId).toBe('example-latest');
    expect(h.applyChange).toHaveBeenCalledTimes(2);
  });

  it('resolves a matching-original reset after the earlier write fails without respawning the unchanged runtime', async () => {
    const held = deferred();
    const instance = accountInstance('idle');
    const h = makeHarness(instance, async () => { await held.promise; throw new Error('Example startup failure'); });
    const earlier = h.queue.requestChange(instance.id, accountChange()).catch(error => error);
    let resetComplete = false;
    const reset = h.queue.requestChange(instance.id, accountChange('example-original')).then(result => { resetComplete = true; return result; });
    await flushMacrotasks();
    expect(resetComplete).toBe(false);
    held.resolve();
    expect(await earlier).toBeInstanceOf(Error);
    await flushMacrotasks();
    await expect(reset).resolves.toBe(instance);
    expect(instance.accountProfileId).toBe('example-original');
    expect(h.applyChange).toHaveBeenCalledOnce();
    expect(instance.desiredRuntime).toBeUndefined();
  });

  it('publishes immediate account ownership before an idle original account can be mistaken for readiness', async () => {
    const held = deferred();
    const instance = accountInstance('idle');
    const snapshots: (DesiredRuntime | undefined)[] = [];
    const queue = new DesiredRuntimeQueue({
      getInstance: () => instance, isAdapterOnLoan: () => false, notifyApplyFailure: vi.fn(),
      publishPendingState: () => snapshots.push(instance.desiredRuntime),
      applyChange: async (_id, desired) => { await held.promise; instance.accountProfileId = desired.accountProfileId; return instance; },
    });
    const request = queue.requestChange(instance.id, accountChange());
    expect(instance.status).toBe('idle');
    expect(instance.accountProfileId).toBe('example-original');
    expect(snapshots).toEqual([accountChange()]);
    held.resolve();
    await request;
    expect(snapshots).toEqual([accountChange(), undefined]);
    expect(instance.accountProfileId).toBe('example-picked');
  });

  it.each([
    ['immediate', 'loan'], ['deferred', 'loan'], ['immediate', 'status'], ['deferred', 'status'],
  ] as const)('consumes the sole %s %s boundary that preceded transient rejection exactly once', async (mode, reason) => {
    const instance = accountInstance(mode === 'immediate' ? 'idle' : 'busy');
    let attempts = 0;
    const h = makeHarness(instance, async (_id, desired) => {
      if (++attempts === 1) {
        if (reason === 'loan') {
          h.queue.onAdapterLoanReleased(instance.id);
          throw new AdapterOnLoanError(instance.id);
        }
        instance.status = 'busy'; h.queue.onSettled(instance);
        const gateError = new Error(getModelSwitchUnavailableReason(instance.status));
        instance.status = 'idle'; h.queue.onSettled(instance);
        throw gateError;
      }
      instance.accountProfileId = desired.accountProfileId;
      return instance;
    });
    const request = h.queue.requestChange(instance.id, accountChange());
    if (mode === 'deferred') { instance.status = 'idle'; h.queue.onSettled(instance); }
    await flushMacrotasks(); await flushMacrotasks();
    await expect(request).resolves.toBe(instance);
    expect(instance.accountProfileId).toBe('example-picked');
    expect(instance.desiredRuntime).toBeUndefined();
    expect(h.applyChange).toHaveBeenCalledTimes(2);
    expect(h.notifyApplyFailure).not.toHaveBeenCalled();
  });

  it.each(['immediate', 'deferred'] as const)('does not spin an %s transient rejection without a new external boundary', async mode => {
    const instance = accountInstance(mode === 'immediate' ? 'idle' : 'busy');
    const h = makeHarness(instance, async () => { throw new AdapterOnLoanError(instance.id); });
    let settled = false;
    const result = h.queue.requestChange(instance.id, accountChange()).catch(error => error).then(value => { settled = true; return value; });
    if (mode === 'deferred') { instance.status = 'idle'; h.queue.onSettled(instance); }
    await flushMacrotasks(); await flushMacrotasks(); await flushMacrotasks();
    expect(h.applyChange).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(instance.desiredRuntime).toEqual(accountChange());
    await h.queue.requestChange(instance.id, accountChange('example-original'));
    expect(await result).toBeInstanceOf(Error);
  });

  it('does not retry a permanent startup failure merely because initialization emitted a settled boundary', async () => {
    const instance = accountInstance();
    const failure = new Error('Example CLI is unavailable');
    const h = makeHarness(instance, async () => {
      instance.status = 'initializing'; h.queue.onSettled(instance);
      instance.status = 'error'; h.queue.onSettled(instance);
      throw failure;
    });
    const result = h.queue.requestChange(instance.id, accountChange()).catch(error => error);
    instance.status = 'idle'; h.queue.onSettled(instance);
    await flushMacrotasks(); await flushMacrotasks();
    expect(await result).toBe(failure);
    expect(h.applyChange).toHaveBeenCalledOnce();
    expect(instance.desiredRuntime).toBeUndefined();
    expect(h.notifyApplyFailure).toHaveBeenCalledOnce();
  });

  it('resolves an unapplied matching-account request and publishes null when external approval satisfies its inherited YOLO flip', async () => {
    const instance = accountInstance();
    instance.yoloMode = false;
    const snapshots: (DesiredRuntime | undefined)[] = [];
    const applyChange = vi.fn(async () => instance);
    const queue = new DesiredRuntimeQueue({ getInstance: () => instance, isAdapterOnLoan: () => false,
      applyChange, notifyApplyFailure: vi.fn(), publishPendingState: current => snapshots.push(current.desiredRuntime) });
    const desired = { ...accountChange('example-original'), yoloMode: true };
    const request = queue.requestChange(instance.id, desired);
    instance.yoloMode = true;
    queue.clearQueuedYoloKey(instance);
    await expect(request).resolves.toBe(instance);
    expect(snapshots).toEqual([desired, undefined]);
    expect(applyChange).not.toHaveBeenCalled();
  });

  it('preserves account/model remainder ownership when a satisfied YOLO key is removed', async () => {
    const instance = accountInstance();
    instance.yoloMode = false;
    const h = makeHarness(instance, async (_id, desired) => {
      instance.accountProfileId = desired.accountProfileId;
      instance.currentModel = desired.model;
      return instance;
    });
    const desired = { ...accountChange(), model: 'sonnet', yoloMode: true };
    let complete = false;
    const request = h.queue.requestChange(instance.id, desired).then(result => { complete = true; return result; });
    instance.yoloMode = true;
    h.queue.clearQueuedYoloKey(instance);
    await flushMacrotasks();
    expect(complete).toBe(false);
    expect(instance.desiredRuntime).toEqual({ ...accountChange(), model: 'sonnet' });
    instance.status = 'idle'; h.queue.onSettled(instance);
    await flushMacrotasks();
    await expect(request).resolves.toBe(instance);
    expect(instance.accountProfileId).toBe('example-picked');
    expect(instance.currentModel).toBe('sonnet');
    expect(instance.yoloMode).toBe(true);
  });

  it('keeps a forced mode correction after an older captured write changes it', async () => {
    const held = deferred();
    const instance = accountInstance('idle');
    instance.yoloMode = false;
    const h = makeHarness(instance, async (_id, desired) => {
      if (h.applyChange.mock.calls.length === 1) await held.promise;
      instance.accountProfileId = desired.accountProfileId;
      if (desired.yoloMode !== undefined) instance.yoloMode = desired.yoloMode;
      return instance;
    });
    const first = h.queue.requestChange(instance.id, { ...accountChange(), yoloMode: true });
    const newerTarget = { ...accountChange(), yoloMode: false };
    let complete = false;
    const newer = h.queue.requestChange(instance.id, newerTarget).then(result => { complete = true; return result; });
    h.queue.clearQueuedYoloKey(instance);
    expect(instance.desiredRuntime).toBe(newerTarget);
    expect(complete).toBe(false);
    held.resolve();
    await first; await flushMacrotasks();
    await expect(newer).resolves.toBe(instance);
    expect(instance.accountProfileId).toBe('example-picked');
    expect(instance.yoloMode).toBe(false);
    expect(h.applyChange).toHaveBeenCalledTimes(2);
  });

  it('invalidates old cleanup intent when a newer explicit YOLO request replaces its exact target', async () => {
    const held = deferred();
    const instance = accountInstance('idle');
    instance.yoloMode = false;
    const h = makeHarness(instance, async (_id, desired) => {
      if (h.applyChange.mock.calls.length === 1) await held.promise;
      instance.accountProfileId = desired.accountProfileId;
      if (desired.yoloMode !== undefined) instance.yoloMode = desired.yoloMode;
      return instance;
    });
    const first = h.queue.requestChange(instance.id, { ...accountChange(), yoloMode: true });
    const cancelled = h.queue.requestChange(instance.id, { ...accountChange(), yoloMode: false }).catch(error => error);
    h.queue.clearQueuedYoloKey(instance);
    const latestTarget = { ...accountChange('example-latest'), yoloMode: true };
    const latest = h.queue.requestChange(instance.id, latestTarget);
    expect(await cancelled).toBeInstanceOf(Error);
    expect(instance.desiredRuntime).toBe(latestTarget);
    held.resolve(); await first; await flushMacrotasks();
    await expect(latest).resolves.toBe(instance);
    expect(instance.accountProfileId).toBe('example-latest');
    expect(instance.yoloMode).toBe(true);
  });

  it.each(['satisfied', 'corrective'] as const)('finishes same-owner active cleanup with only the %s mode work needed', async mode => {
    const held = deferred();
    const instance = accountInstance('idle');
    instance.yoloMode = false;
    const h = makeHarness(instance, async (_id, desired) => {
      if (h.applyChange.mock.calls.length === 1) {
        if (mode === 'satisfied') instance.yoloMode = true;
        await held.promise;
      }
      instance.accountProfileId = desired.accountProfileId;
      if (desired.yoloMode !== undefined) instance.yoloMode = desired.yoloMode;
      return instance;
    });
    const target = { ...accountChange(), yoloMode: true };
    const first = h.queue.requestChange(instance.id, target);
    h.queue.clearQueuedYoloKey(instance);
    expect(instance.desiredRuntime).toBe(target);
    held.resolve(); await first; await flushMacrotasks();
    expect(instance.accountProfileId).toBe('example-picked');
    expect(instance.yoloMode).toBe(mode === 'satisfied');
    expect(instance.desiredRuntime).toBeUndefined();
    expect(h.applyChange).toHaveBeenCalledTimes(mode === 'satisfied' ? 1 : 2);
  });

  it.each(['immediate', 'deferred'] as const)('does not revive a permanently failed %s target due to same-owner cleanup', async mode => {
    const held = deferred();
    const instance = accountInstance(mode === 'immediate' ? 'idle' : 'busy');
    const h = makeHarness(instance, async (_id, desired) => {
      instance.status = 'initializing'; instance.accountProfileId = desired.accountProfileId; instance.yoloMode = desired.yoloMode ?? false;
      try { await held.promise; } catch (error) { instance.status = 'error'; instance.accountProfileId = 'example-original'; throw error; }
      return instance;
    });
    const result = h.queue.requestChange(instance.id, { ...accountChange(), yoloMode: true }).catch(error => error);
    if (mode === 'deferred') { instance.status = 'idle'; h.queue.onSettled(instance); await flushMacrotasks(); }
    h.queue.clearQueuedYoloKey(instance);
    held.reject(new Error('Example permanent startup failure'));
    expect(await result).toBeInstanceOf(Error);
    await flushMacrotasks(); await flushMacrotasks();
    expect(instance.accountProfileId).toBe('example-original');
    expect(instance.desiredRuntime).toBeUndefined();
    expect(h.applyChange).toHaveBeenCalledOnce();
  });

  it('does not turn an active cleanup into a transient retry without an external boundary', async () => {
    const held = deferred();
    const instance = accountInstance();
    instance.yoloMode = false;
    const h = makeHarness(instance, async () => { await held.promise; throw new AdapterOnLoanError(instance.id); });
    let settled = false;
    const result = h.queue.requestChange(instance.id, { ...accountChange(), yoloMode: true }).catch(error => error).then(value => { settled = true; return value; });
    instance.status = 'idle'; h.queue.onSettled(instance); await flushMacrotasks();
    h.queue.clearQueuedYoloKey(instance);
    held.resolve(); await flushMacrotasks(); await flushMacrotasks();
    expect(instance.desiredRuntime).toEqual(accountChange());
    expect(h.applyChange).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    await h.queue.requestChange(instance.id, accountChange('example-original'));
    expect(await result).toBeInstanceOf(Error);
  });

  it('rejects newer queued completion ownership if the instance disappears before cleanup intent finishes', async () => {
    const held = deferred();
    const instance = accountInstance('idle');
    let removed = false;
    const queue = new DesiredRuntimeQueue({ getInstance: () => removed ? undefined : instance,
      isAdapterOnLoan: () => false, publishPendingState: vi.fn(), notifyApplyFailure: vi.fn(),
      applyChange: async () => { await held.promise; throw new Error('Example removed runtime'); } });
    const first = queue.requestChange(instance.id, { ...accountChange(), yoloMode: true }).catch(error => error);
    const newer = queue.requestChange(instance.id, { ...accountChange('example-latest'), yoloMode: true }).catch(error => error);
    queue.clearQueuedYoloKey(instance);
    removed = true; held.resolve();
    expect(await first).toBeInstanceOf(Error);
    expect(await newer).toEqual(expect.objectContaining({ message: expect.stringContaining('not found') }));
  });


  describe.each(['immediate', 'deferred'] as const)('%s completion lifecycle validation', mode => {
    it.each(['terminated', 'failed', 'superseded', 'removed', 'replaced-idle', 'replaced-busy', 'replaced-loan', 'success'] as const)(
      'reports completed handoff truthfully after %s', async outcome => {
        const held = deferred();
        const instance = accountInstance(mode === 'immediate' ? 'idle' : 'busy');
        const state = new InstanceStateManager();
        state.setInstance(instance);
        const replacementTarget = { provider: 'claude', model: 'sonnet' } as const;
        let loan: AdapterLoan | undefined;
        const applyChange = vi.fn(async (_id: string, desired: DesiredRuntime) => {
          await held.promise;
          instance.accountProfileId = desired.accountProfileId;
          if (outcome === 'replaced-loan') loan = beginAdapterLoan(instance.id, 'example-replacement-loop');
          return instance;
        });
        const notifyApplyFailure = vi.fn();
        const queue = new DesiredRuntimeQueue({ getInstance: id => state.getInstance(id), isAdapterOnLoan,
          applyChange, notifyApplyFailure, publishPendingState: vi.fn() });
        let settled = false;
        const request = queue.requestChange(instance.id, accountChange()).catch(error => error)
          .then(value => { settled = true; return value; });
        let replacement: Instance | undefined;
        try {
          if (mode === 'deferred') { instance.status = 'idle'; queue.onSettled(instance); }
          await flushMacrotasks();
          expect(applyChange).toHaveBeenCalledOnce(); expect(settled).toBe(false);
          if (outcome === 'removed') state.deleteInstance(instance.id);
          else if (outcome.startsWith('replaced-')) {
            replacement = accountInstance(outcome === 'replaced-busy' ? 'busy' : 'idle');
            replacement.accountProfileId = 'example-replacement';
            // A ready replacement has no queued work. Unavailable replacements
            // own independent work that this discarded operation must preserve.
            if (outcome !== 'replaced-idle') replacement.desiredRuntime = replacementTarget;
            state.setInstance(replacement);
          } else if (outcome !== 'success') {
            instance.status = outcome as InstanceStatus; queue.onSettled(instance);
          }
          await flushMacrotasks(); expect(settled).toBe(false);
          held.resolve();
          await vi.waitFor(() => expect(settled).toBe(true));
          const result = await request;
          if (outcome === 'success') {
            expect(result).toBe(instance);
            expect(instance.accountProfileId).toBe('example-picked');
            expect(instance.desiredRuntime).toBeUndefined();
          } else expect(result).toEqual(expect.objectContaining({ message: expect.stringContaining('no longer available') }));
          await flushMacrotasks();
          expect(applyChange).toHaveBeenCalledOnce();
          expect(notifyApplyFailure).not.toHaveBeenCalled();
          if (replacement) {
            expect(state.getInstance(instance.id)).toBe(replacement);
            expect(replacement.accountProfileId).toBe('example-replacement');
            expect(replacement.desiredRuntime).toBe(outcome === 'replaced-idle' ? undefined : replacementTarget);
          }
        } finally {
          const live = state.getInstance(instance.id);
          if (live) { live.status = 'terminated'; queue.onSettled(live); }
          held.resolve(); endAdapterLoan(loan); await flushMacrotasks();
          await Promise.allSettled([request]); state.destroy();
        }
      },
    );

    it('allows the older live write to finish while the newer account retains future-write ownership', async () => {
      const heldOld = deferred();
      const heldNew = deferred();
      const instance = accountInstance(mode === 'immediate' ? 'idle' : 'busy');
      const h = makeHarness(instance, async (_id, desired) => {
        await (desired.accountProfileId === 'example-picked' ? heldOld.promise : heldNew.promise);
        instance.accountProfileId = desired.accountProfileId;
        return instance;
      });
      let oldSettled = false;
      let newSettled = false;
      const older = h.queue.requestChange(instance.id, accountChange()).catch(error => error)
        .then(value => { oldSettled = true; return value; });
      let newer: Promise<unknown> | undefined;
      try {
        if (mode === 'deferred') { instance.status = 'idle'; h.queue.onSettled(instance); }
        await flushMacrotasks();
        newer = h.queue.requestChange(instance.id, accountChange('example-latest')).catch(error => error)
          .then(value => { newSettled = true; return value; });
        await flushMacrotasks();
        expect(oldSettled).toBe(false); expect(newSettled).toBe(false);
        expect(instance.desiredRuntime).toEqual(accountChange('example-latest'));
        heldOld.resolve();
        await vi.waitFor(() => expect(oldSettled).toBe(true));
        expect(await older).toBe(instance);
        await flushMacrotasks();
        expect(instance.accountProfileId).toBe('example-picked');
        expect(instance.desiredRuntime).toEqual(accountChange('example-latest'));
        expect(newSettled).toBe(false); expect(h.applyChange).toHaveBeenCalledTimes(2);
        heldNew.resolve();
        await vi.waitFor(() => expect(newSettled).toBe(true));
        expect(await newer).toBe(instance);
        expect(instance.accountProfileId).toBe('example-latest');
        expect(instance.desiredRuntime).toBeUndefined();
      } finally {
        instance.status = 'terminated'; h.queue.onSettled(instance);
        heldOld.resolve(); heldNew.resolve(); await flushMacrotasks();
        await Promise.allSettled([older, ...(newer ? [newer] : [])]);
      }
    });
  });

  it.each(['idle', 'busy'] as const)('keeps a confirmed matching-account request a no-op from %s', async status => {
    const h = makeHarness(accountInstance(status));
    await expect(h.queue.requestChange(h.instance.id, accountChange('example-original'))).resolves.toBe(h.instance);
    expect(h.applyChange).not.toHaveBeenCalled();
    expect(h.publishPendingState).not.toHaveBeenCalled();
    expect(h.instance.desiredRuntime).toBeUndefined();
  });



  describe.each(['immediate', 'deferred'] as const)('%s rejected operation ownership', mode => {
    describe.each(['loan', 'permanent'] as const)('%s apply rejection', reason => {
      it.each(['removed', 'replacement-idle', 'replacement-busy', 'replacement-loan'] as const)(
        'rejects the old request without parking or notifying against %s', async outcome => {
          const held = deferred();
          const original = accountInstance(mode === 'immediate' ? 'idle' : 'busy');
          const state = new InstanceStateManager(); state.setInstance(original);
          const target = { provider: 'claude', model: 'sonnet' } as const;
          const failure = reason === 'loan' ? new AdapterOnLoanError(original.id) : new Error('Example original operation failed');
          let loan: AdapterLoan | undefined;
          const applyChange = vi.fn(async (id: string, desired: DesiredRuntime) => {
            if (desired.accountProfileId === 'example-picked') await held.promise;
            const current = state.getInstance(id);
            if (!current) throw new Error('Example runtime removed');
            if (desired.model !== undefined) current.currentModel = desired.model;
            return current;
          });
          const notifyApplyFailure = vi.fn();
          const queue = new DesiredRuntimeQueue({ getInstance: id => state.getInstance(id), isAdapterOnLoan,
            applyChange, publishPendingState: vi.fn(), notifyApplyFailure });
          let settled = false;
          const request = queue.requestChange(original.id, accountChange()).catch(error => error)
            .then(value => { settled = true; return value; });
          let replacement: Instance | undefined;
          try {
            if (mode === 'deferred') { original.status = 'idle'; queue.onSettled(original); }
            await flushMacrotasks(); expect(applyChange).toHaveBeenCalledOnce(); expect(settled).toBe(false);
            if (outcome === 'removed') state.deleteInstance(original.id);
            else {
              replacement = accountInstance(outcome === 'replacement-busy' ? 'busy' : 'idle');
              replacement.accountProfileId = 'example-replacement'; replacement.desiredRuntime = target;
              state.setInstance(replacement);
              if (outcome === 'replacement-loan') loan = beginAdapterLoan(original.id, 'example-replacement-loop');
            }
            held.reject(failure);
            await vi.waitFor(() => expect(settled).toBe(true));
            expect(await request).toBe(failure);
            await flushMacrotasks();
            expect(notifyApplyFailure).not.toHaveBeenCalled();
            expect(applyChange).toHaveBeenCalledTimes(outcome === 'replacement-idle' ? 2 : 1);
            if (replacement) {
              expect(replacement.accountProfileId).toBe('example-replacement');
              if (outcome === 'replacement-idle') {
                expect(applyChange).toHaveBeenLastCalledWith(original.id, target);
                expect(replacement.currentModel).toBe('sonnet'); expect(replacement.desiredRuntime).toBeUndefined();
              } else expect(replacement.desiredRuntime).toBe(target);
            }
          } finally {
            const live = state.getInstance(original.id);
            if (live) { live.status = 'terminated'; queue.onSettled(live); }
            held.reject(failure); endAdapterLoan(loan); await flushMacrotasks();
            await Promise.allSettled([request]); state.destroy();
          }
        },
      );
    });

    it.each(['loan', 'status'] as const)('retries a genuine same-owner %s rejection only on its real boundary', async reason => {
      const held = deferred();
      const instance = accountInstance(mode === 'immediate' ? 'idle' : 'busy');
      let loan: AdapterLoan | undefined;
      const applyChange = vi.fn(async (_id: string, desired: DesiredRuntime) => {
        if (applyChange.mock.calls.length === 1) await held.promise;
        instance.accountProfileId = desired.accountProfileId;
        return instance;
      });
      const notifyApplyFailure = vi.fn();
      const queue = new DesiredRuntimeQueue({ getInstance: () => instance, isAdapterOnLoan,
        applyChange, publishPendingState: vi.fn(), notifyApplyFailure });
      const unsubscribe = onAdapterLoanReleased(id => queue.onAdapterLoanReleased(id));
      let settled = false;
      const request = queue.requestChange(instance.id, accountChange()).catch(error => error)
        .then(value => { settled = true; return value; });
      try {
        if (mode === 'deferred') { instance.status = 'idle'; queue.onSettled(instance); }
        await flushMacrotasks();
        if (reason === 'loan') loan = beginAdapterLoan(instance.id, 'example-original-loop');
        else { instance.status = 'busy'; queue.onSettled(instance); }
        held.reject(reason === 'loan' ? new AdapterOnLoanError(instance.id)
          : new Error(getModelSwitchUnavailableReason(instance.status)));
        await flushMacrotasks(); await flushMacrotasks();
        expect(settled).toBe(false); expect(applyChange).toHaveBeenCalledOnce();
        expect(instance.desiredRuntime).toEqual(accountChange());
        if (reason === 'loan') endAdapterLoan(loan);
        else { instance.status = 'idle'; queue.onSettled(instance); }
        await vi.waitFor(() => expect(settled).toBe(true));
        expect(await request).toBe(instance); expect(applyChange).toHaveBeenCalledTimes(2);
        expect(instance.accountProfileId).toBe('example-picked'); expect(instance.desiredRuntime).toBeUndefined();
        expect(notifyApplyFailure).not.toHaveBeenCalled();
      } finally {
        instance.status = 'terminated'; queue.onSettled(instance);
        held.resolve(); unsubscribe(); endAdapterLoan(loan); await flushMacrotasks(); await Promise.allSettled([request]);
      }
    });

    it.each(['same', 'replacement'] as const)('retains a newer %s owner account until its own held write succeeds', async owner => {
      const heldOld = deferred(); const heldNew = deferred();
      const original = accountInstance(mode === 'immediate' ? 'idle' : 'busy');
      const state = new InstanceStateManager(); state.setInstance(original);
      const failure = new AdapterOnLoanError(original.id);
      const applyChange = vi.fn(async (id: string, desired: DesiredRuntime) => {
        await (desired.accountProfileId === 'example-picked' ? heldOld.promise : heldNew.promise);
        const current = state.getInstance(id);
        if (!current) throw new Error('Example runtime removed');
        current.accountProfileId = desired.accountProfileId; return current;
      });
      const notifyApplyFailure = vi.fn();
      const queue = new DesiredRuntimeQueue({ getInstance: id => state.getInstance(id), isAdapterOnLoan,
        applyChange, publishPendingState: vi.fn(), notifyApplyFailure });
      let oldSettled = false; let newSettled = false;
      const older = queue.requestChange(original.id, accountChange()).catch(error => error)
        .then(value => { oldSettled = true; return value; });
      let newer: Promise<unknown> | undefined;
      let current = original;
      try {
        if (mode === 'deferred') { original.status = 'idle'; queue.onSettled(original); }
        await flushMacrotasks();
        current = owner === 'same' ? original : accountInstance();
        current.status = 'busy'; state.setInstance(current);
        const target = accountChange('example-latest');
        newer = queue.requestChange(current.id, target).catch(error => error).then(value => { newSettled = true; return value; });
        heldOld.reject(failure);
        await vi.waitFor(() => expect(oldSettled).toBe(true));
        expect(await older).toBe(failure);
        expect(current.desiredRuntime).toBe(target); expect(newSettled).toBe(false);
        if (owner === 'replacement') expect(notifyApplyFailure).not.toHaveBeenCalled();
        current.status = 'idle'; queue.onSettled(current); await flushMacrotasks();
        expect(applyChange).toHaveBeenCalledTimes(2); expect(newSettled).toBe(false);
        expect(current.desiredRuntime).toBe(target);
        heldNew.resolve(); await vi.waitFor(() => expect(newSettled).toBe(true));
        expect(await newer).toBe(current); expect(current.accountProfileId).toBe('example-latest');
        expect(current.desiredRuntime).toBeUndefined();
      } finally {
        current.status = 'terminated'; queue.onSettled(current);
        heldOld.reject(failure); heldNew.resolve(); await flushMacrotasks();
        await Promise.allSettled([older, ...(newer ? [newer] : [])]); state.destroy();
      }
    });
  });

});
