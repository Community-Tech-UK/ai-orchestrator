/**
 * Activity Status Component
 *
 * Displays the current activity status with a processing spinner.
 * Shows tool-aware messages like "Gathering context" or "Making edits".
 */

import {
  Component,
  input,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ProcessingSpinnerComponent } from './processing-spinner.component';
import { InstanceStatus } from '../../core/state/instance.store';

@Component({
  selector: 'app-activity-status',
  standalone: true,
  imports: [ProcessingSpinnerComponent],
  template: `
    @if (isActive()) {
      <div class="activity-status">
        <app-processing-spinner />
        <span class="activity-text">{{ displayText() }}</span>
      </div>
    }
  `,
  styles: [`
    .activity-status {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
      background: var(--bg-tertiary, #1a1a2e);
      border-radius: var(--radius-md, 8px);
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    }

    .activity-text {
      font-size: 13px;
      color: var(--text-secondary, #a0a0a0);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActivityStatusComponent {
  /** Current instance status */
  status = input.required<InstanceStatus>();

  /** Debounced activity text from store */
  activity = input<string>('');

  /** Whether to show the activity status */
  isActive = computed(() => {
    const s = this.status();
    return s === 'busy' || s === 'initializing';
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
}
