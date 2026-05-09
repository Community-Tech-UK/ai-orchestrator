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
        <span>Update {{ store.state().count === 1 ? 'CLI' : 'CLIs' }}</span>
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
      border: 1px solid var(--warning-border, rgba(234, 179, 8, 0.4));
      border-radius: 999px;
      background: var(--warning-bg, rgba(234, 179, 8, 0.12));
      color: var(--warning-color, #eab308);
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.25rem 0.625rem;
      white-space: nowrap;
    }
    .cli-update-pill:hover {
      background: color-mix(in srgb, var(--warning-color, #eab308) 22%, transparent);
    }
    .dot {
      width: 0.45rem;
      height: 0.45rem;
      border-radius: 999px;
      background: var(--warning-color, #eab308);
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
      .filter((entry) => entry.updateAvailable === true)
      .map((entry) => {
        const command = entry.updatePlan.displayCommand ?? entry.updatePlan.reason ?? 'Updater configured';
        const versions = entry.latestVersion && entry.currentVersion
          ? `${entry.currentVersion} → ${entry.latestVersion}`
          : entry.currentVersion ?? '';
        return `${entry.displayName} ${versions}: ${command}`.trim();
      })
      .join('\n');
  }
}
