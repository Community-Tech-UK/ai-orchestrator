import { DestroyRef, Injectable, effect, inject } from '@angular/core';
import { MobileGatewayIpcService } from './ipc/mobile-gateway-ipc.service';
import { InstanceQueries } from '../state/instance/instance.queries';
import { InstanceStateService } from '../state/instance/instance-state.service';

/**
 * Keeps the desktop's unread dots and the phone's "finished" items in step.
 * Opening a session here clears it on the phone; opening or dismissing it on
 * the phone clears the dot here. Created once at startup.
 */
@Injectable({ providedIn: 'root' })
export class MobileCompletionSyncService {
  private readonly ipc = inject(MobileGatewayIpcService);
  private readonly queries = inject(InstanceQueries);
  private readonly state = inject(InstanceStateService);

  constructor() {
    effect(() => {
      const instanceId = this.queries.selectedInstanceId();
      if (instanceId) void this.ipc.markViewed(instanceId);
    });
    const unsubscribe = this.ipc.onCompletionViewed((instanceId) =>
      this.state.updateInstance(instanceId, { hasUnreadCompletion: false }));
    inject(DestroyRef).onDestroy(unsubscribe);
  }
}
