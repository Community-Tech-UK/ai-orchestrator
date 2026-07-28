import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { LocalAiAggregateStatus } from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';

const STATE_LABELS: Record<LocalAiAggregateStatus['state'], string> = {
  'not-configured': 'Not configured',
  checking: 'Checking',
  healthy: 'Healthy',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  paused: 'Paused',
};

@Component({
  selector: 'app-local-ai-status-chip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.isInitialized()) {
      <button
        type="button"
        class="local-ai-status-chip"
        data-testid="local-ai-status-chip"
        [attr.data-state]="!store.hasAuthoritativeSnapshot()
          ? 'unavailable'
          : store.aggregate().state === 'not-configured'
          ? 'neutral'
          : store.aggregate().state"
        [attr.aria-label]="accessibleLabel()"
        [title]="accessibleLabel()"
        (click)="openHealthCentre()"
      >
        <span class="status-mark" aria-hidden="true"></span>
        <span>Local AI: {{ stateLabel() }}</span>
        @if (store.hasAuthoritativeSnapshot()) {
          <span class="target-count">{{ targetCountLabel() }}</span>
        }
      </button>
    }
  `,
  styles: [`
    :host {
      display: inline-flex;
    }

    .local-ai-status-chip {
      -webkit-app-region: no-drag;
      display: inline-flex;
      align-items: center;
      gap: 0.38rem;
      height: 24px;
      padding: 0 0.55rem;
      border: 1px solid var(--pill-neutral-border);
      border-radius: var(--radius-full);
      background: var(--pill-neutral-bg);
      color: var(--pill-neutral-fg);
      cursor: pointer;
      font: inherit;
      font-size: var(--text-xs);
      font-weight: 650;
      white-space: nowrap;
    }

    .status-mark {
      width: 6px;
      height: 6px;
      border-radius: var(--radius-full);
      background: currentColor;
    }

    .target-count {
      color: var(--text-muted);
      font-weight: 500;
    }

    .local-ai-status-chip[data-state='healthy'] {
      border-color: var(--pill-ok-border);
      background: var(--pill-ok-bg);
      color: var(--pill-ok-fg);
    }

    .local-ai-status-chip[data-state='checking'] {
      border-color: var(--pill-info-border);
      background: var(--pill-info-bg);
      color: var(--pill-info-fg);
    }

    .local-ai-status-chip[data-state='degraded'] {
      border-color: var(--pill-warn-border);
      background: var(--pill-warn-bg);
      color: var(--pill-warn-fg);
    }

    .local-ai-status-chip[data-state='unavailable'] {
      border-color: var(--pill-error-border);
      background: var(--pill-error-bg);
      color: var(--pill-error-fg);
    }

    .local-ai-status-chip:hover {
      background: var(--glass-strong);
    }

    .local-ai-status-chip:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
    }
  `],
})
export class LocalAiStatusChipComponent {
  protected readonly store = inject(LocalAiGuardStore);
  private readonly router = inject(Router);

  protected readonly stateLabel = computed(() =>
    this.store.hasAuthoritativeSnapshot()
      ? STATE_LABELS[this.store.aggregate().state]
      : 'Status unavailable');
  protected readonly targetCountLabel = computed(() => {
    const count = this.store.aggregate().enrolled;
    return `${count} ${count === 1 ? 'target' : 'targets'}`;
  });
  protected readonly accessibleLabel = computed(() => {
    if (!this.store.hasAuthoritativeSnapshot()) {
      return 'Local AI Guard: Status unavailable. Open Local AI health centre.';
    }
    const aggregate = this.store.aggregate();
    const targetNoun = aggregate.enrolled === 1 ? 'target' : 'targets';
    return `Local AI Guard: ${this.stateLabel()}. ${aggregate.enrolled} enrolled ${targetNoun}. Open Local AI health centre.`;
  });

  protected openHealthCentre(): void {
    void this.router.navigateByUrl('/local-ai');
  }
}
