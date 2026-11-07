import type { InstanceInputContextDeliveredEvent } from '../../../../../shared/types/input-context-delivery.types';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { InstanceEventsService } from '../instance-events.service';
import { IpcEventBusService, type InstanceOutputEvent, type InputRequiredEvent, type InputRequiredResolvedEvent } from './ipc-event-bus.service';
import { InstanceIpcService } from './instance-ipc.service';
import type { StateUpdate } from '../update-batcher.service';

function makeProviderEnvelope(
  partial: Partial<ProviderRuntimeEventEnvelope> = {},
): ProviderRuntimeEventEnvelope {
  return {
    eventId: 'evt-1',
    seq: 0,
    timestamp: 1_717_000_000_000,
    provider: 'claude',
    instanceId: 'inst-1',
    event: {
      kind: 'output',
      content: 'hello',
      messageType: 'assistant',
      messageId: 'msg-1',
      timestamp: 1_717_000_000_000,
    },
    ...partial,
  };
}

describe('IpcEventBusService', () => {
  let capturedDelivery: ((event: InstanceInputContextDeliveredEvent) => void) | undefined;
  let capturedProviderRuntimeEvent:
    | ((event: ProviderRuntimeEventEnvelope) => void)
    | undefined;

  let receiveInput: (request: InputRequiredEvent) => void;
  let resolveInput: (event: InputRequiredResolvedEvent) => void;
  let removeInstance: (instanceId: string) => void;
  let updateInstance: (update: StateUpdate) => void;
  let updateBatch: (batch: { updates: StateUpdate[] }) => void;

  const hadElectronAPI = 'electronAPI' in (window as unknown as Record<string, unknown>);
  const originalElectronAPI = (window as unknown as { electronAPI?: unknown }).electronAPI;

  beforeEach(() => {
    TestBed.resetTestingModule();
    capturedProviderRuntimeEvent = undefined;
    capturedDelivery = undefined;

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      onProviderRuntimeEvent: (callback: (event: ProviderRuntimeEventEnvelope) => void) => {
        capturedProviderRuntimeEvent = callback;
        return () => {
          capturedProviderRuntimeEvent = undefined;
        };
      },
    };

    TestBed.configureTestingModule({
      providers: [
        InstanceEventsService,
        IpcEventBusService,
        {
          provide: InstanceIpcService,
          useValue: {
            onInputContextDelivered: (callback: (event: InstanceInputContextDeliveredEvent) => void) => {
              capturedDelivery = callback;
              return () => { capturedDelivery = undefined; };
            },
            onInstanceCreated: () => () => undefined,
            onInstanceRemoved: (callback: typeof removeInstance) => { removeInstance = callback; return () => undefined; },
            onInstanceStateUpdate: (callback: typeof updateInstance) => { updateInstance = callback; return () => undefined; },
            onBatchUpdate: (callback: typeof updateBatch) => { updateBatch = callback; return () => undefined; },
            onOrchestrationActivity: () => () => undefined,
            onCompactStatus: () => () => undefined,
            onInputRequired: (callback: typeof receiveInput) => { receiveInput = callback; return () => undefined; },
            onInputRequiredResolved: (callback: typeof resolveInput) => { resolveInput = callback; return () => undefined; },
          },
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    if (hadElectronAPI) {
      (window as unknown as { electronAPI: unknown }).electronAPI = originalElectronAPI;
    } else {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
  });

  it('bridges delivery metadata separately from output and removes its listener', () => {
    const service = TestBed.inject(IpcEventBusService);
    const received: InstanceInputContextDeliveredEvent[] = [];
    const subscription = service.inputContextDelivered$.subscribe(event => received.push(event));
    const delivery = { instanceId: 'inst-1', messageId: 'user', deliveryId: 'delivery', tokens: 120 };
    capturedDelivery?.(delivery); expect(received).toEqual([delivery]);
    subscription.unsubscribe(); expect(capturedDelivery).toBeUndefined();
  });

  it('bridges provider runtime output envelopes into instanceOutput$', () => {
    const service = TestBed.inject(IpcEventBusService);
    const received: InstanceOutputEvent[] = [];

    service.instanceOutput$.subscribe((event) => received.push(event));

    capturedProviderRuntimeEvent?.(makeProviderEnvelope({
      event: {
        kind: 'output',
        content: 'hello world',
        messageType: 'assistant',
        messageId: 'msg-1',
        timestamp: 1_717_000_000_123,
        attachments: [{ name: 'img.png', type: 'image/png', size: 123, data: 'data:image/png;base64,abc' }],
        thinking: [{ id: 'thought-1', content: 'thinking', format: 'structured', timestamp: 1_717_000_000_124 }],
        thinkingExtracted: true,
      },
    }));

    expect(received).toEqual([
      {
        instanceId: 'inst-1',
        message: {
          id: 'msg-1',
          timestamp: 1_717_000_000_123,
          type: 'assistant',
          content: 'hello world',
          attachments: [{ name: 'img.png', type: 'image/png', size: 123, data: 'data:image/png;base64,abc' }],
          thinking: [{ id: 'thought-1', content: 'thinking', format: 'structured', timestamp: 1_717_000_000_124 }],
          thinkingExtracted: true,
        },
      },
    ]);
  });

  it('ignores non-output provider runtime events', () => {
    const service = TestBed.inject(IpcEventBusService);
    const received: InstanceOutputEvent[] = [];

    service.instanceOutput$.subscribe((event) => received.push(event));

    capturedProviderRuntimeEvent?.(makeProviderEnvelope({
      event: {
        kind: 'status',
        status: 'busy',
      },
    }));

    expect(received).toHaveLength(0);
  });

  const request = (instanceId = 'child', requestId = 'approval'): InputRequiredEvent => ({
    instanceId, requestId, prompt: 'Allow this exact operation?', timestamp: 42,
    metadata: { type: 'deferred_permission', tool_use_id: 'runtime-tool', tool_input: { command: 'echo approval' } },
  });

  it('retains complete payloads without a panel and deduplicates downstream deliveries', () => {
    const service = TestBed.inject(IpcEventBusService);
    const delivered: InputRequiredEvent[] = [];
    service.inputRequired$.subscribe((event) => delivered.push(event));
    const payload = request();
    receiveInput(payload);
    receiveInput(payload);
    receiveInput(request('parent'));
    expect(service.pendingInputRequired()).toEqual([payload, request('parent')]);
    // InstanceStore derives its approval count from this shared stream.
    expect(delivered).toEqual([payload, request('parent')]);
  });

  it.each(['timeout', 'auto_approved', 'decided', 'cancelled', 'exited'] as const)(
    'removes only the matching runtime request when resolved: %s', (reason) => {
      const service = TestBed.inject(IpcEventBusService);
      receiveInput(request());
      receiveInput(request('parent'));
      resolveInput({ instanceId: 'child', requestId: 'approval', reason });
      expect(service.pendingInputRequired()).toEqual([request('parent')]);
    },
  );

  it('clears removed instances without clearing their parent or siblings', () => {
    const service = TestBed.inject(IpcEventBusService);
    receiveInput(request());
    receiveInput(request('parent'));
    receiveInput(request('sibling'));
    removeInstance('child');
    expect(service.pendingInputRequired()).toEqual([request('parent'), request('sibling')]);
  });

  it.each(['cancelled', 'interrupting', 'respawning', 'error', 'terminated', 'hibernated', 'initializing'])(
    'clears requests while unmounted when the runtime becomes %s', (status) => {
      const service = TestBed.inject(IpcEventBusService);
      receiveInput(request());
      receiveInput(request('parent'));
      updateInstance({ instanceId: 'child', status });
      expect(service.pendingInputRequired()).toEqual([request('parent')]);
    },
  );

  it.each(['adapterGeneration', 'restartEpoch'] as const)('clears on %s replacement through batch updates', (key) => {
    const service = TestBed.inject(IpcEventBusService);
    updateInstance({ instanceId: 'child', [key]: 1 });
    receiveInput(request());
    receiveInput(request('parent'));
    updateBatch({ updates: [{ instanceId: 'child', [key]: 1, status: 'waiting' }] });
    expect(service.pendingInputRequired()).toHaveLength(2);
    updateBatch({ updates: [{ instanceId: 'child', [key]: 2 }] });
    expect(service.pendingInputRequired()).toEqual([request('parent')]);
    receiveInput(request('child', 'new-runtime-request'));
    expect(service.pendingInputRequired()).toEqual([request('parent'), request('child', 'new-runtime-request')]);
  });

  it('clears on replacement observed through the actual normalized provider event channel', () => {
    const service = TestBed.inject(IpcEventBusService);
    capturedProviderRuntimeEvent?.(makeProviderEnvelope({ instanceId: 'child', adapterGeneration: 1 }));
    receiveInput(request());
    capturedProviderRuntimeEvent?.(makeProviderEnvelope({ instanceId: 'child', seq: 1, adapterGeneration: 2 }));
    expect(service.pendingInputRequired()).toEqual([]);
  });

  it('clears on provider exit without requiring a mounted panel', () => {
    const service = TestBed.inject(IpcEventBusService);
    receiveInput(request());
    capturedProviderRuntimeEvent?.(makeProviderEnvelope({ instanceId: 'child', event: { kind: 'exit', code: 0, signal: null } }));
    expect(service.pendingInputRequired()).toEqual([]);
  });

});
