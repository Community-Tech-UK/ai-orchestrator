/**
 * Confidence Meter Component
 *
 * Displays confidence score (0-100%) with visual meter:
 * - Animated fill
 * - Color-coded levels (low/medium/high)
 * - Optional percentage label
 * - Multiple size variants
 */

import {
  Component,
  input,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { ConfidenceThresholds, ConfidenceDisplayOptions } from '../../../../../shared/types/verification-ui.types';

const DEFAULT_THRESHOLDS: ConfidenceThresholds = {
  low: 0.4,
  high: 0.75,
};

@Component({
  selector: 'app-confidence-meter',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="confidence-meter"
      [class.small]="options().size === 'small'"
      [class.large]="options().size === 'large'"
      [class.animate]="options().animate"
    >
      <!-- Meter Bar -->
      <div class="meter-container">
        <div
          class="meter-fill"
          [class.low]="level() === 'low'"
          [class.medium]="level() === 'medium'"
          [class.high]="level() === 'high'"
          [style.width.%]="percentage()"
        ></div>
        <div class="meter-markers">
          <div class="marker" [style.left.%]="thresholds().low * 100"></div>
          <div class="marker" [style.left.%]="thresholds().high * 100"></div>
        </div>
      </div>

      <!-- Labels -->
      <div class="meter-labels">
        @if (options().showPercentage) {
          <span
            class="percentage"
            [class.low]="level() === 'low'"
            [class.medium]="level() === 'medium'"
            [class.high]="level() === 'high'"
          >
            {{ percentage().toFixed(0) }}%
          </span>
        }

        @if (options().showLabel) {
          <span
            class="level-label"
            [class.low]="level() === 'low'"
            [class.medium]="level() === 'medium'"
            [class.high]="level() === 'high'"
          >
            {{ levelLabel() }}
          </span>
        }
      </div>
    </div>
  `,
  styles: [`
    .confidence-meter {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    /* Meter Container */
    .meter-container {
      position: relative;
      height: 8px;
      background: var(--bg-tertiary, #262626);
      border-radius: 4px;
      overflow: hidden;
    }

    .confidence-meter.small .meter-container {
      height: 4px;
    }

    .confidence-meter.large .meter-container {
      height: 12px;
    }

    /* Meter Fill */
    .meter-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.5s ease;
    }

    .confidence-meter.animate .meter-fill {
      transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .meter-fill.low {
      background: linear-gradient(90deg, #ef4444, #f87171);
    }

    .meter-fill.medium {
      background: linear-gradient(90deg, #f59e0b, #fbbf24);
    }

    .meter-fill.high {
      background: linear-gradient(90deg, #22c55e, #4ade80);
    }

    /* Markers */
    .meter-markers {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
    }

    .marker {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 1px;
      background: var(--bg-primary, #0a0a0a);
      opacity: 0.3;
    }

    /* Labels */
    .meter-labels {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .percentage {
      font-size: 14px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }

    .confidence-meter.small .percentage {
      font-size: 12px;
    }

    .confidence-meter.large .percentage {
      font-size: 18px;
    }

    .percentage.low {
      color: #ef4444;
    }

    .percentage.medium {
      color: #f59e0b;
    }

    .percentage.high {
      color: #22c55e;
    }

    .level-label {
      font-size: 12px;
      font-weight: 600;
    }

    .confidence-meter.small .level-label {
      font-size: 10px;
    }

    .confidence-meter.large .level-label {
      font-size: 14px;
    }

    .level-label.low {
      color: #ef4444;
    }

    .level-label.medium {
      color: #f59e0b;
    }

    .level-label.high {
      color: #22c55e;
    }
  `],
})
export class ConfidenceMeterComponent {
  // Inputs
  value = input.required<number>(); // 0-1
  options = input<ConfidenceDisplayOptions>({
    showPercentage: true,
    showLabel: true,
    animate: true,
    size: 'medium',
  });

  // Computed
  thresholds = computed((): ConfidenceThresholds => {
    return this.options().thresholds || DEFAULT_THRESHOLDS;
  });

  percentage = computed(() => {
    return Math.min(100, Math.max(0, this.value() * 100));
  });

  level = computed((): 'low' | 'medium' | 'high' => {
    const val = this.value();
    const thresh = this.thresholds();

    if (val < thresh.low) return 'low';
    if (val >= thresh.high) return 'high';
    return 'medium';
  });

  levelLabel = computed(() => {
    const lvl = this.level();
    switch (lvl) {
      case 'low': return 'Low';
      case 'medium': return 'Medium';
      case 'high': return 'High';
    }
  });
}
