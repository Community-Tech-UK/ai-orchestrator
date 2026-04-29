import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CliUpdatePillStore } from '../../core/state/cli-update-pill.store';

@Component({
  selector: 'app-cli-update-pill',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.state().count > 0) {
      <button
        type="button"
        class="cli-update-pill"
        [title]="tooltip()"
        (click)="openCliHealth()"
      >
        <span class="dot" aria-hidden="true"></span>
        <span>{{ store.state().count }} updater{{ store.state().count === 1 ? '' : 's' }}</span>
      </button>
    }
  `,
  styles: [`
    :host { display: inline-flex; }
    .cli-update-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-height: 28px;
      border: 1px solid var(--border-color, #2a2a2e);
      border-radius: 999px;
      background: var(--bg-secondary, #1a1a1a);
      color: var(--text-primary, #e5e5e5);
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.25rem 0.625rem;
      white-space: nowrap;
    }
    .cli-update-pill:hover { background: rgba(255, 255, 255, 0.08); }
    .dot {
      width: 0.45rem;
      height: 0.45rem;
      border-radius: 999px;
      background: #7aa2f7;
      flex: 0 0 auto;
    }
  `],
})
export class CliUpdatePillComponent implements OnInit {
  protected readonly store = inject(CliUpdatePillStore);
  private readonly router = inject(Router);

  ngOnInit(): void {
    this.store.init();
  }

  openCliHealth(): void {
    void this.router.navigate(['/settings'], {
      queryParams: { tab: 'cli-health' },
    });
  }

  tooltip(): string {
    return this.store.state().entries
      .map((entry) => {
        const command = entry.updatePlan.displayCommand ?? entry.updatePlan.reason ?? 'Updater configured';
        return `${entry.displayName} ${entry.currentVersion ?? ''}: ${command}`;
      })
      .join('\n');
  }
}
