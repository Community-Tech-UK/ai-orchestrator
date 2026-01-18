/**
 * Status Indicator Component - Visual status dot with color and animation
 */

import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import { InstanceStatus } from '../../core/state/instance.store';

const STATUS_COLORS: Record<InstanceStatus, string> = {
  initializing: '#f59e0b', // Amber
  idle: '#10b981',         // Green
  busy: '#3b82f6',         // Blue
  waiting_for_input: '#f59e0b', // Amber
  error: '#ef4444',        // Red
  terminated: '#6b7280',   // Gray
};

const STATUS_LABELS: Record<InstanceStatus, string> = {
  initializing: 'Initializing...',
  idle: 'Idle',
  busy: 'Processing...',
  waiting_for_input: 'Waiting for input',
  error: 'Error',
  terminated: 'Terminated',
};

@Component({
  selector: 'app-status-indicator',
  standalone: true,
  template: `
    <div class="status-wrapper" [class.with-label]="showLabel()">
      <div
        class="status-indicator"
        [style.backgroundColor]="color()"
        [class.pulsing]="isPulsing()"
        [title]="label()"
      ></div>
      @if (showLabel()) {
        <span class="status-label">{{ label() }}</span>
      }
    </div>
  `,
  styles: [`
    .status-wrapper {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
    }

    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .status-indicator.pulsing {
      animation: pulse 1.5s ease-in-out infinite;
    }

    .status-label {
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 1;
        transform: scale(1);
      }
      50% {
        opacity: 0.6;
        transform: scale(0.9);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusIndicatorComponent {
  status = input.required<InstanceStatus>();
  showLabel = input<boolean>(false);

  color = computed(() => STATUS_COLORS[this.status()]);
  label = computed(() => STATUS_LABELS[this.status()]);

  isPulsing = computed(() =>
    this.status() === 'busy' || this.status() === 'initializing'
  );
}
