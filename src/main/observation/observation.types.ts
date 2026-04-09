/**
 * Observation Memory Types
 *
 * Types for the live observation pipeline that captures moment-to-moment
 * decisions, tool choices, reasoning patterns, and inter-agent dynamics.
 */

export type ObservationLevel = 'trace' | 'event' | 'milestone' | 'critical';

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

export interface ReflectedPattern {
  description: string;
  type: 'success_pattern' | 'failure_pattern' | 'workflow_optimization' | 'agent_behavior' | 'cross_instance';
  evidence: string[];
  strength: number;
}

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

export interface ObservationConfig {
  enabled: boolean;
  observeTokenThreshold: number;
  observeTimeThresholdMs: number;
  ringBufferSize: number;
  reflectObservationThreshold: number;
  observationTtlMs: number;
  reflectionTtlMs: number;
  policyTokenBudget: number;
  maxReflectionsPerPrompt: number;
  promotionConfidenceThreshold: number;
  promotionUsageThreshold: number;
  promotionEffectivenessThreshold: number;
  enablePrivacyFiltering: boolean;
  minLevel: ObservationLevel;
}

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
