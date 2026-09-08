/**
 * Browser Approvals Banner
 *
 * Root-level banner shown whenever ANY instance has a pending Browser Gateway
 * approval request. Before this banner, pending requests were only visible on
 * the approvals card of the instance being viewed or on the /browser page, so
 * requests for other instances routinely expired unseen after 30 minutes and
 * the agent stalled on a decision nobody knew was wanted.
 *
 * Grantable requests can be allowed here with a duration dropdown (once,
 * session, or always). Payment and identity-secret scopes still go to review.
 * Deny stays available for every pending request.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import type {
  BrowserApprovalRequest,
  BrowserGrantProposal,
} from '@contracts/types/browser';
import { BrowserGatewayIpcService } from '../services/ipc/browser-gateway-ipc.service';
import { BrowserApprovalsStore } from './browser-approvals.store';
import {
  type BannerGrantMode,
  bannerCanQuickApprove,
  bannerConfirmationPhrase,
  bannerGrantModes,
  bannerGrantRequiresConfirmation,
  bannerModeLabel,
  buildBannerGrant,
} from './browser-approvals-banner.rules';

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
              @if (needsConfirmation(approval)) {
                <label class="banner-confirm">
                  <span>Type <strong>{{ confirmationPhrase(approval) }}</strong> to allow publishing or deleting</span>
                  <input
                    type="text"
                    [value]="confirmation()"
                    [disabled]="working() !== null"
                    [placeholder]="confirmationPhrase(approval)"
                    [attr.aria-label]="'Type ' + confirmationPhrase(approval) + ' to allow publishing or deleting'"
                    (input)="onConfirmationInput($event)"
                    (click)="$event.stopPropagation()"
                  />
                </label>
              }
              @if (modesFor(approval).length > 1) {
                <select
                  class="banner-scope"
                  [value]="selectedMode()"
                  [disabled]="working() !== null"
                  aria-label="How long to allow this browser permission"
                  (change)="onModeChange($event)"
                >
                  @for (mode of modesFor(approval); track mode) {
                    <option [value]="mode">{{ modeLabel(mode) }}</option>
                  }
                </select>
              }
              <button
                type="button"
                class="banner-btn primary"
                [disabled]="working() !== null"
                (click)="approve(approval)"
              >{{ working() === approval.requestId ? 'Approving…' : approveLabel(approval) }}</button>
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
      flex-wrap: wrap;
      justify-content: flex-end;
      align-items: center;
      gap: 0.5rem;
    }

    .banner-confirm {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
      max-width: 28rem;
      color: var(--text-secondary, #cbd5e1);
      font-size: 0.72rem;
    }

    .banner-confirm input {
      height: 28px;
      width: 12rem;
      padding: 0 0.65rem;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 6px;
      background-color: rgba(255, 255, 255, 0.06);
      color: var(--text-primary, #e5e5e5);
      font-size: 0.78rem;
    }

    .banner-scope {
      height: 28px;
      padding: 0 2rem 0 0.65rem;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 6px;
      background-color: rgba(255, 255, 255, 0.06);
      color: var(--text-primary, #e5e5e5);
      cursor: pointer;
      font-size: 0.78rem;
      font-weight: 600;
      background-position: right 8px center;
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
  readonly selectedMode = signal<BannerGrantMode>('per_action');
  readonly confirmation = signal('');
  readonly working = signal<string | null>(null);
  readonly errorMessage = signal<string | null>(null);
  private readonly boundRequestId = signal('');

  constructor() {
    effect(() => {
      const approval = this.oldestPending();
      const requestId = approval?.requestId ?? '';
      if (this.boundRequestId() === requestId) {
        return;
      }
      this.boundRequestId.set(requestId);
      this.selectedMode.set(approval ? (this.modesFor(approval)[0] ?? 'per_action') : 'per_action');
      this.confirmation.set('');
    });
  }

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
    return bannerCanQuickApprove(approval);
  }

  modesFor(approval: BrowserApprovalRequest): BannerGrantMode[] {
    return bannerGrantModes(approval);
  }

  modeLabel(mode: BannerGrantMode): string {
    return bannerModeLabel(mode);
  }

  approveLabel(approval: BrowserApprovalRequest): string {
    return this.modesFor(approval).length > 1 ? 'Approve' : this.modeLabel(this.selectedMode());
  }

  onModeChange(event: Event): void {
    this.selectedMode.set((event.target as HTMLSelectElement).value as BannerGrantMode);
  }

  confirmationPhrase(approval: BrowserApprovalRequest): string {
    return bannerConfirmationPhrase(approval);
  }

  needsConfirmation(approval: BrowserApprovalRequest): boolean {
    const grant = this.quickGrant(approval, this.selectedMode());
    return grant !== null && bannerGrantRequiresConfirmation(grant);
  }

  onConfirmationInput(event: Event): void {
    this.confirmation.set((event.target as HTMLInputElement).value);
  }

  async approve(approval: BrowserApprovalRequest): Promise<void> {
    if (this.working()) {
      return;
    }
    const mode = this.selectedMode();
    const grant = this.quickGrant(approval, mode);
    if (!grant) {
      this.errorMessage.set('This request needs review before it can be allowed.');
      return;
    }
    const phrase = this.confirmationPhrase(approval);
    if (
      bannerGrantRequiresConfirmation(grant) &&
      this.confirmation().trim() !== phrase
    ) {
      this.errorMessage.set(
        `Type ${phrase} to allow publishing or deleting without another prompt.`,
      );
      return;
    }
    this.working.set(approval.requestId);
    this.errorMessage.set(null);
    try {
      const response = await this.browserGateway.approveRequest({
        requestId: approval.requestId,
        grant,
        reason: this.approveReason(mode),
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
    mode: BannerGrantMode,
  ): BrowserGrantProposal | null {
    return buildBannerGrant(approval, mode);
  }

  private approveReason(mode: BannerGrantMode): string {
    switch (mode) {
      case 'per_action':
        return 'Allowed once from browser permission bar';
      case 'session':
        return 'Allowed for session from browser permission bar';
      case 'autonomous':
        return 'Always allowed from browser permission bar';
    }
  }

  private displayHost(value: string): string {
    try {
      return new URL(value).host;
    } catch {
      return value;
    }
  }
}
