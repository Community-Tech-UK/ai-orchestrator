import { Injectable, computed, inject, signal } from '@angular/core';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { BrowserGatewayIpcService } from '../services/ipc/browser-gateway-ipc.service';

const REFRESH_INTERVAL_MS = 5_000;

@Injectable({ providedIn: 'root' })
export class BrowserApprovalsStore {
  private readonly browserGateway = inject(BrowserGatewayIpcService);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshGeneration = 0;
  private readonly minimizedRequestSet = signal<string | null>(null);

  readonly pendingRequests = signal<BrowserApprovalRequest[]>([]);
  readonly oldestPending = computed(() =>
    [...this.pendingRequests()].sort((a, b) => a.createdAt - b.createdAt)[0] ?? null,
  );
  readonly requestSetKey = computed(() =>
    this.pendingRequests().map((request) => request.requestId).sort().join('|'),
  );
  readonly isMinimized = computed(() =>
    this.pendingRequests().length > 0 &&
    this.minimizedRequestSet() === this.requestSetKey(),
  );

  startPolling(): void {
    if (this.refreshTimer) {
      return;
    }
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  refresh(force = false): Promise<void> {
    if (this.refreshPromise && !force) {
      return this.refreshPromise;
    }
    const generation = ++this.refreshGeneration;
    const current = this.loadPendingRequests(generation);
    const tracked = current.finally(() => {
      if (this.refreshPromise === tracked) this.refreshPromise = null;
    });
    this.refreshPromise = tracked;
    return tracked;
  }

  removeRequest(requestId: string): void {
    this.replacePendingRequests(
      this.pendingRequests().filter((request) => request.requestId !== requestId),
    );
  }

  minimizeCurrentSet(): void {
    this.minimizedRequestSet.set(this.requestSetKey());
  }

  restore(): void {
    this.minimizedRequestSet.set(null);
  }

  private async loadPendingRequests(generation: number): Promise<void> {
    const response = await this.browserGateway.listApprovalRequests({
      status: 'pending',
      limit: 25,
    });
    if (response.success && generation === this.refreshGeneration) {
      this.replacePendingRequests(response.data?.data ?? []);
    }
  }

  private replacePendingRequests(requests: BrowserApprovalRequest[]): void {
    const nextKey = requests.map((request) => request.requestId).sort().join('|');
    if (this.minimizedRequestSet() !== null && nextKey !== this.requestSetKey()) {
      this.minimizedRequestSet.set(null);
    }
    this.pendingRequests.set(requests);
  }
}
