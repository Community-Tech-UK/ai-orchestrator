/**
 * Learning Insights Feed Component
 *
 * Real-time feed of learning discoveries:
 * - Filterable by insight type
 * - Action buttons (Apply, Dismiss)
 * - Animated entry for new insights
 * - Confidence and evidence display
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';

export interface LearningInsight {
  id: string;
  type: 'pattern' | 'anti_pattern' | 'recommendation' | 'anomaly';
  description: string;
  confidence: number;
  evidenceCount: number;
  timestamp: number;
  isNew?: boolean;
  applied?: boolean;
}

@Component({
  selector: 'app-learning-insights-feed',
  standalone: true,
  template: `
    <div class="feed-container">
      <div class="feed-header">
        <h3 class="feed-title">Learning Insights</h3>
        <div class="filters">
          @for (type of insightTypes; track type.value) {
            <button
              class="filter-chip"
              [class.active]="isTypeSelected(type.value)"
              (click)="toggleType(type.value)"
            >
              {{ type.icon }} {{ type.label }}
            </button>
          }
        </div>
      </div>

      <div class="feed-content">
        @for (insight of filteredInsights(); track insight.id) {
          <div
            class="insight-card"
            [class.new]="insight.isNew"
            [class.applied]="insight.applied"
            [class]="'type-' + insight.type"
          >
            <div class="insight-icon">
              <span class="icon" [class]="'icon-' + insight.type">
                {{ getInsightIcon(insight.type) }}
              </span>
            </div>
            <div class="insight-body">
              <div class="insight-header">
                <span class="insight-type">{{ formatType(insight.type) }}</span>
                <span class="insight-time">{{ formatTime(insight.timestamp) }}</span>
              </div>
              <p class="insight-text">{{ insight.description }}</p>
              <div class="insight-meta">
                <span class="confidence">
                  Confidence: {{ (insight.confidence * 100).toFixed(0) }}%
                </span>
                <span class="evidence">
                  Evidence: {{ insight.evidenceCount }} outcomes
                </span>
              </div>
            </div>
            <div class="insight-actions">
              @if (!insight.applied) {
                <button
                  class="action-btn apply"
                  (click)="applyInsight.emit(insight)"
                  title="Mark as Applied"
                >
                  ✓
                </button>
              }
              <button
                class="action-btn dismiss"
                (click)="dismissInsight.emit(insight)"
                title="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        }

        @if (filteredInsights().length === 0) {
          <div class="empty-state">
            <span class="empty-icon">💡</span>
            <span class="empty-text">No insights to display</span>
            <span class="empty-hint">Insights will appear as the system learns from task outcomes</span>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .feed-container {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .feed-header {
      margin-bottom: var(--spacing-sm);
    }

    .feed-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 var(--spacing-xs) 0;
    }

    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .filter-chip {
      padding: 3px 8px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      font-size: 9px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: white;
      }
    }

    .feed-content {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .insight-card {
      display: flex;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      border-left: 3px solid transparent;
      transition: all var(--transition-fast);

      &.new {
        animation: slideIn 0.3s ease-out;
      }

      &.applied {
        opacity: 0.6;
      }

      &.type-pattern {
        border-left-color: #10b981;
      }

      &.type-anti_pattern {
        border-left-color: #ef4444;
      }

      &.type-recommendation {
        border-left-color: #3b82f6;
      }

      &.type-anomaly {
        border-left-color: #f59e0b;
      }
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(-10px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .insight-icon {
      flex-shrink: 0;
    }

    .icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      font-size: 12px;

      &.icon-pattern {
        background: rgba(16, 185, 129, 0.2);
      }

      &.icon-anti_pattern {
        background: rgba(239, 68, 68, 0.2);
      }

      &.icon-recommendation {
        background: rgba(59, 130, 246, 0.2);
      }

      &.icon-anomaly {
        background: rgba(245, 158, 11, 0.2);
      }
    }

    .insight-body {
      flex: 1;
      min-width: 0;
    }

    .insight-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }

    .insight-type {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .insight-time {
      font-size: 9px;
      color: var(--text-muted);
    }

    .insight-text {
      font-size: 11px;
      color: var(--text-primary);
      line-height: 1.4;
      margin: 0 0 4px 0;
    }

    .insight-meta {
      display: flex;
      gap: var(--spacing-md);
    }

    .confidence, .evidence {
      font-size: 9px;
      color: var(--text-muted);
    }

    .insight-actions {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex-shrink: 0;
    }

    .action-btn {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 10px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &.apply {
        background: rgba(16, 185, 129, 0.2);
        color: #10b981;

        &:hover {
          background: rgba(16, 185, 129, 0.4);
        }
      }

      &.dismiss {
        background: rgba(239, 68, 68, 0.2);
        color: #ef4444;

        &:hover {
          background: rgba(239, 68, 68, 0.4);
        }
      }
    }

    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-lg);
    }

    .empty-icon {
      font-size: 28px;
      opacity: 0.5;
    }

    .empty-text {
      font-size: 12px;
      color: var(--text-muted);
    }

    .empty-hint {
      font-size: 10px;
      color: var(--text-muted);
      opacity: 0.7;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LearningInsightsFeedComponent {
  /** Input insights */
  insights = input<LearningInsight[]>([]);

  /** Events */
  applyInsight = output<LearningInsight>();
  dismissInsight = output<LearningInsight>();

  /** Selected filter types */
  selectedTypes = signal<Set<string>>(new Set(['pattern', 'anti_pattern', 'recommendation', 'anomaly']));

  /** Insight types for filters */
  insightTypes = [
    { value: 'pattern', label: 'Patterns', icon: '✅' },
    { value: 'anti_pattern', label: 'Anti-Patterns', icon: '⚠️' },
    { value: 'recommendation', label: 'Recommendations', icon: '💡' },
    { value: 'anomaly', label: 'Anomalies', icon: '🔍' },
  ];

  /** Filtered insights */
  filteredInsights = computed(() => {
    const types = this.selectedTypes();
    return this.insights()
      .filter(i => types.has(i.type))
      .sort((a, b) => b.timestamp - a.timestamp);
  });

  isTypeSelected(type: string): boolean {
    return this.selectedTypes().has(type);
  }

  toggleType(type: string): void {
    const current = new Set(this.selectedTypes());
    if (current.has(type)) {
      current.delete(type);
    } else {
      current.add(type);
    }
    this.selectedTypes.set(current);
  }

  getInsightIcon(type: string): string {
    switch (type) {
      case 'pattern': return '✅';
      case 'anti_pattern': return '⚠️';
      case 'recommendation': return '💡';
      case 'anomaly': return '🔍';
      default: return '❓';
    }
  }

  formatType(type: string): string {
    return type.replace(/_/g, ' ');
  }

  formatTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    return `${Math.floor(hours / 24)}d ago`;
  }
}
