/**
 * Review Coordinator
 * Aggregates findings from multiple review agents and deduplicates results
 */

import { EventEmitter } from 'events';
import type {
  ReviewIssue,
  ReviewAgentConfig,
} from '../../shared/types/review-agent.types';

// Local types for review coordination
export interface ReviewResult {
  agentId: string;
  issues: ReviewIssue[];
  filesAnalyzed: number;
  duration: number;
  tokensUsed: number;
}

export interface ReviewCoordinatorConfig {
  defaultConfidenceThreshold: number;
  maxConcurrentAgents: number;
  timeoutMs: number;
}

export interface CoordinatedReviewSummary {
  totalIssues: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  byFile: Record<string, number>;
  agentsRun: number;
  filesAnalyzed: number;
  duration: number;
  averageConfidence: number;
}

export interface CoordinatedReview {
  id: string;
  targetFiles: string[];
  agents: ReviewAgentConfig[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  results: Map<string, ReviewResult>;
  aggregatedIssues: ReviewIssue[];
  summary?: CoordinatedReviewSummary;
  startTime: number;
  endTime?: number;
}

export class ReviewCoordinator extends EventEmitter {
  private static instance: ReviewCoordinator;
  private activeReviews: Map<string, CoordinatedReview> = new Map();
  private completedReviews: Map<string, CoordinatedReview> = new Map();

  static getInstance(): ReviewCoordinator {
    if (!this.instance) {
      this.instance = new ReviewCoordinator();
    }
    return this.instance;
  }

  private constructor() {
    super();
  }

  // ============ Review Coordination ============

