/**
 * Pending Approvals Banner (LT-095)
 *
 * Root-level banner shown whenever ANY pending `PermissionRegistry` request
 * exists that a human — not YOLO auto-approval, not a timeout — needs to
 * decide: a Computer Use desktop app grant, an App Store/Google Play release,
 * or a Microsoft calendar mutation/account connection. Before this banner,
 * `PermissionRegistry.resolve()` had no renderer-reachable call site at all —
 * a real Computer Use grant request sat pending for its full 60-second window
 * and expired unseen (see `docs/plans/livetest-remediation-register.md#lt-095`).
 *
 * Modelled directly on `BrowserApprovalsBannerComponent`, the closest existing
 * precedent for "surface every pending cross-instance approval at the app
 * root and poll", extended with a per-item risk badge, a countdown, and an
 * Extend action for the 60-second Computer Use window (well short of the
 * 5-minute window the App Store/Play and calendar approvals get).
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
import type { PendingApprovalItem } from '../../../../shared/types/permission-registry.types';
import { PermissionRegistryIpcService } from '../services/ipc/permission-registry-ipc.service';
import {
  classifyPermissionRisk,
  formatDetails,
  formatRemaining,
  type PermissionRiskInfo,
} from './pending-approvals-banner.rules';

const REFRESH_INTERVAL_MS = 2_500;
const CLOCK_TICK_MS = 1_000;
const EXTEND_MS = 2 * 60_000;

@Component({
  selector: 'app-pending-approvals-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pendingRequests().length > 0) {
      <section class="approvals-banner" role="status" aria-live="polite">
        <div class="banner-header">
          <span class="status-dot" [class.critical]="hasCritical()" aria-hidden="true"></span>
          <strong>
            {{ pendingRequests().length === 1
              ? 'Approval needed'
              : pendingRequests().length + ' approvals needed' }}
          </strong>
          @if (errorMessage(); as err) {
            <span class="banner-error">{{ err }}</span>
          }
        </div>
        <ul class="approval-list">
          @for (item of pendingRequests(); track item.id) {
            <li class="approval-row" [class.critical]="risk(item).tier === 'critical'">
              <div class="approval-copy">
                <div class="approval-copy-top">
                  <span class="risk-badge" [class]="'tier-' + risk(item).tier">{{ risk(item).label }}</span>
                  <span class="approval-timer">{{ remaining(item) }}</span>
                </div>
                <span class="approval-desc">{{ item.description }}</span>
                <span class="approval-meta">
                  {{ item.instanceLabel || item.instanceId }}
                  @if (item.instanceProvider) { &middot; {{ item.instanceProvider }} }
                  @if (item.toolName) { &middot; {{ item.toolName }} }
                </span>
                @if (details(item); as d) {
                  <span class="approval-details">{{ d }}</span>
                }
              </div>
              <div class="approval-actions">
                <button
                  type="button"
                  class="banner-btn primary"
                  [disabled]="working() !== null"
                  (click)="approve(item)"
                >{{ working() === item.id ? 'Approving…' : 'Approve' }}</button>
                <button
                  type="button"
                  class="banner-btn danger"
                  [disabled]="working() !== null"
                  aria-label="Deny this request"
                  (click)="deny(item)"
                >Deny</button>
                <button
                  type="button"
                  class="banner-btn"
                  [disabled]="working() !== null"
                  aria-label="Give this request 2 more minutes before it expires"
                  (click)="extend(item)"
                >+2 min</button>
              </div>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [`
    .approvals-banner {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      padding: 0.6rem 1rem;
      border-top: 1px solid color-mix(in srgb, var(--warning-color, #f59e0b) 38%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--warning-color, #f59e0b) 38%, transparent);
      background: color-mix(in srgb, var(--warning-color, #f59e0b) 10%, var(--bg-primary, #0f172a));
      color: var(--text-primary, #e5e5e5);
      z-index: 1002;
    }

    .banner-header {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      font-size: 0.84rem;
    }

    .status-dot {
      width: 9px;
      height: 9px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: var(--warning-color, #f59e0b);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning-color, #f59e0b) 18%, transparent);
    }

    .status-dot.critical {
      background: var(--error-color, #f87171);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--error-color, #f87171) 20%, transparent);
    }

    .banner-error {
      color: #fca5a5;
    }

    .approval-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }

    .approval-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.4rem 0.6rem;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .approval-row.critical {
      border-color: color-mix(in srgb, var(--error-color, #f87171) 45%, transparent);
    }

    .approval-copy {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
    }

    .approval-copy-top {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .risk-badge {
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      padding: 0.05rem 0.4rem;
      border-radius: 999px;
    }

    .risk-badge.tier-critical {
      color: #fecaca;
      background: color-mix(in srgb, var(--error-color, #f87171) 22%, transparent);
    }

    .risk-badge.tier-warning {
      color: #fde68a;
      background: color-mix(in srgb, var(--warning-color, #f59e0b) 20%, transparent);
    }

    .risk-badge.tier-info {
      color: #cbd5e1;
      background: rgba(255, 255, 255, 0.08);
    }

    .approval-timer {
      font-variant-numeric: tabular-nums;
      font-size: 0.76rem;
      color: var(--text-secondary, #cbd5e1);
    }

    .approval-desc {
      font-size: 0.84rem;
    }

    .approval-meta,
    .approval-details {
      font-size: 0.74rem;
      color: var(--text-secondary, #94a3b8);
    }

    .approval-actions {
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
      white-space: nowrap;
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

    @media (max-width: 860px) {
      .approval-row {
        flex-wrap: wrap;
      }
    }
  `],
})
export class PendingApprovalsBannerComponent implements OnInit, OnDestroy {
  private readonly permissionRegistry = inject(PermissionRegistryIpcService);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;

  readonly pendingRequests = signal<PendingApprovalItem[]>([]);
  readonly working = signal<string | null>(null);
  readonly errorMessage = signal<string | null>(null);
  private readonly now = signal(Date.now());

  readonly hasCritical = computed(() =>
    this.pendingRequests().some((item) => this.risk(item).tier === 'critical'),
  );

  ngOnInit(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
    this.clockTimer = setInterval(() => {
      this.now.set(Date.now());
    }, CLOCK_TICK_MS);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      return;
    }
    this.refreshInFlight = true;
    try {
      const response = await this.permissionRegistry.listPending();
      if (response.success) {
        this.pendingRequests.set(response.data ?? []);
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  risk(item: PendingApprovalItem): PermissionRiskInfo {
    return classifyPermissionRisk(item.action);
  }

  remaining(item: PendingApprovalItem): string {
    return formatRemaining(item.expiresAt, this.now());
  }

  details(item: PendingApprovalItem): string {
    return formatDetails(item.details);
  }

  async approve(item: PendingApprovalItem): Promise<void> {
    await this.decide(item, true);
  }

  async deny(item: PendingApprovalItem): Promise<void> {
    await this.decide(item, false);
  }

  async extend(item: PendingApprovalItem): Promise<void> {
    if (this.working()) {
      return;
    }
    this.working.set(item.id);
    this.errorMessage.set(null);
    try {
      const response = await this.permissionRegistry.extend(item.id, EXTEND_MS);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to extend the request.');
        return;
      }
      await this.refresh();
    } finally {
      this.working.set(null);
    }
  }

  private async decide(item: PendingApprovalItem, granted: boolean): Promise<void> {
    if (this.working()) {
      return;
    }
    this.working.set(item.id);
    this.errorMessage.set(null);
    try {
      const response = await this.permissionRegistry.resolve(
        item.id,
        granted,
        granted ? 'Approved from pending approvals banner' : 'Denied from pending approvals banner',
      );
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to submit your decision.');
        return;
      }
      this.removeItem(item.id);
      await this.refresh();
    } finally {
      this.working.set(null);
    }
  }

  private removeItem(id: string): void {
    this.pendingRequests.update((items) => items.filter((item) => item.id !== id));
  }
}
