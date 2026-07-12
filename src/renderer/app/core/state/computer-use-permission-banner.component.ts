/**
 * Computer Use Permission Banner
 *
 * Root-level dismissible banner shown while Computer Use is enabled on macOS
 * but Screen Recording or Accessibility is not ready. One action per missing
 * permission; dismissing collapses the warning into the title-bar chip for the
 * current enabled period. Presentation only — all state lives in
 * {@link ComputerUsePermissionStore}.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  ComputerUsePermissionStore,
  PERMISSION_LABELS,
} from './computer-use-permission.store';
import type { DesktopSystemPermission } from '../../../../shared/types/desktop-gateway.types';

@Component({
  selector: 'app-computer-use-permission-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.bannerVisible()) {
      <section
        class="cu-permission-banner"
        [class.error]="store.unavailable()"
        role="status"
        aria-live="polite"
      >
        <div class="banner-main">
          <span class="status-dot" aria-hidden="true"></span>
          <div class="banner-copy">
            <strong>{{ title() }}</strong>
            <span>{{ detail() }}</span>
            @if (store.error(); as err) {
              <span class="banner-error">{{ err }}</span>
            }
          </div>
        </div>

        <div class="banner-actions">
          @for (permission of store.missingPermissions(); track permission) {
            <button
              type="button"
              class="banner-btn primary"
              [disabled]="store.requesting() !== null"
              [attr.aria-label]="'Open ' + label(permission) + ' settings'"
              (click)="request(permission)"
            >
              {{ store.requesting() === permission
                ? 'Opening…'
                : 'Open ' + label(permission) + ' settings' }}
            </button>
          }
          <button
            type="button"
            class="banner-btn"
            aria-label="Dismiss Computer Use permission banner"
            title="Dismiss"
            (click)="dismiss()"
          >
            Dismiss
          </button>
        </div>
      </section>
    }
  `,
  styles: [`
    .cu-permission-banner {
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

    .cu-permission-banner.error {
      border-color: rgba(239, 68, 68, 0.38);
      background: rgba(239, 68, 68, 0.14);
    }

    .cu-permission-banner.error .status-dot {
      background: #ef4444;
      box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.16);
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
      border-color: rgba(245, 158, 11, 0.42);
      background: rgba(245, 158, 11, 0.14);
    }
  `],
})
export class ComputerUsePermissionBannerComponent {
  protected readonly store = inject(ComputerUsePermissionStore);

  protected readonly title = computed(() =>
    this.store.unavailable()
      ? 'Computer Use is unavailable'
      : 'Computer Use needs macOS permissions');

  protected readonly detail = computed(() => {
    if (this.store.unavailable()) {
      const actions = this.store.health()?.setupActions ?? [];
      return actions.length > 0
        ? actions.join(' ')
        : 'The Computer Use driver could not report permission health.';
    }
    const missing = this.store.missingPermissions()
      .map((permission) => PERMISSION_LABELS[permission]);
    return missing.length > 0
      ? `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not granted to Harness.`
      : 'Permission health is degraded.';
  });

  protected label(permission: DesktopSystemPermission): string {
    return PERMISSION_LABELS[permission];
  }

  protected async request(permission: DesktopSystemPermission): Promise<void> {
    await this.store.requestPermission(permission);
  }

  protected dismiss(): void {
    this.store.dismissBanner();
  }
}
