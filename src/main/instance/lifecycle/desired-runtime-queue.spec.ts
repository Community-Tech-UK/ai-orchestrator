import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DesiredRuntimeQueue, type DesiredRuntimeQueueDeps } from './desired-runtime-queue';
import { AdapterOnLoanError } from './adapter-loan-registry';
import { computeRuntimeDiff, planContinuity } from './runtime-reconciler-plan';
import type { DesiredRuntime, Instance, InstanceStatus } from '../../../shared/types/instance.types';

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
  const noDiff = { providerChanged: false, modelChanged: true, reasoningChanged: false, runtimeTargetChanged: false, yoloModeChanged: false, copilotAccountChanged: false, hasChanges: true };

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
