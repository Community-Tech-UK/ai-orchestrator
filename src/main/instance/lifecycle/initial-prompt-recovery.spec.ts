import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceStatus, OutputMessage } from '../../../shared/types/instance.types';
import {
  deliverInitialPromptAfterSpawn,
  type InitialPromptRecoveryDeps,
} from './initial-prompt-recovery';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

function makeInstance(status: InstanceStatus = 'idle'): Instance {
  return { id: 'inst-1', status, contextUsage: undefined, outputBuffer: [] } as unknown as Instance;
}

function makeDeps(): InitialPromptRecoveryDeps & {
  emitted: OutputMessage[];
  buffered: OutputMessage[];
  transitions: InstanceStatus[];
} {
  const emitted: OutputMessage[] = [];
  const buffered: OutputMessage[] = [];
  const transitions: InstanceStatus[] = [];
  return {
    emitted,
    buffered,
    transitions,
    transitionState: (instance, status) => {
      transitions.push(status);
      instance.status = status;
    },
    queueUpdate: vi.fn(),
    addToOutputBuffer: (_instance, message) => { buffered.push(message); },
    emitOutput: (_id, message) => { emitted.push(message); },
  };
}

describe('deliverInitialPromptAfterSpawn', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes through cleanly when the send succeeds — no notice, no transition', async () => {
    const instance = makeInstance('idle');
    const deps = makeDeps();
    const send = vi.fn().mockResolvedValue(undefined);

    await deliverInitialPromptAfterSpawn(instance, new AbortController().signal, send, deps);

    expect(send).toHaveBeenCalledOnce();
    expect(deps.buffered).toHaveLength(0);
    expect(deps.emitted).toHaveLength(0);
    expect(deps.transitions).toHaveLength(0);
    expect(deps.queueUpdate).not.toHaveBeenCalled();
  });

  it('preserves the session and posts a notice when the send fails post-spawn', async () => {
    const instance = makeInstance('busy');
    const deps = makeDeps();
    const send = vi.fn().mockRejectedValue(
      new Error('Codex context-cost recovery paused because the active turn did not confirm interruption.'),
    );

    // Must not throw — the failure is swallowed so the spawn transaction commits.
    await expect(
      deliverInitialPromptAfterSpawn(instance, new AbortController().signal, send, deps),
    ).resolves.toBeUndefined();

    // Settled back to idle so the user can resend.
    expect(instance.status).toBe('idle');
    expect(deps.transitions).toEqual(['idle']);
    expect(deps.queueUpdate).toHaveBeenCalledOnce();

    // A single explanatory system notice was buffered and emitted.
    expect(deps.buffered).toHaveLength(1);
    const notice = deps.buffered[0];
    expect(notice.type).toBe('system');
    expect(notice.metadata?.['initialPromptFailed']).toBe(true);
    expect(notice.content).toContain('context-cost recovery paused');
    expect(deps.emitted[0]).toBe(notice);
  });

  it('rethrows on an in-flight abort so the caller can roll back a deliberate teardown', async () => {
    const instance = makeInstance('idle');
    const deps = makeDeps();
    const controller = new AbortController();
    const send = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted mid-turn');
    });

    await expect(
      deliverInitialPromptAfterSpawn(instance, controller.signal, send, deps),
    ).rejects.toThrow('aborted mid-turn');

    // No preservation side effects on the abort path.
    expect(deps.buffered).toHaveLength(0);
    expect(deps.transitions).toHaveLength(0);
  });

  it('does not attempt an idle transition from a terminal-ish status but still notifies', async () => {
    const instance = makeInstance('error');
    const deps = makeDeps();
    const send = vi.fn().mockRejectedValue(new Error('app-server exited unexpectedly during turn'));

    await deliverInitialPromptAfterSpawn(instance, new AbortController().signal, send, deps);

    expect(deps.transitions).toHaveLength(0);
    expect(instance.status).toBe('error');
    expect(deps.buffered).toHaveLength(1);
  });
});
