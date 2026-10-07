import { describe, expect, it, vi } from 'vitest';

import { InstanceContinuationDispatch } from './instance-continuation-dispatch';
import type { ContinuationInstance } from './instance-continuation-dispatch';

describe('InstanceContinuationDispatch crash recovery', () => {
  it('reserves a cutoff continuation while a fresh-replay wait reason is still set', async () => {
    const instance: ContinuationInstance = {
      status: 'idle',
      requestCount: 1,
      parentId: null,
      launchMode: 'orchestrated',
      provider: 'claude',
      waitReason: { kind: 'respawning', strategy: 'fresh-replay', startedAt: 1 },
    };
    const sendInput = vi.fn(async (
      _instanceId: string,
      _message: string,
      _attachments: undefined,
      options?: { beforeProviderDispatch?: () => void },
    ) => {
      options?.beforeProviderDispatch?.();
    });
    const dispatch = new InstanceContinuationDispatch(
      { hasInhibitor: () => false } as never,
      {
        getInstance: () => instance,
        waitForInstanceSettled: async () => instance,
        sendInput,
      },
    );
    dispatch.start();

    const reservation = dispatch.reserve({
      instanceId: 'inst-1',
      trigger: 'cutoff',
      requestCount: 1,
      prompt: 'Continue the interrupted turn.',
      internalSource: 'crash-turn-continuation',
    });

    expect(reservation).toBeDefined();
    expect(instance.waitReason).toEqual({ kind: 'respawning', strategy: 'fresh-replay', startedAt: 1 });
    await expect(dispatch.dispatch(reservation!, { settle: false })).resolves.toBe(true);
    expect(sendInput).toHaveBeenCalledOnce();
  });
});
