/**
 * Context Warning Component - Shows context usage warnings and compact controls
 */

import {
  Component,
  input,
  output,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';

@Component({
  selector: 'app-context-warning',
  standalone: true,
  template: `
    @if (visible()) {
      <div class="context-warning" [class]="levelClass()">
        <div class="warning-content">
          <span class="warning-icon">{{ icon() }}</span>
          <span class="warning-text">{{ message() }}</span>
        </div>
        <div class="warning-actions">
          @if (!isCompacting()) {
            <button class="compact-btn" (click)="compactNow.emit()">
              Compact Now
            </button>
          } @else {
            <span class="compacting-label">Compacting...</span>
          }
          @if (level() === 'warning') {
            <button class="dismiss-btn" (click)="onDismiss()" title="Dismiss">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .context-warning {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-md);
      font-size: 13px;
      gap: var(--spacing-sm);
    }

    .context-warning.level-warning {
      background: rgba(234, 179, 8, 0.1);
      border: 1px solid rgba(234, 179, 8, 0.3);
      color: var(--warning-color);
    }

    .context-warning.level-critical {
      background: rgba(249, 115, 22, 0.1);
      border: 1px solid rgba(249, 115, 22, 0.3);
      color: #f97316;
    }

    .context-warning.level-emergency {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: var(--error-color);
    }

    .warning-content {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      min-width: 0;
    }

    .warning-icon {
      font-size: 16px;
      flex-shrink: 0;
    }

    .warning-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .warning-actions {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      flex-shrink: 0;
    }

    .compact-btn {
      padding: 4px 12px;
      border-radius: var(--radius-sm);
      border: 1px solid currentColor;
      background: transparent;
      color: inherit;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);
      white-space: nowrap;
    }

    .compact-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .compacting-label {
      font-size: 12px;
      font-style: italic;
      opacity: 0.8;
    }

    .dismiss-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      border-radius: var(--radius-sm);
      opacity: 0.6;
      transition: all var(--transition-fast);
    }

    .dismiss-btn:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.1);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextWarningComponent {
  percentage = input.required<number>();
  level = input.required<'warning' | 'critical' | 'emergency'>();
  isCompacting = input<boolean>(false);
  dismissed = input<boolean>(false);
  /** When true, the percentage is an estimate, not actual context occupancy. */
  isEstimated = input<boolean>(false);

  compactNow = output<void>();
  dismiss = output<void>();

  visible = computed(() => {
    if (this.dismissed()) return false;
    return this.percentage() >= 75;
  });

  levelClass = computed(() => `level-${this.level()}`);

  icon = computed(() => {
    switch (this.level()) {
      case 'emergency': return '\u26D4';
      case 'critical': return '\u26A0\uFE0F';
      default: return '\u26A0\uFE0F';
    }
  });

  message = computed(() => {
    const pct = Math.round(this.percentage());
    const estimatedNote = this.isEstimated() ? ' (estimated)' : '';
    switch (this.level()) {
      case 'emergency':
        return `Context at ~${pct}%${estimatedNote} \u2014 compaction required`;
      case 'critical':
        return `Context at ~${pct}%${estimatedNote} \u2014 compacting...`;
      default:
        return `Context at ~${pct}%${estimatedNote} \u2014 auto-compact at 80%`;
    }
  });

  onDismiss(): void {
    this.dismiss.emit();
  }
}
