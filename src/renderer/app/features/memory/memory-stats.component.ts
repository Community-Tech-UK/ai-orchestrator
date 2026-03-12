/**
 * Memory Stats Component
 *
 * Memory system statistics dashboard:
 * - Total entries count
 * - Token usage breakdown
 * - Operation history
 * - Eviction activity
 * - Storage efficiency metrics
 */

import {
  Component,
  input,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';

interface MemoryStats {
  totalEntries: number;
  entriesByType: Record<string, number>;
  tokenUsage: {
    shortTerm: number;
    longTerm: number;
    total: number;
    limit: number;
  };
  operations: {
    adds: number;
    updates: number;
    deletes: number;
    noops: number;
  };
  evictions: {
    total: number;
    recent: number;
    byReason: Record<string, number>;
  };
  retention: {
    crossSession: number;
    avgLifespan: number;
  };
}

@Component({
  selector: 'app-memory-stats',
  standalone: true,
  template: `
    <div class="stats-container">
      <!-- Header -->
      <div class="stats-header">
        <span class="stats-icon">📊</span>
        <span class="stats-title">Memory Statistics</span>
      </div>

      @if (stats(); as s) {
        <!-- Overview Cards -->
        <div class="overview-cards">
          <div class="stat-card">
            <span class="card-icon">🧠</span>
            <div class="card-content">
              <span class="card-value">{{ s.totalEntries }}</span>
              <span class="card-label">Total Entries</span>
            </div>
          </div>

          <div class="stat-card">
            <span class="card-icon">📝</span>
            <div class="card-content">
              <span class="card-value">{{ formatTokens(s.tokenUsage.total) }}</span>
              <span class="card-label">Tokens Used</span>
            </div>
          </div>

          <div class="stat-card">
            <span class="card-icon">🔄</span>
            <div class="card-content">
              <span class="card-value">{{ totalOperations() }}</span>
              <span class="card-label">Operations</span>
            </div>
          </div>

          <div class="stat-card">
            <span class="card-icon">♻️</span>
            <div class="card-content">
              <span class="card-value">{{ s.evictions.total }}</span>
              <span class="card-label">Evictions</span>
            </div>
          </div>
        </div>

        <!-- Token Usage -->
        <div class="section">
          <span class="section-title">Token Usage</span>
          <div class="token-breakdown">
            <div class="token-bar-container">
              <div class="token-bar">
                <div
                  class="token-segment short-term"
                  [style.width.%]="(s.tokenUsage.shortTerm / s.tokenUsage.limit) * 100"
                  title="Short-term: {{ formatTokens(s.tokenUsage.shortTerm) }}"
                ></div>
                <div
                  class="token-segment long-term"
                  [style.width.%]="(s.tokenUsage.longTerm / s.tokenUsage.limit) * 100"
                  title="Long-term: {{ formatTokens(s.tokenUsage.longTerm) }}"
                ></div>
              </div>
              <span class="token-limit">
                {{ formatTokens(s.tokenUsage.total) }} / {{ formatTokens(s.tokenUsage.limit) }}
              </span>
            </div>
            <div class="token-legend">
              <span class="legend-item">
                <span class="legend-color short-term"></span>
                Short-term ({{ formatTokens(s.tokenUsage.shortTerm) }})
              </span>
              <span class="legend-item">
                <span class="legend-color long-term"></span>
                Long-term ({{ formatTokens(s.tokenUsage.longTerm) }})
              </span>
            </div>
          </div>
        </div>

        <!-- Entries by Type -->
        <div class="section">
          <span class="section-title">Entries by Type</span>
          <div class="type-breakdown">
            @for (type of entryTypes; track type) {
              <div class="type-row">
                <span class="type-icon">{{ getTypeIcon(type) }}</span>
                <span class="type-name">{{ type }}</span>
                <div class="type-bar-container">
                  <div
                    class="type-bar"
                    [class]="'type-' + type"
                    [style.width.%]="getTypePercent(s, type)"
                  ></div>
                </div>
                <span class="type-count">{{ s.entriesByType[type] || 0 }}</span>
              </div>
            }
          </div>
        </div>

        <!-- Operations -->
        <div class="section">
          <span class="section-title">Operations</span>
          <div class="operations-grid">
            <div class="op-item add">
              <span class="op-icon">➕</span>
              <span class="op-count">{{ s.operations.adds }}</span>
              <span class="op-label">Adds</span>
            </div>
            <div class="op-item update">
              <span class="op-icon">✏️</span>
              <span class="op-count">{{ s.operations.updates }}</span>
              <span class="op-label">Updates</span>
            </div>
            <div class="op-item delete">
              <span class="op-icon">🗑️</span>
              <span class="op-count">{{ s.operations.deletes }}</span>
              <span class="op-label">Deletes</span>
            </div>
            <div class="op-item noop">
              <span class="op-icon">⏭️</span>
              <span class="op-count">{{ s.operations.noops }}</span>
              <span class="op-label">No-ops</span>
            </div>
          </div>
          <div class="operations-bar">
            <div
              class="op-segment add"
              [style.width.%]="getOpPercent(s.operations.adds)"
            ></div>
            <div
              class="op-segment update"
              [style.width.%]="getOpPercent(s.operations.updates)"
            ></div>
            <div
              class="op-segment delete"
              [style.width.%]="getOpPercent(s.operations.deletes)"
            ></div>
            <div
              class="op-segment noop"
              [style.width.%]="getOpPercent(s.operations.noops)"
            ></div>
          </div>
        </div>

        <!-- Eviction Stats -->
        <div class="section">
          <span class="section-title">Evictions</span>
          <div class="eviction-stats">
            <div class="eviction-summary">
              <span class="eviction-total">{{ s.evictions.total }} total</span>
              <span class="eviction-recent">{{ s.evictions.recent }} recent</span>
            </div>
            @if (hasEvictionReasons(s)) {
              <div class="eviction-reasons">
                @for (reason of getEvictionReasons(s); track reason.key) {
                  <div class="reason-item">
                    <span class="reason-name">{{ reason.key }}</span>
                    <span class="reason-count">{{ reason.count }}</span>
                  </div>
                }
              </div>
            }
          </div>
        </div>

        <!-- Retention Metrics -->
        <div class="section">
          <span class="section-title">Retention</span>
          <div class="retention-metrics">
            <div class="retention-item">
              <span class="retention-label">Cross-Session Retention</span>
              <div class="retention-bar-container">
                <div
                  class="retention-bar"
                  [style.width.%]="s.retention.crossSession"
                ></div>
              </div>
              <span class="retention-value">{{ s.retention.crossSession.toFixed(1) }}%</span>
            </div>
            <div class="retention-item">
              <span class="retention-label">Avg. Memory Lifespan</span>
              <span class="retention-value lifespan">
                {{ formatDuration(s.retention.avgLifespan) }}
              </span>
            </div>
          </div>
        </div>
      } @else {
        <div class="empty-state">
          <span class="empty-icon">📊</span>
          <span class="empty-text">No statistics available</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .stats-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
    }

    .stats-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .stats-icon {
      font-size: 18px;
    }

    .stats-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .overview-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .stat-card {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
    }

    .card-icon {
      font-size: 24px;
    }

    .card-content {
      display: flex;
      flex-direction: column;
    }

    .card-value {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .card-label {
      font-size: 10px;
      color: var(--text-muted);
    }

    .section {
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);

      &:last-child {
        border-bottom: none;
      }
    }

    .section-title {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: var(--spacing-sm);
    }

    /* Token Usage */
    .token-breakdown {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .token-bar-container {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .token-bar {
      flex: 1;
      height: 20px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      overflow: hidden;
      display: flex;
    }

    .token-segment {
      height: 100%;

      &.short-term {
        background: var(--memory-episodic);
      }

      &.long-term {
        background: var(--memory-procedural);
      }
    }

    .token-limit {
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .token-legend {
      display: flex;
      gap: var(--spacing-md);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .legend-color {
      width: 12px;
      height: 12px;
      border-radius: 2px;

      &.short-term {
        background: var(--memory-episodic);
      }

      &.long-term {
        background: var(--memory-procedural);
      }
    }

    /* Type Breakdown */
    .type-breakdown {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .type-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .type-icon {
      font-size: 14px;
    }

    .type-name {
      width: 70px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .type-bar-container {
      flex: 1;
      height: 8px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      overflow: hidden;
    }

    .type-bar {
      height: 100%;
      border-radius: 4px;

      &.type-episodic { background: var(--memory-episodic); }
      &.type-procedural { background: var(--memory-procedural); }
      &.type-semantic { background: var(--memory-semantic); }
      &.type-short_term { background: var(--memory-short-term); }
      &.type-long_term { background: var(--memory-long-term); }
    }

    .type-count {
      width: 30px;
      font-size: 12px;
      color: var(--text-primary);
      text-align: right;
    }

    /* Operations */
    .operations-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
    }

    .op-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: var(--spacing-sm);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
    }

    .op-icon {
      font-size: 16px;
      margin-bottom: 4px;
    }

    .op-count {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .op-label {
      font-size: 10px;
      color: var(--text-muted);
    }

    .operations-bar {
      height: 8px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      overflow: hidden;
      display: flex;
    }

    .op-segment {
      height: 100%;

      &.add { background: var(--operation-add); }
      &.update { background: var(--operation-update); }
      &.delete { background: var(--operation-delete); }
      &.noop { background: var(--operation-noop); }
    }

    /* Evictions */
    .eviction-stats {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .eviction-summary {
      display: flex;
      gap: var(--spacing-md);
    }

    .eviction-total {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .eviction-recent {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .eviction-reasons {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-xs);
    }

    .reason-item {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
    }

    .reason-name {
      font-size: 11px;
      color: var(--text-secondary);
    }

    .reason-count {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-primary);
    }

    /* Retention */
    .retention-metrics {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .retention-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .retention-label {
      width: 150px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .retention-bar-container {
      flex: 1;
      height: 8px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      overflow: hidden;
    }

    .retention-bar {
      height: 100%;
      background: var(--success-color);
      border-radius: 4px;
    }

    .retention-value {
      width: 60px;
      font-size: 12px;
      color: var(--text-primary);
      text-align: right;

      &.lifespan {
        width: auto;
        flex: 1;
      }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xl);
      color: var(--text-muted);
    }

    .empty-icon {
      font-size: 32px;
      opacity: 0.5;
    }

    .empty-text {
      font-size: 13px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemoryStatsComponent {
  /** Memory statistics */
  stats = input<MemoryStats | null>(null);

  /** Entry types (matches MemoryType from unified-memory.types.ts) */
  entryTypes = ['short_term', 'long_term', 'episodic', 'semantic', 'procedural'];

  /** Total operations */
  totalOperations = computed(() => {
    const s = this.stats();
    if (!s) return 0;
    return s.operations.adds + s.operations.updates + s.operations.deletes + s.operations.noops;
  });

  getTypeIcon(type: string): string {
    switch (type) {
      case 'episodic':
        return '📅';
      case 'procedural':
        return '⚙️';
      case 'semantic':
        return '💡';
      case 'short_term':
        return '💭';
      case 'long_term':
        return '🗄️';
      default:
        return '📝';
    }
  }

  formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    }
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}k`;
    }
    return tokens.toString();
  }

  formatDuration(ms: number): string {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  getTypePercent(stats: MemoryStats, type: string): number {
    if (stats.totalEntries === 0) return 0;
    return ((stats.entriesByType[type] || 0) / stats.totalEntries) * 100;
  }

  getOpPercent(count: number): number {
    const total = this.totalOperations();
    if (total === 0) return 0;
    return (count / total) * 100;
  }

  hasEvictionReasons(stats: MemoryStats): boolean {
    return Object.keys(stats.evictions.byReason).length > 0;
  }

  getEvictionReasons(stats: MemoryStats): { key: string; count: number }[] {
    return Object.entries(stats.evictions.byReason).map(([key, count]) => ({
      key,
      count,
    }));
  }
}
