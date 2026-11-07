import { Injectable, Injector, inject } from '@angular/core';
import { Router } from '@angular/router';
import { InstanceStore } from '../state/instance.store';

@Injectable({ providedIn: 'root' })
export class SessionNavigator {
  private readonly injector = inject(Injector);

  openSession(id: string): void {
    this.injector.get(InstanceStore).setSelectedInstance(id);
    void this.injector.get(Router).navigate(['/']);
  }
}
