import { Injectable, inject } from '@angular/core';
import { Observable, filter, map, merge, share } from 'rxjs';

import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { OutputMessage } from '../../../../../shared/types/instance.types';
import type { OrchestrationActivityPayload } from '../../../../../shared/types/ipc.types';
import type { StateUpdate } from '../../services/update-batcher.service';
import { InstanceEventsService } from '../instance-events.service';
import { InstanceIpcService } from './instance-ipc.service';

const OUTPUT_EVENT_DEDUPE_WINDOW_MS = 60_000;

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

type OutputEventSource = 'legacy' | 'provider';

interface TaggedInstanceOutputEvent {
  source: OutputEventSource;
  event: InstanceOutputEvent;
}

@Injectable({ providedIn: 'root' })
export class IpcEventBusService {
  private instanceIpc = inject(InstanceIpcService);
  private instanceEvents = inject(InstanceEventsService);
  private pendingOutputSignatures = new Map<string, {
    source: OutputEventSource;
    expiresAt: number;
  }>();

  readonly instanceCreated$ = this.createStream<InstanceCreatedEvent>((next) =>
    this.instanceIpc.onInstanceCreated((data) => next(data as InstanceCreatedEvent)),
  );

  readonly instanceRemoved$ = this.createStream<string>((next) =>
    this.instanceIpc.onInstanceRemoved(next),
  );

  readonly instanceStateUpdate$ = this.createStream<StateUpdate>((next) =>
    this.instanceIpc.onInstanceStateUpdate((data) => next(data as StateUpdate)),
  );

  readonly instanceOutput$ = merge(
    this.createStream<InstanceOutputEvent>((next) =>
      this.instanceIpc.onInstanceOutput((data) => next(data as InstanceOutputEvent)),
    ).pipe(map((event) => ({ source: 'legacy' as const, event }))),
    this.instanceEvents.outputEvents$.pipe(
      map((envelope) => toInstanceOutputEventFromEnvelope(envelope)),
      filter((event): event is InstanceOutputEvent => event !== null),
      map((event) => ({ source: 'provider' as const, event })),
    ),
  ).pipe(
    filter((taggedEvent) => !this.isDuplicateInstanceOutput(taggedEvent)),
    map((taggedEvent) => taggedEvent.event),
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

  private isDuplicateInstanceOutput(taggedEvent: TaggedInstanceOutputEvent): boolean {
    this.prunePendingOutputSignatures();

    const eventSignature = this.getOutputEventSignature(taggedEvent.event);
    if (!eventSignature) {
      return false;
    }

    const now = Date.now();
    const existing = this.pendingOutputSignatures.get(eventSignature);
    if (existing && existing.expiresAt > now && existing.source !== taggedEvent.source) {
      this.pendingOutputSignatures.delete(eventSignature);
      return true;
    }

    this.pendingOutputSignatures.set(eventSignature, {
      source: taggedEvent.source,
      expiresAt: now + OUTPUT_EVENT_DEDUPE_WINDOW_MS,
    });
    return false;
  }

  private getOutputEventSignature(event: InstanceOutputEvent): string | null {
    const messageId = event.message?.id;
    if (typeof event.instanceId !== 'string' || event.instanceId.length === 0) {
      return null;
    }

    if (typeof messageId !== 'string' || messageId.length === 0) {
      return null;
    }

    return JSON.stringify([
      event.instanceId,
      messageId,
      event.message.timestamp,
      event.message.type,
      event.message.content,
      event.message.metadata ?? null,
      event.message.attachments ?? null,
      event.message.thinking ?? null,
      event.message.thinkingExtracted ?? null,
    ]);
  }

  private prunePendingOutputSignatures(now = Date.now()): void {
    for (const [eventSignature, entry] of this.pendingOutputSignatures) {
      if (entry.expiresAt <= now) {
        this.pendingOutputSignatures.delete(eventSignature);
      }
    }
  }
}
