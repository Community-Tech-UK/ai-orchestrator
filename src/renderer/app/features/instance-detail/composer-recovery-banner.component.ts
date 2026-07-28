/**
 * Composer recovery banner.
 *
 * New-session submission failures used to be reported only through
 * `InstanceStore.setError()`, which no template renders — the user saw the
 * prompt vanish and nothing else. This is the visible half of the fix: it
 * states what went wrong and offers Retry or Discard against the durable
 * submission journal, so the composition is never a dead end.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { ComposerSubmissionRecord } from '../../core/services/composer-submission.types';

@Component({
  selector: 'app-composer-recovery-banner',
  standalone: true,
  template: `
    @if (submitting()) {
      <div class="composer-recovery composer-recovery-pending" role="status">
        <span class="composer-recovery-spinner" aria-hidden="true"></span>
        <span class="composer-recovery-text">Starting session — your message is kept until it is confirmed.</span>
      </div>
    } @else if (record(); as unsent) {
      <div class="composer-recovery composer-recovery-failed" role="alert">
        <div class="composer-recovery-body">
          <strong class="composer-recovery-title">This message was not sent</strong>
          <span class="composer-recovery-reason">{{ unsent.lastError }}</span>
          <span class="composer-recovery-meta">{{ summary() }}</span>
        </div>
        <div class="composer-recovery-actions">
          <button type="button" class="composer-recovery-btn primary" (click)="retry.emit(unsent)">
            Retry
          </button>
          <button type="button" class="composer-recovery-btn" (click)="discard.emit(unsent)">
            Discard
          </button>
        </div>
      </div>
    } @else if (error(); as message) {
      <div class="composer-recovery composer-recovery-failed" role="alert">
        <div class="composer-recovery-body">
          <span class="composer-recovery-reason">{{ message }}</span>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .composer-recovery {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        margin-bottom: 8px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        font-family: var(--font-mono);
        font-size: 11px;
      }

      .composer-recovery-failed {
        border-color: rgba(var(--warning-rgb), 0.35);
        background: rgba(var(--warning-rgb), 0.08);
      }

      .composer-recovery-body {
        display: flex;
        flex-direction: column;
        gap: 3px;
        flex: 1;
        min-width: 0;
      }

      .composer-recovery-title {
        color: var(--text-primary);
        font-weight: 600;
      }

      .composer-recovery-reason {
        color: var(--text-secondary);
        white-space: pre-wrap;
      }

      .composer-recovery-meta {
        color: var(--text-muted);
      }

      .composer-recovery-actions {
        display: flex;
        gap: 8px;
        flex-shrink: 0;
      }

      .composer-recovery-btn {
        height: 26px;
        padding: 0 12px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.04);
        color: var(--text-secondary);
        font-family: var(--font-mono);
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
      }

      .composer-recovery-btn.primary {
        border-color: rgba(var(--primary-rgb), 0.4);
        background: rgba(var(--primary-rgb), 0.14);
        color: var(--text-primary);
      }

      .composer-recovery-spinner {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.15);
        border-top-color: rgba(var(--primary-rgb), 0.8);
        animation: composer-recovery-spin 0.8s linear infinite;
      }

      @keyframes composer-recovery-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerRecoveryBannerComponent {
  record = input<ComposerSubmissionRecord | null>(null);
  submitting = input(false);
  error = input<string | null>(null);

  retry = output<ComposerSubmissionRecord>();
  discard = output<ComposerSubmissionRecord>();

  readonly summary = computed(() => {
    const unsent = this.record();
    if (!unsent) return '';

    const parts = [`${unsent.text.length} characters`];
    if (unsent.files.length > 0) {
      parts.push(`${unsent.files.length} attachment${unsent.files.length === 1 ? '' : 's'}`);
    }
    if (unsent.attempts > 1) {
      parts.push(`${unsent.attempts} attempts`);
    }
    return parts.join(' · ');
  });
}
