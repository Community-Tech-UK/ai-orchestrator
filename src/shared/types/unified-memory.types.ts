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

export type MemoryType = 'short_term' | 'long_term' | 'episodic' | 'semantic' | 'procedural';

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

  // Training settings (Three-Stage Progressive Training)
  trainingStage: TrainingStage;
  enableGRPO: boolean;
}

// ============ Tool Actions ============

export type MemoryToolType = 'store' | 'retrieve' | 'update' | 'delete' | 'summarize' | 'link';

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

export interface WorkflowMemory {
  id: string;
  name: string;
  steps: string[];
  successRate: number;
  applicableContexts: string[];
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
  totalTokens: number;
}

export interface RetrievalOptions {
  types?: MemoryType[];
  maxTokens?: number;
  sessionId?: string;
  instanceId?: string;
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
