import { describe, expect, it, vi } from 'vitest';
import type { ThinClientCommandExecutorDeps } from './thin-client-command-executor';
import { sendInput } from './thin-client-instance-commands';

describe('thin-client queued input ownership', () => {
  it('carries validated queue ownership and automatic provenance to the main send path', async () => {
    const send = vi.fn(async () => undefined);
    const deps = { instanceManager: { sendInput: send, getInstance: () => undefined } } as unknown as ThinClientCommandExecutorDeps;

    await expect(sendInput(deps, {
      instanceId: 'session-1', message: 'queued original', isRetry: true,
      automatedInput: true, queuedAdmissionId: 'original-admission',
    })).resolves.toEqual({ success: true });

    expect(send).toHaveBeenCalledExactlyOnceWith('session-1', 'queued original', undefined, {
      isRetry: true, automatedInput: true, queuedAdmissionId: 'original-admission',
    });
  });

  it('never carries a person origin: a thin-client caller cannot mark text as typed by a person', async () => {
    const send = vi.fn(async (..._args: unknown[]) => undefined);
    const deps = { instanceManager: { sendInput: send, getInstance: () => undefined } } as unknown as ThinClientCommandExecutorDeps;
    const origin = { kind: 'person', typedAt: 1_700_000_000_000 };

    await sendInput(deps, { instanceId: 'session-1', message: 'land it anyway', origin });

    expect(send).toHaveBeenCalledOnce();
    const options = send.mock.calls[0]![3] as object;
    expect('origin' in options).toBe(false);
  });
});
