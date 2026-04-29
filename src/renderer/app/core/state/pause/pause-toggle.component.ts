import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PauseStore } from './pause.store';

@Component({
  selector: 'app-pause-toggle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="pause-toggle"
      [class.active]="store.manualPaused()"
      [attr.aria-pressed]="store.manualPaused()"
      [attr.aria-label]="store.manualPaused() ? 'Resume orchestrator' : 'Pause orchestrator'"
      [title]="store.manualPaused() ? 'Resume orchestrator' : 'Pause orchestrator'"
      (click)="toggleManualPause()"
    >
      @if (store.manualPaused()) {
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.2 2.5v11l8-5.5-8-5.5Z" />
        </svg>
      } @else {
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 2.5h2.4v11H4v-11Zm5.6 0H12v11H9.6v-11Z" />
        </svg>
      }
    </button>
  `,
  styles: [`
    .pause-toggle {
      width: 32px;
      height: 32px;
      display: inline-grid;
      place-items: center;
      border: 1px solid var(--border-color, #333);
      border-radius: 6px;
      background: var(--bg-secondary, #1e1e1e);
      color: var(--text-secondary, #aaa);
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }

    .pause-toggle:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-primary, #e5e5e5);
    }

    .pause-toggle.active {
      color: #fecaca;
      border-color: rgba(239, 68, 68, 0.45);
      background: rgba(239, 68, 68, 0.18);
    }

    svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
  `],
})
export class PauseToggleComponent {
  protected readonly store = inject(PauseStore);

  async toggleManualPause(): Promise<void> {
    await this.store.setManual(!this.store.manualPaused());
  }
}
