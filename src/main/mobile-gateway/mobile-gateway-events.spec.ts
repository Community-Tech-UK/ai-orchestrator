import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { MobileServerEvent } from '../../shared/types/mobile-gateway.types';
import { MobileGatewayEvents } from './mobile-gateway-events';
import type { GatewayInstanceSource } from './mobile-gateway-instance-routes';
import { MobileGatewayStreamCursor } from './mobile-gateway-stream-cursor';

function message(id: string, timestamp: number): OutputMessage {
  return { id, timestamp, type: 'assistant', content: id };
}

function envelope(
  seq: number,
  event: ProviderRuntimeEventEnvelope['event'],
): ProviderRuntimeEventEnvelope {
  return {
    eventId: `event-${seq}`,
    seq,
    timestamp: 100 + seq,
    provider: 'claude',
    instanceId: 'session',
    adapterGeneration: 4,
    event,
  };
}

describe('MobileGatewayEvents output cursors', () => {
  it('ends an already-working instance when its first observed update is idle', () => {
    const source = new EventEmitter() as EventEmitter & GatewayInstanceSource;
    source.getInstance = vi.fn();
    source.getAllInstances = vi.fn(() => [{ id: 'session', status: 'processing' } as Instance]);
    source.getOrchestrationHandler = vi.fn(() => new EventEmitter() as never);
    const sendLiveActivityPush = vi.fn();
    const clearLiveActivityTokens = vi.fn();
    const events = new MobileGatewayEvents({
      getInstanceSource: () => source,
      getPauseSource: () => ({
        on: vi.fn(), removeListener: vi.fn(),
        toPayload: () => ({ isPaused: false, reasons: [], pausedAt: null, lastChange: 0 }),
        addReason: vi.fn(), removeReason: vi.fn(),
      }),
      getLoopSource: () => null,
      getPauseState: () => ({ isPaused: false, reasons: [], pausedAt: null, lastChange: 0 }),
      promptStore: {
        handleInputRequired: vi.fn(), handleInputRequiredResolved: vi.fn(),
        handleUserAction: vi.fn(), clearForInstance: vi.fn(),
      } as never,
      streamCursor: new MobileGatewayStreamCursor(), hasClients: () => false,
      broadcast: vi.fn(), scheduleSnapshotBroadcast: vi.fn(), isInstanceBeingViewed: () => false,
      clearInstanceQueue: vi.fn(), clearSendInFlight: vi.fn(), drainQueue: vi.fn(),
      drainAllQueues: vi.fn(), sendCompletionPush: vi.fn(), sendLiveActivityPush,
      clearLiveActivityTokens, warn: vi.fn(),
    });
    events.attach();

    source.emit('instance:state-update', { instanceId: 'session', status: 'idle' });

    expect(sendLiveActivityPush).toHaveBeenCalledOnce();
    expect(sendLiveActivityPush).toHaveBeenCalledWith('session', 'idle', 'end');
    expect(clearLiveActivityTokens).toHaveBeenCalledWith('session');
    events.detach();
  });

  it('does not advance streamSeq for non-output provider events', () => {
    const source = new EventEmitter() as EventEmitter & GatewayInstanceSource;
    const buffer: OutputMessage[] = [];
    source.getInstance = vi.fn(() => ({ outputBuffer: buffer } as Instance));
    source.getAllInstances = vi.fn(() => []);
    source.getOrchestrationHandler = vi.fn(() => new EventEmitter() as never);
    const broadcasts: MobileServerEvent[] = [];
    const events = new MobileGatewayEvents({
      getInstanceSource: () => source,
      getPauseSource: () => ({
        on: vi.fn(), removeListener: vi.fn(),
        toPayload: () => ({ isPaused: false, reasons: [], pausedAt: null, lastChange: 0 }),
        addReason: vi.fn(), removeReason: vi.fn(),
      }),
      getLoopSource: () => null,
      getPauseState: () => ({ isPaused: false, reasons: [], pausedAt: null, lastChange: 0 }),
      promptStore: {
        handleInputRequired: vi.fn(), handleInputRequiredResolved: vi.fn(),
        handleUserAction: vi.fn(), clearForInstance: vi.fn(),
      } as never,
      streamCursor: new MobileGatewayStreamCursor(),
      hasClients: () => true,
      broadcast: (event) => broadcasts.push(event),
      scheduleSnapshotBroadcast: vi.fn(), isInstanceBeingViewed: () => false,
      clearInstanceQueue: vi.fn(), clearSendInFlight: vi.fn(), drainQueue: vi.fn(),
      drainAllQueues: vi.fn(), sendCompletionPush: vi.fn(), sendLiveActivityPush: vi.fn(),
      clearLiveActivityTokens: vi.fn(), warn: vi.fn(),
    });
    events.attach();

    buffer.push(message('first', 101));
    source.emit('provider:normalized-event', envelope(3, {
      kind: 'output', content: 'first', messageType: 'assistant', messageId: 'first', timestamp: 101,
    }));
    source.emit('provider:normalized-event', envelope(4, { kind: 'status', status: 'processing' }));
    buffer.push(message('second', 105));
    source.emit('provider:normalized-event', envelope(5, {
      kind: 'output', content: 'second', messageType: 'assistant', messageId: 'second', timestamp: 105,
    }));

    const frames = broadcasts.filter(
      (event): event is Extract<MobileServerEvent, { type: 'instance-output' }> => event.type === 'instance-output',
    );
    expect(frames.map((frame) => frame.data.seq)).toEqual([3, 5]);
    expect(frames.map((frame) => frame.data.streamSeq)).toEqual([0, 1]);
    expect(frames.map((frame) => frame.data.bufferIndex)).toEqual([0, 1]);
    expect(frames.map((frame) => frame.data.cursorEpoch)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    expect(frames[1].data.cursorEpoch).toBe(frames[0].data.cursorEpoch);
    expect(frames.map((frame) => frame.data.adapterGeneration)).toEqual([4, 4]);

    events.detach();
  });
});
