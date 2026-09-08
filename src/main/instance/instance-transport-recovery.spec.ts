import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { mapAdapterRuntimeEvent } from '../providers/adapter-runtime-event-bridge';
import { classifyTurnEndingFailure, turnEndingFailureMetadata } from '../cli/adapters/acp-transport-failure';
import { toAcpCliUsage } from '../cli/adapters/acp-usage-estimator';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import {
  InstanceAnnounceThenHaltContinuation,
  type InstanceAnnounceThenHaltContinuationHost,
} from './instance-announce-then-halt-continuation';
import { TRANSPORT_RECOVERY_PROMPT } from './instance-transport-recovery-policy';

const CANCEL = 'Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)';
const CONTENT = `The upgrade is in place. Next I’ll run an independent completion-gate review.\n\n${CANCEL}`;

describe('regular Cursor transport recovery', () => {
  let events: EventEmitter;
  let instance: Instance;
  let host: InstanceAnnounceThenHaltContinuationHost;
  let registry: InstanceAsyncWorkRegistry;
  let coordinator: InstanceAnnounceThenHaltContinuation;
  let dispatched: string[];
  let paused: boolean;
  let loopOwned: boolean;

  // Exercise the same classification, usage, and normalized mapper as ACP.
  function complete(content = CONTENT): ProviderRuntimeEventEnvelope {
    const failure = classifyTurnEndingFailure(content);
    const response = {
      id: `response-${instance.requestCount}`, role: 'assistant' as const, content,
      usage: toAcpCliUsage(undefined, 644910, 'Upgrade Angular', content, 'changed package.json'),
      metadata: { stopReason: 'end_turn', ...(failure ? turnEndingFailureMetadata(failure) : {}) },
    };
    const mapped = mapAdapterRuntimeEvent('complete', [response])!;
    instance.outputBuffer = [{ id: response.id, type: 'assistant', content, timestamp: Date.now() }];
    return {
      eventId: response.id, seq: instance.requestCount, timestamp: Date.now(),
      provider: 'cursor', instanceId: instance.id,
      event: { ...mapped.event, requestCountAtCompletion: instance.requestCount } as ProviderRuntimeEventEnvelope['event'],
      raw: { source: 'adapter-event:complete', payload: mapped.rawPayload },
    };
  }
  function emit(envelope = complete()): void { events.emit('provider:normalized-event', envelope); }
  function manualInput(): void {
    events.emit('instance:input-started', { instanceId: instance.id, autoContinuation: false });
    instance.requestCount++;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    events = new EventEmitter();
    instance = { id: 'root', parentId: null, provider: 'cursor', launchMode: 'orchestrated',
      status: 'idle', requestCount: 1, outputBuffer: [] } as unknown as Instance;
    registry = new InstanceAsyncWorkRegistry();
    dispatched = [];
    paused = false;
    loopOwned = false;
    host = {
      on: events.on.bind(events), off: events.off.bind(events), getInstance: () => instance,
      waitForInstanceSettled: vi.fn(async () => instance),
      emitSystemMessage: vi.fn(),
      sendInput: vi.fn(async (_id, prompt, _attachments, options) => {
        options?.beforeProviderDispatch?.();
        instance.requestCount++;
        dispatched.push(prompt);
      }),
    };
    coordinator = new InstanceAnnounceThenHaltContinuation(registry, host, () => loopOwned, () => paused);
    coordinator.start();
  });
  afterEach(() => { coordinator.stop(); vi.useRealTimers(); });

  it('resumes preserved work after backoff without replaying the user request', async () => {
    emit();
    await vi.advanceTimersByTimeAsync(1999);
    expect(dispatched).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatched).toEqual([TRANSPORT_RECOVERY_PROMPT]);
    expect(host.emitSystemMessage).toHaveBeenCalledWith('root', expect.stringContaining('attempt 1 of 2'),
      { source: 'transport-recovery', attempt: 1 });
    emit(complete('All requested checks passed.'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(dispatched).toHaveLength(1);
  });

  it('allows two retries even when complete fires before sendInput resolves, then stops', async () => {
    host.sendInput = vi.fn(async (_id, prompt, _attachments, options) => {
      options?.beforeProviderDispatch?.();
      instance.requestCount++;
      dispatched.push(prompt);
      emit(); // Real ACP event order: complete -> sendInput promise resolves.
    });
    emit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(dispatched).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(dispatched).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatched).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(dispatched).toHaveLength(2);
    expect(host.emitSystemMessage).toHaveBeenCalledWith('root', expect.stringContaining('after two automatic'),
      { source: 'transport-recovery', exhausted: true });
    manualInput();
    emit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(dispatched).toHaveLength(3);
  });

  it('deduplicates completed requests before, during and after dispatch', async () => {
    const envelope = complete();
    emit(envelope); emit(envelope);
    await vi.advanceTimersByTimeAsync(2000);
    emit(envelope);
    await vi.advanceTimersByTimeAsync(10000);
    expect(dispatched).toHaveLength(1);
  });

  it.each(['stop', 'input', 'removed', 'shutdown', 'cancelled'])(
    'cancels backoff on %s and ignores a stale completion', async (cause) => {
      const envelope = complete();
      emit(envelope);
      await vi.advanceTimersByTimeAsync(1000);
      if (cause === 'stop') events.emit('instance:interrupt-requested', { instanceId: 'root' });
      if (cause === 'input') manualInput();
      if (cause === 'removed') {
        host.getInstance = () => undefined;
        events.emit('instance:removed', 'root');
      }
      if (cause === 'shutdown') coordinator.stop();
      if (cause === 'cancelled') {
        events.emit('instance:state-changed', { instanceId: 'root', status: 'cancelled' });
      }
      emit(envelope);
      await vi.advanceTimersByTimeAsync(10000);
      expect(dispatched).toEqual([]);
    },
  );

  it('permits a fresh manual turn after Stop', async () => {
    emit();
    events.emit('instance:interrupt-requested', { instanceId: 'root' });
    manualInput();
    emit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(dispatched).toHaveLength(1);
  });

  it.each(['pause', 'loop', 'async-work', 'new-request', 'permission', 'session', 'adapter', 'provider'])(
    'rechecks %s after the backoff', async (condition) => {
      emit();
      await vi.advanceTimersByTimeAsync(1000);
      if (condition === 'pause') paused = true;
      if (condition === 'loop') loopOwned = true;
      if (condition === 'async-work') registry.observe('root', { phase: 'started', workId: 'work', kind: 'background-shell' });
      if (condition === 'new-request') instance.requestCount++;
      if (condition === 'permission') instance.status = 'waiting_for_permission';
      if (condition === 'session') instance.sessionId = 'replacement-session';
      if (condition === 'adapter') instance.adapterGeneration = 2;
      if (condition === 'provider') instance.provider = 'codex';
      await vi.advanceTimersByTimeAsync(10000);
      expect(dispatched).toEqual([]);
    },
  );

  it('cancels during asynchronous send preflight', async () => {
    let release!: () => void;
    host.sendInput = vi.fn(async (_id, prompt, _attachments, options) => {
      await new Promise<void>(resolve => { release = resolve; });
      options?.beforeProviderDispatch?.();
      dispatched.push(prompt);
    });
    emit();
    await vi.advanceTimersByTimeAsync(2000);
    events.emit('instance:interrupt-requested', { instanceId: 'root' });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatched).toEqual([]);
  });

  it('honours Stop called synchronously by a recovery-notice observer', async () => {
    host.emitSystemMessage = () => { events.emit('instance:interrupt-requested', { instanceId: 'root' }); };
    emit();
    await vi.advanceTimersByTimeAsync(10000);
    expect(dispatched).toEqual([]);
  });

  it.each(['child', 'interactive', 'loop', 'paused', 'inhibitor', 'quota', 'degraded', 'missing-fence'])(
    'does not schedule when %s owns or prevents work', async (condition) => {
      const envelope = complete();
      if (condition === 'child') instance.parentId = 'parent';
      if (condition === 'interactive') instance.launchMode = 'interactive';
      if (condition === 'loop') loopOwned = true;
      if (condition === 'paused') paused = true;
      if (condition === 'inhibitor') registry.observe('root', { phase: 'started', workId: 'work', kind: 'background-shell' });
      if (envelope.event.kind === 'complete') {
        if (condition === 'quota') envelope.event.quota = { exhausted: true };
        if (condition === 'degraded') envelope.event.degradedReason = 'delayed';
        if (condition === 'missing-fence') delete envelope.event.requestCountAtCompletion;
      }
      emit(envelope);
      await vi.advanceTimersByTimeAsync(10000);
      expect(dispatched).toEqual([]);
    },
  );

  it.each(['different-provider', 'measured-usage', 'no-metadata', 'cancelled-stop', 'no-raw', 'refusal', 'quoted', 'open-fence', 'unknown-error'])(
    'rejects %s instead of acting on generic error text', async (condition) => {
      let envelope = complete();
      const payload = envelope.raw!.payload as { usage?: unknown; metadata?: Record<string, unknown> };
      if (condition === 'different-provider') envelope = { ...envelope, provider: 'copilot' };
      if (condition === 'measured-usage') payload.usage = { inputTokens: 100, outputTokens: 10 };
      if (condition === 'no-metadata') delete payload.metadata;
      if (condition === 'cancelled-stop') payload.metadata!['stopReason'] = 'cancelled';
      if (condition === 'no-raw') envelope = { ...envelope, raw: undefined };
      if (condition === 'refusal') envelope = complete('Error: RetriableError: [resource_exhausted] Error');
      if (condition === 'quoted') envelope = complete(`Example:\n\n> ${CANCEL}`);
      if (condition === 'open-fence') envelope = complete(`Example:\n\x60\x60\x60text\n${CANCEL}`);
      if (condition === 'unknown-error') envelope = complete('Error: RetriableError: [internal] ECONNRESET yesterday');
      emit(envelope);
      await vi.advanceTimersByTimeAsync(10000);
      expect(dispatched).toEqual([]);
    },
  );
});
