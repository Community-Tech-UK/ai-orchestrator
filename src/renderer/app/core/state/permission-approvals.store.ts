import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import type { PendingApprovalItem } from '../../../../shared/types/permission-registry.types';
import { PermissionRegistryIpcService } from '../services/ipc/permission-registry-ipc.service';

/** One shared poll for the shell's time-critical banner and Needs you. */
@Injectable({ providedIn: 'root' })
export class PermissionApprovalsStore {
  private readonly ipc = inject(PermissionRegistryIpcService);
  private readonly requests = signal<PendingApprovalItem[]>([]);
  private readonly clock = signal(Date.now());
  private refreshTimer?: ReturnType<typeof setInterval>;
  private clockTimer?: ReturnType<typeof setInterval>;
  private inFlight: Promise<void> | null = null;
  private refreshFailed = false;
  readonly pendingRequests = this.requests.asReadonly();
  readonly now = this.clock.asReadonly();

  constructor() { inject(DestroyRef).onDestroy(() => this.stopPolling()); }

  startPolling(): void {
    if (this.refreshTimer) return;
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), 2500);
    this.clockTimer = setInterval(() => this.clock.set(Date.now()), 1000);
  }

  stopPolling(): void {
    clearInterval(this.refreshTimer); clearInterval(this.clockTimer);
    this.refreshTimer = undefined; this.clockTimer = undefined;
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.ipc.listPending().then((result) => {
      if (result.success) {
        this.requests.set(result.data ?? []);
        this.refreshFailed = false;
      } else this.reportRefreshFailure();
    }).catch(() => this.reportRefreshFailure())
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private reportRefreshFailure(): void {
    if (!this.refreshFailed) console.warn('Unable to refresh approval requests. Keeping the last successful list.');
    this.refreshFailed = true;
  }

  removeItem(id: string): void { this.requests.update((items) => items.filter((item) => item.id !== id)); }
}
