/**
 * GRPO Configuration Panel Component
 *
 * Adjust GRPO hyperparameters from the UI:
 * - Group size, learning rate, clip epsilon
 * - Entropy coefficient, value coefficient
 * - Min samples for training
 * - Reset to defaults functionality
 */

import {
  Component,
  input,
  output,
  signal,
  effect,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface GRPOConfig {
  groupSize: number;
  learningRate: number;
  clipEpsilon: number;
  entropyCoef: number;
  valueCoef: number;
  minSamplesForTraining: number;
}

const DEFAULT_CONFIG: GRPOConfig = {
  groupSize: 8,
  learningRate: 0.001,
  clipEpsilon: 0.2,
  entropyCoef: 0.01,
  valueCoef: 0.5,
  minSamplesForTraining: 32,
};

@Component({
  selector: 'app-grpo-config-panel',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="config-panel" [class.expanded]="isExpanded()">
      <div class="panel-header" (click)="toggleExpanded()">
        <div class="header-left">
          <span class="panel-icon">⚙️</span>
          <span class="panel-title">GRPO Configuration</span>
        </div>
        <span class="expand-icon">{{ isExpanded() ? '▲' : '▼' }}</span>
      </div>

      @if (isExpanded()) {
        <div class="panel-content">
          <div class="config-grid">
            <!-- Group Size -->
            <div class="config-item">
              <label class="config-label">
                Group Size
                <span class="config-hint">Outcomes per advantage group</span>
              </label>
              <div class="config-control">
                <input
                  type="number"
                  class="config-input"
                  [ngModel]="localConfig().groupSize"
                  (ngModelChange)="updateConfig('groupSize', $event)"
                  min="2"
                  max="32"
                  step="1"
                />
                <span class="config-default">(default: {{ defaults.groupSize }})</span>
              </div>
            </div>

            <!-- Learning Rate -->
            <div class="config-item">
              <label class="config-label">
                Learning Rate
                <span class="config-hint">Policy update rate</span>
              </label>
              <div class="config-control">
                <input
                  type="number"
                  class="config-input"
                  [ngModel]="localConfig().learningRate"
                  (ngModelChange)="updateConfig('learningRate', $event)"
                  min="0.0001"
                  max="0.1"
                  step="0.0001"
                />
                <span class="config-default">(default: {{ defaults.learningRate }})</span>
              </div>
            </div>

            <!-- Clip Epsilon -->
            <div class="config-item">
              <label class="config-label">
                Clip Epsilon
                <span class="config-hint">PPO-style clipping</span>
              </label>
              <div class="config-control">
                <input
                  type="number"
                  class="config-input"
                  [ngModel]="localConfig().clipEpsilon"
                  (ngModelChange)="updateConfig('clipEpsilon', $event)"
                  min="0.1"
                  max="0.5"
                  step="0.01"
                />
                <span class="config-default">(default: {{ defaults.clipEpsilon }})</span>
              </div>
            </div>

            <!-- Entropy Coefficient -->
            <div class="config-item">
              <label class="config-label">
                Entropy Coefficient
                <span class="config-hint">Exploration bonus</span>
              </label>
              <div class="config-control">
                <input
                  type="number"
                  class="config-input"
                  [ngModel]="localConfig().entropyCoef"
                  (ngModelChange)="updateConfig('entropyCoef', $event)"
                  min="0"
                  max="0.1"
                  step="0.001"
                />
                <span class="config-default">(default: {{ defaults.entropyCoef }})</span>
              </div>
            </div>

            <!-- Value Coefficient -->
            <div class="config-item">
              <label class="config-label">
                Value Coefficient
                <span class="config-hint">Value loss weight</span>
              </label>
              <div class="config-control">
                <input
                  type="number"
                  class="config-input"
                  [ngModel]="localConfig().valueCoef"
                  (ngModelChange)="updateConfig('valueCoef', $event)"
                  min="0.1"
                  max="1"
                  step="0.1"
                />
                <span class="config-default">(default: {{ defaults.valueCoef }})</span>
              </div>
            </div>

            <!-- Min Samples -->
            <div class="config-item">
              <label class="config-label">
                Min Samples for Training
                <span class="config-hint">Minimum outcomes before training</span>
              </label>
              <div class="config-control">
                <input
                  type="number"
                  class="config-input"
                  [ngModel]="localConfig().minSamplesForTraining"
                  (ngModelChange)="updateConfig('minSamplesForTraining', $event)"
                  min="8"
                  max="256"
                  step="8"
                />
                <span class="config-default">(default: {{ defaults.minSamplesForTraining }})</span>
              </div>
            </div>
          </div>

          <div class="config-actions">
            <button
              class="action-btn secondary"
              (click)="resetToDefaults()"
              [disabled]="!hasChanges()"
            >
              Reset to Defaults
            </button>
            <button
              class="action-btn primary"
              (click)="applyChanges()"
              [disabled]="!hasChanges()"
            >
              Apply Changes
            </button>
          </div>

          @if (hasChanges()) {
            <div class="changes-indicator">
              <span class="indicator-dot"></span>
              Unsaved changes
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .config-panel {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm) var(--spacing-md);
      cursor: pointer;
      transition: background var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .panel-icon {
      font-size: 14px;
    }

    .panel-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .expand-icon {
      font-size: 10px;
      color: var(--text-muted);
    }

    .panel-content {
      padding: var(--spacing-md);
      border-top: 1px solid var(--border-color);
    }

    .config-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }

    .config-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .config-label {
      font-size: 11px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .config-hint {
      display: block;
      font-size: 9px;
      font-weight: 400;
      color: var(--text-muted);
    }

    .config-control {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .config-input {
      width: 100px;
      padding: 6px 8px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 11px;
      font-family: var(--font-mono);

      &:focus {
        outline: none;
        border-color: var(--primary-color);
      }

      &::-webkit-inner-spin-button,
      &::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
    }

    .config-default {
      font-size: 9px;
      color: var(--text-muted);
    }

    .config-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--spacing-sm);
    }

    .action-btn {
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.secondary {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        color: var(--text-primary);

        &:hover:not(:disabled) {
          background: var(--bg-hover);
        }
      }

      &.primary {
        background: var(--primary-color);
        border: 1px solid var(--primary-color);
        color: white;

        &:hover:not(:disabled) {
          filter: brightness(1.1);
        }
      }
    }

    .changes-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: var(--spacing-sm);
      font-size: 10px;
      color: #f59e0b;
    }

    .indicator-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #f59e0b;
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GrpoConfigPanelComponent {
  /** Current config from parent */
  config = input<GRPOConfig>(DEFAULT_CONFIG);

  /** Config change event */
  configChange = output<GRPOConfig>();

  /** Panel expanded state */
  isExpanded = signal<boolean>(false);

  /** Local config for editing */
  localConfig = signal<GRPOConfig>({ ...DEFAULT_CONFIG });

  /** Default config values */
  defaults = DEFAULT_CONFIG;

  constructor() {
    // Sync local config with input
    effect(() => {
      const inputConfig = this.config();
      this.localConfig.set({ ...inputConfig });
    }, { allowSignalWrites: true });
  }

  toggleExpanded(): void {
    this.isExpanded.update(v => !v);
  }

  updateConfig<K extends keyof GRPOConfig>(key: K, value: GRPOConfig[K]): void {
    this.localConfig.update(config => ({
      ...config,
      [key]: value,
    }));
  }

  hasChanges(): boolean {
    const current = this.localConfig();
    const original = this.config();

    return Object.keys(current).some(
      key => current[key as keyof GRPOConfig] !== original[key as keyof GRPOConfig]
    );
  }

  resetToDefaults(): void {
    this.localConfig.set({ ...DEFAULT_CONFIG });
    this.configChange.emit({ ...DEFAULT_CONFIG });
  }

  applyChanges(): void {
    this.configChange.emit({ ...this.localConfig() });
  }
}
