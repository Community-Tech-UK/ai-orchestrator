/**
 * Status Indicator Component - Visual status dot with color and animation
 */

import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import { InstanceStatus } from '../../core/state/instance.store';

const STATUS_COLORS: Record<InstanceStatus, string> = {
  initializing: '#f59e0b', // Amber
  ready: '#10b981',        // Green - fully started
  idle: '#10b981',         // Green
  busy: '#3b82f6',         // Blue
  processing: '#3b82f6',   // Blue - alive but no output yet (remote heartbeat)
  thinking_deeply: '#8b5cf6', // Purple - extended thinking (90s+ no stdout)
  waiting_for_input: '#f59e0b', // Amber
  waiting_for_permission: '#f59e0b', // Amber - needs approval
  respawning: '#8b5cf6',   // Purple - recovering from interrupt
  hibernating: '#6b7280',  // Gray - transitioning
  hibernated: '#4b5563',   // Darker gray - resting
  waking: '#f59e0b',       // Amber - waking up
  degraded: '#f97316',     // Orange - remote node disconnected
  error: '#ef4444',        // Red
  failed: '#ef4444',       // Red - unrecoverable failure
  terminated: '#6b7280',   // Gray
};

const STATUS_LABELS: Record<InstanceStatus, string> = {
  initializing: 'Initializing...',
  ready: 'Ready',
  idle: 'Idle',
  busy: 'Processing...',
  processing: 'Processing...',
  thinking_deeply: 'Thinking deeply...',
  waiting_for_input: 'Waiting for input',
  waiting_for_permission: 'Needs approval',
  respawning: 'Resuming session...',
  hibernating: 'Hibernating...',
  hibernated: 'Hibernated',
  waking: 'Waking up...',
  degraded: 'Degraded',
  error: 'Error',
  failed: 'Failed',
  terminated: 'Terminated',
};

@Component({
  selector: 'app-status-indicator',
  standalone: true,
  template: `
    <div class="status-wrapper" [class.with-label]="showLabel()">
      @if (showSpinnerIndicator()) {
        <div
          class="status-spinner"
          [style.--spinner-color]="color()"
          [title]="label()"
        ></div>
      } @else {
        <div
          class="status-indicator"
          [style.backgroundColor]="color()"
          [class.pulsing]="isPulsing()"
          [title]="label()"
        ></div>
      }
      @if (showLabel()) {
        <span class="status-label">{{ visibleLabel() }}</span>
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

    .status-spinner {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex-shrink: 0;
      border: 2px solid rgba(255, 255, 255, 0.12);
      border-top-color: var(--spinner-color);
      border-right-color: var(--spinner-color);
      animation: spin 0.75s linear infinite;
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

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
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
  visibleLabel = computed(() => this.label());

  isPulsing = computed(() =>
    this.status() === 'busy' ||
    this.status() === 'processing' ||
    this.status() === 'thinking_deeply' ||
    this.status() === 'initializing' ||
    this.status() === 'respawning' ||
    this.status() === 'hibernating' ||
    this.status() === 'waking' ||
    this.status() === 'degraded'
  );

  showSpinnerIndicator = computed(() =>
    this.status() === 'busy' ||
    this.status() === 'processing' ||
    this.status() === 'thinking_deeply'
  );
}
