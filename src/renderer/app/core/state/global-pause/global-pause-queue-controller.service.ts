import { effect, Injectable, inject, OnDestroy } from '@angular/core';
import { GlobalPauseStore } from './global-pause.store';
import { QueuePersistenceService } from '../instance/queue-persistence.service';
import { InstanceStateService } from '../instance/instance-state.service';
import { remapPauseQueues } from './global-pause-queue-remap';

/** Keeps persisted initial prompts and queued messages attached to their revived session. */
@Injectable({ providedIn: 'root' })
export class GlobalPauseQueueController implements OnDestroy {
  private readonly pause = inject(GlobalPauseStore);
  private readonly queues = inject(QueuePersistenceService);
  private readonly state = inject(InstanceStateService);
  private readonly restored = new Set<string>();
  private readonly inFlight = new Set<string>();
  private destroyed = false;

  constructor() {
    effect(() => {
      const state = this.pause.state();
      const next = remapPauseQueues(state.entries, this.state.messageQueue());
      if (next) this.state.messageQueue.set(next);
      if (state.phase === 'none') { this.restored.clear(); return; }
      for (const entry of state.entries) {
        if (entry.kind !== 'session' || entry.voidReason !== 'initial-prompt-queued') continue;
        const key = `${entry.id}:${entry.targetId}`;
        if (this.restored.has(key) || this.inFlight.has(key)) continue;
        this.inFlight.add(key);
        void this.queues.restorePauseQueue(entry.targetId, () => !this.destroyed).then(success => {
          if (success && !this.destroyed) this.restored.add(key);
        }).finally(() => this.inFlight.delete(key));
      }
    });
  }
  ngOnDestroy(): void { this.destroyed = true; }
}
