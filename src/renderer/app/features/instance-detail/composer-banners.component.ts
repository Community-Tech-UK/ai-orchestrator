/**
 * Composer banner cluster — session-state bars that gate the composer, so
 * they render directly above it:
 *
 * - Provider quota park (WS7 Phase B): resume-now / cancel / switch-provider.
 * - Hardened (Seatbelt) denial (WS13 slice 3): the allow-and-retry lever —
 *   grant one absolute path as a writable root and restart into the rebuilt
 *   jail. Never disables the sandbox.
 */
import {
  Component,
  ChangeDetectionStrategy,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import type { InstanceStatus } from '../../core/state/instance/instance.types';
import type { InstanceWaitReason } from '../../../../shared/types/instance.types';
import { formatQuotaParkCountdown } from './input-panel-formatters';

@Component({
  selector: 'app-composer-banners',
  standalone: true,
  template: `
    <!-- Provider quota park: gates the composer, so it renders here rather than in the header -->
    @if (quotaParkLabel()) {
      <div class="quota-park-bar" role="status" [title]="quotaParkDetail()">
        <span class="quota-park-text">{{ quotaParkLabel() }}</span>
        <button
          type="button"
          class="quota-park-btn"
          title="Resume this session now instead of waiting"
          (click)="onResumeFromProviderLimit()"
        >Resume now</button>
        <button
          type="button"
          class="quota-park-btn quota-park-btn--secondary"
          title="Cancel the auto-resume for this session"
          (click)="onCancelProviderLimitPark()"
        >Cancel</button>
        @if (canOfferFailover()) {
          <button
            type="button"
            class="quota-park-btn"
            title="Move this conversation to the next configured fallback provider instead of waiting"
            (click)="onFailoverNow()"
          >Switch provider</button>
        }
      </div>
    }

    <!-- WS13: hardened session died — offer the allow-and-retry lever -->
    @if (showHardenedDenialBar()) {
      <div class="quota-park-bar hardened-denial-bar" role="status">
        <span class="quota-park-text">Hardened session exited — the sandbox may have blocked a write.</span>
        <input
          class="hardened-path-input"
          type="text"
          placeholder="/absolute/path/to/allow"
          [value]="hardenedAllowPathValue()"
          (input)="onHardenedPathInput($event)"
        />
        <button
          type="button"
          class="quota-park-btn"
          [disabled]="hardenedAllowBusy()"
          title="Grant this path as a writable root and restart the session inside the rebuilt sandbox"
          (click)="onHardenedAllowPath()"
        >Allow path & retry</button>
        <button
          type="button"
          class="quota-park-btn quota-park-btn--secondary"
          [disabled]="hardenedAllowBusy()"
          title="Restart the session in the same sandbox without granting anything new"
          (click)="onHardenedRetry()"
        >Just retry</button>
      </div>
    }
  `,
  styles: `
    .quota-park-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      margin-bottom: 8px;
      border-radius: 8px;
      background: var(--surface-sunken-bg, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
      font-size: 12px;
      color: var(--text-secondary);
      cursor: help;

      .quota-park-text {
        flex: 1;
      }

      .quota-park-btn {
        font-size: 11px;
        padding: 2px 10px;
        border-radius: 5px;
        border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;

        &:hover {
          background: var(--hover-bg, rgba(255, 255, 255, 0.06));
          color: var(--text-primary, #fff);
        }

        &.quota-park-btn--secondary {
          color: var(--text-muted);
        }
      }

      .hardened-path-input {
        flex: 1;
        min-width: 160px;
        font-size: 11px;
        font-family: var(--font-mono);
        padding: 3px 8px;
        border-radius: 5px;
        border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
        background: var(--surface-sunken-bg, rgba(255, 255, 255, 0.03));
        color: var(--text-primary, #fff);

        &::placeholder {
          color: var(--text-muted);
        }
      }
    }

    .hardened-denial-bar {
      cursor: default;

      .quota-park-text {
        flex: 0 1 auto;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerBannersComponent {
  private instanceIpc = inject(InstanceIpcService);
  private instanceStore = inject(InstanceStore);

  instanceId = input.required<string>();
  waitReason = input<InstanceWaitReason | undefined>(undefined);
  instanceStatus = input<InstanceStatus>('idle');

  /** Quota-park banner state (lives with the composer it gates). */
  readonly quotaPark = computed(() => {
    const wr = this.waitReason();
    return wr?.kind === 'quota-park' ? wr : null;
  });
  private readonly quotaParkNow = signal(Date.now());
  private readonly quotaParkTicker = effect((onCleanup) => {
    if (!this.quotaPark()) return;
    const timer = setInterval(() => this.quotaParkNow.set(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  readonly quotaParkLabel = computed(() => {
    const park = this.quotaPark();
    return park ? `Provider limit — ${formatQuotaParkCountdown(park.resumeAt, this.quotaParkNow())}` : null;
  });
  readonly quotaParkDetail = computed(() => {
    const park = this.quotaPark();
    if (!park) return '';
    return `Parked on a ${park.provider} limit. Re-checks the live quota every few minutes and resumes as soon as the limit lifts; resumes at ${new Date(park.resumeAt).toLocaleTimeString()} at the latest.`;
  });

  onResumeFromProviderLimit(): void {
    void this.instanceIpc.providerLimitResumeNow(this.instanceId());
  }

  onCancelProviderLimitPark(): void {
    void this.instanceIpc.providerLimitCancel(this.instanceId());
  }

  /** WS7 Phase B — offer a provider switch while parked, when fallbacks exist. */
  readonly canOfferFailover = computed(() => {
    if (!this.quotaPark()) return false;
    const inst = this.instanceStore.getInstance(this.instanceId());
    return Boolean(inst?.failoverProviders?.some((p) => p !== inst.provider));
  });

  onFailoverNow(): void {
    void this.instanceIpc.instanceFailoverNow(this.instanceId());
  }

  /** WS13 slice 3 — hardened session died; offer the allow-and-retry lever. */
  readonly showHardenedDenialBar = computed(() => {
    if (this.instanceStatus() !== 'error') return false;
    return Boolean(this.instanceStore.getInstance(this.instanceId())?.hardened);
  });
  readonly hardenedAllowPathValue = signal('');
  readonly hardenedAllowBusy = signal(false);

  onHardenedPathInput(event: Event): void {
    this.hardenedAllowPathValue.set((event.target as HTMLInputElement).value);
  }

  async onHardenedAllowPath(): Promise<void> {
    const path = this.hardenedAllowPathValue().trim();
    if (!path || this.hardenedAllowBusy()) return;
    this.hardenedAllowBusy.set(true);
    try {
      const result = await this.instanceIpc.hardenedAllowPath(this.instanceId(), path);
      if (!result.success) {
        this.instanceStore.setError(result.error?.message || 'Failed to grant the path');
      } else {
        this.hardenedAllowPathValue.set('');
      }
    } finally {
      this.hardenedAllowBusy.set(false);
    }
  }

  /** Retry in the same jail without granting anything new. */
  onHardenedRetry(): void {
    void this.instanceIpc.restartInstance(this.instanceId());
  }
}
