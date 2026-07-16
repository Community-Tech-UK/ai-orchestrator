/**
 * Browser Approvals Banner
 *
 * Root-level banner shown whenever ANY instance has a pending Browser Gateway
 * approval request. Before this banner, pending requests were only visible on
 * the approvals card of the instance being viewed or on the /browser page, so
 * requests for other instances routinely expired unseen after 30 minutes and
 * the agent stalled on a decision nobody knew was wanted.
 *
 * Quick Approve/Deny acts on the oldest pending request with its proposed
 * grant. Requests proposing autonomous mode or credential/payment classes are
 * never one-click approvable here — those route to the /browser page, which
 * carries the explicit confirmation flow.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { BrowserGatewayIpcService } from '../services/ipc/browser-gateway-ipc.service';

const REFRESH_INTERVAL_MS = 5_000;

@Component({
  selector: 'app-browser-approvals-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (oldestPending(); as approval) {
      <section class="approvals-banner" role="status" aria-live="polite">
        <div class="banner-main">
          <span class="status-dot" aria-hidden="true"></span>
          <div class="banner-copy">
            <strong>
              {{ pendingRequests().length === 1
                ? 'A browser action is waiting for your approval'
                : pendingRequests().length + ' browser actions are waiting for your approval' }}
            </strong>
            <span>{{ describe(approval) }}</span>
            @if (errorMessage(); as err) {
              <span class="banner-error">{{ err }}</span>
            }
          </div>
        </div>
        <div class="banner-actions">
          @if (canQuickApprove(approval)) {
            <button
              type="button"
              class="banner-btn primary"
              [disabled]="working() !== null"
              aria-label="Approve the oldest pending browser request"
              (click)="approve(approval)"
            >{{ working() === approval.requestId ? 'Approving…' : 'Approve' }}</button>
            <button
              type="button"
              class="banner-btn"
              [disabled]="working() !== null"
              aria-label="Deny the oldest pending browser request"
              (click)="deny(approval)"
            >Deny</button>
          }
          <button
            type="button"
            class="banner-btn"
            aria-label="Review pending browser requests"
            (click)="review()"
          >Review</button>
        </div>
      </section>
    }
  `,
  styles: [`
    .approvals-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      min-height: 44px;
      padding: 0.6rem 1rem;
      border-top: 1px solid rgba(91, 140, 255, 0.32);
      border-bottom: 1px solid rgba(91, 140, 255, 0.32);
      background: rgba(91, 140, 255, 0.13);
      color: var(--text-primary, #e5e5e5);
      z-index: 1002;
    }

    .banner-main {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .status-dot {
      width: 9px;
      height: 9px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: #5b8cff;
      box-shadow: 0 0 0 3px rgba(91, 140, 255, 0.16);
    }

    .banner-copy {
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      column-gap: 0.65rem;
      row-gap: 0.15rem;
      font-size: 0.84rem;
    }

    .banner-copy span {
      color: var(--text-secondary, #cbd5e1);
    }

    .banner-copy .banner-error {
      color: #fca5a5;
    }

    .banner-actions {
      flex: 0 0 auto;
      display: flex;
      gap: 0.5rem;
    }

    .banner-btn {
      height: 28px;
      padding: 0 0.75rem;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary, #e5e5e5);
      cursor: pointer;
      font-size: 0.78rem;
      font-weight: 600;
    }

    .banner-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.1);
    }

    .banner-btn:disabled {
      opacity: 0.55;
      cursor: default;
    }

    .banner-btn.primary {
      border-color: rgba(89, 201, 138, 0.42);
      background: rgba(89, 201, 138, 0.14);
    }
  `],
})
export class BrowserApprovalsBannerComponent implements OnInit, OnDestroy {
  private readonly browserGateway = inject(BrowserGatewayIpcService);
  private readonly router = inject(Router);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;

  readonly pendingRequests = signal<BrowserApprovalRequest[]>([]);
  readonly working = signal<string | null>(null);
  readonly errorMessage = signal<string | null>(null);

  readonly oldestPending = computed(() => {
    const requests = this.pendingRequests();
    if (requests.length === 0) {
      return null;
    }
    return [...requests].sort((a, b) => a.createdAt - b.createdAt)[0];
  });

  ngOnInit(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      return;
    }
    this.refreshInFlight = true;
    try {
      const response = await this.browserGateway.listApprovalRequests({
        status: 'pending',
        limit: 25,
      });
      if (response.success) {
        this.pendingRequests.set(response.data?.data ?? []);
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  describe(approval: BrowserApprovalRequest): string {
    const action = approval.toolName.replace(/^browser\./, '');
    const where = approval.origin ?? approval.url ?? approval.profileId;
    const file = approval.filePath ? ` · ${approval.filePath}` : '';
    return `${action} on ${where}${file} · session ${approval.instanceId}`;
  }

  canQuickApprove(approval: BrowserApprovalRequest): boolean {
    return (
      approval.proposedGrant.mode !== 'autonomous' &&
      !approval.proposedGrant.allowedActionClasses.some(
        (actionClass) => actionClass === 'credential' || actionClass === 'payment',
      )
    );
  }

  async approve(approval: BrowserApprovalRequest): Promise<void> {
    if (this.working()) {
      return;
    }
    this.working.set(approval.requestId);
    this.errorMessage.set(null);
    try {
      const response = await this.browserGateway.approveRequest({
        requestId: approval.requestId,
        grant: approval.proposedGrant,
        reason: 'Approved from approvals banner',
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to approve browser request.');
        return;
      }
      this.removeRequest(approval.requestId);
      await this.refresh();
    } finally {
      this.working.set(null);
    }
  }

  async deny(approval: BrowserApprovalRequest): Promise<void> {
    if (this.working()) {
      return;
    }
    this.working.set(approval.requestId);
    this.errorMessage.set(null);
    try {
      const response = await this.browserGateway.denyRequest({
        requestId: approval.requestId,
        reason: 'Denied from approvals banner',
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to deny browser request.');
        return;
      }
      this.removeRequest(approval.requestId);
      await this.refresh();
    } finally {
      this.working.set(null);
    }
  }

  review(): void {
    void this.router.navigateByUrl('/browser');
  }

  private removeRequest(requestId: string): void {
    this.pendingRequests.update((requests) =>
      requests.filter((request) => request.requestId !== requestId),
    );
  }
}
