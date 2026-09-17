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
  thinking_deeply: '#4fa3a5', // Teal - extended thinking (90s+ no stdout)
  waiting_for_input: '#f59e0b', // Amber
  waiting_for_permission: '#f59e0b', // Amber - needs approval
  interrupting: '#b89a66', // Bronze - interrupt requested
  cancelling: '#b89a66',   // Bronze - cancellation finalizing
  'interrupt-escalating': '#ef4444', // Red - forced escalation
  cancelled: '#6b7280',    // Gray - cancelled, recoverable
  superseded: '#6b7280',   // Gray - replaced by edit/fork
  respawning: '#4fa3a5',   // Teal - recovering from interrupt
  hibernating: '#6b7280',  // Gray - transitioning
  hibernated: '#4b5563',   // Darker gray - resting
  waking: '#f59e0b',       // Amber - waking up
  degraded: '#f97316',     // Orange - remote node disconnected
  error: '#ef4444',        // Red
  failed: '#ef4444',       // Red - unrecoverable failure
  terminated: '#6b7280',   // Gray
};

/** Steel blue — shared with the rail's background-waiting ring. */
const BACKGROUND_WAITING_COLOR = '#7aa2c8';

const STATUS_LABELS: Record<InstanceStatus, string> = {
  initializing: 'Initializing...',
  ready: 'Ready',
  idle: 'Idle',
  busy: 'Processing...',
  processing: 'Processing...',
  thinking_deeply: 'Thinking deeply...',
  waiting_for_input: 'Waiting for input',
  waiting_for_permission: 'Needs approval',
  interrupting: 'Interrupting...',
  cancelling: 'Cancelling...',
  'interrupt-escalating': 'Escalating interrupt...',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
  respawning: 'Recovering session...',
  hibernating: 'Hibernating...',
  hibernated: 'Hibernated',
  waking: 'Waking up...',
  degraded: 'Degraded',
  error: 'Error',
  failed: 'Failed',
  terminated: 'Closed',
};

@Component({
  selector: 'app-status-indicator',
  standalone: true,
  template: `
    <div class="status-wrapper" [class.with-label]="showLabel()">
      @if (showSpinnerIndicator()) {
        <div
          class="status-spinner"
          role="img"
          [attr.aria-label]="label()"
          [style.--spinner-color]="color()"
          [title]="label()"
        ></div>
      } @else {
        <div
          class="status-indicator"
          role="img"
          [attr.aria-label]="label()"
          [style.backgroundColor]="color()"
          [class.pulsing]="isPulsing()"
          [class.background-waiting]="isBackgroundWaiting()"
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

    /* Idle, but still waiting on provider-owned background work. A slow
       halo in its own colour: not the busy spinner, not the amber pulse. */
    .status-indicator.background-waiting {
      box-shadow: 0 0 0 0 rgba(122, 162, 200, 0.6);
      animation: background-waiting 2.4s ease-out infinite;
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

    @keyframes background-waiting {
      0% {
        box-shadow: 0 0 0 0 rgba(122, 162, 200, 0.6);
      }
      70%, 100% {
        box-shadow: 0 0 0 6px rgba(122, 162, 200, 0);
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
  /** Live provider-owned background tasks; only changes the display while idle. */
  backgroundWorkCount = input<number>(0);

  /**
   * Idle between turns while the provider still owns background work. Checked
   * against settled statuses only, so a running turn keeps its spinner.
   */
  isBackgroundWaiting = computed(() =>
    this.backgroundWorkCount() > 0
    && (this.status() === 'idle' || this.status() === 'ready')
  );

  color = computed(() => this.isBackgroundWaiting() ? BACKGROUND_WAITING_COLOR : STATUS_COLORS[this.status()]);
  label = computed(() => this.isBackgroundWaiting() ? 'Waiting on background work' : STATUS_LABELS[this.status()]);
  visibleLabel = computed(() => this.label());

  isPulsing = computed(() =>
    this.status() === 'initializing' ||
    this.status() === 'respawning' ||
    this.status() === 'hibernating' ||
    this.status() === 'waking' ||
    this.status() === 'interrupting' ||
    this.status() === 'cancelling' ||
    this.status() === 'interrupt-escalating' ||
    // Waiting states are still "live" (waiting on the user, not dead) — a static
    // dot reads as stopped/finished. Pulse them so the difference from a truly
    // settled state (idle/ready) stays visible without reusing the busy spinner,
    // which would incorrectly imply the CLI itself is actively working.
    this.status() === 'waiting_for_input' ||
    this.status() === 'waiting_for_permission'
  );

  showSpinnerIndicator = computed(() =>
    this.status() === 'busy' ||
    this.status() === 'processing' ||
    this.status() === 'thinking_deeply' ||
    this.status() === 'interrupting' ||
    this.status() === 'cancelling' ||
    this.status() === 'interrupt-escalating'
  );
}
