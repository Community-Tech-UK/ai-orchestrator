import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { InstanceEventsService } from '../instance-events.service';
import { IpcEventBusService, type InstanceOutputEvent } from './ipc-event-bus.service';
import { InstanceIpcService } from './instance-ipc.service';

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
  let capturedProviderRuntimeEvent:
    | ((event: ProviderRuntimeEventEnvelope) => void)
    | undefined;

  const hadElectronAPI = 'electronAPI' in (window as unknown as Record<string, unknown>);
  const originalElectronAPI = (window as unknown as { electronAPI?: unknown }).electronAPI;

  beforeEach(() => {
    capturedProviderRuntimeEvent = undefined;

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
            onInstanceCreated: () => () => undefined,
            onInstanceRemoved: () => () => undefined,
            onInstanceStateUpdate: () => () => undefined,
            onBatchUpdate: () => () => undefined,
            onOrchestrationActivity: () => () => undefined,
            onCompactStatus: () => () => undefined,
            onInputRequired: () => () => undefined,
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
});
