import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, filter, map, share } from 'rxjs';

import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { OutputMessage } from '../../../../../shared/types/instance.types';
import type { OrchestrationActivityPayload } from '../../../../../shared/types/ipc.types';
import type { StateUpdate } from '../../services/update-batcher.service';
import { InstanceEventsService } from '../instance-events.service';
import { InstanceIpcService } from './instance-ipc.service';
import { shouldClearInputRequiredForStatus } from './input-required-lifecycle';

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

/** A pending input request that was settled without the user; its card must go. */
export interface InputRequiredResolvedEvent {
  instanceId: string;
  requestId: string;
  reason: 'timeout' | 'auto_approved' | 'decided' | 'cancelled' | 'exited';
  /** `user-action` for a card the model raised itself, which never counted toward the pending-approval badge. */
  kind?: 'user-action';
}

export interface InputRequiredEvent {
  instanceId: string;
  requestId: string;
  prompt: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface FastToggledEvent {
  instanceId: string;
  fastMode: boolean;
  reason: 'user' | 'unavailable';
}

export interface YoloToggledEvent {
  instanceId: string;
  yoloMode: boolean;
  /** Desired value queued while busy; undefined when nothing is pending. */
  pendingYoloMode?: boolean;
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
  readonly instanceTranscriptChunk$ = this.createStream<unknown>((next) =>
    this.instanceIpc.onInstanceTranscriptChunk(next),
  );

  readonly instanceStateUpdate$ = this.createStream<StateUpdate>((next) =>
    this.instanceIpc.onInstanceStateUpdate((data) => next(data as StateUpdate)),
  );

  readonly fastToggled$ = this.createStream<FastToggledEvent>((next) =>
    this.instanceIpc.onFastToggled((data) => next(data)),
  );

  readonly yoloToggled$ = this.createStream<YoloToggledEvent>((next) =>
    this.instanceIpc.onYoloToggled((data) => next(data)),
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
    this.instanceIpc.onInputRequired((data) => {
      // Deduplicate before the shared stream, so downstream approval counts
      // and the retained request list observe exactly the same deliveries.
      if (!this._pendingInputRequired().some((request) =>
        request.instanceId === data.instanceId && request.requestId === data.requestId,
      )) {
        next(data);
      }
    }),
  );

  readonly inputRequiredResolved$ = this.createStream<InputRequiredResolvedEvent>((next) =>
    this.instanceIpc.onInputRequiredResolved((data) => next(data)),
  );

  private readonly _pendingInputRequired = signal<readonly InputRequiredEvent[]>([]);
  readonly pendingInputRequired = this._pendingInputRequired.asReadonly();
  private readonly approvalRuntimes = new Map<string, Pick<StateUpdate, 'adapterGeneration' | 'restartEpoch'>>();

  constructor() {
    // InstanceStore creates this bus at startup, before any approval panel.
    // Keep full runtime payloads, rather than reconstructing them from history.
    this.inputRequired$.pipe(takeUntilDestroyed()).subscribe((request) => {
      this._pendingInputRequired.update((pending) => [...pending, request]);
    });
    this.inputRequiredResolved$.pipe(takeUntilDestroyed()).subscribe(({ instanceId, requestId }) => {
      this.dismissInputRequired(instanceId, requestId);
    });
    this.instanceRemoved$.pipe(takeUntilDestroyed()).subscribe((instanceId) => {
      this.clearInputRequired(instanceId);
      this.approvalRuntimes.delete(instanceId);
    });
    this.instanceStateUpdate$.pipe(takeUntilDestroyed()).subscribe((update) => this.updateApprovalRuntime(update));
    this.batchUpdate$.pipe(takeUntilDestroyed()).subscribe(({ updates }) => {
      updates?.forEach((update) => this.updateApprovalRuntime(update));
    });
    this.instanceEvents.events$.pipe(takeUntilDestroyed()).subscribe((envelope) => {
      if (envelope.adapterGeneration !== undefined
        && this.approvalRuntimes.get(envelope.instanceId)?.adapterGeneration !== envelope.adapterGeneration) {
        this.updateApprovalRuntime({ instanceId: envelope.instanceId, adapterGeneration: envelope.adapterGeneration });
      }
      if (envelope.event.kind === 'exit') {
        this.clearInputRequired(envelope.instanceId);
      }
    });
  }

  dismissInputRequired(instanceId: string, requestId: string): void {
    this.clearInputRequired(instanceId, (request) => request.requestId === requestId);
  }

  clearInputRequired(instanceId: string, shouldClear: (request: InputRequiredEvent) => boolean = () => true): void {
    this._pendingInputRequired.update((pending) => {
      const next = pending.filter((request) => request.instanceId !== instanceId || !shouldClear(request));
      return next.length === pending.length ? pending : next;
    });
  }

  private updateApprovalRuntime(update: StateUpdate): void {
    const previous = this.approvalRuntimes.get(update.instanceId);
    const replaced = (['adapterGeneration', 'restartEpoch'] as const).some((key) =>
      previous?.[key] !== undefined && update[key] !== undefined && previous[key] !== update[key],
    );
    this.approvalRuntimes.set(update.instanceId, {
      adapterGeneration: update.adapterGeneration ?? previous?.adapterGeneration,
      restartEpoch: update.restartEpoch ?? previous?.restartEpoch,
    });
    if (replaced || shouldClearInputRequiredForStatus(update.status)) {
      this.clearInputRequired(update.instanceId);
    }
  }

  private createStream<T>(
    subscribe: (next: (event: T) => void) => () => void,
  ): Observable<T> {
    return new Observable<T>((subscriber) => {
      const unsubscribe = subscribe((event) => subscriber.next(event));
      return () => unsubscribe();
    }).pipe(share());
  }
}
