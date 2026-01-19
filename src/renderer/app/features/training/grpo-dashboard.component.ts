/**
 * GRPO Training Dashboard Component
 *
 * Displays self-improvement training metrics and insights:
 * - Task outcomes tracking
 * - Pattern effectiveness visualization
 * - Learning insights display
 * - Prompt enhancement recommendations
 * - A/B test results
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { SlicePipe } from '@angular/common';

/** Task outcome from self-improvement tracking */
export interface TaskOutcome {
  id: string;
  instanceId: string;
  taskType: string;
  taskDescription: string;
  prompt: string;
  context?: string;
  agentUsed: string;
  modelUsed: string;
  workflowUsed?: string;
  toolsUsed: ToolUsageRecord[];
  tokensUsed: number;
  duration: number;
  success: boolean;
  completionScore?: number;
  userSatisfaction?: number;
  errorType?: string;
  errorMessage?: string;
  patterns: TaskPattern[];
  timestamp: number;
}

export interface ToolUsageRecord {
  tool: string;
  count: number;
  avgDuration: number;
  errorCount: number;
}

export interface TaskPattern {
  type: PatternType;
  value: string;
  effectiveness: number;
  sampleSize: number;
  lastUpdated: number;
}

export type PatternType =
  | 'tool_sequence'
  | 'agent_task_pairing'
  | 'model_task_pairing'
  | 'prompt_structure'
  | 'error_recovery'
  | 'context_selection'
  | 'workflow_shortcut';

export interface LearningInsight {
  id: string;
  type: 'pattern' | 'anti-pattern' | 'optimization' | 'recommendation';
  description: string;
  confidence: number;
  evidence: string[];
  taskTypes: string[];
  createdAt: number;
  appliedCount: number;
  successRate: number;
}

export interface Experience {
  id: string;
  taskType: string;
  description: string;
  successfulPatterns: TaskPattern[];
  failurePatterns: TaskPattern[];
  examplePrompts: ExamplePrompt[];
  sampleSize: number;
  avgSuccessRate: number;
  lastUpdated: number;
}

export interface ExamplePrompt {
  prompt: string;
  context?: string;
  outcome: 'success' | 'failure';
  lessonsLearned: string[];
}

export interface TrainingStats {
  totalOutcomes: number;
  successRate: number;
  patternCount: number;
  insightCount: number;
  experienceCount: number;
  topPatterns: TaskPattern[];
  recentInsights: LearningInsight[];
}

