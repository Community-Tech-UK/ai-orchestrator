import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerRuntimeError } from './app-server-runtime-errors';
import { sendCodexOrchestrationResponse } from './orchestration-response-send';

const collision = () => new CodexAppServerRuntimeError({
  kind: 'request-rejected',
  recoverability: 'retry-thread',
  message: 'Codex app-server runtime already has an active turn',
});

describe('Codex orchestration response send', () => {
  it('retries a confirmed pre-turn collision once the competing turn releases its slot', async () => {
    let active = false;
    const sendInput = vi.fn(async () => {
      if (sendInput.mock.calls.length === 1) {
        active = true;
        throw collision();
      }
    });
    setTimeout(() => { active = false; }, 20);

    await sendCodexOrchestrationResponse('childId: child-42', {
      isAppServerMode: () => true,
      isReady: () => true,
      hasActiveTurn: () => active,
      sendInput,
    });

    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(sendInput).toHaveBeenNthCalledWith(1, 'childId: child-42');
    expect(sendInput).toHaveBeenNthCalledWith(2, 'childId: child-42');
  });

  it('does not retry an ambiguous send failure that may have reached the provider', async () => {
    const sendInput = vi.fn(async () => { throw new Error('response stream disconnected'); });

    await expect(sendCodexOrchestrationResponse('childId: child-42', {
      isAppServerMode: () => true,
      isReady: () => true,
      hasActiveTurn: () => false,
      sendInput,
    })).rejects.toThrow('response stream disconnected');
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the resident runtime terminates', async () => {
    let ready = true;
    setTimeout(() => { ready = false; }, 20);
    const sendInput = vi.fn();

    await expect(sendCodexOrchestrationResponse('childId: child-42', {
      isAppServerMode: () => true,
      isReady: () => ready,
      hasActiveTurn: () => true,
      sendInput,
    })).rejects.toThrow('ended before the orchestration response could be delivered');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('keeps the child response pending after the first wait deadline and sends it on later idle', async () => {
    vi.useFakeTimers();
    try {
      let active = true;
      let settled = false;
      const sendInput = vi.fn(async (_message: string) => undefined);
      const onDelayed = vi.fn();
      const delivery = sendCodexOrchestrationResponse('childId: child-42', {
        isAppServerMode: () => true,
        isReady: () => true,
        hasActiveTurn: () => active,
        sendInput,
        onDelayed,
      }).finally(() => { settled = true; });
      void delivery.catch(() => undefined);

      await vi.advanceTimersByTimeAsync(120_100);
      expect(onDelayed).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(sendInput).not.toHaveBeenCalled();

      active = false;
      await vi.advanceTimersByTimeAsync(500);
      await delivery;
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('childId: child-42');
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues the pending delivery if displaying the delay notice fails', async () => {
    vi.useFakeTimers();
    try {
      let active = true;
      const sendInput = vi.fn(async (_message: string) => undefined);
      const delivery = sendCodexOrchestrationResponse('childId: child-42', {
        isAppServerMode: () => true,
        isReady: () => true,
        hasActiveTurn: () => active,
        sendInput,
        onDelayed: () => { throw new Error('display unavailable'); },
      });

      await vi.advanceTimersByTimeAsync(120_500);
      active = false;
      await vi.advanceTimersByTimeAsync(500);
      await delivery;
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('childId: child-42');
    } finally {
      vi.useRealTimers();
    }
  });
});
