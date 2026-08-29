import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import {
  ASYNC_WORK_CONTINUATION_PROMPT,
  InstanceAsyncWorkContinuation,
  type InstanceAsyncWorkContinuationHost,
} from './instance-async-work-continuation';

describe('InstanceAsyncWorkContinuation', () => {
  let registry: InstanceAsyncWorkRegistry;
  let instance: { status: 'idle' | 'busy' | 'hibernated'; requestCount: number };
  let host: InstanceAsyncWorkContinuationHost;
  let sendInput: ReturnType<typeof vi.fn>;
  let continuation: InstanceAsyncWorkContinuation;

  beforeEach(() => {
    registry = new InstanceAsyncWorkRegistry();
    instance = { status: 'idle', requestCount: 3 };
    sendInput = vi.fn(async () => undefined);
    host = {
      getInstance: vi.fn(() => instance),
      waitForInstanceSettled: vi.fn(async () => instance),
      sendInput,
    };
    continuation = new InstanceAsyncWorkContinuation(registry, host);
    continuation.start();
  });

  it('continues an idle session after a terminal background result', async () => {
    registry.observe('instance-1', {
      phase: 'terminal',
      workId: 'bg-1',
      kind: 'background-shell',
      status: 'completed',
    });

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(sendInput).toHaveBeenCalledWith(
      'instance-1',
      ASYNC_WORK_CONTINUATION_PROMPT,
      undefined,
      { autoContinuation: true },
    );
    expect(registry.hasInhibitor('instance-1')).toBe(false);
  });

  it('coalesces a burst of terminal results into one continuation', async () => {
    registry.observe('instance-1', {
      phase: 'terminal',
      workId: 'bg-1',
      kind: 'background-shell',
      status: 'completed',
    });
    registry.observe('instance-1', {
      phase: 'terminal',
      workId: 'agent-1',
      kind: 'subagent',
      status: 'completed',
    });

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
  });

  it('suppresses continuation when a user turn starts while awaiting settlement', async () => {
    instance.status = 'busy';
    let settle!: () => void;
    host.waitForInstanceSettled = vi.fn(() => new Promise<void>((resolve) => {
      settle = resolve;
    }));

    registry.observe('instance-1', {
      phase: 'terminal',
      workId: 'bg-1',
      kind: 'background-shell',
      status: 'completed',
    });
    await vi.waitFor(() => expect(host.waitForInstanceSettled).toHaveBeenCalled());
    instance.requestCount += 1;
    instance.status = 'busy';
    settle();

    await vi.waitFor(() => expect(registry.hasInhibitor('instance-1')).toBe(false));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('uses sendInput for a hibernated session so the normal wake path applies', async () => {
    instance.status = 'hibernated';

    registry.observe('instance-1', {
      phase: 'terminal',
      workId: 'external-1',
      kind: 'subagent',
      status: 'completed',
    });

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(host.waitForInstanceSettled).not.toHaveBeenCalled();
  });

  it('releases completion delivery when automatic continuation fails', async () => {
    sendInput.mockRejectedValueOnce(new Error('adapter unavailable'));

    registry.observe('instance-1', {
      phase: 'terminal',
      workId: 'bg-1',
      kind: 'background-shell',
      status: 'failed',
    });

    await vi.waitFor(() => expect(registry.hasInhibitor('instance-1')).toBe(false));
    expect(sendInput).toHaveBeenCalledTimes(1);
  });
});
