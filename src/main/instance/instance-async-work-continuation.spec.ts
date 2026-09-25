import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import {
  ASYNC_WORK_CONTINUATION_PROMPT,
  InstanceAsyncWorkContinuation,
  STALLED_WORK_CHECK_IN_AFTER_MS,
  buildStalledWorkCheckInPrompt,
  type InstanceAsyncWorkContinuationHost,
} from './instance-async-work-continuation';

type TestInstance = {
  status: 'idle' | 'busy' | 'hibernated' | 'ready';
  requestCount: number;
  lastActivity: number;
};

describe('InstanceAsyncWorkContinuation', () => {
  let registry: InstanceAsyncWorkRegistry;
  let instance: TestInstance;
  let host: InstanceAsyncWorkContinuationHost;
  let sendInput: ReturnType<typeof vi.fn>;
  let continuation: InstanceAsyncWorkContinuation;

  const terminal = (workId = 'bg-1', status: 'completed' | 'failed' = 'completed') => ({
    phase: 'terminal' as const,
    workId,
    kind: 'background-shell' as const,
    status,
  });

  beforeEach(() => {
    registry = new InstanceAsyncWorkRegistry();
    instance = { status: 'idle', requestCount: 3, lastActivity: 0 };
    sendInput = vi.fn(async () => undefined);
    host = {
      getInstance: vi.fn(() => instance),
      waitForInstanceSettled: vi.fn(async () => instance),
      sendInput,
    };
    continuation = new InstanceAsyncWorkContinuation(registry, host, { providerResumeGraceMs: 0 });
    continuation.start();
  });

  afterEach(() => {
    continuation.stop();
    vi.useRealTimers();
  });

  it('continues an idle session after a terminal background result', async () => {
    registry.observe('instance-1', terminal());

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(sendInput).toHaveBeenCalledWith(
      'instance-1',
      ASYNC_WORK_CONTINUATION_PROMPT,
      undefined,
      { autoContinuation: true, internalSource: 'async-work-continuation' },
    );
    expect(registry.hasInhibitor('instance-1')).toBe(false);
  });

  it('coalesces a burst of terminal results into one continuation', async () => {
    registry.observe('instance-1', terminal('bg-1'));
    registry.observe('instance-1', { ...terminal('agent-1'), kind: 'subagent' });

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
  });

  it('leaves a result that arrives mid-turn to the active turn', async () => {
    instance.status = 'busy';

    registry.observe('instance-1', terminal());

    await vi.waitFor(() => expect(registry.hasInhibitor('instance-1')).toBe(false));
    expect(host.waitForInstanceSettled).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('suppresses continuation when a user turn starts during the grace period', async () => {
    continuation.stop();
    continuation = new InstanceAsyncWorkContinuation(registry, host, { providerResumeGraceMs: 20 });
    continuation.start();

    registry.observe('instance-1', terminal());
    instance.requestCount += 1;
    instance.status = 'busy';

    await vi.waitFor(() => expect(registry.hasInhibitor('instance-1')).toBe(false));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('yields to a provider that resumed on its own, even after that turn already settled', async () => {
    continuation.stop();
    continuation = new InstanceAsyncWorkContinuation(registry, host, { providerResumeGraceMs: 50 });
    continuation.start();

    registry.observe('instance-1', terminal());
    registry.observe('instance-1', { phase: 'provider-resumed' });
    // The provider's own turn is short and is back to idle before the grace ends.
    instance.status = 'idle';

    await vi.waitFor(() => expect(registry.hasInhibitor('instance-1')).toBe(false));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('sends nothing when stopped during the grace period', async () => {
    continuation.stop();
    continuation = new InstanceAsyncWorkContinuation(registry, host, { providerResumeGraceMs: 1_000 });
    continuation.start();

    registry.observe('instance-1', terminal());
    await Promise.resolve();
    continuation.stop();

    await vi.waitFor(() => expect(registry.hasInhibitor('instance-1')).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('holds the fallback continuation while the app is paused or a loop owns the session', async () => {
    continuation.stop();
    let paused = true;
    let looping = false;
    continuation = new InstanceAsyncWorkContinuation(registry, host, {
      providerResumeGraceMs: 0,
      isPaused: () => paused,
      isManagedLoopInstance: () => looping,
    });
    continuation.start();

    registry.observe('instance-1', terminal('bg-1'));
    await vi.waitFor(() => expect(registry.hasInhibitor('instance-1')).toBe(false));
    paused = false;
    looping = true;
    registry.observe('instance-1', terminal('bg-2'));
    await vi.waitFor(() => expect(registry.hasInhibitor('instance-1')).toBe(false));

    expect(sendInput).not.toHaveBeenCalled();
  });

  it('falls back to its own continuation when the provider does not resume within the grace period', async () => {
    continuation.stop();
    continuation = new InstanceAsyncWorkContinuation(registry, host, { providerResumeGraceMs: 20 });
    continuation.start();

    registry.observe('instance-1', terminal());

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
  });

  it('uses sendInput for a hibernated session so the normal wake path applies', async () => {
    instance.status = 'hibernated';

    registry.observe('instance-1', { ...terminal('external-1'), kind: 'subagent' });

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(host.waitForInstanceSettled).not.toHaveBeenCalled();
  });

  it('releases completion delivery when automatic continuation fails', async () => {
    sendInput.mockRejectedValueOnce(new Error('adapter unavailable'));

    registry.observe('instance-1', terminal('bg-1', 'failed'));

    await vi.waitFor(() => expect(registry.hasInhibitor('instance-1')).toBe(false));
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  describe('stalled background work check-in', () => {
    const start = 1_000_000;
    const stalledAt = start + STALLED_WORK_CHECK_IN_AFTER_MS;

    beforeEach(() => {
      registry = new InstanceAsyncWorkRegistry(() => start);
      continuation.stop();
      continuation = new InstanceAsyncWorkContinuation(registry, host, { providerResumeGraceMs: 0 });
      continuation.start();
      instance.lastActivity = start;
      registry.observe('instance-1', { phase: 'started', workId: 'bg-1', kind: 'background-shell' });
    });

    it('checks in once when an idle session has been silent on running work', async () => {
      await continuation.checkStalledWork(stalledAt - 1);
      expect(sendInput).not.toHaveBeenCalled();

      await continuation.checkStalledWork(stalledAt);
      await continuation.checkStalledWork(stalledAt + 60_000);

      expect(sendInput).toHaveBeenCalledTimes(1);
      expect(sendInput).toHaveBeenCalledWith(
        'instance-1',
        buildStalledWorkCheckInPrompt(STALLED_WORK_CHECK_IN_AFTER_MS),
        undefined,
        { autoContinuation: true, internalSource: 'async-work-continuation' },
      );
    });

    it('checks in again for different work after the first check-in', async () => {
      await continuation.checkStalledWork(stalledAt);
      registry.observe('instance-1', { phase: 'snapshot', work: [{ workId: 'bg-2', kind: 'background-shell' }] });

      await continuation.checkStalledWork(stalledAt + STALLED_WORK_CHECK_IN_AFTER_MS);

      expect(sendInput).toHaveBeenCalledTimes(2);
    });

    it('waits while the session shows recent activity', async () => {
      instance.lastActivity = stalledAt - 1_000;

      await continuation.checkStalledWork(stalledAt);

      expect(sendInput).not.toHaveBeenCalled();
    });

    it('does not interrupt a busy session', async () => {
      instance.status = 'busy';

      await continuation.checkStalledWork(stalledAt);

      expect(sendInput).not.toHaveBeenCalled();
    });

    it('holds automatic input while the app is paused or a loop owns the session', async () => {
      continuation.stop();
      let paused = true;
      let looping = false;
      continuation = new InstanceAsyncWorkContinuation(registry, host, {
        providerResumeGraceMs: 0,
        isPaused: () => paused,
        isManagedLoopInstance: () => looping,
      });
      continuation.start();

      await continuation.checkStalledWork(stalledAt);
      paused = false;
      looping = true;
      await continuation.checkStalledWork(stalledAt);

      expect(sendInput).not.toHaveBeenCalled();
    });

    it('logs and survives a failed check-in', async () => {
      sendInput.mockRejectedValueOnce(new Error('adapter unavailable'));

      await expect(continuation.checkStalledWork(stalledAt)).resolves.toBeUndefined();
      expect(sendInput).toHaveBeenCalledTimes(1);
    });
  });
});
