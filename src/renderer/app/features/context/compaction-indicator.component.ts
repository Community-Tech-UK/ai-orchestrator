/**
 * Compaction Indicator Component
 *
 * Phase 7 UI/UX Improvement: Visual indicator for context compaction status
 * - Progress bar with color coding (green/yellow/orange/red)
 * - Tooltip with current usage and thresholds
 * - Expandable details showing tier distribution
 */

import { ChangeDetectionStrategy, Component, signal, effect, computed, input, output } from '@angular/core';
import { LIMITS } from '../../../../shared/constants/limits';
import { CommonModule } from '@angular/common';

interface ElectronAPI {
  compactionGetStatus?: (params: { instanceId: string | undefined }) => Promise<{ success: boolean; data: CompactionStatus }>;
  compactionTrigger?: (params: { instanceId: string | undefined }) => Promise<{ success: boolean }>;
}

// Helper to access API from preload
const getApi = () => (window as unknown as { electronAPI: ElectronAPI }).electronAPI;

export interface CompactionStatus {
  /** Current token usage */
  currentTokens: number;
  /** Maximum token limit */
  maxTokens: number;
  /** Usage percentage (0-100) */
  usagePercent: number;
  /** Warning threshold percentage */
  warningThreshold: number;
  /** Emergency threshold percentage */
  emergencyThreshold: number;
  /** Whether compaction is currently running */
  isCompacting: boolean;
  /** Last compaction timestamp */
  lastCompactionAt?: number;
  /** Tier distribution */
  tierDistribution: {
    full: number;
    section: number;
    keyDecisions: number;
    minimal: number;
  };
  /** Recent compaction metrics */
  metrics?: {
    compressionRatio: number;
    informationRetention: number;
    tokensBefore: number;
    tokensAfter: number;
    itemsCompacted: number;
    itemsPreserved: number;
  };
}