  async startReview(
    targetFiles: string[],
    agents: ReviewAgentConfig[],
    options?: { parallel?: boolean; confidenceThreshold?: number }
  ): Promise<string> {
    const reviewId = `review-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const review: CoordinatedReview = {
      id: reviewId,
      targetFiles,
      agents,
      status: 'pending',
      results: new Map(),
      aggregatedIssues: [],
      startTime: Date.now(),
    };

    this.activeReviews.set(reviewId, review);
    this.emit('review:started', { reviewId, targetFiles, agents: agents.map(a => a.id) });

    // Start the review process
    this.runReview(review, options).catch(error => {
      review.status = 'failed';
      this.emit('review:failed', { reviewId, error: error.message });
    });

    return reviewId;
  }

  private async runReview(
    review: CoordinatedReview,
    options?: { parallel?: boolean; confidenceThreshold?: number }
  ): Promise<void> {
    review.status = 'running';
    const parallel = options?.parallel ?? true;
    const confidenceThreshold = options?.confidenceThreshold ?? 0;

    try {
      if (parallel) {
        // Run all agents in parallel
        const promises = review.agents.map(agent => this.runAgent(review, agent));
        await Promise.all(promises);
      } else {
        // Run agents sequentially
        for (const agent of review.agents) {
          await this.runAgent(review, agent);
        }
      }

      // Aggregate and deduplicate findings
      review.aggregatedIssues = this.aggregateIssues(review, confidenceThreshold);

      // Generate summary
      review.summary = this.generateSummary(review);

      review.status = 'completed';
      review.endTime = Date.now();

      // Move to completed
      this.activeReviews.delete(review.id);
      this.completedReviews.set(review.id, review);

      this.emit('review:completed', {
        reviewId: review.id,
        issueCount: review.aggregatedIssues.length,
        summary: review.summary,
      });
    } catch (error) {
      review.status = 'failed';
      throw error;
    }
  }

  private async runAgent(review: CoordinatedReview, agent: ReviewAgentConfig): Promise<void> {
    this.emit('agent:started', { reviewId: review.id, agentId: agent.id });

    // Placeholder for actual agent execution
    // In real implementation, this would spawn the agent and collect results
    const result: ReviewResult = {
      agentId: agent.id,
      issues: [],
      filesAnalyzed: review.targetFiles.length,
      duration: 0,
      tokensUsed: 0,
    };

    // Simulate agent finding issues (actual implementation calls LLM)
    // This is a placeholder - real implementation would use the review agent

    review.results.set(agent.id, result);
    this.emit('agent:completed', { reviewId: review.id, agentId: agent.id, issueCount: result.issues.length });
  }

  // ============ Issue Aggregation ============

  private aggregateIssues(review: CoordinatedReview, confidenceThreshold: number): ReviewIssue[] {
    const allIssues: ReviewIssue[] = [];

    // Collect all issues from all agents
    for (const result of review.results.values()) {
      allIssues.push(...result.issues);
    }

    // Filter by confidence threshold
    const filteredIssues = allIssues.filter(issue => (issue.confidence ?? 0) >= confidenceThreshold);

    // Deduplicate similar issues
    const deduplicatedIssues = this.deduplicateIssues(filteredIssues);

    // Sort by severity and confidence
    return this.sortIssues(deduplicatedIssues);
  }

  private deduplicateIssues(issues: ReviewIssue[]): ReviewIssue[] {
    const seen = new Map<string, ReviewIssue>();

    for (const issue of issues) {
      const key = this.getIssueKey(issue);
      const existing = seen.get(key);

      if (!existing) {
        seen.set(key, issue);
      } else {
        // Keep the one with higher confidence
        if ((issue.confidence ?? 0) > (existing.confidence ?? 0)) {
          seen.set(key, issue);
        }
        // Merge agents that found this issue
        // (would need to track this in a real implementation)
      }
    }

    return Array.from(seen.values());
  }

  private getIssueKey(issue: ReviewIssue): string {
    // Create a unique key based on location and category
    return `${issue.file || 'unknown'}:${issue.line || 0}:${issue.category}:${issue.title.toLowerCase().slice(0, 50)}`;
  }

  private sortIssues(issues: ReviewIssue[]): ReviewIssue[] {
    const severityOrder: Record<string, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      info: 4,
    };

    return issues.sort((a, b) => {
      // First by severity
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (severityDiff !== 0) return severityDiff;

      // Then by confidence (higher first)
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    });
  }

  // ============ Summary Generation ============

  private generateSummary(review: CoordinatedReview): CoordinatedReviewSummary {
    const issues = review.aggregatedIssues;

    const bySeverity: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };

    const byCategory: Record<string, number> = {};
    const byFile: Record<string, number> = {};

    for (const issue of issues) {
      bySeverity[issue.severity]++;
      byCategory[issue.category] = (byCategory[issue.category] || 0) + 1;
      if (issue.file) {
        byFile[issue.file] = (byFile[issue.file] || 0) + 1;
      }
    }

    return {
      totalIssues: issues.length,
      bySeverity,
      byCategory,
      byFile,
      agentsRun: review.agents.length,
      filesAnalyzed: review.targetFiles.length,
      duration: (review.endTime || Date.now()) - review.startTime,
      averageConfidence: issues.length > 0 ? issues.reduce((sum, i) => sum + (i.confidence ?? 0), 0) / issues.length : 0,
    };
  }

  // ============ Public API ============

  getReview(reviewId: string): CoordinatedReview | undefined {
    return this.activeReviews.get(reviewId) || this.completedReviews.get(reviewId);
  }

  getActiveReviews(): CoordinatedReview[] {
    return Array.from(this.activeReviews.values());
  }

  getIssues(reviewId: string, options?: { severity?: string; category?: string; file?: string }): ReviewIssue[] {
    const review = this.getReview(reviewId);
    if (!review) return [];

    let issues = review.aggregatedIssues;

    if (options?.severity) {
      issues = issues.filter(i => i.severity === options.severity);
    }
    if (options?.category) {
      issues = issues.filter(i => i.category === options.category);
    }
    if (options?.file) {
      issues = issues.filter(i => i.file === options.file);
    }

    return issues;
  }

  getSummary(reviewId: string): CoordinatedReviewSummary | undefined {
    const review = this.getReview(reviewId);
    return review?.summary;
  }

  async cancelReview(reviewId: string): Promise<boolean> {
    const review = this.activeReviews.get(reviewId);
    if (!review || review.status !== 'running') return false;

    review.status = 'failed';
    this.activeReviews.delete(reviewId);
    this.emit('review:cancelled', { reviewId });
    return true;
  }

  // ============ Export ============

  exportAsMarkdown(reviewId: string): string {
    const review = this.getReview(reviewId);
    if (!review) return '';

    const lines: string[] = [];
    lines.push('# Code Review Report\n');
    lines.push(`**Files Analyzed**: ${review.targetFiles.length}`);
    lines.push(`**Agents Used**: ${review.agents.map(a => a.name).join(', ')}`);
    lines.push(`**Total Issues**: ${review.aggregatedIssues.length}\n`);

    if (review.summary) {
      lines.push('## Summary\n');
      lines.push(`| Severity | Count |`);
      lines.push(`|----------|-------|`);
      for (const [severity, count] of Object.entries(review.summary.bySeverity)) {
        if (count > 0) {
          lines.push(`| ${severity} | ${count} |`);
        }
      }
      lines.push('');
    }

    lines.push('## Issues\n');
    for (const issue of review.aggregatedIssues) {
      lines.push(`### [${issue.severity.toUpperCase()}] ${issue.title}\n`);
      lines.push(`**File**: ${issue.file || 'N/A'}${issue.line ? `:${issue.line}` : ''}`);
      lines.push(`**Category**: ${issue.category}`);
      lines.push(`**Confidence**: ${issue.confidence}%\n`);
      lines.push(issue.description);
      if (issue.suggestion) {
        lines.push(`\n**Suggestion**: ${issue.suggestion}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

// Export singleton getter
export function getReviewCoordinator(): ReviewCoordinator {
  return ReviewCoordinator.getInstance();
}
