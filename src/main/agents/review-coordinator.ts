/**
 * Review Coordinator
 * Aggregates findings from multiple review agents and deduplicates results
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs/promises';
import z from 'zod';
import type {
  ReviewIssue,
  ReviewAgentConfig,
} from '../../shared/types/review-agent.types';
import { createVcsManager, isGitAvailable } from '../workspace/git/vcs-manager';

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
  instanceId?: string;
  workingDirectory?: string;
  diffOnly?: boolean;
  targetFiles: string[];
  agents: ReviewAgentConfig[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  results: Map<string, ReviewResult>;
  aggregatedIssues: ReviewIssue[];
  summary?: CoordinatedReviewSummary;
  startTime: number;
  endTime?: number;
  contextText?: string;
}

export class ReviewCoordinator extends EventEmitter {
  private static instance: ReviewCoordinator | null = null;
  private activeReviews: Map<string, CoordinatedReview> = new Map();
  private completedReviews: Map<string, CoordinatedReview> = new Map();

  static getInstance(): ReviewCoordinator {
    if (!this.instance) {
      this.instance = new ReviewCoordinator();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    ReviewCoordinator.instance = null;
  }

  private constructor() {
    super();
  }

  // ============ Review Coordination ============

  async startReview(
    targetFiles: string[],
    agents: ReviewAgentConfig[],
    options?: {
      parallel?: boolean;
      confidenceThreshold?: number;
      instanceId?: string;
      workingDirectory?: string;
      diffOnly?: boolean;
      model?: string;
    }
  ): Promise<string> {
    const reviewId = `review-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const review: CoordinatedReview = {
      id: reviewId,
      instanceId: options?.instanceId,
      workingDirectory: options?.workingDirectory,
      diffOnly: options?.diffOnly,
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
    options?: {
      parallel?: boolean;
      confidenceThreshold?: number;
      model?: string;
    }
  ): Promise<void> {
    review.status = 'running';
    const parallel = options?.parallel ?? true;
    const confidenceThreshold = options?.confidenceThreshold ?? 0;

    try {
      if (parallel) {
        // Run all agents in parallel
        const promises = review.agents.map(agent => this.runAgent(review, agent, { model: options?.model }));
        await Promise.all(promises);
      } else {
        // Run agents sequentially
        for (const agent of review.agents) {
          await this.runAgent(review, agent, { model: options?.model });
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

  private async runAgent(
    review: CoordinatedReview,
    agent: ReviewAgentConfig,
    options?: { model?: string }
  ): Promise<void> {
    this.emit('agent:started', { reviewId: review.id, agentId: agent.id });
    const startedAt = Date.now();

    const ctxText = await this.getReviewContext(review);
    const systemPrompt = this.buildAgentSystemPrompt(agent);
    const userPrompt = this.buildAgentUserPrompt(review, agent);

    const invoked = await this.invokeReviewAgent({
      reviewId: review.id,
      agentId: agent.id,
      instanceId: review.instanceId,
      model: options?.model,
      systemPrompt,
      context: ctxText,
      userPrompt,
    });

    const parsedIssues = this.parseAgentIssues(agent.id, invoked.responseText);
    const limitedIssues =
      typeof agent.maxIssues === 'number' && agent.maxIssues > 0
        ? parsedIssues.slice(0, agent.maxIssues)
        : parsedIssues;

    const result: ReviewResult = {
      agentId: agent.id,
      issues: limitedIssues,
      filesAnalyzed: review.targetFiles.length,
      duration: Date.now() - startedAt,
      tokensUsed: invoked.tokensUsed,
    };

    review.results.set(agent.id, result);
    this.emit('agent:completed', {
      reviewId: review.id,
      agentId: agent.id,
      issueCount: result.issues.length
    });
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

  getIssuesByAgent(reviewId: string, agentId?: string, severity?: string): ReviewIssue[] {
    const review = this.getReview(reviewId);
    if (!review) return [];
    let issues = review.aggregatedIssues;
    if (agentId) issues = issues.filter((i) => i.agentId === agentId);
    if (severity) issues = issues.filter((i) => i.severity === severity);
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

  acknowledgeIssue(reviewId: string, issueId: string, acknowledged: boolean): ReviewIssue | null {
    const review = this.getReview(reviewId);
    if (!review) return null;
    const issue = review.aggregatedIssues.find((i) => i.id === issueId);
    if (!issue) return null;
    issue.acknowledged = acknowledged;
    return issue;
  }

  // ============ Agent Invocation + Parsing ============

  private buildAgentSystemPrompt(agent: ReviewAgentConfig): string {
    const base = [
      'You are a strict code review agent.',
      'Return findings ONLY as JSON.',
      'Output format: either a JSON array of issues, or an object: { "issues": [ ... ] }.',
      'Each issue must include: category, severity, title, description.',
      'Optional: file, line, endLine, suggestion, codeSnippet, confidence (0-100).',
      'Do not include markdown outside the JSON. Do not include trailing commentary.',
    ].join('\n');

    return `${base}\n\n${agent.systemPromptAddition || ''}`.trim();
  }

  private buildAgentUserPrompt(review: CoordinatedReview, agent: ReviewAgentConfig): string {
    const filesList = review.targetFiles.map((f) => `- ${f}`).join('\n');
    const focus = agent.focusAreas?.length ? agent.focusAreas.join(', ') : 'general';
    const mode = review.diffOnly ? 'diff' : 'files';

    return [
      `Review the provided ${mode} context for the following files:`,
      filesList || '(no files specified)',
      '',
      `Focus areas: ${focus}`,
      '',
      'Find issues that would matter in production: correctness, edge cases, performance traps, maintainability, and test gaps.',
      'Be concrete: point to file + line when possible, and suggest a fix.',
    ].join('\n');
  }

  private async invokeReviewAgent(params: {
    reviewId: string;
    agentId: string;
    instanceId?: string;
    model?: string;
    systemPrompt: string;
    context: string;
    userPrompt: string;
  }): Promise<{ responseText: string; tokensUsed: number }> {
    const hasInvoker = this.listenerCount('review:invoke-agent') > 0;
    if (!hasInvoker) {
      throw new Error('No review invoker registered (review:invoke-agent)');
    }

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Review agent invocation timed out'));
      }, 5 * 60 * 1000);

      this.emit('review:invoke-agent', {
        correlationId: `${params.reviewId}:${params.agentId}`,
        reviewId: params.reviewId,
        instanceId: params.instanceId,
        agentId: params.agentId,
        model: params.model || 'default',
        systemPrompt: params.systemPrompt,
        context: params.context,
        userPrompt: params.userPrompt,
        callback: (err: string | null, response?: string, tokens?: number) => {
          clearTimeout(timeout);
          if (err) return reject(new Error(err));
          resolve({ responseText: response || '', tokensUsed: tokens || 0 });
        }
      });
    });
  }

  private parseAgentIssues(agentId: string, raw: string): ReviewIssue[] {
    const jsonText = this.extractJson(raw);
    if (!jsonText) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return [];
    }

    const issuesUnknown =
      Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? (parsed as any).issues : null);

    if (!Array.isArray(issuesUnknown)) return [];

    const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
    const IssueInSchema = z.object({
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
      category: z.string().min(1),
      severity: z.string().min(1),
      confidence: z.number().min(0).max(100).optional(),
      dimensionScores: z.record(z.string(), z.number()).optional(),
      title: z.string().min(1),
      description: z.string().min(1),
      suggestion: z.string().optional(),
      codeSnippet: z.string().optional(),
    });

    const out: ReviewIssue[] = [];
    for (const item of issuesUnknown) {
      const parsedIssue = IssueInSchema.safeParse(item);
      if (!parsedIssue.success) continue;

      const severityRaw = parsedIssue.data.severity.toLowerCase().trim();
      const severity = SeveritySchema.safeParse(severityRaw).success
        ? (severityRaw as any)
        : 'medium';

      out.push({
        id: `issue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        agentId,
        file: parsedIssue.data.file,
        line: parsedIssue.data.line,
        endLine: parsedIssue.data.endLine,
        category: parsedIssue.data.category,
        severity,
        confidence: parsedIssue.data.confidence,
        dimensionScores: parsedIssue.data.dimensionScores,
        title: parsedIssue.data.title,
        description: parsedIssue.data.description,
        suggestion: parsedIssue.data.suggestion,
        codeSnippet: parsedIssue.data.codeSnippet,
        reportedAt: Date.now(),
        acknowledged: false,
      });
    }

    return out;
  }

  private extractJson(raw: string): string | null {
    const text = (raw || '').trim();
    if (!text) return null;

    // Prefer fenced JSON blocks.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) return fenced[1].trim();

    // Try parsing entire content.
    if (text.startsWith('{') || text.startsWith('[')) return text;

    const firstObj = text.indexOf('{');
    const firstArr = text.indexOf('[');
    const start = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
    if (start === -1) return null;

    const lastObj = text.lastIndexOf('}');
    const lastArr = text.lastIndexOf(']');
    const end = Math.max(lastObj, lastArr);
    if (end <= start) return null;

    return text.slice(start, end + 1).trim();
  }

  // ============ Context Gathering ============

  private async getReviewContext(review: CoordinatedReview): Promise<string> {
    if (typeof review.contextText === 'string') return review.contextText;

    const wd = review.workingDirectory || process.cwd();
    const files = review.targetFiles || [];
    const diffOnly = Boolean(review.diffOnly);

    const parts: string[] = [];
    parts.push(`Working directory: ${wd}`);
    parts.push(`Files: ${files.length}`);
    parts.push('');

    // Try git diffs first if requested.
    if (diffOnly && isGitAvailable()) {
      try {
        const vcs = createVcsManager(wd);
        if (vcs.isGitRepository()) {
          const diffParts: string[] = [];
          for (const file of files) {
            const rel = this.normalizeFilePath(wd, file);
            const unstaged = vcs.getFileDiff(rel, false);
            const staged = vcs.getFileDiff(rel, true);
            const u = this.diffResultToText(unstaged);
            const s = this.diffResultToText(staged);
            if (u.trim()) {
              diffParts.push(`### Unstaged diff: ${file}\n${u}`);
            }
            if (s.trim()) {
              diffParts.push(`### Staged diff: ${file}\n${s}`);
            }
          }
          if (diffParts.length > 0) {
            parts.push('# Diff');
            parts.push(diffParts.join('\n\n'));
            parts.push('');
          }
        }
      } catch {
        // ignore; fall back to file contents
      }
    }

    // Include file contents if not diffOnly, or if diffOnly produced nothing.
    const hasDiff = parts.some((p) => p.startsWith('# Diff'));
    if (!diffOnly || !hasDiff) {
      parts.push('# Files');
      for (const file of files) {
        const abs = this.normalizeFilePath(wd, file);
        const content = await this.readFileBounded(abs, 120_000);
        parts.push(`## ${file}`);
        parts.push('```');
        parts.push(content);
        parts.push('```');
        parts.push('');
      }
    }

    // Hard cap to avoid pathological contexts.
    const maxChars = 250_000;
    let joined = parts.join('\n');
    if (joined.length > maxChars) {
      joined = joined.slice(0, maxChars) + '\n\n[Context truncated]\n';
    }

    review.contextText = joined;
    return joined;
  }

  private normalizeFilePath(workingDirectory: string, filePath: string): string {
    if (!filePath) return workingDirectory;
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(workingDirectory, filePath);
  }

  private diffResultToText(diff: any): string {
    if (!diff || !Array.isArray(diff.files) || diff.files.length === 0) return '';
    const lines: string[] = [];
    for (const f of diff.files) {
      lines.push(`diff -- ${f.path} (${f.status})`);
      for (const h of f.hunks || []) {
        lines.push(h.content);
      }
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  private async readFileBounded(absPath: string, maxBytes: number): Promise<string> {
    try {
      const buf = await fs.readFile(absPath);
      if (buf.byteLength <= maxBytes) return buf.toString('utf-8');
      return buf.subarray(0, maxBytes).toString('utf-8') + '\n\n[File truncated]\n';
    } catch (e) {
      return `[Unable to read file: ${absPath}]`;
    }
  }
}

// Export singleton getter
export function getReviewCoordinator(): ReviewCoordinator {
  return ReviewCoordinator.getInstance();
}
