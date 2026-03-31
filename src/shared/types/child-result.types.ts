/**
 * Child Result Types - Structured storage for child instance outputs
 *
 * This system allows children to report structured results that are stored
 * externally, preventing context overflow in parent instances.
 */

import type { ChildErrorClassification } from './child-announce.types';

/**
 * Types of artifacts a child can report
 */
export type ArtifactType =
  | 'finding' // A discovery or issue found
  | 'recommendation' // A suggested action
  | 'code_snippet' // A piece of code with location
  | 'file_reference' // A reference to a file
  | 'screenshot' // Browser screenshot or visual capture
  | 'console_log_excerpt' // Console output or browser log excerpt
  | 'network_error_summary' // Network failure summary or HAR excerpt
  | 'trace_reference' // Trace, HAR, or other heavyweight browser artifact
  | 'decision' // A decision made with rationale
  | 'data' // Structured data (JSON, etc.)
  | 'command' // A command that was executed
  | 'error' // An error encountered
  | 'warning' // A warning or concern
  | 'success' // A successful outcome
  | 'metric'; // A measurement or statistic

/**
 * Severity levels for findings
 */
export type ArtifactSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Individual artifact from child work
 */
export interface ChildArtifact {
  id: string;
  type: ArtifactType;
  severity?: ArtifactSeverity;
  title?: string;
  content: string;
  file?: string; // File path if relevant
  lines?: string; // Line range (e.g., "45-52")
  metadata?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Structured result reported by a child
 */
export interface ChildResult {
  id: string;
  childId: string;
  parentId: string;
  taskDescription: string;

  // Summary (always loaded into parent context)
  summary: string;
  summaryTokens: number;

  // Structured artifacts (loaded on demand)
  artifacts: ChildArtifact[];
  artifactCount: number;

  // Conclusions and key decisions (compact, loadable separately)
  conclusions: string[];
  keyDecisions: string[];

  // Full transcript reference (never loaded unless explicitly requested)
  fullTranscriptRef: string; // File path to full output
  fullTranscriptTokens: number;

  // Metadata
  success: boolean;
  /** Structured error classification (populated on failure) */
  errorClassification?: ChildErrorClassification;
  completedAt: number;
  duration: number; // ms
  tokensUsed: number;
}

/**
 * Compact summary returned to parent by default
 */
export interface ChildResultSummary {
  resultId: string;
  childId: string;
  summary: string;
  success: boolean;
  artifactCount: number;
  artifactTypes: ArtifactType[];
  conclusionCount: number;
  hasFullTranscript: boolean;
  completedAt: number;
}

/**
 * Command for child to report structured result
 */
export interface ReportResultCommand {
  action: 'report_result';
  summary: string;
  success?: boolean; // Defaults to true
  artifacts?: Array<{
    type: ArtifactType;
    severity?: ArtifactSeverity;
    title?: string;
    content: string;
    file?: string;
    lines?: string;
    metadata?: Record<string, unknown>;
  }>;
  conclusions?: string[];
  keyDecisions?: string[];
}

/**
 * Command for parent to get child summary
 */
export interface GetChildSummaryCommand {
  action: 'get_child_summary';
  childId: string;
}

/**
 * Command for parent to get child artifacts
 */
export interface GetChildArtifactsCommand {
  action: 'get_child_artifacts';
  childId: string;
  types?: ArtifactType[]; // Filter by type
  severity?: ArtifactSeverity[]; // Filter by severity
  limit?: number; // Max artifacts to return
}

/**
 * Command for parent to get specific section of child output
 */
export interface GetChildSectionCommand {
  action: 'get_child_section';
  childId: string;
  section: 'conclusions' | 'decisions' | 'artifacts' | 'full';
  artifactId?: string; // Get specific artifact with context
  includeContext?: boolean; // Include surrounding context
}

/**
 * Response for get_child_summary
 */
export interface ChildSummaryResponse {
  resultId: string;
  childId: string;
  summary: string;
  success: boolean;
  artifactCount: number;
  artifactTypes: ArtifactType[];
  conclusions: string[];
  hasMoreDetails: boolean;
  commands: {
    getArtifacts: string;
    getDecisions: string;
    getFull: string;
  };
}

/**
 * Response for get_child_artifacts
 */
export interface ChildArtifactsResponse {
  childId: string;
  artifacts: ChildArtifact[];
  total: number;
  filtered: number;
  hasMore: boolean;
}

/**
 * Response for get_child_section
 */
export interface ChildSectionResponse {
  childId: string;
  section: string;
  content: string;
  tokenCount: number;
}
