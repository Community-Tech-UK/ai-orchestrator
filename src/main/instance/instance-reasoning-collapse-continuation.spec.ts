import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import {
  CONTENT_FILTER_CONTINUATION_PROMPT,
  CONTENT_FILTER_NOTICE,
  InstanceReasoningCollapseContinuation,
  MAX_REASONING_COLLAPSE_CONTINUATIONS,
  REASONING_COLLAPSE_CONTINUATION_PROMPT,
  REASONING_COLLAPSE_NOTICE,
  type InstanceReasoningCollapseContinuationHost,
} from './instance-reasoning-collapse-continuation';
import { captureInstanceRecoveryEpoch, isInstanceRecoveryEpochCurrent } from './instance-turn-ending-state';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const ID = 'instance-1';

describe('InstanceReasoningCollapseContinuation', () => {
  let events: EventEmitter;
  let registry: InstanceAsyncWorkRegistry;
  let instance: Instance;
  let host: InstanceReasoningCollapseContinuationHost;
  let sendInput: ReturnType<typeof vi.fn>;
  let emitSystemMessage: ReturnType<typeof vi.fn>;
  let waitForInstanceSettled: ReturnType<typeof vi.fn>;
  let isManagedLoopInstance: ReturnType<typeof vi.fn>;
  let isPaused: ReturnType<typeof vi.fn>;
  let continuation: InstanceReasoningCollapseContinuation;

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function cutoffComplete(metadata: Record<string, unknown>): void {
    const envelope: ProviderRuntimeEventEnvelope = {
      eventId: `complete-${Math.random()}`,
      seq: 1,
      timestamp: Date.now(),
      provider: 'opencode',
      instanceId: ID,
      raw: {
        source: 'adapter-event:complete',
        payload: { metadata: { stopReason: 'end_turn', ...metadata } },
      },
      event: { kind: 'complete', stopReason: 'end_turn' },
    };
    events.emit('provider:normalized-event', envelope);
  }

  function collapseComplete(): void {
    cutoffComplete({ reasoningCollapsed: true });
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
    sendInput = vi.fn(async (_id, _message, _attachments, options) => {
      (options as { beforeProviderDispatch?: () => void } | undefined)?.beforeProviderDispatch?.();
      instance.requestCount += 1;
      events.emit('instance:input-started', { instanceId: ID, autoContinuation: true });
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
    continuation = new InstanceReasoningCollapseContinuation(registry, host, isManagedLoopInstance, isPaused);
    continuation.start();
  });

  afterEach(() => continuation.stop());

  it('invalidates pending overflow at actual user-input and Stop boundaries, preserving internal inputs', () => {
    const epoch = captureInstanceRecoveryEpoch(ID);
    events.emit('instance:input-started', { instanceId: ID, autoContinuation: true });
    expect(isInstanceRecoveryEpochCurrent(ID, epoch)).toBe(true);
    events.emit('instance:input-started', { instanceId: ID, autoContinuation: false });
    expect(isInstanceRecoveryEpochCurrent(ID, epoch)).toBe(false);
    const next = captureInstanceRecoveryEpoch(ID);
    events.emit('instance:interrupt-requested', { instanceId: ID, origin: 'user' });
    expect(isInstanceRecoveryEpochCurrent(ID, next)).toBe(false);
  });

  it('continues a root session whose reasoning collapsed', async () => {
    collapseComplete();

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(sendInput).toHaveBeenCalledWith(ID, REASONING_COLLAPSE_CONTINUATION_PROMPT, undefined, {
      autoContinuation: true,
      internalSource: 'reasoning-collapse-continuation',
      signal: expect.any(AbortSignal),
      beforeProviderDispatch: expect.any(Function),
      assertProviderDispatchCurrent: expect.any(Function),
    });
    expect(emitSystemMessage).toHaveBeenCalledWith(
      ID,
      REASONING_COLLAPSE_NOTICE,
      { source: 'reasoning-collapse' },
    );
    expect(emitSystemMessage).toHaveBeenCalledWith(
      ID,
      `Continuing the cut-off turn automatically (attempt 1 of ${MAX_REASONING_COLLAPSE_CONTINUATIONS}).`,
      { source: 'reasoning-collapse', attempt: 1 },
    );
  });

  it('continues a root session the provider content-filtered', async () => {
    const adapter = { prepareContentFilterRecovery: async () => true };
    Object.assign(host, { getAdapter: () => adapter });
    cutoffComplete({ contentFilterBlocked: true, contentFilterFromTool: true });

    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(sendInput).toHaveBeenCalledWith(ID, CONTENT_FILTER_CONTINUATION_PROMPT, undefined, {
      autoContinuation: true,
      internalSource: 'content-filter-continuation',
      signal: expect.any(AbortSignal),
      beforeProviderDispatch: expect.any(Function),
      assertProviderDispatchCurrent: expect.any(Function),
    });
    expect(emitSystemMessage).toHaveBeenCalledWith(
      ID,
      CONTENT_FILTER_NOTICE,
      { source: 'content-filter' },
    );
  });

  it('ignores a normal completion', async () => {
    events.emit('provider:normalized-event', {
      eventId: 'complete-ok',
      seq: 1,
      timestamp: Date.now(),
      provider: 'opencode',
      instanceId: ID,
      raw: { source: 'adapter-event:complete', payload: { metadata: { stopReason: 'end_turn' } } },
      event: { kind: 'complete', stopReason: 'end_turn' },
    } satisfies ProviderRuntimeEventEnvelope);
    await flush();

    expect(sendInput).not.toHaveBeenCalled();
    expect(emitSystemMessage).not.toHaveBeenCalled();
  });

  it('explains the stop but does not continue a child session', async () => {
    instance.parentId = 'parent-1';
    collapseComplete();
    await flush();

    expect(emitSystemMessage).toHaveBeenCalledWith(ID, REASONING_COLLAPSE_NOTICE, { source: 'reasoning-collapse' });
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('does not continue while paused or while a managed loop owns the session', async () => {
    isPaused.mockReturnValue(true);
    collapseComplete();
    await flush();
    expect(sendInput).not.toHaveBeenCalled();

    isPaused.mockReturnValue(false);
    isManagedLoopInstance.mockReturnValue(true);
    collapseComplete();
    await flush();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it(`stops after ${MAX_REASONING_COLLAPSE_CONTINUATIONS} continuations and resets when the user sends input`, async () => {
    for (let i = 1; i <= MAX_REASONING_COLLAPSE_CONTINUATIONS; i += 1) {
      collapseComplete();
      await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(i));
      instance.status = 'idle';
    }

    collapseComplete();
    await flush();
    expect(sendInput).toHaveBeenCalledTimes(MAX_REASONING_COLLAPSE_CONTINUATIONS);
    expect(emitSystemMessage).toHaveBeenCalledWith(
      ID,
      expect.stringContaining('Send "continue" to try again'),
      { source: 'reasoning-collapse', exhausted: true },
    );

    events.emit('instance:input-started', { instanceId: ID, autoContinuation: false });
    collapseComplete();
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(MAX_REASONING_COLLAPSE_CONTINUATIONS + 1));
  });
  it('continues a native max_tokens completion without repetitive thinking', async () => {
    cutoffComplete({ stopReason: 'max_tokens' });
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(sendInput.mock.calls[0]?.[1]).toContain('smaller pieces');
  });

  it('shares one two-attempt budget between crash and length endings across compaction', async () => {
    cutoffComplete({ stopReason: 'max_tokens' });
    await flush();
    events.emit('instance:state-changed', { instanceId: ID, previousStatus: 'busy', status: 'respawning' });
    events.emit('provider:normalized-event', {
      instanceId: ID, event: { kind: 'output', messageType: 'system', metadata: { autoRespawn: true } },
    });
    await flush();
    events.emit('provider:normalized-event', { instanceId: ID, event: { kind: 'compaction' } });
    collapseComplete();
    await flush();
    expect(sendInput).toHaveBeenCalledTimes(2);
  });

  it('stands down while Codex owns the next goal turn', async () => {
    Object.assign(host, { getAdapter: () => ({ hasProviderAutoContinuation: async () => true }) });
    collapseComplete();
    await flush();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('stands down if a native goal activates while Harness input is queued for context preparation', async () => {
    let nativeOwner = false;
    let providerDispatches = 0;
    const adapter = {
      hasProviderAutoContinuation: vi.fn(async () => nativeOwner),
      hasPendingProviderAutoContinuation: () => nativeOwner,
    };
    Object.assign(host, { getAdapter: () => adapter });
    sendInput.mockImplementation(async (_id, _message, _attachments, options) => {
      // The initial asynchronous goal query was inactive; a goal notification
      // arrives during the manager's asynchronous context preparation.
      nativeOwner = true;
      options.beforeProviderDispatch();
      providerDispatches += 1;
    });
    collapseComplete();
    await flush();
    expect(adapter.hasProviderAutoContinuation).toHaveBeenCalledOnce();
    expect(providerDispatches).toBe(0);
    expect(emitSystemMessage.mock.calls.some((call) => call[2]?.attempt)).toBe(false);
    expect(instance.requestCount).toBe(3);
  });

  it('does not replay an instruction refusal without source sanitization', async () => {
    cutoffComplete({ stopReason: 'refusal' });
    await flush();
    expect(sendInput).not.toHaveBeenCalled();
    expect(emitSystemMessage).toHaveBeenCalled();
  });

  it('cancels at the provider dispatch fence when the user takes over', async () => {
    sendInput.mockImplementation(async (_id, _message, _attachments, options) => {
      events.emit('instance:input-started', { instanceId: ID, autoContinuation: false });
      expect(() => options.beforeProviderDispatch()).toThrow();
    });
    collapseComplete();
    await flush();
    expect(sendInput).toHaveBeenCalledOnce();
    expect(emitSystemMessage.mock.calls.some((call) => call[2]?.attempt)).toBe(false);
  });

  it('can schedule the second cutoff before the first send promise settles', async () => {
    let completeSend!: () => void;
    sendInput.mockImplementationOnce(async (_id, _message, _attachments, options) => {
      options.beforeProviderDispatch();
      instance.requestCount += 1;
      cutoffComplete({ stopReason: 'max_tokens' });
      await new Promise<void>((resolve) => { completeSend = resolve; });
    });
    collapseComplete();
    await flush();
    expect(sendInput).toHaveBeenCalledTimes(2);
    completeSend();
  });

  it('cancels queued length recovery when a later normal completion supersedes it', async () => {
    let settle!: () => void;
    waitForInstanceSettled.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve; }));
    collapseComplete();
    cutoffComplete({ stopReason: 'end_turn' });
    settle();
    await flush();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('notices an abnormal ending for a managed loop without sending a prompt', async () => {
    isManagedLoopInstance.mockReturnValue(true);
    cutoffComplete({ stopReason: 'max_tokens' });
    await flush();
    expect(sendInput).not.toHaveBeenCalled();
    expect(emitSystemMessage).toHaveBeenCalled();
  });

  it('preserves the stop reason on intentional hibernation and offers continuation after wake restoration', async () => {
    isPaused.mockReturnValue(true);
    cutoffComplete({ stopReason: 'max_tokens' });
    await flush();
    emitSystemMessage.mockClear();
    instance.status = 'hibernated';
    events.emit('instance:state-changed', { instanceId: ID, previousStatus: 'hibernating', status: 'hibernated' });
    expect(emitSystemMessage).toHaveBeenCalledWith(ID,
      expect.stringContaining('max output'), { source: 'turn-ending-hibernation', reason: 'max_output' });
    emitSystemMessage.mockClear();
    instance.status = 'waking';
    events.emit('instance:state-changed', { instanceId: ID, previousStatus: 'hibernated', status: 'waking' });
    instance.status = 'idle';
    events.emit('instance:state-changed', { instanceId: ID, previousStatus: 'waking', status: 'idle' });
    expect(emitSystemMessage).not.toHaveBeenCalled();
    instance.status = 'ready';
    events.emit('instance:state-changed', { instanceId: ID, previousStatus: 'idle', status: 'ready' });
    expect(emitSystemMessage).toHaveBeenCalledWith(ID,
      expect.stringContaining('Send "continue"'), { source: 'turn-ending-wake', reason: 'max_output' });
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('does not offer another automatic-budget continuation after two attempts on wake', async () => {
    collapseComplete(); await flush();
    collapseComplete(); await flush();
    emitSystemMessage.mockClear();
    events.emit('instance:state-changed', { instanceId: ID, previousStatus: 'hibernated', status: 'waking' });
    events.emit('instance:state-changed', { instanceId: ID, previousStatus: 'waking', status: 'ready' });
    expect(emitSystemMessage.mock.calls[0]?.[1]).toContain('max output');
    expect(emitSystemMessage.mock.calls[0]?.[1]).not.toContain('Send "continue"');
    expect(sendInput).toHaveBeenCalledTimes(2);
  });

});
