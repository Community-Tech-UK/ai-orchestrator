/**
 * Browser Approvals Banner
 *
 * Root-level banner shown whenever ANY instance has a pending Browser Gateway
 * approval request. Before this banner, pending requests were only visible on
 * the approvals card of the instance being viewed or on the /browser page, so
 * requests for other instances routinely expired unseen after 30 minutes and
 * the agent stalled on a decision nobody knew was wanted.
 *
 * Low-risk proposals can be narrowed to one action or the current session here.
 * Credential, payment, unknown, submit, and destructive scopes require review.
 * Deny stays available for every pending request.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import type {
  BrowserActionClass,
  BrowserApprovalRequest,
  BrowserGrantProposal,
} from '@contracts/types/browser';
import { BrowserGatewayIpcService } from '../services/ipc/browser-gateway-ipc.service';
import { BrowserApprovalsStore } from './browser-approvals.store';
const QUICK_APPROVAL_BLOCKED_CLASSES = new Set<BrowserActionClass>([
  'credential',
  'financial_identity',
  'sensitive_identity',
  'payment',
  'submit',
  'destructive',
  'unknown',
]);

@Component({
  selector: 'app-browser-approvals-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (oldestPending(); as approval) {
      @if (isMinimized()) {
        <section class="approvals-banner compact" role="status" aria-live="polite">
          <button type="button" class="compact-main" (click)="review(approval)">
            <span class="status-dot" aria-hidden="true"></span>
            <strong>{{ pendingRequests().length === 1 ? '1 browser approval waiting' : pendingRequests().length + ' browser approvals waiting' }}</strong>
            <span>Request 1 of {{ pendingRequests().length }} · #{{ shortRequestId(approval) }}</span>
          </button>
          <button type="button" class="banner-btn" (click)="restore()">Show</button>
        </section>
      } @else {
        <section class="approvals-banner" role="status" aria-live="polite">
          <button type="button" class="banner-main" (click)="review(approval)">
            <span class="status-dot" aria-hidden="true"></span>
            <span class="banner-copy">
              <strong>
                {{ pendingRequests().length === 1
                  ? 'Browser permission requested'
                  : pendingRequests().length + ' browser permissions requested' }}
              </strong>
              <span>{{ describe(approval) }}</span>
              <span class="request-identity">New request · Request 1 of {{ pendingRequests().length }} · #{{ shortRequestId(approval) }} · received {{ receivedAt(approval) }}</span>
              @if (errorMessage(); as err) {
                <span class="banner-error">{{ err }}</span>
              }
            </span>
          </button>
          <div class="banner-actions">
            @if (canQuickApprove(approval)) {
              <button
                type="button"
                class="banner-btn primary"
                [disabled]="working() !== null"
                (click)="approve(approval, 'per_action')"
              >{{ working() === approval.requestId ? 'Allowing…' : 'Allow once' }}</button>
              <button
                type="button"
                class="banner-btn"
                [disabled]="working() !== null"
                (click)="approve(approval, 'session')"
              >Allow for session</button>
            }
            <button
              type="button"
              class="banner-btn danger"
              [disabled]="working() !== null"
              aria-label="Deny the oldest pending browser request"
              (click)="deny(approval)"
            >Deny</button>
            <button
              type="button"
              class="banner-btn"
              [disabled]="working() !== null"
              aria-label="Review pending browser requests"
              (click)="review(approval)"
            >More options</button>
            <button
              type="button"
              class="banner-close"
              aria-label="Minimize browser approval banner"
              (click)="minimize()"
            >×</button>
          </div>
        </section>
      }
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
      border-top: 1px solid color-mix(in srgb, var(--warning-color, #f59e0b) 38%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--warning-color, #f59e0b) 38%, transparent);
      background: color-mix(in srgb, var(--warning-color, #f59e0b) 10%, var(--bg-primary, #0f172a));
      color: var(--text-primary, #e5e5e5);
      z-index: 1002;
    }

    .banner-main {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }

    .status-dot {
      width: 9px;
      height: 9px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: var(--warning-color, #f59e0b);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning-color, #f59e0b) 18%, transparent);
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

    .banner-copy .request-identity {
      flex-basis: 100%;
      color: var(--text-muted, #94a3b8);
      font-size: 0.72rem;
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

    .banner-btn.danger {
      color: var(--error-color, #f87171);
      border-color: color-mix(in srgb, var(--error-color, #f87171) 42%, transparent);
    }

    .banner-btn:focus-visible {
      outline: 2px solid var(--warning-color, #f59e0b);
      outline-offset: 2px;
    }

    .banner-close {
      width: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--text-secondary, #cbd5e1);
      cursor: pointer;
      font-size: 1.2rem;
      line-height: 1;
    }

    .banner-close:hover,
    .banner-close:focus-visible {
      background: rgba(255, 255, 255, 0.1);
    }

    .approvals-banner.compact {
      min-height: 36px;
      padding-block: 0.35rem;
    }

    .compact-main {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 0.65rem;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 0.78rem;
    }

    .compact-main span:last-child {
      color: var(--text-secondary, #cbd5e1);
    }

    @media (max-width: 860px) {
      .approvals-banner,
      .banner-actions {
        flex-wrap: wrap;
      }
    }
  `],
})
export class BrowserApprovalsBannerComponent implements OnInit, OnDestroy {
  private readonly browserGateway = inject(BrowserGatewayIpcService);
  private readonly approvals = inject(BrowserApprovalsStore);
  private readonly router = inject(Router);

  readonly pendingRequests = this.approvals.pendingRequests;
  readonly oldestPending = this.approvals.oldestPending;
  readonly isMinimized = this.approvals.isMinimized;
  readonly working = signal<string | null>(null);
  readonly errorMessage = signal<string | null>(null);

  ngOnInit(): void {
    this.approvals.startPolling();
  }

  ngOnDestroy(): void {
    this.approvals.stopPolling();
  }

  async refresh(): Promise<void> {
    await this.approvals.refresh();
  }

  describe(approval: BrowserApprovalRequest): string {
    const action = approval.toolName.replace(/^browser\./, '').replaceAll('_', ' ');
    const where = this.displayHost(approval.origin ?? approval.url ?? approval.profileId);
    const file = approval.filePath ? ` · ${approval.filePath}` : '';
    return `${action} on ${where}${file} · session ${approval.instanceId}`;
  }

  canQuickApprove(approval: BrowserApprovalRequest): boolean {
    return this.quickGrant(approval, 'session') !== null;
  }

  async approve(
    approval: BrowserApprovalRequest,
    mode: 'per_action' | 'session',
  ): Promise<void> {
    if (this.working()) {
      return;
    }
    const grant = this.quickGrant(approval, mode);
    if (!grant) {
      this.errorMessage.set('This request needs review before it can be allowed.');
      return;
    }
    this.working.set(approval.requestId);
    this.errorMessage.set(null);
    try {
      const response = await this.browserGateway.approveRequest({
        requestId: approval.requestId,
        grant,
        reason: mode === 'per_action'
          ? 'Allowed once from browser permission bar'
          : 'Allowed for session from browser permission bar',
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to approve browser request.');
        return;
      }
      this.approvals.removeRequest(approval.requestId);
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
      this.approvals.removeRequest(approval.requestId);
      await this.refresh();
    } finally {
      this.working.set(null);
    }
  }

  review(approval: BrowserApprovalRequest): void {
    void this.router.navigate(['/browser'], {
      queryParams: { view: 'permissions', requestId: approval.requestId },
    });
  }

  minimize(): void {
    this.approvals.minimizeCurrentSet();
  }

  restore(): void {
    this.approvals.restore();
  }

  shortRequestId(approval: BrowserApprovalRequest): string {
    return approval.requestId.length <= 12 ? approval.requestId : approval.requestId.slice(0, 8);
  }

  receivedAt(approval: BrowserApprovalRequest): string {
    return new Date(approval.createdAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private quickGrant(
    approval: BrowserApprovalRequest,
    mode: 'per_action' | 'session',
  ): BrowserGrantProposal | null {
    const proposedClasses = approval.proposedGrant.allowedActionClasses;
    if (
      QUICK_APPROVAL_BLOCKED_CLASSES.has(approval.actionClass) ||
      !proposedClasses.includes(approval.actionClass) ||
      proposedClasses.some((actionClass) => QUICK_APPROVAL_BLOCKED_CLASSES.has(actionClass))
    ) {
      return null;
    }
    return {
      ...approval.proposedGrant,
      mode,
      allowedActionClasses: mode === 'per_action'
        ? [approval.actionClass]
        : [...new Set(proposedClasses)],
      autonomous: false,
    };
  }

  private displayHost(value: string): string {
    try {
      return new URL(value).host;
    } catch {
      return value;
    }
  }
}
