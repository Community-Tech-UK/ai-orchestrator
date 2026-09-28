import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import {
  CRASH_TURN_CONTINUATION_PROMPT,
  InstanceCrashTurnContinuation,
  MAX_CRASH_TURN_CONTINUATIONS,
  type InstanceCrashTurnContinuationHost,
} from './instance-crash-turn-continuation';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const ID = 'instance-1';

describe('InstanceCrashTurnContinuation', () => {
  let events: EventEmitter;
  let registry: InstanceAsyncWorkRegistry;
  let instance: Instance;
  let host: InstanceCrashTurnContinuationHost;
  let sendInput: ReturnType<typeof vi.fn>;
  let emitSystemMessage: ReturnType<typeof vi.fn>;
  let waitForInstanceSettled: ReturnType<typeof vi.fn>;
  let isManagedLoopInstance: ReturnType<typeof vi.fn>;
  let isPaused: ReturnType<typeof vi.fn>;
  let continuation: InstanceCrashTurnContinuation;

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function transition(previousStatus: Instance['status'], status: Instance['status']): void {
    instance.status = status;
    events.emit('instance:state-changed', { instanceId: ID, previousStatus, status, timestamp: Date.now() });
  }

  function restartNotice(metadata: Record<string, unknown> = { autoRespawn: true }): void {
    const envelope: ProviderRuntimeEventEnvelope = {
      eventId: `notice-${Math.random()}`,
      seq: 1,
      timestamp: Date.now(),
      provider: 'copilot',
      instanceId: ID,
      event: { kind: 'output', messageType: 'system', content: 'Session reconnected automatically', metadata },
    };
    events.emit('provider:normalized-event', envelope);
  }

  /** busy → respawning → ready → idle, then the restart notice — the pogg12k15 shape. */
  function crashMidTurnAndRestart(): void {
    transition('idle', 'busy');
    transition('busy', 'respawning');
    transition('respawning', 'ready');
    transition('ready', 'idle');
    restartNotice();
  }

  beforeEach(() => {
    events = new EventEmitter();
    registry = new InstanceAsyncWorkRegistry();
    instance = {
      id: ID,
      parentId: null,
      launchMode: 'orchestrated',
      status: 'idle',
      requestCount: 3,
      outputBuffer: [],
    } as unknown as Instance;
    // The real sendInput runs beforeProviderDispatch, then the turn starts.
    sendInput = vi.fn(async (_id, _message, _attachments, options) => {
      (options as { beforeProviderDispatch?: () => void } | undefined)?.beforeProviderDispatch?.();
      instance.requestCount += 1;
      events.emit('instance:input-started', { instanceId: ID, autoContinuation: true });
      transition('idle', 'busy');
    });
    emitSystemMessage = vi.fn();
    waitForInstanceSettled = vi.fn(async () => instance);
    isManagedLoopInstance = vi.fn(() => false);
    isPaused = vi.fn(() => false);
    host = {
      on: (event, listener) => events.on(event, listener),
      off: (event, listener) => events.off(event, listener),
      getInstance: vi.fn(() => instance),
      emitSystemMessage,
      waitForInstanceSettled,
      sendInput,
    };
    continuation = new InstanceCrashTurnContinuation(registry, host, isManagedLoopInstance, isPaused);
    continuation.start();
  });

  afterEach(() => continuation.stop());

  it('continues a turn cut off by an unexpected exit once the restart settles', async () => {
    crashMidTurnAndRestart();

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(waitForInstanceSettled).toHaveBeenCalledOnce();
    expect(sendInput).toHaveBeenCalledWith(ID, CRASH_TURN_CONTINUATION_PROMPT, undefined, {
      autoContinuation: true,
      internalSource: 'crash-turn-continuation',
      signal: expect.any(AbortSignal),
      beforeProviderDispatch: expect.any(Function),
    });
    expect(emitSystemMessage).toHaveBeenCalledWith(
      ID,
      `Continuing the interrupted turn automatically (attempt 1 of ${MAX_CRASH_TURN_CONTINUATIONS}).`,
      { source: 'crash-turn-continuation', attempt: 1 },
    );
  });

  it('continues after a stuck-process restart, which only fires on an active turn', async () => {
    transition('idle', 'busy');
    transition('busy', 'idle');
    restartNotice({ autoRespawn: true, recoveryCause: 'stuck' });

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
  });

  it('does nothing when the process died while idle', async () => {
    transition('idle', 'respawning');
    transition('respawning', 'idle');
    restartNotice();
    await flush();

    expect(sendInput).not.toHaveBeenCalled();
  });

  it('does nothing after a user interrupt', async () => {
    transition('idle', 'busy');
    transition('busy', 'interrupting');
    transition('interrupting', 'respawning');
    transition('respawning', 'idle');
    restartNotice();
    await flush();

    expect(sendInput).not.toHaveBeenCalled();
  });

  it('does nothing when the restart already handed the session a new turn', async () => {
    transition('idle', 'busy');
    transition('busy', 'respawning');
    transition('respawning', 'busy');
    restartNotice();
    await flush();

    expect(sendInput).not.toHaveBeenCalled();
  });

  it('does not let a marker from an unannounced restart leak into a later idle restart', async () => {
    transition('idle', 'busy');
    transition('busy', 'respawning');
    transition('respawning', 'idle'); // e.g. a deferred-permission resume: no restart notice
    transition('idle', 'respawning');
    transition('respawning', 'idle');
    restartNotice();
    await flush();

    expect(sendInput).not.toHaveBeenCalled();
  });

  it(`stops after ${MAX_CRASH_TURN_CONTINUATIONS} continuations and resets when the user sends input`, async () => {
    for (let i = 1; i <= MAX_CRASH_TURN_CONTINUATIONS; i += 1) {
      crashMidTurnAndRestart();
      await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(i));
    }

    crashMidTurnAndRestart();
    await flush();
    expect(sendInput).toHaveBeenCalledTimes(MAX_CRASH_TURN_CONTINUATIONS);
    expect(emitSystemMessage).toHaveBeenLastCalledWith(
      ID,
      expect.stringContaining('Send "continue" to try again'),
      { source: 'crash-turn-continuation', exhausted: true },
    );

    events.emit('instance:input-started', { instanceId: ID, autoContinuation: false });
    crashMidTurnAndRestart();
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(MAX_CRASH_TURN_CONTINUATIONS + 1));
  });

  describe('while waiting for the session to settle', () => {
    let settle: () => void;

    beforeEach(() => {
      waitForInstanceSettled.mockImplementation(() => new Promise<void>((resolve) => {
        settle = resolve;
      }));
    });

    it('is cancelled by user input', async () => {
      crashMidTurnAndRestart();
      events.emit('instance:input-started', { instanceId: ID, autoContinuation: false });
      settle();
      await flush();

      expect(sendInput).not.toHaveBeenCalled();
    });

    it('is cancelled by an interrupt', async () => {
      crashMidTurnAndRestart();
      events.emit('instance:interrupt-requested', { instanceId: ID });
      settle();
      await flush();

      expect(sendInput).not.toHaveBeenCalled();
    });

    it('is cancelled when the session is terminated', async () => {
      crashMidTurnAndRestart();
      transition('idle', 'terminated');
      settle();
      await flush();

      expect(sendInput).not.toHaveBeenCalled();
    });

    it('stands down when a queued user message dispatched first', async () => {
      crashMidTurnAndRestart();
      instance.requestCount += 1;
      settle();
      await flush();

      expect(sendInput).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['a child instance', () => { instance.parentId = 'parent-1'; }],
    ['a terminal-mode session', () => { instance.launchMode = 'interactive'; }],
  ])('ignores %s', async (_label, arrange) => {
    arrange();
    crashMidTurnAndRestart();
    await flush();

    expect(sendInput).not.toHaveBeenCalled();
  });

  it.each([
    ['the orchestrator is paused', () => { isPaused.mockReturnValue(true); }],
    ['a loop owns the session', () => { isManagedLoopInstance.mockReturnValue(true); }],
    ['the pause state cannot be read', () => { isPaused.mockImplementation(() => { throw new Error('unavailable'); }); }],
    ['the session is parked', () => { instance.waitReason = { kind: 'provider-limit' } as unknown as Instance['waitReason']; }],
    ['background work is pending', () => { vi.spyOn(registry, 'hasInhibitor').mockReturnValue(true); }],
  ])('suppresses delivery when %s', async (_label, arrange) => {
    arrange();
    crashMidTurnAndRestart();
    await flush();
    await flush();

    expect(sendInput).not.toHaveBeenCalled();
  });
});
