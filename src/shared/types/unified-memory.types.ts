/**
 * Unified Memory Types
 * Based on AgeMem pattern (arXiv:2601.01885) for unified long-term and short-term memory
 *
 * Memory Types:
 * - Short-term: Within-session context buffer
 * - Long-term: Persistent semantic memory (via Memory-R1)
 * - Episodic: Past session summaries and patterns
 * - Procedural: Learned workflows and strategies
 */

import type { MemoryEntry } from './memory-r1.types';

// ============ Memory Categories ============

export type MemoryType =
  | 'short_term'
  | 'long_term'
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'skills';

export type TrainingStage = 1 | 2 | 3;

// ============ Configuration ============

export interface UnifiedMemoryConfig {
  // Short-term settings
  shortTermMaxTokens: number; // Context window budget
  shortTermSummarizeAt: number; // When to start summarizing

  // Long-term settings
  longTermMaxEntries: number;
  longTermPersistPath: string;

  // Integration settings
  retrievalBlend: number; // 0-1, weight of long-term in retrieval
  contextBudgetSplit: {
    shortTerm: number; // Fraction for short-term
    longTerm: number; // Fraction for long-term
    procedural: number; // Fraction for procedural
  };

  // Retrieval tuning
  qualityCostProfile?: 'quality' | 'balanced' | 'cost';
  diversityThreshold?: number; // 0-1, higher means more diversity
  rlmMaxResults?: number; // max RLM chunks per tier

  // Semantic cache
  semanticCacheMaxEntries?: number;
  semanticCacheTtlMs?: number;

  // Training settings (Three-Stage Progressive Training)
  trainingStage: TrainingStage;
  enableGRPO: boolean;
}

// ============ Tool Actions ============

export type MemoryToolType =
  | 'store'
  | 'retrieve'
  | 'update'
  | 'delete'
  | 'summarize'
  | 'link';

export interface MemoryToolAction {
  tool: MemoryToolType;
  params: Record<string, unknown>;
  targetType: MemoryType;
}

// ============ Unified State ============

export interface UnifiedMemoryState {
  // Short-term (within session)
  shortTerm: ShortTermState;

  // Long-term (across sessions, via Memory-R1)
  longTerm: LongTermState;

  // Episodic (past sessions)
  episodic: EpisodicState;

  // Procedural (learned workflows)
  procedural: ProceduralState;
}

export interface ShortTermState {
  buffer: string[];
  summaries: string[];
  currentTokens: number;
}

export interface LongTermState {
  entries: Map<string, MemoryEntry>;
  index: SemanticIndex;
}

export interface EpisodicState {
  sessions: SessionMemory[];
  patterns: LearnedPattern[];
}

export interface ProceduralState {
  workflows: WorkflowMemory[];
  strategies: StrategyMemory[];
}

// ============ Semantic Index ============

export interface SemanticIndex {
  embeddings: Map<string, number[]>;
  clusters: Map<string, string[]>;
  lastRebuilt: number;
}

// ============ Session Memory ============

export type SessionOutcome = 'success' | 'partial' | 'failure';

export interface SessionMemory {
  sessionId: string;
  summary: string;
  keyEvents: string[];
  outcome: SessionOutcome;
  lessonsLearned: string[];
  timestamp: number;
}

// ============ Learned Patterns ============

export interface LearnedPattern {
  id: string;
  pattern: string;
  successRate: number;
  usageCount: number;
  contexts: string[];
}

// ============ Workflow Memory ============

/**
 * Reasons why a workflow execution failed
 * Phase 4.1: Failure Analysis
 */
export type FailureReason = 'user_correction' | 'error' | 'timeout' | 'cancelled';

/**
 * Tracks individual failure patterns for learning
 * Phase 4.1: Failure Analysis
 */
export interface FailurePattern {
  reason: FailureReason;
  pattern?: string; // Error message pattern or correction type
  feedback?: string; // User feedback if available
  timestamp: number;
}

/**
 * Extended outcome tracking for workflows with failure analysis
 * Phase 4.1: Failure Analysis
 */
