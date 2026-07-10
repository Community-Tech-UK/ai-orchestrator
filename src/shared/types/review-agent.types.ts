/**
 * Review Agent Types - Specialized code review agents with different scoring systems
 * Validated patterns from Claude Code pr-review-toolkit
 */

import type { ReviewSeverity } from './review-severity';

/** `info` remains for persisted legacy/UI records; new LLM findings are
 * validated by ReviewFindingPayloadSchema and use ReviewSeverity only. */
export type SeverityLevel = ReviewSeverity | 'info';

export type ScoringSystem =
  | { type: 'confidence'; min: number; max: number; threshold: number }
  | { type: 'severity'; levels: SeverityLevel[]; reportAll: boolean }
  | { type: 'dimensional'; dimensions: string[]; threshold: number };

export interface ReviewIssue {
  id: string;
  agentId: string;

  // Location
  file?: string;
  line?: number;
  endLine?: number;

  // Classification
  category: string;
  severity: SeverityLevel;

  // Scoring (varies by agent)
  confidence?: number; // 0-100 for confidence-based
  dimensionScores?: Record<string, number>; // For dimensional

  // Content
  title: string;
  description: string;
  suggestion?: string;
  codeSnippet?: string;

  // Metadata
  reportedAt: number;
  acknowledged?: boolean;
}

export interface ReviewAgentConfig {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;

  // Focus
  focusAreas: string[];
  filePatterns?: string[]; // Only review matching files

  // Scoring
  scoringSystem: ScoringSystem;

  // Prompt
  systemPromptAddition: string;

  // Limits
  maxIssues?: number;
  timeout?: number;
}

export interface ReviewSession {
  id: string;
  instanceId: string;
  agentIds: string[];

  // Scope
  files: string[];
  diffOnly: boolean;

  // Results
  issues: ReviewIssue[];
  summary?: ReviewSummary;

  // Timing
  startedAt: number;
  completedAt?: number;
}

export interface ReviewSummary {
  totalIssues: number;
  bySeverity: Record<SeverityLevel, number>;
  byAgent: Record<string, number>;
  topFiles: { file: string; count: number }[];
  overallScore?: number;
}

// Review session state management
export type ReviewSessionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ReviewSessionState {
  session: ReviewSession;
  status: ReviewSessionStatus;
  currentAgentIndex: number;
  progress: number; // 0-100
  error?: string;
}

// Events
export type ReviewEventType =
  | 'review:session-started'
  | 'review:session-completed'
  | 'review:agent-started'
  | 'review:agent-completed'
  | 'review:issue-found'
  | 'review:progress';

export interface ReviewEvent {
  type: ReviewEventType;
  session: ReviewSession;
  agentId?: string;
  issue?: ReviewIssue;
  progress?: number;
}

// Helper functions
export function createReviewSession(
  instanceId: string,
  agentIds: string[],
  files: string[],
  diffOnly = false
): ReviewSession {
  return {
    id: `review-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    instanceId,
    agentIds,
    files,
    diffOnly,
    issues: [],
    startedAt: Date.now(),
  };
}

export function createReviewIssue(
  agentId: string,
  category: string,
  severity: SeverityLevel,
  title: string,
  description: string
): ReviewIssue {
  return {
    id: `issue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    agentId,
    category,
    severity,
    title,
    description,
    reportedAt: Date.now(),
    acknowledged: false,
  };
}

export function calculateReviewSummary(session: ReviewSession): ReviewSummary {
  const bySeverity: Record<SeverityLevel, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  const byAgent: Record<string, number> = {};
  const fileCount: Record<string, number> = {};

  for (const issue of session.issues) {
    bySeverity[issue.severity]++;
    byAgent[issue.agentId] = (byAgent[issue.agentId] || 0) + 1;
    if (issue.file) {
      fileCount[issue.file] = (fileCount[issue.file] || 0) + 1;
    }
  }

  const topFiles = Object.entries(fileCount)
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Calculate overall score (100 - weighted penalty)
  const penalty =
    bySeverity.critical * 20 +
    bySeverity.high * 10 +
    bySeverity.medium * 5 +
    bySeverity.low * 2 +
    bySeverity.info * 0;
  const overallScore = Math.max(0, 100 - penalty);

  return {
    totalIssues: session.issues.length,
    bySeverity,
    byAgent,
    topFiles,
    overallScore,
  };
}

export function filterIssuesByThreshold(
  issues: ReviewIssue[],
  config: ReviewAgentConfig
): ReviewIssue[] {
  const { scoringSystem } = config;

  switch (scoringSystem.type) {
    case 'confidence':
      return issues.filter((i) => (i.confidence ?? 0) >= scoringSystem.threshold);

    case 'severity':
      if (scoringSystem.reportAll) return issues;
      return issues.filter((i) => scoringSystem.levels.includes(i.severity));

    case 'dimensional':
      return issues.filter((i) => {
        if (!i.dimensionScores) return false;
        const scores = Object.values(i.dimensionScores);
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        return avg >= scoringSystem.threshold;
      });

    default:
      return issues;
  }
}
