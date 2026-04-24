import { Injectable, inject } from '@angular/core';
import { Observable, filter, map, share } from 'rxjs';

import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { OutputMessage } from '../../../../../shared/types/instance.types';
import type { OrchestrationActivityPayload } from '../../../../../shared/types/ipc.types';
import type { StateUpdate } from '../../services/update-batcher.service';
import { InstanceEventsService } from '../instance-events.service';
import { InstanceIpcService } from './instance-ipc.service';

function toOutputMessageType(
  messageType: string | undefined,
): OutputMessage['type'] {
  switch (messageType) {
    case 'assistant':
    case 'user':
    case 'system':
    case 'tool_use':
    case 'tool_result':
    case 'error':
      return messageType;
    default:
      return 'assistant';
  }
}

function toInstanceOutputEventFromEnvelope(
  envelope: ProviderRuntimeEventEnvelope,
): InstanceOutputEvent | null {
  if (envelope.event.kind !== 'output') {
    return null;
  }

  const message: OutputMessage = {
    id: envelope.event.messageId ?? envelope.eventId,
    timestamp: envelope.event.timestamp ?? envelope.timestamp,
    type: toOutputMessageType(envelope.event.messageType),
    content: envelope.event.content,
  };

  if (envelope.event.metadata !== undefined) {
    message.metadata = { ...envelope.event.metadata };
  }

  if (envelope.adapterGeneration !== undefined || envelope.turnId !== undefined) {
    message.metadata = {
      ...message.metadata,
      ...(envelope.adapterGeneration !== undefined ? { adapterGeneration: envelope.adapterGeneration } : {}),
      ...(envelope.turnId !== undefined ? { turnId: envelope.turnId } : {}),
    };
  }

  if (envelope.event.attachments !== undefined) {
    message.attachments = envelope.event.attachments.map((attachment) => ({ ...attachment }));
  }

  if (envelope.event.thinking !== undefined) {
    message.thinking = envelope.event.thinking.map((block) => ({ ...block }));
  }

  if (envelope.event.thinkingExtracted !== undefined) {
    message.thinkingExtracted = envelope.event.thinkingExtracted;
  }

  return {
    instanceId: envelope.instanceId,
    message,
  };
}

export interface InstanceCreatedEvent {
  id?: string;
  sessionId?: string;
  agentId?: string;
  workingDirectory?: string;
}

export interface BatchUpdateEvent {
  updates?: StateUpdate[];
}

export interface CompactStatusEvent {
  instanceId: string;
  status: string;
}

export interface InstanceOutputEvent {
  instanceId: string;
  message: OutputMessage;
}

export interface InputRequiredEvent {
  instanceId: string;
  requestId: string;
}

@Injectable({ providedIn: 'root' })
export class IpcEventBusService {
  private instanceEvents = inject(InstanceEventsService);
  private instanceIpc = inject(InstanceIpcService);

  readonly instanceCreated$ = this.createStream<InstanceCreatedEvent>((next) =>
    this.instanceIpc.onInstanceCreated((data) => next(data as InstanceCreatedEvent)),
  );

  readonly instanceRemoved$ = this.createStream<string>((next) =>
    this.instanceIpc.onInstanceRemoved(next),
  );

  readonly instanceStateUpdate$ = this.createStream<StateUpdate>((next) =>
    this.instanceIpc.onInstanceStateUpdate((data) => next(data as StateUpdate)),
  );

  readonly instanceOutput$ = this.instanceEvents.outputEvents$.pipe(
    map((envelope) => toInstanceOutputEventFromEnvelope(envelope)),
    filter((event): event is InstanceOutputEvent => event !== null),
    share(),
  );

  readonly batchUpdate$ = this.createStream<BatchUpdateEvent>((next) =>
    this.instanceIpc.onBatchUpdate((data) => next(data as BatchUpdateEvent)),
  );

  readonly orchestrationActivity$ = this.createStream<OrchestrationActivityPayload>((next) =>
    this.instanceIpc.onOrchestrationActivity((data) => next(data as OrchestrationActivityPayload)),
  );

  readonly compactStatus$ = this.createStream<CompactStatusEvent>((next) =>
    this.instanceIpc.onCompactStatus((data) => next(data as CompactStatusEvent)),
  );

  readonly inputRequired$ = this.createStream<InputRequiredEvent>((next) =>
    this.instanceIpc.onInputRequired((data) => next(data as InputRequiredEvent)),
  );

  private createStream<T>(
    subscribe: (next: (event: T) => void) => () => void,
  ): Observable<T> {
    return new Observable<T>((subscriber) => {
      const unsubscribe = subscribe((event) => subscriber.next(event));
      return () => unsubscribe();
    }).pipe(share());
  }
}
