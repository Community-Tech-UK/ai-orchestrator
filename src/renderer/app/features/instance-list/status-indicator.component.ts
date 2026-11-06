/**
 * Status Indicator Component - Visual status dot with color and animation
 */

import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import { InstanceStatus } from '../../core/state/instance.store';
import type { InstanceWaitReason } from '../../../../shared/types/instance-wait-reason.types';
import {
  describeInstanceStatus,
  presentInstanceStatus,
} from '../../../../shared/attention/instance-status-presentation';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';

@Component({
  selector: 'app-status-indicator',
  standalone: true,
  imports: [AioTooltipDirective],
  template: `
    <div class="status-wrapper" [class.with-label]="showLabel()">
      @if (showSpinnerIndicator()) {
        <div
          class="status-spinner"
          role="img"
          [attr.aria-label]="label()"
          [style.--spinner-color]="color()"
          [appTooltip]="label()"
          [appTooltipDisabled]="showLabel()"
          [attr.tabindex]="showLabel() ? null : 0"
        ></div>
      } @else {
        <div
          class="status-indicator"
          role="img"
          [attr.aria-label]="label()"
          [style.backgroundColor]="color()"
          [class.pulsing]="isPulsing()"
          [class.background-waiting]="isBackgroundWaiting()"
          [appTooltip]="label()"
          [appTooltipDisabled]="showLabel()"
          [attr.tabindex]="showLabel() ? null : 0"
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
   * Why the session is waiting, when it is. A session parked on a usage limit
   * or signed out is `idle` by status, so only this makes the dot say so.
   */
  waitReason = input<InstanceWaitReason | null | undefined>(null);

  /** Words, colour and dot behaviour all come from the one status presenter. */
  private readonly presentation = computed(() => presentInstanceStatus(
    this.status(),
    this.waitReason(),
    { backgroundWorkCount: this.backgroundWorkCount() },
  ));

  /**
   * Idle between turns while the provider still owns background work. The
   * presenter only reports this for settled statuses, so a running turn keeps
   * its spinner.
   */
  isBackgroundWaiting = computed(() => this.presentation().tone === 'background');

  color = computed(() => this.presentation().color);
  /** The accessible name and the tooltip: one string. */
  label = computed(() => describeInstanceStatus(this.presentation()));
  visibleLabel = computed(() => this.presentation().label);

  // Waiting states are still "live" (waiting on the user, not dead) — a static
  // dot reads as stopped/finished, so the presenter pulses them. That keeps the
  // difference from a truly settled state (idle/ready) visible without reusing
  // the busy spinner, which would imply the CLI itself is actively working.
  isPulsing = computed(() => this.presentation().pulse);

  showSpinnerIndicator = computed(() => this.presentation().spinner);
}
