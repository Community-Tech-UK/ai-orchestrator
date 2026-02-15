/**
 * Observation Memory Types
 *
 * Types for the live observation pipeline that captures moment-to-moment
 * decisions, tool choices, reasoning patterns, and inter-agent dynamics.
 */

// ============================================
// Observation Level & Source
// ============================================

/** Severity/importance level of a raw observation */
export type ObservationLevel = 'trace' | 'event' | 'milestone' | 'critical';

/** Source event that produced the observation */
export type ObservationSource =
  | 'instance:output'
  | 'instance:state-update'
  | 'instance:batch-update'
  | 'debate:completed'
  | 'verification:completed'
  | 'outcome:recorded'
  | 'orchestration:task-complete'
  | 'orchestration:task-error'
  | 'orchestration:spawn-child'
  | 'consensus:reached'
  | 'manual';

// ============================================
// Raw Observation (pre-compression)
// ============================================

/** Raw event captured from EventEmitter before compression */
export interface RawObservation {
  id: string;
  source: ObservationSource;
  instanceId?: string;
  sessionId?: string;
  timestamp: number;
  level: ObservationLevel;
  content: string;
  metadata: Record<string, unknown>;
  tokenEstimate: number;
}

// ============================================
// Observation (compressed summary)
// ============================================

/** Compressed observation produced by ObserverAgent */
export interface Observation {
  id: string;
  summary: string;
  sourceIds: string[];
  instanceIds: string[];
  themes: string[];
  keyFindings: string[];
  successSignals: number;
  failureSignals: number;
  timestamp: number;
  createdAt: number;
  ttl: number;
  promoted: boolean;
  tokenCount: number;
}

// ============================================
// Reflection (consolidated pattern)
// ============================================

/** A pattern extracted from multiple observations */
export interface ReflectedPattern {
  description: string;
  type: 'success_pattern' | 'failure_pattern' | 'workflow_optimization' | 'agent_behavior' | 'cross_instance';
  evidence: string[];
  strength: number;
}

/** Consolidated reflection produced by ReflectorAgent */
export interface Reflection {
  id: string;
  title: string;
  insight: string;
  observationIds: string[];
  patterns: ReflectedPattern[];
  confidence: number;
  applicability: string[];
  createdAt: number;
  ttl: number;
  usageCount: number;
  effectivenessScore: number;
  promotedToProcedural: boolean;
}

// ============================================
// Configuration
// ============================================

/** Configuration for the observation pipeline */
export interface ObservationConfig {
  /** Whether observation is enabled */
  enabled: boolean;

  /** Token threshold before flushing buffer to ObserverAgent */
  observeTokenThreshold: number;

  /** Time threshold (ms) before flushing buffer */
  observeTimeThresholdMs: number;

  /** Max raw observations in ring buffer */
  ringBufferSize: number;

  /** Number of observations before triggering reflection */
  reflectObservationThreshold: number;

  /** Default TTL for observations (ms) */
  observationTtlMs: number;

  /** Default TTL for reflections (ms) */
  reflectionTtlMs: number;

  /** Max token budget for policy injection */
  policyTokenBudget: number;

  /** Max reflections to inject per prompt */
  maxReflectionsPerPrompt: number;

  /** Minimum confidence for reflection promotion to procedural */
  promotionConfidenceThreshold: number;

  /** Minimum usage count for reflection promotion */
  promotionUsageThreshold: number;

  /** Minimum effectiveness for reflection promotion */
  promotionEffectivenessThreshold: number;

  /** Strip PII / file paths from observations */
  enablePrivacyFiltering: boolean;

  /** Minimum observation level to capture */
  minLevel: ObservationLevel;
}

/** Default observation configuration */
export const DEFAULT_OBSERVATION_CONFIG: ObservationConfig = {
  enabled: true,
  observeTokenThreshold: 30_000,
  observeTimeThresholdMs: 5 * 60 * 1000,
  ringBufferSize: 500,
  reflectObservationThreshold: 10,
  observationTtlMs: 7 * 24 * 60 * 60 * 1000,
  reflectionTtlMs: 30 * 24 * 60 * 60 * 1000,
  policyTokenBudget: 1500,
  maxReflectionsPerPrompt: 3,
  promotionConfidenceThreshold: 0.8,
  promotionUsageThreshold: 5,
  promotionEffectivenessThreshold: 0.7,
  enablePrivacyFiltering: true,
  minLevel: 'event',
};

// ============================================
// Statistics
// ============================================

/** Aggregate statistics for the observation system */
export interface ObservationStats {
  totalRawCaptured: number;
  totalObservations: number;
  totalReflections: number;
  promotedReflections: number;
  averageConfidence: number;
  averageEffectiveness: number;
  totalInjections: number;
  successfulInjections: number;
  bufferSize: number;
  lastFlushTimestamp: number | null;
  lastReflectionTimestamp: number | null;
}
