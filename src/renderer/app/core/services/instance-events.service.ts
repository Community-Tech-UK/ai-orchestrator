import { Injectable, OnDestroy } from '@angular/core';
import { Subject, filter } from 'rxjs';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

interface ProviderRuntimeEventApi {
  onProviderRuntimeEvent?: (cb: (env: ProviderRuntimeEventEnvelope) => void) => () => void;
}

@Injectable({ providedIn: 'root' })
export class InstanceEventsService implements OnDestroy {
  private readonly _events$ = new Subject<ProviderRuntimeEventEnvelope>();
  readonly events$ = this._events$.asObservable();

  readonly outputEvents$ = this.events$.pipe(filter(e => e.event.kind === 'output'));
  readonly toolUseEvents$ = this.events$.pipe(filter(e => e.event.kind === 'tool_use'));
  readonly toolResultEvents$ = this.events$.pipe(filter(e => e.event.kind === 'tool_result'));
  readonly statusEvents$ = this.events$.pipe(filter(e => e.event.kind === 'status'));
  readonly contextEvents$ = this.events$.pipe(filter(e => e.event.kind === 'context'));
  readonly errorEvents$ = this.events$.pipe(filter(e => e.event.kind === 'error'));
  readonly exitEvents$ = this.events$.pipe(filter(e => e.event.kind === 'exit'));
  readonly spawnedEvents$ = this.events$.pipe(filter(e => e.event.kind === 'spawned'));
  readonly completeEvents$ = this.events$.pipe(filter(e => e.event.kind === 'complete'));

  private readonly expectedSeq = new Map<string, number>();
  private readonly unsub: () => void;

  constructor() {
    const api = (window as unknown as { electronAPI?: ProviderRuntimeEventApi }).electronAPI;
    if (!api?.onProviderRuntimeEvent) {
      this.unsub = () => undefined;
      return;
    }

    this.unsub = api.onProviderRuntimeEvent(env => {
      const expected = this.expectedSeq.get(env.instanceId) ?? 0;
      if (env.seq !== expected) {
        console.warn(`[InstanceEventsService] event gap for ${env.instanceId}: expected seq ${expected}, got ${env.seq}`);
      }
      this.expectedSeq.set(env.instanceId, env.seq + 1);
      this._events$.next(env);
    });
  }

  ngOnDestroy(): void {
    this.unsub();
    this._events$.complete();
  }
}
