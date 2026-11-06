/**
 * Session rail notice for a session list that could not be loaded.
 *
 * The first `state:resync` can fail for good (the main process may refuse the handshake or return no list). The
 * store used to put that in `InstanceStore.error`, which no template renders, so the rail simply looked empty
 * while running sessions were missing. This notice stays until a retry loads the list, keeps the raw reason
 * behind Details, and says so when a retry fails again so the button never looks like it did nothing.
 */

import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, output, signal } from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import type { InstanceListLoadFailure } from '../../core/state/instance/instance.types';

@Component({
  selector: 'app-instance-list-load-failure',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.listLoadFailure(); as failure) {
      <div class="load-failure" data-testid="instance-list-load-failure">
        <div role="alert">
          <strong class="load-failure-title">
            {{ failedAgain() ? 'Still could not load sessions' : 'Could not load sessions' }}
          </strong>
          <p class="load-failure-text">Running sessions may be missing from this list.</p>
        </div>
        <button
          type="button"
          class="load-failure-retry"
          [attr.aria-disabled]="retrying() ? 'true' : null"
          (click)="retry()"
        >
          {{ retrying() ? 'Trying again…' : 'Try again' }}
        </button>
        <details class="load-failure-details">
          <summary>Details</summary>
          <pre class="load-failure-detail">{{ failure.detail }}</pre>
        </details>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .load-failure {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--spacing-sm);
        margin: var(--spacing-sm) var(--spacing-lg) 0;
        padding: var(--spacing-md);
        border: 1px solid var(--pill-error-border);
        border-radius: var(--radius-md);
        background: var(--pill-error-bg);
      }

      .load-failure-title {
        display: block;
        margin-bottom: 2px;
        font-size: 12px;
        font-weight: 600;
        color: var(--pill-error-fg);
      }

      .load-failure-text {
        margin: 0;
        font-size: 12px;
        color: var(--text-secondary);
      }

      .load-failure-retry {
        padding: 4px 12px;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .load-failure-retry:hover {
        background: var(--bg-hover);
      }

      .load-failure-retry[aria-disabled='true'] {
        cursor: progress;
        opacity: 0.7;
      }

      .load-failure-details {
        width: 100%;
        font-size: 11px;
        color: var(--text-muted);
      }

      .load-failure-details summary {
        cursor: pointer;
      }

      .load-failure-detail {
        margin: var(--spacing-xs) 0 0;
        font-family: var(--font-mono);
        font-size: 11px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        user-select: text;
      }
    `,
  ],
})
export class InstanceListLoadFailureComponent {
  protected readonly store = inject(InstanceStore);
  private readonly element = inject(ElementRef<HTMLElement>);
  readonly recovered = output<void>();

  protected readonly retrying = signal(false);
  private readonly failureFromRetry = signal<InstanceListLoadFailure | null>(null);

  /** True while the failure on screen is the one a retry just produced. */
  protected readonly failedAgain = computed(() => {
    const failure = this.store.listLoadFailure();
    return failure !== null && failure === this.failureFromRetry();
  });

  protected async retry(): Promise<void> {
    if (this.retrying()) return;
    const focused = this.element.nativeElement.contains(document.activeElement) ? document.activeElement : null;
    this.retrying.set(true);
    try {
      await this.store.refreshInstances();
    } finally {
      this.retrying.set(false);
    }
    this.failureFromRetry.set(this.store.listLoadFailure());
    // The successful snapshot removes the focused retry button. Keep focus in the rail,
    // unless the user moved it elsewhere while the request was running.
    if (!this.store.listLoadFailure() && focused && (document.activeElement === focused
      || (!focused.isConnected && document.activeElement === document.body))) this.recovered.emit();
  }
}
