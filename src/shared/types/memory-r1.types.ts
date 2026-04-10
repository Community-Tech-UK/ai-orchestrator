/**
 * Memory-R1 Types
 * RL-Trained Memory Management based on arXiv:2508.19828
 *
 * Core Innovation: Instead of handcrafted memory rules, the system learns
 * when to remember, update, or forget through trial and error.
 */

import type { KGTriple } from './knowledge-graph.types';

// ============ Core Operations ============

export type MemoryOperation = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

export type MemorySourceType = 'user_input' | 'agent_output' | 'tool_result' | 'derived';

// ============ Memory Entry ============

export interface MemoryEntry {
  id: string;
  content: string;
  embedding?: number[]; // For semantic retrieval

  // Metadata
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;

  // Source tracking
  sourceType: MemorySourceType;
  sourceSessionId: string;
  sourceMessageId?: string;

  // Relevance scoring (updated by RL)
  relevanceScore: number; // 0-1
  confidenceScore: number; // 0-1

  // Linking (A-Mem pattern from arXiv:2502.12110)
  linkedEntries: string[]; // IDs of related entries
  tags: string[];
  entityTriples?: KGTriple[];

  // Lifecycle
  expiresAt?: number; // Optional TTL
  isArchived: boolean;
}

// ============ Manager State ============

export interface MemoryManagerState {
  entries: Map<string, MemoryEntry>;
  totalEntries: number;
  totalTokens: number;

  // Statistics for RL training
  operationHistory: MemoryOperationLog[];
  retrievalHistory: RetrievalLog[];
}

export interface MemoryOperationLog {
  id: string;
  operation: MemoryOperation;
  entryId: string;
  reason: string;
  timestamp: number;

  // For training feedback
  taskId: string;
  outcomeScore?: number; // Filled after task completion
}

export interface RetrievalLog {
  id: string;
  query: string;
  retrievedIds: string[];
  selectedIds: string[]; // Which ones the Answer Agent used
  timestamp: number;

  // For training feedback
  taskId: string;
  retrievalQuality?: number; // 0-1, based on task success
}

// ============ Configuration ============

export interface MemoryManagerConfig {
  maxEntries: number; // Maximum entries to maintain
  maxTokens: number; // Token budget for memory

  // Retrieval settings
  topK: number; // Top-K entries to retrieve
  similarityThreshold: number; // Minimum similarity for retrieval

  // RL training settings
  enableLearning: boolean;
  learningRate: number;
  rewardDiscount: number;
  batchSize: number;

  // Embedding model
  embeddingModel: string;
  embeddingDimension: number;
}

// ============ Decision Types ============

export interface MemoryManagerDecision {
  operation: MemoryOperation;
  entryId?: string; // For UPDATE/DELETE
  content?: string; // For ADD/UPDATE
  confidence: number;
  reasoning: string;
}

export interface AnswerAgentContext {
  query: string;
  retrievedMemories: MemoryEntry[];
  selectedMemories: MemoryEntry[];
  response: string;
  tokensUsed: number;
}

// ============ Statistics ============

export interface MemoryR1Stats {
  totalEntries: number;
  totalTokens: number;
  avgRelevanceScore: number;
  operationCounts: Record<MemoryOperation, number>;
  recentRetrievals: number;
  cacheHitRate: number;
}

// ============ Serialization ============

export interface MemoryR1Snapshot {
  version: string;
  timestamp: number;
  entries: [string, MemoryEntry][];
  operationHistory: MemoryOperationLog[];
  retrievalHistory: RetrievalLog[];
}
