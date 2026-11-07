import { DestroyRef, Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { attentionLevelForInstanceStatus } from '../../../../shared/attention/attention-level';
import { InstanceStore } from '../state/instance.store';
import { ActionDispatchService } from './action-dispatch.service';

@Injectable({ providedIn: 'root' })
export class NextAttentionSessionService {
  private readonly instances = inject(InstanceStore);
  private readonly router = inject(Router);
  constructor() {
    // The key itself lives in DEFAULT_KEYBINDINGS so the conflict checks see it; only the action is wired here.
    const unregister = inject(ActionDispatchService).register({ id: 'next-attention-session', run: () => this.next() });
    inject(DestroyRef).onDestroy(unregister);
  }
  private async next(): Promise<void> {
    const sessions = this.instances.instances();
    const selected = sessions.findIndex(session => session.id === this.instances.selectedInstanceId());
    for (let offset = 1; offset <= sessions.length; offset++) {
      const session = sessions[(selected + offset + sessions.length) % sessions.length];
      const attention = attentionLevelForInstanceStatus(session.status);
      if (attention === 'blocked' || attention === 'failed' || session.waitReason?.kind === 'auth-required') {
        this.instances.setSelectedInstance(session.id);
        await this.router.navigateByUrl('/');
        return;
      }
    }
  }
}