@Component({
  selector: 'app-grpo-dashboard',
  standalone: true,
  imports: [SlicePipe],
  template: `
    <div class="dashboard-container">
      <!-- Header -->
      <div class="dashboard-header">
        <div class="header-left">
          <span class="dashboard-icon">🎯</span>
          <span class="dashboard-title">GRPO Training Dashboard</span>
          <span class="training-badge" [class.active]="isTrainingActive()">
            {{ isTrainingActive() ? 'Learning Active' : 'Inactive' }}
          </span>
        </div>
        <div class="header-actions">
          <button class="action-btn" (click)="refreshData.emit()">
            🔄 Refresh
          </button>
          <button class="action-btn" (click)="exportData.emit()">
            📥 Export
          </button>
        </div>
      </div>

      <!-- Stats Overview -->
      @if (stats(); as statsData) {
        <div class="stats-overview">
          <div class="stat-card">
            <span class="stat-icon">📊</span>
            <div class="stat-content">
              <span class="stat-value">{{ statsData.totalOutcomes }}</span>
              <span class="stat-label">Total Outcomes</span>
            </div>
          </div>
          <div class="stat-card">
            <span class="stat-icon">✅</span>
            <div class="stat-content">
              <span class="stat-value">{{ (statsData.successRate * 100).toFixed(1) }}%</span>
              <span class="stat-label">Success Rate</span>
            </div>
          </div>
          <div class="stat-card">
            <span class="stat-icon">🧬</span>
            <div class="stat-content">
              <span class="stat-value">{{ statsData.patternCount }}</span>
              <span class="stat-label">Patterns</span>
            </div>
          </div>
          <div class="stat-card">
            <span class="stat-icon">💡</span>
            <div class="stat-content">
              <span class="stat-value">{{ statsData.insightCount }}</span>
              <span class="stat-label">Insights</span>
            </div>
          </div>
          <div class="stat-card">
            <span class="stat-icon">📚</span>
            <div class="stat-content">
              <span class="stat-value">{{ statsData.experienceCount }}</span>
              <span class="stat-label">Experiences</span>
            </div>
          </div>
        </div>
      }

      <!-- Main Content -->
      <div class="dashboard-content">
        <!-- Left Panel: Patterns & Insights -->
        <div class="left-panel">
          <!-- Top Patterns -->
          <div class="panel-section">
            <div class="section-header">
              <span class="section-title">Top Patterns</span>
              <select
                class="pattern-filter"
                [value]="patternTypeFilter()"
                (change)="onPatternFilterChange($event)"
              >
                <option value="">All Types</option>
                @for (type of patternTypes; track type) {
                  <option [value]="type">{{ formatPatternType(type) }}</option>
                }
              </select>
            </div>
            <div class="patterns-list">
              @for (pattern of filteredPatterns(); track pattern.value) {
                <div class="pattern-card">
                  <div class="pattern-header">
                    <span class="pattern-type-badge" [class]="'type-' + pattern.type">
                      {{ getPatternTypeIcon(pattern.type) }} {{ formatPatternType(pattern.type) }}
                    </span>
                    <span class="pattern-effectiveness" [class.high]="pattern.effectiveness >= 0.7" [class.low]="pattern.effectiveness < 0.3">
                      {{ (pattern.effectiveness * 100).toFixed(0) }}%
                    </span>
                  </div>
                  <div class="pattern-value">{{ pattern.value }}</div>
                  <div class="pattern-meta">
                    <span class="meta-item">{{ pattern.sampleSize }} samples</span>
                    <span class="meta-item">{{ formatTimeAgo(pattern.lastUpdated) }}</span>
                  </div>
                  <div class="effectiveness-bar">
                    <div
                      class="effectiveness-fill"
                      [style.width.%]="pattern.effectiveness * 100"
                      [class.high]="pattern.effectiveness >= 0.7"
                      [class.medium]="pattern.effectiveness >= 0.3 && pattern.effectiveness < 0.7"
                      [class.low]="pattern.effectiveness < 0.3"
                    ></div>
                  </div>
                </div>
              }

              @if (filteredPatterns().length === 0) {
                <div class="empty-state">
                  <span class="empty-icon">🧬</span>
                  <span class="empty-text">No patterns discovered yet</span>
                </div>
              }
            </div>
          </div>

          <!-- Learning Insights -->
          <div class="panel-section">
            <div class="section-header">
              <span class="section-title">Learning Insights</span>
              <select
                class="insight-filter"
                [value]="insightTypeFilter()"
                (change)="onInsightFilterChange($event)"
              >
                <option value="">All Types</option>
                <option value="pattern">Patterns</option>
                <option value="anti-pattern">Anti-Patterns</option>
                <option value="optimization">Optimizations</option>
                <option value="recommendation">Recommendations</option>
              </select>
            </div>
            <div class="insights-list">
              @for (insight of filteredInsights(); track insight.id) {
                <div
                  class="insight-card"
                  [class]="'insight-' + insight.type"
                  [class.selected]="selectedInsight()?.id === insight.id"
                  (click)="selectInsight(insight)"
                >
                  <div class="insight-header">
                    <span class="insight-type-badge" [class]="'type-' + insight.type">
                      {{ getInsightTypeIcon(insight.type) }} {{ insight.type }}
                    </span>
                    <span class="insight-confidence">
                      {{ (insight.confidence * 100).toFixed(0) }}% confidence
                    </span>
                  </div>
                  <div class="insight-description">{{ insight.description }}</div>
                  <div class="insight-meta">
                    <span class="meta-item">Applied {{ insight.appliedCount }}x</span>
                    <span class="meta-item">{{ (insight.successRate * 100).toFixed(0) }}% success</span>
                  </div>
                </div>
              }

              @if (filteredInsights().length === 0) {
                <div class="empty-state">
                  <span class="empty-icon">💡</span>
                  <span class="empty-text">No insights generated yet</span>
                </div>
              }
            </div>
          </div>
        </div>

        <!-- Right Panel: Outcomes & Detail -->
        <div class="right-panel">
          <!-- Recent Outcomes -->
          <div class="panel-section">
            <div class="section-header">
              <span class="section-title">Recent Outcomes</span>
              <div class="outcome-filters">
                <button
                  class="filter-btn"
                  [class.active]="outcomeFilter() === ''"
                  (click)="setOutcomeFilter('')"
                >
                  All
                </button>
                <button
                  class="filter-btn success"
                  [class.active]="outcomeFilter() === 'success'"
                  (click)="setOutcomeFilter('success')"
                >
                  Success
                </button>
                <button
                  class="filter-btn failure"
                  [class.active]="outcomeFilter() === 'failure'"
                  (click)="setOutcomeFilter('failure')"
                >
                  Failed
                </button>
              </div>
            </div>
            <div class="outcomes-list">
              @for (outcome of filteredOutcomes(); track outcome.id) {
                <div
                  class="outcome-card"
                  [class.success]="outcome.success"
                  [class.failure]="!outcome.success"
                  [class.selected]="selectedOutcome()?.id === outcome.id"
                  (click)="selectOutcome(outcome)"
                >
                  <div class="outcome-header">
                    <span class="outcome-status">
                      {{ outcome.success ? '✅' : '❌' }}
                    </span>
                    <span class="outcome-type">{{ outcome.taskType }}</span>
                    <span class="outcome-time">{{ formatTimeAgo(outcome.timestamp) }}</span>
                  </div>
                  <div class="outcome-description">
                    {{ truncate(outcome.taskDescription, 80) }}
                  </div>
                  <div class="outcome-meta">
                    <span class="meta-item">🤖 {{ outcome.agentUsed }}</span>
                    <span class="meta-item">🧠 {{ outcome.modelUsed }}</span>
                    <span class="meta-item">🔢 {{ outcome.tokensUsed }} tokens</span>
                  </div>
                </div>
              }

              @if (filteredOutcomes().length === 0) {
                <div class="empty-state">
                  <span class="empty-icon">📊</span>
                  <span class="empty-text">No outcomes recorded yet</span>
                </div>
              }
            </div>
          </div>

          <!-- Selected Detail -->
          @if (selectedOutcome(); as outcome) {
            <div class="detail-panel">
              <div class="detail-header">
                <span class="detail-title">Outcome Detail</span>
                <button class="close-btn" (click)="clearOutcomeSelection()">✕</button>
              </div>
              <div class="detail-body">
                <div class="detail-section">
                  <span class="section-label">Task</span>
                  <span class="section-value">{{ outcome.taskDescription }}</span>
                </div>
                <div class="detail-section">
                  <span class="section-label">Prompt</span>
                  <pre class="prompt-content">{{ outcome.prompt }}</pre>
                </div>
                <div class="detail-section">
                  <span class="section-label">Configuration</span>
                  <div class="config-grid">
                    <div class="config-item">
                      <span class="config-label">Agent</span>
                      <span class="config-value">{{ outcome.agentUsed }}</span>
                    </div>
                    <div class="config-item">
                      <span class="config-label">Model</span>
                      <span class="config-value">{{ outcome.modelUsed }}</span>
                    </div>
                    <div class="config-item">
                      <span class="config-label">Tokens</span>
                      <span class="config-value">{{ outcome.tokensUsed }}</span>
                    </div>
                    <div class="config-item">
                      <span class="config-label">Duration</span>
                      <span class="config-value">{{ formatDuration(outcome.duration) }}</span>
                    </div>
                    @if (outcome.completionScore !== undefined) {
                      <div class="config-item">
                        <span class="config-label">Completion</span>
                        <span class="config-value">{{ (outcome.completionScore * 100).toFixed(0) }}%</span>
                      </div>
                    }
                    @if (outcome.userSatisfaction !== undefined) {
                      <div class="config-item">
                        <span class="config-label">Satisfaction</span>
                        <span class="config-value">{{ outcome.userSatisfaction }}/5</span>
                      </div>
                    }
                  </div>
                </div>
                @if (outcome.toolsUsed.length > 0) {
                  <div class="detail-section">
                    <span class="section-label">Tools Used</span>
                    <div class="tools-list">
                      @for (tool of outcome.toolsUsed; track tool.tool) {
                        <div class="tool-item">
                          <span class="tool-name">{{ tool.tool }}</span>
                          <span class="tool-count">{{ tool.count }}x</span>
                          @if (tool.errorCount > 0) {
                            <span class="tool-errors">{{ tool.errorCount }} errors</span>
                          }
                        </div>
                      }
                    </div>
                  </div>
                }
                @if (!outcome.success && outcome.errorType) {
                  <div class="detail-section">
                    <span class="section-label">Error</span>
                    <div class="error-info">
                      <span class="error-type">{{ outcome.errorType }}</span>
                      @if (outcome.errorMessage) {
                        <span class="error-message">{{ outcome.errorMessage }}</span>
                      }
                    </div>
                  </div>
                }
                @if (outcome.patterns.length > 0) {
                  <div class="detail-section">
                    <span class="section-label">Extracted Patterns</span>
                    <div class="patterns-mini-list">
                      @for (pattern of outcome.patterns; track pattern.value) {
                        <div class="pattern-mini">
                          <span class="pattern-mini-type">{{ getPatternTypeIcon(pattern.type) }}</span>
                          <span class="pattern-mini-value">{{ pattern.value }}</span>
                        </div>
                      }
                    </div>
                  </div>
                }
              </div>
            </div>
          } @else if (selectedInsight(); as insight) {
            <div class="detail-panel">
              <div class="detail-header">
                <span class="detail-title">Insight Detail</span>
                <button class="close-btn" (click)="clearInsightSelection()">✕</button>
              </div>
              <div class="detail-body">
                <div class="detail-section">
                  <span class="section-label">Description</span>
                  <span class="section-value">{{ insight.description }}</span>
                </div>
                <div class="detail-section">
                  <span class="section-label">Metrics</span>
                  <div class="config-grid">
                    <div class="config-item">
                      <span class="config-label">Confidence</span>
                      <span class="config-value">{{ (insight.confidence * 100).toFixed(0) }}%</span>
                    </div>
                    <div class="config-item">
                      <span class="config-label">Applied</span>
                      <span class="config-value">{{ insight.appliedCount }} times</span>
                    </div>
                    <div class="config-item">
                      <span class="config-label">Success Rate</span>
                      <span class="config-value">{{ (insight.successRate * 100).toFixed(0) }}%</span>
                    </div>
                    <div class="config-item">
                      <span class="config-label">Created</span>
                      <span class="config-value">{{ formatTimeAgo(insight.createdAt) }}</span>
                    </div>
                  </div>
                </div>
                @if (insight.taskTypes.length > 0) {
                  <div class="detail-section">
                    <span class="section-label">Applicable Task Types</span>
                    <div class="task-types-list">
                      @for (taskType of insight.taskTypes; track taskType) {
                        <span class="task-type-badge">{{ taskType }}</span>
                      }
                    </div>
                  </div>
                }
                @if (insight.evidence.length > 0) {
                  <div class="detail-section">
                    <span class="section-label">Evidence</span>
                    <ul class="evidence-list">
                      @for (item of insight.evidence; track item) {
                        <li class="evidence-item">{{ item }}</li>
                      }
                    </ul>
                  </div>
                }
              </div>
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    .dashboard-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 600px;
    }

    .dashboard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .dashboard-icon {
      font-size: 20px;
    }

    .dashboard-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .training-badge {
      padding: 3px 8px;
      border-radius: var(--radius-sm);
      font-size: 10px;
      font-weight: 600;
      background: var(--bg-tertiary);
      color: var(--text-muted);

      &.active {
        background: rgba(16, 185, 129, 0.2);
        color: #10b981;
      }
    }

    .header-actions {
      display: flex;
      gap: var(--spacing-sm);
    }

    .action-btn {
      padding: 6px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }
    }

    /* Stats Overview */
    .stats-overview {
      display: flex;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
      overflow-x: auto;
    }

    .stat-card {
      flex: 1;
      min-width: 100px;
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
    }

    .stat-icon {
      font-size: 20px;
    }

    .stat-content {
      display: flex;
      flex-direction: column;
    }

    .stat-value {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .stat-label {
      font-size: 10px;
      color: var(--text-muted);
    }

    /* Main Content */
    .dashboard-content {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--spacing-md);
      padding: var(--spacing-md);
      overflow: hidden;
    }

    .left-panel, .right-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      overflow: hidden;
    }

    .panel-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .section-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .pattern-filter, .insight-filter {
      padding: 4px 8px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 10px;
    }

    .outcome-filters {
      display: flex;
      gap: 4px;
    }

    .filter-btn {
      padding: 3px 8px;
      background: var(--bg-secondary);
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 10px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        background: var(--primary-color);
        color: white;
      }

      &.success.active {
        background: #10b981;
      }

      &.failure.active {
        background: var(--error-color);
      }
    }

    /* Patterns List */
    .patterns-list, .insights-list, .outcomes-list {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-sm);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .pattern-card {
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
    }

    .pattern-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }

    .pattern-type-badge {
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-size: 9px;
      font-weight: 600;

      &.type-tool_sequence { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
      &.type-agent_task_pairing { background: rgba(16, 185, 129, 0.2); color: #10b981; }
      &.type-model_task_pairing { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
      &.type-prompt_structure { background: rgba(139, 92, 246, 0.2); color: #8b5cf6; }
      &.type-error_recovery { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
      &.type-context_selection { background: rgba(236, 72, 153, 0.2); color: #ec4899; }
      &.type-workflow_shortcut { background: rgba(20, 184, 166, 0.2); color: #14b8a6; }
    }

    .pattern-effectiveness {
      font-size: 11px;
      font-weight: 600;

      &.high { color: #10b981; }
      &.low { color: var(--error-color); }
    }

    .pattern-value {
      font-size: 11px;
      color: var(--text-primary);
      margin-bottom: 4px;
    }

    .pattern-meta {
      display: flex;
      gap: var(--spacing-sm);
      margin-bottom: 4px;
    }

    .meta-item {
      font-size: 9px;
      color: var(--text-muted);
    }

    .effectiveness-bar {
      height: 4px;
      background: var(--bg-tertiary);
      border-radius: 2px;
      overflow: hidden;
    }

    .effectiveness-fill {
      height: 100%;
      border-radius: 2px;

      &.high { background: #10b981; }
      &.medium { background: #f59e0b; }
      &.low { background: var(--error-color); }
    }

    /* Insights List */
    .insight-card {
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        border-left-color: var(--primary-color);
      }

      &.insight-pattern { border-left-color: #10b981; }
      &.insight-anti-pattern { border-left-color: #ef4444; }
      &.insight-optimization { border-left-color: #3b82f6; }
      &.insight-recommendation { border-left-color: #f59e0b; }
    }

    .insight-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }

    .insight-type-badge {
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-size: 9px;
      font-weight: 600;

      &.type-pattern { background: rgba(16, 185, 129, 0.2); color: #10b981; }
      &.type-anti-pattern { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
      &.type-optimization { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
      &.type-recommendation { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
    }

    .insight-confidence {
      font-size: 9px;
      color: var(--text-muted);
    }

    .insight-description {
      font-size: 11px;
      color: var(--text-primary);
      line-height: 1.4;
      margin-bottom: 4px;
    }

    .insight-meta {
      display: flex;
      gap: var(--spacing-sm);
    }

    /* Outcomes List */
    .outcome-card {
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        border-left-color: var(--primary-color);
      }

      &.success {
        border-left-color: #10b981;
      }

      &.failure {
        border-left-color: var(--error-color);
      }
    }

    .outcome-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: 4px;
    }

    .outcome-status {
      font-size: 12px;
    }

    .outcome-type {
      font-size: 11px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .outcome-time {
      font-size: 9px;
      color: var(--text-muted);
      margin-left: auto;
    }

    .outcome-description {
      font-size: 11px;
      color: var(--text-secondary);
      margin-bottom: 4px;
    }

    .outcome-meta {
      display: flex;
      gap: var(--spacing-sm);
    }

    /* Detail Panel */
    .detail-panel {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      max-height: 300px;
      overflow-y: auto;
    }

    .detail-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
      position: sticky;
      top: 0;
      background: var(--bg-tertiary);
    }

    .detail-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .close-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;

      &:hover {
        color: var(--text-primary);
      }
    }

    .detail-body {
      padding: var(--spacing-md);
    }

    .detail-section {
      margin-bottom: var(--spacing-md);

      &:last-child {
        margin-bottom: 0;
      }
    }

    .section-label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: var(--spacing-xs);
    }

    .section-value {
      font-size: 12px;
      color: var(--text-primary);
    }

    .prompt-content {
      margin: 0;
      padding: var(--spacing-sm);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 11px;
      color: var(--text-primary);
      white-space: pre-wrap;
      max-height: 100px;
      overflow-y: auto;
      font-family: var(--font-mono);
    }

    .config-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--spacing-sm);
    }

    .config-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .config-label {
      font-size: 9px;
      color: var(--text-muted);
    }

    .config-value {
      font-size: 11px;
      color: var(--text-primary);
    }

    .tools-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .tool-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: 4px 8px;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
    }

    .tool-name {
      font-size: 11px;
      color: var(--text-primary);
    }

    .tool-count {
      font-size: 10px;
      color: var(--text-muted);
    }

    .tool-errors {
      font-size: 10px;
      color: var(--error-color);
      margin-left: auto;
    }

    .error-info {
      padding: var(--spacing-sm);
      background: rgba(239, 68, 68, 0.1);
      border-radius: var(--radius-sm);
      border-left: 3px solid var(--error-color);
    }

    .error-type {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: var(--error-color);
      margin-bottom: 4px;
    }

    .error-message {
      font-size: 11px;
      color: var(--text-secondary);
    }

    .patterns-mini-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .pattern-mini {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      font-size: 10px;
      color: var(--text-secondary);
    }

    .pattern-mini-type {
      font-size: 12px;
    }

    .task-types-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .task-type-badge {
      padding: 2px 6px;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--text-secondary);
    }

    .evidence-list {
      margin: 0;
      padding-left: var(--spacing-md);
    }

    .evidence-item {
      font-size: 11px;
      color: var(--text-secondary);
      margin-bottom: 4px;
    }

    /* Empty State */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xl);
      color: var(--text-muted);
    }

    .empty-icon {
      font-size: 28px;
      opacity: 0.5;
    }

    .empty-text {
      font-size: 12px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GrpoDashboardComponent {
  /** Training stats */
  stats = input<TrainingStats | null>(null);

  /** All patterns */
  patterns = input<TaskPattern[]>([]);

  /** All insights */
  insights = input<LearningInsight[]>([]);

  /** All outcomes */
  outcomes = input<TaskOutcome[]>([]);

  /** Training active */
  isTrainingActive = input<boolean>(false);

  /** Events */
  refreshData = output<void>();
  exportData = output<void>();

  /** Pattern types */
  patternTypes: PatternType[] = [
    'tool_sequence',
    'agent_task_pairing',
    'model_task_pairing',
    'prompt_structure',
    'error_recovery',
    'context_selection',
    'workflow_shortcut',
  ];

  /** Filters */
  patternTypeFilter = signal<PatternType | ''>('');
  insightTypeFilter = signal<LearningInsight['type'] | ''>('');
  outcomeFilter = signal<'success' | 'failure' | ''>('');

  /** Selections */
  selectedOutcome = signal<TaskOutcome | null>(null);
  selectedInsight = signal<LearningInsight | null>(null);

  /** Filtered patterns */
  filteredPatterns = computed(() => {
    const filter = this.patternTypeFilter();
    let result = this.patterns();

    if (filter) {
      result = result.filter(p => p.type === filter);
    }

    return result.sort((a, b) => b.effectiveness - a.effectiveness).slice(0, 20);
  });

  /** Filtered insights */
  filteredInsights = computed(() => {
    const filter = this.insightTypeFilter();
    let result = this.insights();

    if (filter) {
      result = result.filter(i => i.type === filter);
    }

    return result.sort((a, b) => b.confidence - a.confidence).slice(0, 20);
  });

  /** Filtered outcomes */
  filteredOutcomes = computed(() => {
    const filter = this.outcomeFilter();
    let result = this.outcomes();

    if (filter === 'success') {
      result = result.filter(o => o.success);
    } else if (filter === 'failure') {
      result = result.filter(o => !o.success);
    }

    return result.sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
  });

  getPatternTypeIcon(type: PatternType): string {
    switch (type) {
      case 'tool_sequence': return '🔧';
      case 'agent_task_pairing': return '🤖';
      case 'model_task_pairing': return '🧠';
      case 'prompt_structure': return '📝';
      case 'error_recovery': return '🔄';
      case 'context_selection': return '📋';
      case 'workflow_shortcut': return '⚡';
      default: return '❓';
    }
  }

  getInsightTypeIcon(type: LearningInsight['type']): string {
    switch (type) {
      case 'pattern': return '✅';
      case 'anti-pattern': return '⚠️';
      case 'optimization': return '🚀';
      case 'recommendation': return '💡';
      default: return '❓';
    }
  }

  formatPatternType(type: PatternType): string {
    return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  formatTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  }

  onPatternFilterChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.patternTypeFilter.set(target.value as PatternType | '');
  }

  onInsightFilterChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.insightTypeFilter.set(target.value as LearningInsight['type'] | '');
  }

  setOutcomeFilter(filter: 'success' | 'failure' | ''): void {
    this.outcomeFilter.set(filter);
  }

  selectOutcome(outcome: TaskOutcome): void {
    this.selectedOutcome.set(outcome);
    this.selectedInsight.set(null);
  }

  selectInsight(insight: LearningInsight): void {
    this.selectedInsight.set(insight);
    this.selectedOutcome.set(null);
  }

  clearOutcomeSelection(): void {
    this.selectedOutcome.set(null);
  }

  clearInsightSelection(): void {
    this.selectedInsight.set(null);
  }
}
