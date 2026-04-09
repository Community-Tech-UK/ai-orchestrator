/**
 * Activity Status Component
 *
 * Displays the current activity status with a processing spinner and elapsed time.
 * Shows tool-aware messages like "Gathering context" or "Making edits",
 * orchestration activity like "Spawning child: reviewer", and elapsed time.
 */

import {
  Component,
  input,
  computed,
  signal,
  ChangeDetectionStrategy,
  OnDestroy,
  effect,
} from '@angular/core';
import { ProcessingSpinnerComponent } from './processing-spinner.component';
import { InstanceStatus } from '../../core/state/instance.store';

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

@Component({
  selector: 'app-activity-status',
  standalone: true,
  imports: [ProcessingSpinnerComponent],
  template: `
    @if (isActive()) {
      <div class="activity-status">
        <app-processing-spinner />
        <span class="activity-text">{{ displayText() }}</span>
        @if (elapsedText()) {
          <span class="elapsed-time">{{ elapsedText() }}</span>
        }
      </div>
    }
  `,
  styles: [`
    .activity-status {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
      background: var(--bg-tertiary, #1a1a2e);
      border-radius: var(--radius-md, 8px);
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
      height: 36px;
    }

    .activity-text {
      font-size: 13px;
      color: var(--text-secondary, #a0a0a0);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 18px;
    }

    .elapsed-time {
      font-size: 12px;
      color: var(--text-tertiary, #666);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActivityStatusComponent implements OnDestroy {
  /** Current instance status */
  status = input.required<InstanceStatus>();

  /** Debounced activity text from store */
  activity = input<string>('');

  /** Timestamp when the instance became busy (for elapsed time) */
  busySince = input<number | undefined>(undefined);

  /** Whether to show the activity status */
  isActive = computed(() => {
    const s = this.status();
    return s === 'busy' || s === 'processing' || s === 'thinking_deeply' || s === 'initializing';
  });

  /** Text to display */
  displayText = computed(() => {
    const activity = this.activity();
    if (activity) {
      return activity;
    }

    // Fallback based on status
    const s = this.status();
    switch (s) {
      case 'initializing':
        return 'Initializing...';
      case 'busy':
        return 'Processing...';
      default:
        return '';
    }
  });

  /** Elapsed time display text */
  elapsedText = computed(() => {
    const since = this.busySince();
    const tick = this._tick();
    if (!since || !this.isActive() || tick < 0) return '';

    const elapsed = Date.now() - since;
    // Only show after 3 seconds to avoid flashing for quick operations
    if (elapsed < 3000) return '';
    return formatElapsed(elapsed);
  });

  // Internal tick signal that forces re-computation every second
  private _tick = signal(0);
  private _timerHandle: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Start/stop the timer based on active state
    effect(() => {
      const active = this.isActive();
      if (active && !this._timerHandle) {
        this._tick.set(Date.now());
        this._timerHandle = setInterval(() => {
          this._tick.set(Date.now());
        }, 1000);
      } else if (!active && this._timerHandle) {
        clearInterval(this._timerHandle);
        this._timerHandle = null;
        this._tick.set(-1);
      }
    });
  }

  ngOnDestroy(): void {
    if (this._timerHandle) {
      clearInterval(this._timerHandle);
      this._timerHandle = null;
    }
  }
}
