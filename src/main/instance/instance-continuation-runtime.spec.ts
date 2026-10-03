import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { ProviderRuntimeEventEnvelope, TurnEndingClassification } from '@contracts/types/provider-runtime-events';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import { InstanceContinuationRuntime } from './instance-continuation-runtime';
import { InstanceContinuationDispatch } from './instance-continuation-dispatch';
import { InstanceAsyncWorkContinuation } from './instance-async-work-continuation';
import { InstanceAnnounceThenHaltContinuation } from './instance-announce-then-halt-continuation';
import type { InstanceReasoningCollapseContinuationHost } from './instance-reasoning-collapse-continuation';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

describe('shared continuation runtime', () => {
  let events: EventEmitter;
  let registry: InstanceAsyncWorkRegistry;
  let instance: Instance;
  let host: InstanceReasoningCollapseContinuationHost;
  let runtime: InstanceContinuationRuntime;
  let providerInputs: string[];
  let adapter: unknown;
  let paused: boolean;
  let looping: boolean;
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  function complete(ending?: TurnEndingClassification, content = "I'll now run the tests."): void {
    events.emit('provider:normalized-event', {
      eventId: 'event', seq: 1, timestamp: Date.now(), instanceId: 'root',
      provider: instance.provider === 'cursor' ? 'cursor' : 'opencode',
      raw: { source: 'adapter-event:complete', payload: { content } },
      event: { kind: 'complete', requestCountAtCompletion: instance.requestCount, ...(ending ? { turnEnding: ending } : {}) },
    } satisfies ProviderRuntimeEventEnvelope);
  }
  function terminal(workId = 'background'): void {
    registry.observe('root', { phase: 'terminal', workId, kind: 'background-shell', status: 'completed' });
  }
  beforeEach(() => {
    events = new EventEmitter();
    registry = new InstanceAsyncWorkRegistry();
    instance = { id: 'root', parentId: null, launchMode: 'orchestrated', provider: 'opencode',
      sessionId: 'session', adapterGeneration: 1, status: 'idle', requestCount: 3, lastActivity: 0,
      outputBuffer: [{ id: 'answer', type: 'assistant', content: "I'll now run the tests.", timestamp: 0 }],
    } as Instance;
    providerInputs = [];
    paused = false;
    looping = false;
    adapter = {};
    host = {
      on: events.on.bind(events), off: events.off.bind(events), getInstance: () => instance,
      getAdapter: () => adapter, emitSystemMessage: vi.fn(),
      waitForInstanceSettled: async () => instance,
      sendInput: async (_id, prompt, _attachments, options) => {
        events.emit('instance:input-started', { instanceId: 'root', autoContinuation: true });
        options?.beforeProviderDispatch?.();
        instance.requestCount += 1;
        providerInputs.push(prompt);
      },
    };
    runtime = new InstanceContinuationRuntime(registry, host, () => looping, () => paused, 0);
    runtime.start();
  });
  afterEach(() => { runtime.stop(); vi.useRealTimers(); });

  it('replaces an unsettled normal nudge with one authoritative cutoff prompt', async () => {
    let settle!: () => void;
    let waiting = 0;
    host.waitForInstanceSettled = async () => {
      if (++waiting === 1) await new Promise<void>((resolve) => { settle = resolve; });
      return instance;
    };
    complete();
    await vi.waitFor(() => expect(waiting).toBe(1));
    complete({ reason: 'max_output', evidence: 'native_max_output' });
    await vi.waitFor(() => expect(providerInputs).toHaveLength(1));
    settle(); await flush();
    expect(providerInputs).toHaveLength(1);
    expect(providerInputs[0]).toContain('Output token limit hit');
  });

  it('gives a terminal background result ownership over a queued nudge and coalesces its burst', async () => {
    let settle!: () => void;
    host.waitForInstanceSettled = () => new Promise<void>((resolve) => { settle = resolve; });
    complete();
    await vi.waitFor(() => expect(settle).toBeTypeOf('function'));
    terminal(); terminal('second');
    await vi.waitFor(() => expect(providerInputs).toHaveLength(1));
    settle(); await flush();
    expect(providerInputs).toEqual(['A background task has finished. Review its task notification and result, then continue the work you were waiting to complete.']);
    expect(registry.hasInhibitor('root')).toBe(false);
  });

  it('revokes normal background delivery when an authoritative quota ending arrives during grace', async () => {
    runtime.stop();
    runtime = new InstanceContinuationRuntime(registry, host, () => false, () => false, 10_000);
    runtime.start();
    terminal(); await Promise.resolve();
    complete({ reason: 'quota', evidence: 'native_quota' });
    await vi.waitFor(() => expect(registry.hasInhibitor('root')).toBe(false));
    expect(providerInputs).toEqual([]);
  });

  it('preserves child background wake through a newly created adapter', async () => {
    instance.parentId = 'parent';
    instance.status = 'hibernated';
    adapter = undefined;
    host.wakeInstance = async () => {
      instance.status = 'waking';
      events.emit('instance:state-changed', { instanceId: 'root', status: 'waking' });
      adapter = { hasProviderAutoContinuation: async () => false, hasPendingProviderAutoContinuation: () => false };
      instance.adapterGeneration = 2;
      instance.sessionId = 'restored-session';
      instance.status = 'ready';
      events.emit('instance:state-changed', { instanceId: 'root', status: 'ready', previousStatus: 'waking' });
    };
    terminal();
    await vi.waitFor(() => expect(registry.hasInhibitor('root')).toBe(false));
    expect(providerInputs).toHaveLength(1);
  });

  it('yields a hibernated background wake to ownership queried on its fresh adapter', async () => {
    instance.parentId = 'parent';
    instance.status = 'hibernated';
    adapter = undefined;
    host.wakeInstance = async () => {
      instance.status = 'ready';
      instance.adapterGeneration = 2;
      adapter = { hasProviderAutoContinuation: async () => true, hasPendingProviderAutoContinuation: () => true };
    };
    terminal();
    await vi.waitFor(() => expect(registry.hasInhibitor('root')).toBe(false));
    expect(providerInputs).toEqual([]);
  });

  it.each(['announce', 'async-result', 'cutoff'] as const)('yields %s to a native goal acquired during send preflight', async (source) => {
    let nativeOwner = false;
    adapter = { hasProviderAutoContinuation: async () => nativeOwner, hasPendingProviderAutoContinuation: () => nativeOwner };
    host.sendInput = async (_id, prompt, _attachments, options) => {
      nativeOwner = true;
      options?.beforeProviderDispatch?.();
      providerInputs.push(prompt);
    };
    if (source === 'async-result') terminal();
    else complete(source === 'cutoff' ? { reason: 'max_output', evidence: 'native_max_output' } : undefined);
    await flush();
    expect(providerInputs).toEqual([]);
    expect(instance.requestCount).toBe(3);
  });

  it('rechecks notice observers before charging the shared cutoff budget', async () => {
    let nativeOwner = false;
    adapter = { hasProviderAutoContinuation: async () => nativeOwner, hasPendingProviderAutoContinuation: () => nativeOwner };
    host.emitSystemMessage = (_id, _content, metadata) => { if (metadata?.['attempt']) nativeOwner = true; };
    complete({ reason: 'max_output', evidence: 'native_max_output' });
    await flush();
    expect(providerInputs).toEqual([]);
    nativeOwner = false;
    const attempts: unknown[] = [];
    host.emitSystemMessage = (_id, _content, metadata) => { if (metadata?.['attempt']) attempts.push(metadata['attempt']); };
    complete({ reason: 'max_output', evidence: 'native_max_output' }); await flush();
    complete({ reason: 'max_output', evidence: 'native_max_output' }); await flush();
    complete({ reason: 'max_output', evidence: 'native_max_output' }); await flush();
    expect(providerInputs).toHaveLength(2);
    expect(attempts).toEqual([1, 2]);
  });

  it('keeps normal and cutoff caps across automatic turns and resets them on manual input', async () => {
    complete(); await flush();
    complete({ reason: 'max_output', evidence: 'native_max_output' }); await flush();
    complete({ reason: 'content_filter', evidence: 'native_content_filter', contentFilterFromTool: true });
    // Unsupported sanitization cannot consume the remaining cutoff attempt.
    await flush();
    complete({ reason: 'max_output', evidence: 'native_max_output' }); await flush();
    complete({ reason: 'max_output', evidence: 'native_max_output' }); await flush();
    complete(); await flush();
    expect(providerInputs).toHaveLength(3);
    events.emit('instance:input-started', { instanceId: 'root', autoContinuation: false });
    instance.requestCount++;
    instance.outputBuffer = [{ id: 'fresh-answer', type: 'assistant', content: "I'll now run the tests.", timestamp: 1 }];
    complete(); await flush();
    complete({ reason: 'max_output', evidence: 'native_max_output' }); await flush();
    expect(providerInputs).toHaveLength(5);
  });

  it('stopping an injected source leaves the common owner available to the other source', async () => {
    runtime.stop();
    const owner = new InstanceContinuationDispatch(registry, host);
    const background = new InstanceAsyncWorkContinuation(registry, host, { dispatch: owner, providerResumeGraceMs: 0 });
    const announcements = new InstanceAnnounceThenHaltContinuation(registry, host, () => false, () => false, owner);
    owner.start(); background.start(); announcements.start();
    try {
      background.stop();
      complete(); await flush();
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]).toContain('Continue now.');
    } finally { background.stop(); announcements.stop(); owner.stop(); }
  });

  it('revokes a queued normal prompt when a later completion suppresses automatic continuation', async () => {
    let settle!: () => void;
    host.waitForInstanceSettled = () => new Promise<void>((resolve) => { settle = resolve; });
    complete();
    await vi.waitFor(() => expect(settle).toBeTypeOf('function'));
    complete({ reason: 'completed', evidence: 'native_completed', autoContinueSuppressed: true });
    settle(); await flush();
    expect(providerInputs).toEqual([]);
  });

  it.each(['announce', 'cursor'] as const)('revokes a queued %s prompt after a later ordinary completion on the same request', async (source) => {
    vi.useFakeTimers();
    let settle!: () => void;
    host.waitForInstanceSettled = () => new Promise<void>((resolve) => { settle = resolve; });
    if (source === 'announce') complete({ reason: 'completed', evidence: 'native_completed' });
    else {
      instance.provider = 'cursor';
      const cancel = 'Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)';
      events.emit('provider:normalized-event', {
        eventId: 'cursor', seq: 1, timestamp: 1, instanceId: 'root', provider: 'cursor',
        raw: { source: 'adapter-event:complete', payload: {
          content: `The task is incomplete.\n${cancel}`, usage: { isEstimated: true },
          metadata: { truncatedTurn: true, transportFailure: cancel, stopReason: 'end_turn' },
        } },
        event: { kind: 'complete', requestCountAtCompletion: instance.requestCount,
          turnEnding: { reason: 'truncated_transport', evidence: 'transport_tail' } },
      } satisfies ProviderRuntimeEventEnvelope);
    }
    await vi.advanceTimersByTimeAsync(source === 'cursor' ? 2_000 : 0);
    expect(settle).toBeTypeOf('function');
    const content = 'The tests passed. The requested work is complete.';
    instance.outputBuffer.push({ id: 'finished', type: 'assistant', content, timestamp: 1 });
    complete({ reason: 'completed', evidence: 'native_completed' }, content);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(providerInputs).toEqual([]);
    expect(instance.requestCount).toBe(3);
  });

  it('gives background completion ownership over a Cursor transport backoff', async () => {
    vi.useFakeTimers();
    instance.provider = 'cursor';
    const cancel = 'Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)';
    events.emit('provider:normalized-event', {
      eventId: 'cursor', seq: 1, timestamp: 1, instanceId: 'root', provider: 'cursor',
      raw: { source: 'adapter-event:complete', payload: {
        content: `The task is incomplete.\n${cancel}`, usage: { isEstimated: true },
        metadata: { truncatedTurn: true, transportFailure: cancel, stopReason: 'end_turn' },
      } },
      event: { kind: 'complete', requestCountAtCompletion: instance.requestCount,
        turnEnding: { reason: 'truncated_transport', evidence: 'transport_tail' } },
    } satisfies ProviderRuntimeEventEnvelope);
    // A later ordinary ending clears the transport notice, while its backoff is still queued.
    complete({ reason: 'completed', evidence: 'native_completed' });
    terminal();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(providerInputs).toHaveLength(1);
    expect(providerInputs[0]).toContain('A background task has finished.');
  });

  it('cancels all pending source work and releases its inhibitor on runtime shutdown', async () => {
    runtime.stop();
    runtime = new InstanceContinuationRuntime(registry, host, () => false, () => false, 10_000);
    runtime.start();
    terminal(); await Promise.resolve();
    runtime.stop(); await flush();
    expect(providerInputs).toEqual([]);
    expect(registry.hasInhibitor('root')).toBe(false);
    expect(events.eventNames()).toEqual([]);
    expect(registry.eventNames()).toEqual([]);
  });
});
