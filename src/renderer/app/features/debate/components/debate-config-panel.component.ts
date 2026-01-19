/**
 * Debate Configuration Panel Component
 *
 * Adjust debate parameters from the UI:
 * - Number of agents
 * - Convergence threshold
 * - Max rounds
 * - Temperature range
 * - Human intervention toggle
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

export interface DebateConfig {
  agentCount: number;
  convergenceThreshold: number;
  maxRounds: number;
  temperatureMin: number;
  temperatureMax: number;
  enableHumanIntervention: boolean;
  timeout: number;
}

const DEFAULT_CONFIG: DebateConfig = {
  agentCount: 3,
  convergenceThreshold: 0.8,
  maxRounds: 4,
  temperatureMin: 0.3,
  temperatureMax: 0.9,
  enableHumanIntervention: false,
  timeout: 300000, // 5 minutes
};

@Component({
  selector: 'app-debate-config-panel',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="config-panel" [class.expanded]="isExpanded()">
      <div class="panel-header" (click)="toggleExpanded()">
        <div class="header-left">
          <span class="panel-icon">⚙️</span>
          <span class="panel-title">Debate Configuration</span>
        </div>
        <span class="expand-icon">{{ isExpanded() ? '▲' : '▼' }}</span>
      </div>

      @if (isExpanded()) {
        <div class="panel-content">
          <div class="config-grid">
            <!-- Agent Count -->
            <div class="config-item">
              <label class="config-label">
                Number of Agents
                <span class="config-hint">Debating participants</span>
              </label>
              <div class="config-control">
                <input
                  type="range"
                  class="range-input"
                  [ngModel]="localConfig().agentCount"
                  (ngModelChange)="updateConfig('agentCount', $event)"
                  min="2"
                  max="5"
                  step="1"
                />
                <span class="range-value">{{ localConfig().agentCount }}</span>
              </div>
            </div>

            <!-- Convergence Threshold -->
            <div class="config-item">
              <label class="config-label">
                Convergence Threshold
                <span class="config-hint">Consensus required to end early</span>
              </label>
              <div class="config-control">
                <input
                  type="range"
                  class="range-input"
                  [ngModel]="localConfig().convergenceThreshold"
                  (ngModelChange)="updateConfig('convergenceThreshold', $event)"
                  min="0.5"
                  max="0.95"
                  step="0.05"
                />
                <span class="range-value">{{ (localConfig().convergenceThreshold * 100).toFixed(0) }}%</span>
              </div>
            </div>

            <!-- Max Rounds -->
            <div class="config-item">
              <label class="config-label">
                Max Rounds
                <span class="config-hint">Maximum debate iterations</span>
              </label>
              <div class="config-control">
                <select
                  class="select-input"
                  [ngModel]="localConfig().maxRounds"
                  (ngModelChange)="updateConfig('maxRounds', $event)"
                >
                  <option [value]="3">3 (Quick)</option>
                  <option [value]="4">4 (Standard)</option>
                  <option [value]="5">5 (Thorough)</option>
                </select>
              </div>
            </div>

            <!-- Timeout -->
            <div class="config-item">
              <label class="config-label">
                Timeout
                <span class="config-hint">Max duration before cancellation</span>
              </label>
              <div class="config-control">
                <select
                  class="select-input"
                  [ngModel]="localConfig().timeout"
                  (ngModelChange)="updateConfig('timeout', $event)"
                >
                  <option [value]="120000">2 minutes</option>
                  <option [value]="300000">5 minutes</option>
                  <option [value]="600000">10 minutes</option>
                </select>
              </div>
            </div>

            <!-- Temperature Range -->
            <div class="config-item full-width">
              <label class="config-label">
                Temperature Range
                <span class="config-hint">Response diversity ({{ localConfig().temperatureMin.toFixed(1) }} - {{ localConfig().temperatureMax.toFixed(1) }})</span>
              </label>
              <div class="config-control dual-slider">
                <span class="range-label">Min</span>
                <input
                  type="range"
                  class="range-input"
                  [ngModel]="localConfig().temperatureMin"
                  (ngModelChange)="updateConfig('temperatureMin', $event)"
                  min="0.1"
                  max="0.8"
                  step="0.1"
                />
                <span class="range-label">Max</span>
                <input
                  type="range"
                  class="range-input"
                  [ngModel]="localConfig().temperatureMax"
                  (ngModelChange)="updateConfig('temperatureMax', $event)"
                  min="0.5"
                  max="1.0"
                  step="0.1"
                />
              </div>
            </div>

            <!-- Human Intervention -->
            <div class="config-item full-width">
              <label class="config-label checkbox-label">
                <input
                  type="checkbox"
                  class="checkbox-input"
                  [ngModel]="localConfig().enableHumanIntervention"
                  (ngModelChange)="updateConfig('enableHumanIntervention', $event)"
                />
                <span class="checkbox-custom"></span>
                <span class="checkbox-text">
                  Enable Human Review Between Rounds
                  <span class="config-hint">Pause for approval after each round</span>
                </span>
              </label>
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
      gap: 6px;

      &.full-width {
        grid-column: 1 / -1;
      }
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

      &.dual-slider {
        flex-wrap: wrap;
      }
    }

    .range-input {
      flex: 1;
      height: 4px;
      -webkit-appearance: none;
      background: var(--bg-secondary);
      border-radius: 2px;

      &::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--primary-color);
        cursor: pointer;
        transition: transform var(--transition-fast);

        &:hover {
          transform: scale(1.1);
        }
      }
    }

    .range-value {
      min-width: 32px;
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-primary);
      text-align: right;
    }

    .range-label {
      font-size: 9px;
      color: var(--text-muted);
      min-width: 24px;
    }

    .select-input {
      flex: 1;
      padding: 6px 8px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 11px;

      &:focus {
        outline: none;
        border-color: var(--primary-color);
      }
    }

    .checkbox-label {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-sm);
      cursor: pointer;
    }

    .checkbox-input {
      display: none;
    }

    .checkbox-custom {
      width: 16px;
      height: 16px;
      border: 2px solid var(--border-color);
      border-radius: var(--radius-sm);
      flex-shrink: 0;
      transition: all var(--transition-fast);
      position: relative;

      &::after {
        content: '✓';
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: white;
        opacity: 0;
        transform: scale(0);
        transition: all var(--transition-fast);
      }
    }

    .checkbox-input:checked + .checkbox-custom {
      background: var(--primary-color);
      border-color: var(--primary-color);

      &::after {
        opacity: 1;
        transform: scale(1);
      }
    }

    .checkbox-text {
      flex: 1;
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
export class DebateConfigPanelComponent {
  /** Current config from parent */
  config = input<DebateConfig>(DEFAULT_CONFIG);

  /** Config change event */
  configChange = output<DebateConfig>();

  /** Panel expanded state */
  isExpanded = signal<boolean>(false);

  /** Local config for editing */
  localConfig = signal<DebateConfig>({ ...DEFAULT_CONFIG });

  constructor() {
    effect(() => {
      const inputConfig = this.config();
      this.localConfig.set({ ...inputConfig });
    }, { allowSignalWrites: true });
  }

  toggleExpanded(): void {
    this.isExpanded.update(v => !v);
  }

  updateConfig<K extends keyof DebateConfig>(key: K, value: DebateConfig[K]): void {
    this.localConfig.update(config => ({
      ...config,
      [key]: typeof value === 'string' ? parseFloat(value) || value : value,
    }));
  }

  hasChanges(): boolean {
    const current = this.localConfig();
    const original = this.config();

    return Object.keys(current).some(
      key => current[key as keyof DebateConfig] !== original[key as keyof DebateConfig]
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
