import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceStatus, OutputMessage } from '../../../shared/types/instance.types';
import {
  deliverInitialPromptAfterSpawn,
  hasPendingInitialPrompt, retryPendingInitialPrompt,
  type InitialPromptRecoveryDeps,
} from './initial-prompt-recovery';
import { GlobalPauseService } from '../../global-pause/global-pause-service';
import { runAutomaticStartup } from '../../work-admission/automatic-startup';
import { getWorkAdmission } from '../../work-admission/work-admission';

const queue = vi.hoisted(() => ({ enqueueUserMessage: vi.fn(async () => ({ admissionId: 'queued', queuePosition: 0 })) }));
vi.mock('../../session/session-queue-service', () => ({ getSessionQueueService: () => queue }));

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
  it('blocks a delayed automatic first prompt while leaving manually opened chats usable', async () => {
    let finishInit!: () => void;
    const initialization = new Promise<void>(resolve => { finishInit = resolve; });
    const automaticSend = vi.fn(async () => undefined);
    const { delivery } = await runAutomaticStartup(async startup => {
      const instance = makeInstance();
      startup.register(instance, async () => undefined);
      const delivery = (async () => {
        await initialization;
        return deliverInitialPromptAfterSpawn(instance, new AbortController().signal, automaticSend, makeDeps());
      })();
      return { delivery };
    });
    getWorkAdmission().setGlobalPhase('collecting');
    try {
      const cancelled = expect(delivery).rejects.toThrow('cancelled for restart');
      finishInit(); await cancelled;
      expect(automaticSend).not.toHaveBeenCalled();
      const manualSend = vi.fn(async () => undefined);
      await deliverInitialPromptAfterSpawn(makeInstance(), new AbortController().signal, manualSend, makeDeps());
      expect(manualSend).toHaveBeenCalledOnce();
    } finally { getWorkAdmission().setGlobalPhase('none'); }
  });
  it('durably queues a recorded session first message instead of starting it after pause', async () => {
    const instance = makeInstance('idle');
    instance.outputBuffer.push({ type: 'user', content: 'Build the feature', attachments: [{ name: 'notes.txt', type: 'text/plain', size: 4, data: 'data' }] } as OutputMessage);
    const markInitialPromptQueued = vi.fn();
    const pause = vi.spyOn(GlobalPauseService, 'peek').mockReturnValue({ holdsAutomaticInput: () => true, markInitialPromptQueued } as unknown as GlobalPauseService);
    const send = vi.fn(async () => undefined);
    try {
      await deliverInitialPromptAfterSpawn(instance, new AbortController().signal, send, makeDeps());
      expect(send).not.toHaveBeenCalled();
      expect(queue.enqueueUserMessage).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'inst-1', message: 'Build the feature',
        attachments: [{ name: 'notes.txt', type: 'text/plain', size: 4, data: 'data' }] }));
      expect(markInitialPromptQueued).toHaveBeenCalledWith('inst-1');
    } finally { pause.mockRestore(); }
  });

  it('retains queue-marker failures for retry without duplicating the already durable original', async () => {
    const instance = makeInstance();
    instance.outputBuffer.push({ type: 'user', content: 'Original request' } as OutputMessage);
    const markInitialPromptQueued = vi.fn().mockImplementationOnce(() => { throw new Error('Pause marker could not persist'); });
    const pause = vi.spyOn(GlobalPauseService, 'peek').mockReturnValue({ holdsAutomaticInput: () => true, markInitialPromptQueued } as unknown as GlobalPauseService);
    try {
      await expect(deliverInitialPromptAfterSpawn(instance, new AbortController().signal, vi.fn(), makeDeps())).rejects.toThrow('could not persist');
      expect(hasPendingInitialPrompt(instance)).toBe(true);
      await retryPendingInitialPrompt(instance);
      expect(hasPendingInitialPrompt(instance)).toBe(false);
      expect(queue.enqueueUserMessage).toHaveBeenCalledOnce();
      expect(markInitialPromptQueued).toHaveBeenCalledTimes(2);
    } finally { pause.mockRestore(); }
  });

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

  // 2026-09-24: a Codex first turn worked for 27 minutes, then its context
  // recovery paused. "The initial message could not be delivered" was false,
  // and it repeated the reason the adapter had already posted.
  it('settles to idle without a second notice when the adapter already explained the failure', async () => {
    const instance = makeInstance('busy');
    const deps = makeDeps();
    const surfaced = Object.assign(new Error('Codex context recovery paused.'), { surfacedToUser: true });
    const send = vi.fn().mockRejectedValue(surfaced);

    await deliverInitialPromptAfterSpawn(instance, new AbortController().signal, send, deps);

    expect(instance.status).toBe('idle');
    expect(deps.queueUpdate).toHaveBeenCalledOnce();
    expect(deps.buffered).toHaveLength(0);
    expect(deps.emitted).toHaveLength(0);
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