export interface WorkflowOutcome {
  taskId: string;
  success: boolean;
  score: number;
  timestamp: number;
  // Phase 4.1 additions
  failureReason?: FailureReason;
  errorPattern?: string;
  userFeedback?: string;
}

/**
 * Version tracking for workflow evolution
 * Phase 4.2: Workflow Versioning
 */
export interface WorkflowVersion {
  version: number;
  steps: string[];
  createdAt: number;
  reason: 'initial' | 'improvement' | 'error_fix' | 'user_update';
  parentVersion?: number;
}

/**
 * Avoidance rules learned from repeated failures
 * Phase 4.1: Failure Analysis
 */
export interface AvoidanceRule {
  id: string;
  workflowId: string;
  errorPattern: string;
  avoidanceStrategy: string;
  learnedAt: number;
  occurrenceCount: number;
}

export interface WorkflowMemory {
  id: string;
  name: string;
  steps: string[];
  successRate: number;
  applicableContexts: string[];
  // Phase 4.1: Failure tracking
  failurePatterns?: FailurePattern[];
  outcomes?: WorkflowOutcome[];
  // Phase 4.2: Version tracking
  versions?: WorkflowVersion[];
  currentVersion?: number;
}

// ============ Strategy Memory ============

export interface StrategyMemory {
  id: string;
  strategy: string;
  conditions: string[];
  outcomes: StrategyOutcome[];
}

export interface StrategyOutcome {
  taskId: string;
  success: boolean;
  score: number;
  timestamp: number;
}

// ============ Retrieval Results ============

export interface UnifiedRetrievalResult {
  shortTerm: string[];
  longTerm: string[];
  procedural: string[];
  skills: string[];
  wakeContext?: string;
  totalTokens: number;
}

export interface RetrievalOptions {
  types?: MemoryType[];
  maxTokens?: number;
  sessionId?: string;
  instanceId?: string;
  includeWakeContext?: boolean;
  wakeContextWing?: string;
}

// ============ Statistics ============

export interface UnifiedMemoryStats {
  shortTermTokens: number;
  longTermEntries: number;
  episodicSessions: number;
  learnedPatterns: number;
  workflows: number;
  strategies: number;
}

// ============ Serialization ============

export interface UnifiedMemorySnapshot {
  version: string;
  timestamp: number;
  shortTerm: {
    buffer: string[];
    summaries: string[];
  };
  episodic: {
    sessions: SessionMemory[];
    patterns: LearnedPattern[];
  };
  procedural: {
    workflows: WorkflowMemory[];
    strategies: StrategyMemory[];
  };
}

// ============ Cross-Project Learning (Phase 4.3) ============

/**
 * Pattern types that can be shared across projects
 * Named differently from PatternType in self-improvement.types.ts to avoid conflict
 */
export type CrossProjectPatternType =
  | 'workflow'
  | 'strategy'
  | 'error_recovery'
  | 'tool_sequence'
  | 'prompt_structure';

/**
 * Configuration for cross-project learning
 * Privacy-first: disabled by default
 */
export interface CrossProjectConfig {
  enabled: boolean; // Must be explicitly enabled
  isolationMode: 'full' | 'anonymized' | 'disabled';
  allowedPatternTypes: CrossProjectPatternType[]; // Whitelist what can be shared
}

/**
 * A pattern that has been promoted to global scope
 * Source project info is deliberately NOT stored
 */
export interface GlobalPattern {
  id: string;
  type: CrossProjectPatternType;
  description: string;
  steps: string[];
  metadata: Record<string, unknown>;
  totalSuccessRate: number;
  projectCount: number;
  isGlobal: true;
  lastUpdated: number;
}

/**
 * Pattern after anonymization - ready for global storage
 */
export interface AnonymizedPattern {
  id: string;
  type: CrossProjectPatternType;
  description: string; // Generalized description
  steps: string[]; // Anonymized steps
  metadata: Record<string, unknown>; // Stripped of project identifiers
  successRate: number;
}
