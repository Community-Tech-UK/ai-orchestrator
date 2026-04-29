import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { PauseStore } from './pause.store';

@Component({
  selector: 'app-pause-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.isPaused()) {
      <section class="pause-banner" [class.error]="store.detectorError()">
        <div class="banner-main">
          <span class="status-dot" aria-hidden="true"></span>
          <div class="banner-copy">
            <strong>{{ title() }}</strong>
            <span>{{ detail() }}</span>
          </div>
        </div>

        <div class="banner-actions">
          @if (store.manualPaused()) {
            <button type="button" class="banner-btn primary" (click)="resumeManual()">Resume</button>
          }
          <button type="button" class="banner-btn" (click)="openNetworkSettings()">Network</button>
        </div>
      </section>
    }
  `,
  styles: [`
    .pause-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      min-height: 44px;
      padding: 0.6rem 1rem;
      border-top: 1px solid rgba(245, 158, 11, 0.32);
      border-bottom: 1px solid rgba(245, 158, 11, 0.32);
      background: rgba(245, 158, 11, 0.13);
      color: var(--text-primary, #e5e5e5);
      z-index: 1002;
    }

    .pause-banner.error {
      border-color: rgba(239, 68, 68, 0.38);
      background: rgba(239, 68, 68, 0.14);
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
      background: #f59e0b;
      box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.16);
    }

    .error .status-dot {
      background: #ef4444;
      box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.16);
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

    .banner-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .banner-btn.primary {
      border-color: rgba(34, 197, 94, 0.42);
      background: rgba(34, 197, 94, 0.14);
    }
  `],
})
export class PauseBannerComponent {
  protected readonly store = inject(PauseStore);
  private readonly router = inject(Router);

  protected readonly title = computed(() => {
    if (this.store.detectorError()) return 'Network detector needs attention';
    if (this.store.reasons().includes('vpn')) return 'Paused for VPN';
    return 'Orchestrator paused';
  });

  protected readonly detail = computed(() => {
    const queuedTotal = this.store.queuedTotal();
    const queued = queuedTotal > 0
      ? `${queuedTotal} message${queuedTotal === 1 ? '' : 's'} queued.`
      : 'Outgoing provider traffic is blocked.';
    return this.store.detectorError()
      ? `${queued} Review detector status before resuming.`
      : queued;
  });

  async resumeManual(): Promise<void> {
    await this.store.setManual(false);
  }

  openNetworkSettings(): void {
    void this.router.navigate(['/settings'], { fragment: 'network' });
  }
}
