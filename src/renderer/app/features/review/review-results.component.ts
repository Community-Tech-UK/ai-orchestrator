/**
 * Review Results Component
 *
 * Displays code review results with:
 * - Confidence filtering
 * - Severity and category grouping
 * - File/line navigation
 * - Accept/acknowledge issues
 * - Export capabilities
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import type {
  ReviewIssue,
  SeverityLevel,
  ReviewSummary,
} from '../../../../shared/types/review-agent.types';

interface GroupedIssues {
  file: string;
  issues: ReviewIssue[];
}

@Component({
  selector: 'app-review-results',
  standalone: true,
  template: `
    <div class="review-container">
      <!-- Header with Score -->
      <div class="review-header">
        <div class="header-left">
          <span class="review-icon">🔍</span>
          <span class="review-title">Code Review</span>
          @if (score(); as s) {
            <span class="score-badge" [class]="getScoreClass(s.overallScore ?? 0)">
              {{ s.overallScore ?? 0 }}/100
            </span>
          }
        </div>
        <div class="header-actions">
          <button class="action-btn" (click)="exportMarkdown()">
            Export MD
          </button>
          <button class="action-btn" (click)="exportJson()">
            Export JSON
          </button>
        </div>
      </div>

      <!-- Filters -->
      <div class="filters-section">
        <!-- Confidence Slider -->
        <div class="filter-group">
          <label class="filter-label">
            Min Confidence: {{ confidenceThreshold() }}%
          </label>
          <input
            type="range"
            min="0"
            max="100"
            [value]="confidenceThreshold()"
            (input)="onConfidenceChange($event)"
            class="confidence-slider"
          />
        </div>

        <!-- Severity Filter -->
        <div class="filter-group">
          <label class="filter-label">Severity</label>
          <div class="severity-toggles">
            @for (severity of severities; track severity) {
              <button
                class="severity-toggle"
                [class.active]="activeSeverities().has(severity)"
                [class]="'severity-' + severity"
                (click)="toggleSeverity(severity)"
              >
                {{ severity }}
              </button>
            }
          </div>
        </div>

        <!-- Category Filter -->
        @if (availableCategories().length > 0) {
          <div class="filter-group">
            <label class="filter-label">Category</label>
            <select
              class="category-select"
              [value]="selectedCategory()"
              (change)="onCategoryChange($event)"
            >
              <option value="">All Categories</option>
              @for (cat of availableCategories(); track cat) {
                <option [value]="cat">{{ cat }}</option>
              }
            </select>
          </div>
        }
      </div>

      <!-- Stats -->
      <div class="stats-bar">
        <span class="stat">
          {{ filteredIssues().length }} issues
        </span>
        <span class="stat critical">
          {{ criticalCount() }} critical
        </span>
        <span class="stat high">
          {{ highCount() }} high
        </span>
        <span class="stat medium">
          {{ mediumCount() }} medium
        </span>
        <span class="stat low">
          {{ lowCount() }} low
        </span>
      </div>

      <!-- Issue List -->
      <div class="issues-list">
        @for (group of groupedByFile(); track group.file) {
          <div class="file-group">
            <button
              class="file-header"
              (click)="toggleFileExpanded(group.file)"
            >
              <span class="expand-icon">
                {{ expandedFiles().has(group.file) ? '▾' : '▸' }}
              </span>
              <span class="file-name">{{ group.file }}</span>
              <span class="issue-count">{{ group.issues.length }}</span>
            </button>

            @if (expandedFiles().has(group.file)) {
              <div class="file-issues">
                @for (issue of group.issues; track issue.id) {
                  <div
                    class="issue-item"
                    [class]="'severity-' + issue.severity"
                    [class.acknowledged]="acknowledgedIssues().has(issue.id)"
                  >
                    <div class="issue-header">
                      <span class="severity-icon">
                        {{ getSeverityIcon(issue.severity) }}
                      </span>
                      <span class="issue-message">{{ issue.title }}</span>
                      @if (issue.confidence !== undefined) {
                        <span class="confidence-badge">
                          {{ issue.confidence }}%
                        </span>
                      }
                    </div>

                    @if (issue.line !== undefined) {
                      <button
                        class="line-link"
                        (click)="navigateToLine(issue)"
                      >
                        Line {{ issue.line }}
                        @if (issue.endLine && issue.endLine !== issue.line) {
                          - {{ issue.endLine }}
                        }
                      </button>
                    }

                    @if (issue.category) {
                      <span class="category-tag">{{ issue.category }}</span>
                    }

                    @if (issue.suggestion) {
                      <div class="suggestion">
                        <span class="suggestion-label">Suggestion:</span>
                        <span class="suggestion-text">{{ issue.suggestion }}</span>
                      </div>
                    }

                    @if (issue.codeSnippet) {
                      <pre class="code-snippet">{{ issue.codeSnippet }}</pre>
                    }

                    <div class="issue-actions">
                      @if (!acknowledgedIssues().has(issue.id)) {
                        <button
                          class="issue-btn"
                          (click)="acknowledgeIssue(issue)"
                        >
                          Acknowledge
                        </button>
                      } @else {
                        <span class="acknowledged-label">✓ Acknowledged</span>
                      }
                      @if (issue.suggestion) {
                        <button
                          class="issue-btn primary"
                          (click)="applySuggestion(issue)"
                        >
                          Apply Fix
                        </button>
                      }
                    </div>
                  </div>
                }
              </div>
            }
          </div>
        }

        @if (filteredIssues().length === 0) {
          <div class="empty-state">
            @if (issues().length === 0) {
              <span class="empty-icon">✨</span>
              <span class="empty-text">No issues found</span>
            } @else {
              <span class="empty-icon">🔍</span>
              <span class="empty-text">No issues match current filters</span>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .review-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .review-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-tertiary);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .review-icon {
      font-size: 18px;
    }

    .review-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .score-badge {
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 600;

      &.score-good {
        background: var(--success-color);
        color: white;
      }

      &.score-warning {
        background: var(--warning-color);
        color: black;
      }

      &.score-bad {
        background: var(--error-color);
        color: white;
      }
    }

    .header-actions {
      display: flex;
      gap: var(--spacing-xs);
    }

    .action-btn {
      padding: 4px 8px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .filters-section {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-md);
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .filter-group {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .filter-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .confidence-slider {
      width: 150px;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: var(--bg-tertiary);
      border-radius: 2px;
      cursor: pointer;

      &::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        background: var(--primary-color);
        border-radius: 50%;
        cursor: pointer;
      }
    }

    .severity-toggles {
      display: flex;
      gap: 4px;
    }

    .severity-toggle {
      padding: 2px 8px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        border-color: currentColor;
        background: currentColor;
        color: white;
      }

      &.severity-critical {
        &.active {
          background: #dc2626;
          border-color: #dc2626;
        }
        &:not(.active) { color: #dc2626; }
      }

      &.severity-high {
        &.active {
          background: #ea580c;
          border-color: #ea580c;
        }
        &:not(.active) { color: #ea580c; }
      }

      &.severity-medium {
        &.active {
          background: #ca8a04;
          border-color: #ca8a04;
        }
        &:not(.active) { color: #ca8a04; }
      }

      &.severity-low {
        &.active {
          background: #65a30d;
          border-color: #65a30d;
        }
        &:not(.active) { color: #65a30d; }
      }

      &.severity-info {
        &.active {
          background: #0284c7;
          border-color: #0284c7;
        }
        &:not(.active) { color: #0284c7; }
      }
    }

    .category-select {
      padding: 4px 8px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 12px;
    }

    .stats-bar {
      display: flex;
      gap: var(--spacing-md);
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-tertiary);
      font-size: 12px;
    }

    .stat {
      color: var(--text-secondary);

      &.critical { color: #dc2626; }
      &.high { color: #ea580c; }
      &.medium { color: #ca8a04; }
      &.low { color: #65a30d; }
    }

    .issues-list {
      flex: 1;
      overflow-y: auto;
      max-height: 400px;
    }

    .file-group {
      border-bottom: 1px solid var(--border-color);

      &:last-child {
        border-bottom: none;
      }
    }

    .file-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      width: 100%;
      padding: var(--spacing-sm) var(--spacing-md);
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-size: 13px;
      cursor: pointer;
      transition: background var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }
    }

    .expand-icon {
      font-size: 10px;
      width: 12px;
      color: var(--text-secondary);
    }

    .file-name {
      flex: 1;
      text-align: left;
      font-family: var(--font-mono);
      font-size: 12px;
    }

    .issue-count {
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 11px;
      color: var(--text-secondary);
    }

    .file-issues {
      padding: 0 var(--spacing-md) var(--spacing-sm);
    }

    .issue-item {
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-xs);
      background: var(--bg-primary);
      border-radius: var(--radius-sm);
      border-left: 3px solid transparent;

      &.severity-critical { border-left-color: #dc2626; }
      &.severity-high { border-left-color: #ea580c; }
      &.severity-medium { border-left-color: #ca8a04; }
      &.severity-low { border-left-color: #65a30d; }
      &.severity-info { border-left-color: #0284c7; }

      &.acknowledged {
        opacity: 0.6;
      }
    }

    .issue-header {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-sm);
    }

    .severity-icon {
      font-size: 14px;
      flex-shrink: 0;
    }

    .issue-message {
      flex: 1;
      font-size: 13px;
      color: var(--text-primary);
      line-height: 1.4;
    }

    .confidence-badge {
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--text-secondary);
    }

    .line-link {
      display: inline-block;
      margin-top: var(--spacing-xs);
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border: none;
      border-radius: var(--radius-sm);
      color: var(--primary-color);
      font-size: 11px;
      font-family: var(--font-mono);
      cursor: pointer;

      &:hover {
        background: var(--primary-color);
        color: white;
      }
    }

    .category-tag {
      display: inline-block;
      margin-top: var(--spacing-xs);
      margin-left: var(--spacing-sm);
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--text-secondary);
    }

    .suggestion {
      margin-top: var(--spacing-sm);
      padding: var(--spacing-sm);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 12px;
    }

    .suggestion-label {
      font-weight: 600;
      color: var(--text-secondary);
    }

    .suggestion-text {
      color: var(--text-primary);
      margin-left: var(--spacing-xs);
    }

    .code-snippet {
      margin: var(--spacing-sm) 0 0 0;
      padding: var(--spacing-sm);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-primary);
      overflow-x: auto;
    }

    .issue-actions {
      display: flex;
      gap: var(--spacing-xs);
      margin-top: var(--spacing-sm);
    }

    .issue-btn {
      padding: 4px 10px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-secondary);
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: white;

        &:hover {
          background: var(--primary-hover);
        }
      }
    }

    .acknowledged-label {
      font-size: 11px;
      color: var(--success-color);
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
export class ReviewResultsComponent {
  /** Review issues to display */
  issues = input<ReviewIssue[]>([]);

  /** Optional review summary */
  score = input<ReviewSummary | null>(null);

  /** Event when an issue is acknowledged */
  issueAcknowledged = output<ReviewIssue>();

  /** Event when a suggestion should be applied */
  suggestionApplied = output<ReviewIssue>();

  /** Event when navigating to a line */
  navigateTo = output<{ file: string; line: number }>();

  /** Export event */
  exportData = output<{ format: 'markdown' | 'json'; data: string }>();

  /** All severity levels */
  severities: SeverityLevel[] = ['critical', 'high', 'medium', 'low', 'info'];

  /** Confidence threshold (0-100) */
  confidenceThreshold = signal(0);

  /** Active severity filters */
  activeSeverities = signal(new Set<SeverityLevel>(this.severities));

  /** Selected category filter */
  selectedCategory = signal('');

  /** Expanded file groups */
  expandedFiles = signal(new Set<string>());

  /** Acknowledged issue IDs */
  acknowledgedIssues = signal(new Set<string>());

  /** Available categories from issues */
  availableCategories = computed(() => {
    const categories = new Set<string>();
    for (const issue of this.issues()) {
      if (issue.category) {
        categories.add(issue.category);
      }
    }
    return Array.from(categories).sort();
  });

  /** Filtered issues */
  filteredIssues = computed(() => {
    const threshold = this.confidenceThreshold();
    const severities = this.activeSeverities();
    const category = this.selectedCategory();

    return this.issues().filter((issue) => {
      if ((issue.confidence ?? 100) < threshold) return false;
      if (!severities.has(issue.severity)) return false;
      if (category && issue.category !== category) return false;
      return true;
    });
  });

  /** Issues grouped by file */
  groupedByFile = computed(() => {
    const groups = new Map<string, ReviewIssue[]>();

    for (const issue of this.filteredIssues()) {
      const file = issue.file || 'Unknown File';
      const existing = groups.get(file) || [];
      existing.push(issue);
      groups.set(file, existing);
    }

    return Array.from(groups.entries())
      .map(([file, issues]) => ({ file, issues }))
      .sort((a, b) => b.issues.length - a.issues.length);
  });

  /** Count helpers */
  criticalCount = computed(() =>
    this.filteredIssues().filter((i) => i.severity === 'critical').length
  );

  highCount = computed(() =>
    this.filteredIssues().filter((i) => i.severity === 'high').length
  );

  mediumCount = computed(() =>
    this.filteredIssues().filter((i) => i.severity === 'medium').length
  );

  lowCount = computed(() =>
    this.filteredIssues().filter((i) => i.severity === 'low').length
  );

  getScoreClass(score: number): string {
    if (score >= 80) return 'score-good';
    if (score >= 60) return 'score-warning';
    return 'score-bad';
  }

  getSeverityIcon(severity: SeverityLevel): string {
    switch (severity) {
      case 'critical':
        return '🔴';
      case 'high':
        return '🟠';
      case 'medium':
        return '🟡';
      case 'low':
        return '🟢';
      case 'info':
        return '🔵';
      default:
        return '⚪';
    }
  }

  onConfidenceChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.confidenceThreshold.set(parseInt(target.value, 10));
  }

  toggleSeverity(severity: SeverityLevel): void {
    this.activeSeverities.update((set) => {
      const newSet = new Set(set);
      if (newSet.has(severity)) {
        newSet.delete(severity);
      } else {
        newSet.add(severity);
      }
      return newSet;
    });
  }

  onCategoryChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.selectedCategory.set(target.value);
  }

  toggleFileExpanded(file: string): void {
    this.expandedFiles.update((set) => {
      const newSet = new Set(set);
      if (newSet.has(file)) {
        newSet.delete(file);
      } else {
        newSet.add(file);
      }
      return newSet;
    });
  }

  acknowledgeIssue(issue: ReviewIssue): void {
    this.acknowledgedIssues.update((set) => new Set([...set, issue.id]));
    this.issueAcknowledged.emit(issue);
  }

  applySuggestion(issue: ReviewIssue): void {
    this.suggestionApplied.emit(issue);
  }

  navigateToLine(issue: ReviewIssue): void {
    if (issue.file && issue.line !== undefined) {
      this.navigateTo.emit({ file: issue.file, line: issue.line });
    }
  }

  exportMarkdown(): void {
    const lines: string[] = ['# Code Review Results', ''];

    const summary = this.score();
    if (summary?.overallScore !== undefined) {
      lines.push(`**Overall Score:** ${summary.overallScore}/100`, '');
    }

    lines.push(`**Total Issues:** ${this.filteredIssues().length}`, '');

    for (const group of this.groupedByFile()) {
      lines.push(`## ${group.file}`, '');
      for (const issue of group.issues) {
        lines.push(
          `- **[${issue.severity.toUpperCase()}]** ${issue.title}`
        );
        if (issue.line !== undefined) {
          lines.push(`  - Line: ${issue.line}`);
        }
        if (issue.suggestion) {
          lines.push(`  - Suggestion: ${issue.suggestion}`);
        }
      }
      lines.push('');
    }

    this.exportData.emit({ format: 'markdown', data: lines.join('\n') });
  }

  exportJson(): void {
    const data = {
      score: this.score(),
      issues: this.filteredIssues(),
      exportedAt: new Date().toISOString(),
    };
    this.exportData.emit({ format: 'json', data: JSON.stringify(data, null, 2) });
  }
}
