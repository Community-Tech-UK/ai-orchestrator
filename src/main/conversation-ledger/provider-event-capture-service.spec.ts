import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { ProviderEventCaptureService } from './provider-event-capture-service';

describe('ProviderEventCaptureService', () => {
  let events: EventEmitter;
  let appendProviderEventCaptures: ReturnType<typeof vi.fn>;
  let service: ProviderEventCaptureService;

  beforeEach(() => {
    events = new EventEmitter();
    appendProviderEventCaptures = vi.fn().mockResolvedValue(undefined);
    service = new ProviderEventCaptureService({
      ledger: { appendProviderEventCaptures },
    });
    service.start(events);
  });

  it('batches raw-backed canonical events without requiring a conversation thread', async () => {
    events.emit('provider:normalized-event', envelope({
      eventId: '11111111-1111-4111-8111-111111111111',
      instanceId: 'instance-1',
      sessionId: 'session-1',
      seq: 3,
      event: { kind: 'output', content: 'hello' },
      raw: { source: 'adapter-event:output', payload: { nativeId: 'native-1' } },
    }));

    await service.flush();

    expect(appendProviderEventCaptures).toHaveBeenCalledWith([
      expect.objectContaining({
        eventId: '11111111-1111-4111-8111-111111111111',
        instanceId: 'instance-1',
        sessionId: 'session-1',
        sequence: 3,
        event: { kind: 'output', content: 'hello' },
        raw: { source: 'adapter-event:output', payload: { nativeId: 'native-1' } },
      }),
    ]);
  });

  it('ignores canonical events that have no raw provenance', async () => {
    events.emit('provider:normalized-event', envelope({
      eventId: '22222222-2222-4222-8222-222222222222',
      event: { kind: 'status', status: 'idle' },
    }));

    await service.flush();

    expect(appendProviderEventCaptures).not.toHaveBeenCalled();
  });

  it('retains a failed batch for a later retry', async () => {
    appendProviderEventCaptures.mockRejectedValueOnce(new Error('ledger unavailable'));
    events.emit('provider:normalized-event', envelope({
      eventId: '33333333-3333-4333-8333-333333333333',
      event: { kind: 'status', status: 'busy' },
      raw: { source: 'adapter-event:status', payload: 'busy' },
    }));

    await expect(service.flush()).rejects.toThrow('ledger unavailable');
    await service.flush();

    expect(appendProviderEventCaptures).toHaveBeenCalledTimes(2);
    expect(appendProviderEventCaptures.mock.calls[1][0]).toEqual([
      expect.objectContaining({ eventId: '33333333-3333-4333-8333-333333333333' }),
    ]);
  });

  it('flushes an event queued while the preceding ledger write is in flight', async () => {
    vi.useFakeTimers();
    try {
      let resolveFirstWrite: (() => void) | undefined;
      appendProviderEventCaptures.mockImplementationOnce(
        () => new Promise<void>((resolve) => { resolveFirstWrite = resolve; }),
      );
      await service.stop();
      service = new ProviderEventCaptureService({
        ledger: { appendProviderEventCaptures },
        flushDelayMs: 0,
      });
      service.start(events);

      events.emit('provider:normalized-event', envelope({
        eventId: '44444444-4444-4444-8444-444444444444',
        raw: { source: 'adapter-event:status', payload: 'busy' },
      }));
      const firstFlush = service.flush();

      events.emit('provider:normalized-event', envelope({
        eventId: '55555555-5555-4555-8555-555555555555',
        raw: { source: 'adapter-event:status', payload: 'idle' },
      }));
      resolveFirstWrite?.();
      await firstFlush;
      await vi.runOnlyPendingTimersAsync();

      expect(appendProviderEventCaptures).toHaveBeenCalledTimes(2);
      expect(appendProviderEventCaptures.mock.calls[1][0]).toEqual([
        expect.objectContaining({ eventId: '55555555-5555-4555-8555-555555555555' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  function envelope(
    overrides: Partial<ProviderRuntimeEventEnvelope>,
  ): ProviderRuntimeEventEnvelope {
    return {
      eventId: '00000000-0000-4000-8000-000000000000',
      seq: 0,
      timestamp: 100,
      provider: 'claude',
      instanceId: 'instance-default',
      event: { kind: 'status', status: 'busy' },
      ...overrides,
    };
  }
});
