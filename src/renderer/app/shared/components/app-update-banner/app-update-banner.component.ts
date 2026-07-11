import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AppUpdateStore } from '../../../core/state/app-update.store';

@Component({
  selector: 'app-update-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.visible()) {
      <section
        class="app-update-banner"
        data-testid="app-update-banner"
        role="status"
        aria-live="polite"
      >
        <div class="update-copy">
          <strong>Harness {{ availableVersion() }} is ready</strong>
          <span>The update has downloaded. Restart now or it will install when Harness next closes.</span>
          @if (store.error(); as error) {
            <span class="update-error">{{ error }}</span>
          }
        </div>
        <div class="update-actions">
          <button type="button" class="secondary" (click)="store.dismissForSession()">Later</button>
          <button
            type="button"
            class="primary"
            [disabled]="store.loading()"
            (click)="restart()"
          >
            Restart to update
          </button>
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .app-update-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 16px;
      background: var(--bg-elevated);
      border-block: 1px solid var(--pill-ok-border);
      color: var(--text-primary);
      z-index: 900;
    }
    .update-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .update-copy span { color: var(--text-secondary); font-size: var(--text-sm); }
    .update-copy .update-error { color: var(--toast-error-fg); }
    .update-actions { display: flex; gap: 8px; flex: 0 0 auto; }
    button {
      min-height: 32px;
      padding: 0 12px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
      cursor: pointer;
      font-weight: 600;
    }
    button.secondary { background: transparent; color: var(--text-secondary); }
    button.primary { background: var(--primary-color); color: var(--button-on-primary); border-color: transparent; }
    button:disabled { cursor: wait; opacity: 0.65; }
    @media (max-width: 640px) {
      .app-update-banner { align-items: stretch; flex-direction: column; }
      .update-actions { justify-content: flex-end; }
    }
  `],
})
export class AppUpdateBannerComponent {
  protected readonly store = inject(AppUpdateStore);
  protected readonly availableVersion = computed(() => {
    const status = this.store.status();
    return status?.availableVersion ?? 'update';
  });

  protected restart(): void {
    void this.store.restartAndInstall();
  }
}
