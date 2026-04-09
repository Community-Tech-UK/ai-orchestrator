import { Injectable, inject } from '@angular/core';
import { Observable, share } from 'rxjs';

import type { OutputMessage } from '../../../../../shared/types/instance.types';
import type { OrchestrationActivityPayload } from '../../../../../shared/types/ipc.types';
import type { StateUpdate } from '../../services/update-batcher.service';
import { InstanceIpcService } from './instance-ipc.service';

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

  readonly instanceOutput$ = this.createStream<InstanceOutputEvent>((next) =>
    this.instanceIpc.onInstanceOutput((data) => next(data as InstanceOutputEvent)),
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
