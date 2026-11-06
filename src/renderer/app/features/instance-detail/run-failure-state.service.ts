import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { presentError, type ErrorCategory, type PresentedError } from '../../../../shared/present-error';
import { InstanceEventsService } from '../../core/services/instance-events.service';
import { IpcEventBusService } from '../../core/services/ipc/ipc-event-bus.service';

export { SAFE_CONTINUATION } from '../../../../shared/turn-continuation';

export interface RunFailureNotice {
  id: string;
  turnId?: string;
  at: number;
  presentation: PresentedError;
}

@Injectable({ providedIn: 'root' })
export class RunFailureStateService {
  private readonly failures = signal(new Map<string, RunFailureNotice>());
  private readonly latestGeneration = new Map<string, number>();
  private readonly detail = new Map<string, { turnId?: string; text: string }>();

  constructor() {
    const destroyRef = inject(DestroyRef);
    inject(InstanceEventsService).events$.pipe(takeUntilDestroyed(destroyRef)).subscribe(event => this.observe(event));
    inject(IpcEventBusService).instanceRemoved$.pipe(takeUntilDestroyed(destroyRef)).subscribe(id => {
      this.clear(id);
      this.latestGeneration.delete(id);
    });
  }

  forInstance(instanceId: string): RunFailureNotice | undefined {
    return this.failures().get(instanceId);
  }

  private clear(instanceId: string): void {
    this.detail.delete(instanceId);
    if (!this.failures().has(instanceId)) return;
    this.failures.update(previous => {
      const next = new Map(previous);
      next.delete(instanceId);
      return next;
    });
  }

  private observe(envelope: ProviderRuntimeEventEnvelope): void {
    const { instanceId, event, turnId } = envelope;
    const current = this.latestGeneration.get(instanceId) ?? 0;
    const generation = envelope.adapterGeneration ?? current;
    if (generation < current) return;
    if (generation > current) this.clear(instanceId);
    this.latestGeneration.set(instanceId, generation);
    if ((event.kind === 'output' && event.messageType === 'user') ||
      (event.kind === 'status' && ['busy', 'running', 'initializing'].includes(event.status))) {
      this.clear(instanceId);
      return;
    }
    if (event.kind !== 'complete' && event.kind !== 'error' && event.kind !== 'exit') return;
    if (event.kind === 'exit' && event.turnEnding?.reason !== 'crash') return;
    if (event.turnEnding?.providerRetrying || (event.kind === 'complete' && event.degradedReason === 'cancelled')) {
      this.clear(instanceId);
      return;
    }
    if (event.kind === 'error') this.detail.set(instanceId, { turnId, text: event.message });
    if (event.kind === 'exit') this.detail.set(instanceId, {
      turnId, text: event.signal ? `Process exited with signal ${event.signal}.` : `Process exited with status ${event.code ?? 'unknown'}.`,
    });
    const reason = event.turnEnding?.reason;
    const failed = event.kind === 'error'
      ? event.recoverable !== true
      : event.kind === 'exit' || event.turnErrored || (reason !== undefined && reason !== 'completed');
    if (!failed) {
      this.clear(instanceId);
      return;
    }
    const presentation = presentError(categoryForReason(reason), { provider: envelope.provider });
    const detail = this.detail.get(instanceId);
    if (detail && (!turnId || !detail.turnId || detail.turnId === turnId)) presentation.rawDetail = detail.text;
    this.failures.update(previous => new Map(previous).set(instanceId, {
      id: envelope.eventId, turnId, at: envelope.timestamp, presentation,
    }));
  }
}

function categoryForReason(reason: string | undefined): ErrorCategory {
  if (reason === 'quota' || reason === 'auth') return reason;
  if (reason === 'crash') return 'provider-crash';
  if (reason === 'truncated_transport' || reason === 'retryable') return 'network';
  return 'unknown';
}
