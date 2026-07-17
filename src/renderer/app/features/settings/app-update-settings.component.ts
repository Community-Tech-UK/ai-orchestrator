import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import type { UpdateStatus } from '../../../../shared/types/update.types';
import { AppUpdateStore } from '../../core/state/app-update.store';
import { SettingsCardComponent } from './ui/settings-card.component';

@Component({
  selector: 'app-update-settings',
  standalone: true,
  imports: [SettingsCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-settings-card
      title="Application updates"
      description="Harness checks in the background and downloads stable releases for this computer."
      icon="general"
    >
      @if (store.status(); as status) {
        <div class="update-status" [attr.data-state]="status.state">
          <div class="version-lockup">
            <span class="version-label">Installed</span>
            <strong>Harness {{ status.currentVersion ?? 'unknown' }}</strong>
          </div>
          <div class="state-copy">
            <span>{{ stateText(status) }}</span>
            @if (status.lastCheckedAt) {
              <small>Last checked {{ formatCheckedAt(status.lastCheckedAt) }}</small>
            }
          </div>
        </div>

        @if (status.state === 'downloading') {
          <progress
            [value]="status.percent ?? 0"
            max="100"
            aria-label="Application update download progress"
          ></progress>
        }

        @if (status.error || store.error(); as error) {
          <p class="update-error" role="alert">{{ error }}</p>
        }

        @if (status.enabled) {
          <div class="update-actions">
            @if (status.state === 'downloaded') {
              <button type="button" class="primary" [disabled]="store.loading()" (click)="restart()">
                Restart to update
              </button>
            } @else if (status.state === 'error' && status.errorContext === 'download') {
              <button type="button" class="primary" [disabled]="store.loading()" (click)="retry()">
                Retry download
              </button>
            } @else {
              <button
                type="button"
                class="secondary"
                [disabled]="store.loading() || status.state === 'checking' || status.state === 'downloading'"
                (click)="check()"
              >
                Check for updates
              </button>
            }
          </div>
        }
      } @else {
        <p class="unavailable">Update status is available in the packaged Harness app.</p>
      }
    </app-settings-card>
  `,
  styles: [`
    :host { display: block; margin-top: var(--spacing-lg); }
    .update-status {
      display: grid;
      grid-template-columns: minmax(140px, 0.7fr) minmax(220px, 1.3fr);
      gap: var(--spacing-lg);
      align-items: center;
    }
    .version-lockup, .state-copy { display: flex; flex-direction: column; gap: 3px; }
    .version-label {
      color: var(--text-muted);
      font-size: var(--text-xs);
      font-weight: 700;
    }
    .version-lockup strong { color: var(--text-primary); font-size: var(--text-lg); }
    .state-copy { color: var(--text-secondary); font-size: var(--text-sm); }
    .state-copy small { color: var(--text-muted); }
    progress { width: 100%; height: 6px; accent-color: var(--primary-color); }
    .update-error {
      margin: 0;
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid var(--error-border);
      border-radius: var(--radius-sm);
      background: var(--error-bg);
      color: var(--error-color);
      font-size: var(--text-sm);
    }
    .unavailable { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); }
    .update-actions { display: flex; justify-content: flex-end; }
    button {
      min-height: 34px;
      padding: 0 var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      font: inherit;
      font-size: var(--text-sm);
      font-weight: 650;
      cursor: pointer;
    }
    button.primary { border-color: transparent; background: var(--primary-color); color: var(--button-on-primary); }
    button.secondary { background: var(--bg-elevated); color: var(--text-primary); }
    button:disabled { cursor: wait; opacity: 0.6; }
    button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    @media (max-width: 640px) {
      .update-status { grid-template-columns: 1fr; gap: var(--spacing-sm); }
      .update-actions { justify-content: stretch; }
      .update-actions button { width: 100%; }
    }
  `],
})
export class AppUpdateSettingsComponent {
  protected readonly store = inject(AppUpdateStore);

  protected stateText(status: UpdateStatus): string {
    switch (status.state) {
      case 'checking': return 'Checking for updates…';
      case 'available': return `Update ${status.availableVersion ?? ''} found. Downloading automatically.`;
      case 'downloading': return `Downloading ${status.availableVersion ?? 'update'} · ${status.percent ?? 0}%`;
      case 'downloaded': return `Harness ${status.availableVersion ?? 'update'} is ready to install.`;
      case 'not-available': return 'Harness is up to date.';
      case 'error': return 'The update could not be completed.';
      case 'idle':
      default:
        return status.enabled
          ? 'Ready to check for updates.'
          : 'Application updates are available in the packaged Harness app.';
    }
  }

  protected formatCheckedAt(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  protected check(): void { void this.store.check(); }
  protected retry(): void { void this.store.retryDownload(); }
  protected restart(): void { void this.store.restartAndInstall(); }
}
