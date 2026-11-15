import { Injectable, Injector, inject } from '@angular/core';
import { Router } from '@angular/router';
import { InstanceStore } from '../state/instance.store';
import { SideChatStore } from '../state/side-chat.store';
import { ToastService } from './toast.service';

@Injectable({ providedIn: 'root' })
export class SessionNavigator {
  private readonly injector = inject(Injector);

  openSession(id: string): void {
    const instances = this.injector.get(InstanceStore);
    const openedSideChat = this.injector.get(SideChatStore).requestOpenForRuntime(id);
    if (!openedSideChat) {
      if (typeof instances.getInstance(id)?.metadata?.['sideChatId'] === 'string') {
        this.injector.get(ToastService).show('Could not open this sidechat. Try again from its session.', 'error');
        return;
      }
      instances.setSelectedInstance(id);
    }
    void this.injector.get(Router).navigate(['/']);
  }
}
