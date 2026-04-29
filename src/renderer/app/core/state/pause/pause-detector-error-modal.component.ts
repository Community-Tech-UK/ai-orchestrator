import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { PauseStore } from './pause.store';

@Component({
  selector: 'app-pause-detector-error-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.detectorError() && !dismissed()) {
      <div class="modal-backdrop" role="presentation">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="detector-error-title">
          <div class="modal-header">
            <h2 id="detector-error-title">Network detector paused traffic</h2>
            <button type="button" class="icon-btn" aria-label="Dismiss" title="Dismiss" (click)="dismissed.set(true)">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4.3 3.2 8 6.9l3.7-3.7 1.1 1.1L9.1 8l3.7 3.7-1.1 1.1L8 9.1l-3.7 3.7-1.1-1.1L6.9 8 3.2 4.3l1.1-1.1Z" />
              </svg>
            </button>
          </div>
          <p>
            The detector could not confidently determine network state, so outgoing provider traffic is paused.
          </p>
          <div class="modal-actions">
            <button type="button" class="secondary-btn" (click)="openNetworkSettings()">Open Network Settings</button>
            <button type="button" class="primary-btn" (click)="resumeAfterError()">Resume</button>
          </div>
        </section>
      </div>
    }
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 5000;
      display: grid;
      place-items: center;
      padding: 1rem;
      background: rgba(0, 0, 0, 0.45);
    }

    .modal {
      width: min(440px, 100%);
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      background: var(--bg-primary, #111);
      color: var(--text-primary, #e5e5e5);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
      padding: 1rem;
    }

    .modal-header,
    .modal-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }

    h2 {
      margin: 0;
      font-size: 1rem;
    }

    p {
      margin: 0.75rem 0 1rem;
      color: var(--text-secondary, #cbd5e1);
      font-size: 0.875rem;
      line-height: 1.45;
    }

    .icon-btn,
    .primary-btn,
    .secondary-btn {
      border-radius: 6px;
      cursor: pointer;
      color: var(--text-primary, #e5e5e5);
    }

    .icon-btn {
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      border: none;
      background: transparent;
    }

    .icon-btn:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    svg {
      width: 15px;
      height: 15px;
      fill: currentColor;
    }

    .primary-btn,
    .secondary-btn {
      height: 32px;
      border: 1px solid var(--border-color, #333);
      padding: 0 0.85rem;
      font-weight: 600;
    }

    .primary-btn {
      border-color: rgba(34, 197, 94, 0.42);
      background: rgba(34, 197, 94, 0.16);
    }

    .secondary-btn {
      background: rgba(255, 255, 255, 0.06);
    }
  `],
})
export class PauseDetectorErrorModalComponent {
  protected readonly store = inject(PauseStore);
  protected readonly dismissed = signal(false);
  private readonly router = inject(Router);

  constructor() {
    effect(() => {
      if (!this.store.detectorError()) {
        this.dismissed.set(false);
      }
    });
  }

  async resumeAfterError(): Promise<void> {
    await this.store.resumeAfterDetectorError();
  }

  openNetworkSettings(): void {
    this.dismissed.set(true);
    void this.router.navigate(['/settings'], { fragment: 'network' });
  }
}
