/**
 * Context Manager Type Definitions
 *
 * Local types for the context management system.
 * Shared types are imported from ../../shared/types/rlm.types
 */

import type { ContextSection } from '../../../shared/types/rlm.types';
import type {
  RlmPersistedLoadStats,
  RlmProcessRole,
} from '../context-persistence-loader';

/** Clone-safe, additive residency diagnostics exposed by RLM stats surfaces. */
export interface RlmResidencySnapshot extends RlmPersistedLoadStats {
  processRole: RlmProcessRole;
  counts: {
    durableStores: number;
    durableSections: number;
    activeSessions: number;
    residentMetadataSections: number;
    deferredMetadataSections: number;
    residentContentSections: number;
    residentContentStores: number;
    metadataOnlyStores: number;
    deferredStores: number;
  };
  lastAdmissionFailure?: { reason: string };
}

/**
 * Exported store format for import/export functionality
 */
export interface ExportedStore {
  version: string;
  exportedAt: number;
  store: {
    id: string;
    instanceId: string;
    sections: {
      id: string;
      type: ContextSection['type'];
      name: string;
      content: string;
      tokens: number;
      startOffset: number;
      endOffset: number;
      checksum: string;
      depth: number;
      summarizes?: string[];
      parentSummaryId?: string;
      filePath?: string;
      language?: string;
      sourceUrl?: string;
    }[];
    totalTokens: number;
    totalSize: number;
    createdAt: number;
    accessCount: number;
  };
}

/**
 * Import options for store import
 */
export interface ImportStoreOptions {
  newId?: boolean;
  merge?: boolean;
  targetStoreId?: string;
  instanceId?: string;
}

/**
 * Grep query parameters
 */
export interface GrepParams {
  pattern: string;
  maxResults?: number;
}

/**
 * Slice query parameters
 */
export interface SliceParams {
  start: number;
  end: number;
}

/**
 * Get section query parameters
 */
export interface GetSectionParams {
  sectionId: string;
}

/**
 * Summarize query parameters
 */
export interface SummarizeParams {
  sectionIds: string[];
}

/**
 * Sub-query parameters
 */
export interface SubQueryParams {
  prompt: string;
  contextHints?: string[];
}

/**
 * Semantic search parameters
 */
export interface SemanticSearchParams {
  query: string;
  topK?: number;
  minSimilarity?: number;
  useHyDE?: boolean;
}

/**
 * Query result with sections accessed
 */
export interface QueryResult {
  result: string;
  sectionsAccessed: string[];
}

/**
 * Sub-query result with optional sub-queries
 */
export interface SubQueryResult extends QueryResult {
  subQueries?: import('../../../shared/types/rlm.types').ContextQueryResult[];
}

/**
 * Token savings history entry
 */
export interface TokenSavingsEntry {
  date: string;
  directTokens: number;
  actualTokens: number;
  savingsPercent: number;
}

/**
 * Query statistics entry
 */
export interface QueryStatsEntry {
  type: string;
  count: number;
  avgDuration: number;
  avgTokens: number;
}

/**
 * Storage statistics
 */
export interface StorageStats {
  totalStores: number;
  totalSections: number;
  totalTokens: number;
  totalSizeBytes: number;
  byType: { type: string; count: number; tokens: number }[];
  /** Additive diagnostics; absent only for legacy/non-persistent implementations. */
  residency?: RlmResidencySnapshot;
}

/**
 * Section input for batch operations
 */
export interface SectionInput {
  type: ContextSection['type'];
  name: string;
  content: string;
  metadata?: Partial<ContextSection>;
}

/**
 * Vector search result entry
 */
export interface VectorSearchEntry {
  sectionId: string;
  contentPreview: string;
}

/**
 * Vector search result with similarity
 */
export interface VectorSearchResult {
  entry: VectorSearchEntry;
  similarity: number;
}