@Component({
  selector: 'app-compaction-indicator',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="compaction-indicator"
      [class.warning]="status().usagePercent >= status().warningThreshold"
      [class.danger]="status().usagePercent >= status().emergencyThreshold"
      [class.expanded]="expanded()"
      (mouseenter)="showTooltip.set(true)"
      (mouseleave)="showTooltip.set(false)"
    >
      <!-- Compact view -->
      <div
        class="compact-view"
        (click)="toggleExpanded()"
        (keydown.enter)="toggleExpanded()"
        (keydown.space)="toggleExpanded()"
        tabindex="0"
        role="button"
        [attr.aria-expanded]="expanded()"
        aria-label="Toggle compaction indicator details"
      >
        <div class="progress-container">
          <div class="progress-bar">
            <div
              class="progress-fill"
              [style.width.%]="status().usagePercent"
              [class.warning]="status().usagePercent >= status().warningThreshold"
              [class.danger]="status().usagePercent >= status().emergencyThreshold"
            ></div>
            @if (status().warningThreshold < 100) {
              <div
                class="threshold-marker warning"
                [style.left.%]="status().warningThreshold"
              ></div>
            }
            @if (status().emergencyThreshold < 100) {
              <div
                class="threshold-marker danger"
                [style.left.%]="status().emergencyThreshold"
              ></div>
            }
          </div>
        </div>

        <div class="usage-text">
          <span class="current">{{ formatTokens(status().currentTokens) }}</span>
          <span class="separator">/</span>
          <span class="max">{{ formatTokens(status().maxTokens) }}</span>
        </div>

        @if (status().isCompacting) {
          <div class="compacting-indicator" title="Compacting...">
            <span class="spinner"></span>
          </div>
        }
      </div>

      <!-- Tooltip -->
      @if (showTooltip() && !expanded()) {
        <div class="tooltip">
          <div class="tooltip-row">
            <span class="tooltip-label">Usage</span>
            <span class="tooltip-value">
              {{ status().usagePercent.toFixed(1) }}%
            </span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">Warning at</span>
            <span class="tooltip-value">{{ status().warningThreshold }}%</span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">Emergency at</span>
            <span class="tooltip-value">{{ status().emergencyThreshold }}%</span>
          </div>
          @if (status().lastCompactionAt) {
            <div class="tooltip-row">
              <span class="tooltip-label">Last compaction</span>
              <span class="tooltip-value">{{ formatTime(status().lastCompactionAt) }}</span>
            </div>
          }
        </div>
      }

      <!-- Expanded view -->
      @if (expanded()) {
        <div class="expanded-view">
          <!-- Tier distribution -->
          <div class="tier-section">
            <div class="section-header">
              <span>Content Distribution</span>
            </div>
            <div class="tier-bars">
              <div class="tier-bar">
                <div class="tier-label">Full</div>
                <div class="tier-progress">
                  <div
                    class="tier-fill full"
                    [style.width.%]="tierPercent('full')"
                  ></div>
                </div>
                <div class="tier-count">{{ status().tierDistribution.full }}</div>
              </div>
              <div class="tier-bar">
                <div class="tier-label">Section</div>
                <div class="tier-progress">
                  <div
                    class="tier-fill section"
                    [style.width.%]="tierPercent('section')"
                  ></div>
                </div>
                <div class="tier-count">{{ status().tierDistribution.section }}</div>
              </div>
              <div class="tier-bar">
                <div class="tier-label">Key Decisions</div>
                <div class="tier-progress">
                  <div
                    class="tier-fill key-decisions"
                    [style.width.%]="tierPercent('keyDecisions')"
                  ></div>
                </div>
                <div class="tier-count">{{ status().tierDistribution.keyDecisions }}</div>
              </div>
              <div class="tier-bar">
                <div class="tier-label">Minimal</div>
                <div class="tier-progress">
                  <div
                    class="tier-fill minimal"
                    [style.width.%]="tierPercent('minimal')"
                  ></div>
                </div>
                <div class="tier-count">{{ status().tierDistribution.minimal }}</div>
              </div>
            </div>
          </div>

          <!-- Last compaction metrics -->
          @if (status().metrics) {
            <div class="metrics-section">
              <div class="section-header">
                <span>Last Compaction</span>
              </div>
              <div class="metrics-grid">
                <div class="metric">
                  <div class="metric-value">
                    {{ (status().metrics!.compressionRatio * 100).toFixed(0) }}%
                  </div>
                  <div class="metric-label">Compression</div>
                </div>
                <div class="metric">
                  <div class="metric-value">
                    {{ (status().metrics!.informationRetention * 100).toFixed(0) }}%
                  </div>
                  <div class="metric-label">Retention</div>
                </div>
                <div class="metric">
                  <div class="metric-value">{{ status().metrics!.itemsCompacted }}</div>
                  <div class="metric-label">Compacted</div>
                </div>
                <div class="metric">
                  <div class="metric-value">{{ status().metrics!.itemsPreserved }}</div>
                  <div class="metric-label">Preserved</div>
                </div>
              </div>
              <div class="token-change">
                {{ formatTokens(status().metrics!.tokensBefore) }}
                &rarr;
                {{ formatTokens(status().metrics!.tokensAfter) }}
                <span class="saved">
                  (-{{ formatTokens(status().metrics!.tokensBefore - status().metrics!.tokensAfter) }})
                </span>
              </div>
            </div>
          }

          <!-- Actions -->
          <div class="actions">
            <button
              class="btn-compact"
              (click)="triggerCompaction()"
              [disabled]="status().isCompacting || status().usagePercent < 50"
            >
              @if (status().isCompacting) {
                Compacting...
              } @else {
                Compact Now
              }
            </button>
            <button class="btn-refresh" (click)="loadStatus()">
              Refresh
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .compaction-indicator {
        position: relative;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        overflow: visible;

        &.warning {
          border-color: var(--warning-color);
        }

        &.danger {
          border-color: var(--error-color);
        }
      }

      .compact-view {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        cursor: pointer;
      }

      .progress-container {
        flex: 1;
        min-width: 60px;
      }

      .progress-bar {
        position: relative;
        height: 6px;
        background: var(--bg-tertiary);
        border-radius: 3px;
        overflow: visible;
      }

      .progress-fill {
        height: 100%;
        background: var(--success-color);
        border-radius: 3px;
        transition: width 0.3s ease, background 0.3s ease;

        &.warning {
          background: var(--warning-color);
        }

        &.danger {
          background: var(--error-color);
        }
      }

      .threshold-marker {
        position: absolute;
        top: -2px;
        width: 2px;
        height: 10px;
        transform: translateX(-50%);

        &.warning {
          background: var(--warning-color);
        }

        &.danger {
          background: var(--error-color);
        }
      }

      .usage-text {
        font-size: 11px;
        font-family: monospace;
        white-space: nowrap;

        .current {
          color: var(--text-primary);
        }

        .separator {
          color: var(--text-muted);
          margin: 0 2px;
        }

        .max {
          color: var(--text-secondary);
        }
      }

      .compacting-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .spinner {
        width: 12px;
        height: 12px;
        border: 2px solid var(--bg-tertiary);
        border-top-color: var(--primary-color);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .tooltip {
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        margin-bottom: 8px;
        padding: var(--spacing-sm);
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        box-shadow: 0 4px 12px var(--overlay-dark-light);
        z-index: 100;
        min-width: 150px;

        &::after {
          content: '';
          position: absolute;
          top: 100%;
          left: 50%;
          transform: translateX(-50%);
          border: 6px solid transparent;
          border-top-color: var(--border-color);
        }
      }

      .tooltip-row {
        display: flex;
        justify-content: space-between;
        gap: var(--spacing-md);
        font-size: 11px;

        &:not(:last-child) {
          margin-bottom: 4px;
        }
      }

      .tooltip-label {
        color: var(--text-muted);
      }

      .tooltip-value {
        color: var(--text-primary);
        font-weight: 500;
      }

      .expanded-view {
        border-top: 1px solid var(--border-color);
        padding: var(--spacing-sm);
      }

      .section-header {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.03em;
        margin-bottom: var(--spacing-xs);
      }

      .tier-section {
        margin-bottom: var(--spacing-md);
      }

      .tier-bars {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .tier-bar {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .tier-label {
        font-size: 10px;
        color: var(--text-muted);
        width: 80px;
        flex-shrink: 0;
      }

      .tier-progress {
        flex: 1;
        height: 4px;
        background: var(--bg-tertiary);
        border-radius: 2px;
        overflow: hidden;
      }

      .tier-fill {
        height: 100%;
        border-radius: 2px;
        transition: width 0.3s ease;

        &.full {
          background: var(--primary-color);
        }

        &.section {
          background: var(--success-color);
        }

        &.key-decisions {
          background: var(--warning-color);
        }

        &.minimal {
          background: var(--error-color);
        }
      }

      .tier-count {
        font-size: 10px;
        font-family: monospace;
        color: var(--text-muted);
        width: 30px;
        text-align: right;
      }

      .metrics-section {
        margin-bottom: var(--spacing-md);
      }

      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--spacing-xs);
        margin-bottom: var(--spacing-xs);
      }

      .metric {
        text-align: center;
        padding: var(--spacing-xs);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
      }

      .metric-value {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .metric-label {
        font-size: 9px;
        color: var(--text-muted);
      }

      .token-change {
        text-align: center;
        font-size: 11px;
        color: var(--text-secondary);
        font-family: monospace;

        .saved {
          color: var(--success-color);
        }
      }

      .actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .btn-compact,
      .btn-refresh {
        flex: 1;
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: all var(--transition-fast);
        border: 1px solid transparent;
      }

      .btn-compact {
        background: var(--primary-color);
        color: white;

        &:hover:not(:disabled) {
          filter: brightness(1.1);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .btn-refresh {
        background: var(--bg-tertiary);
        border-color: var(--border-color);
        color: var(--text-primary);

        &:hover {
          background: var(--bg-primary);
        }
      }
    `,
  ],
})
export class CompactionIndicatorComponent {
  instanceId = input<string>();
  compactionTriggered = output<void>();

  expanded = signal(false);
  showTooltip = signal(false);

  status = signal<CompactionStatus>({
    currentTokens: 0,
    maxTokens: LIMITS.DEFAULT_MAX_CONTEXT_TOKENS,
    usagePercent: 0,
    warningThreshold: 80,
    emergencyThreshold: 95,
    isCompacting: false,
    tierDistribution: {
      full: 0,
      section: 0,
      keyDecisions: 0,
      minimal: 0,
    },
  });

  private initialized = false;

  constructor() {
    effect(() => {
      if (!this.initialized) {
        this.initialized = true;
        void this.loadStatus();
      }
    });
  }

  totalTierItems = computed(() => {
    const dist = this.status().tierDistribution;
    return dist.full + dist.section + dist.keyDecisions + dist.minimal;
  });

  tierPercent(tier: keyof CompactionStatus['tierDistribution']): number {
    const total = this.totalTierItems();
    if (total === 0) return 0;
    return (this.status().tierDistribution[tier] / total) * 100;
  }

  toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  async loadStatus(): Promise<void> {
    const api = getApi();
    if (!api?.compactionGetStatus) return;

    try {
      const response = await api.compactionGetStatus({
        instanceId: this.instanceId(),
      });
      if (response.success) {
        this.status.set(response.data);
      }
    } catch (error) {
      console.error('Failed to load compaction status:', error);
    }
  }

  async triggerCompaction(): Promise<void> {
    const api = getApi();
    if (!api?.compactionTrigger) return;

    this.status.update((s) => ({ ...s, isCompacting: true }));

    try {
      const response = await api.compactionTrigger({
        instanceId: this.instanceId(),
      });
      if (response.success) {
        this.compactionTriggered.emit();
        // Reload status after a short delay
        setTimeout(() => void this.loadStatus(), 1000);
      }
    } catch (error) {
      console.error('Failed to trigger compaction:', error);
    } finally {
      this.status.update((s) => ({ ...s, isCompacting: false }));
    }
  }

  formatTokens(count: number): string {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M';
    }
    if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'k';
    }
    return count.toString();
  }

  formatTime(timestamp: number | undefined): string {
    if (!timestamp) return 'Never';

    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
