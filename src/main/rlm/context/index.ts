/**
 * Context Manager Module - Barrel Exports
 *
 * This module provides the decomposed context management functionality.
 * Import from this file for clean, organized access to context features.
 */

// Types
export type {
  ExportedStore,
  ImportStoreOptions,
  GrepParams,
  SliceParams,
  GetSectionParams,
  SummarizeParams,
  SubQueryParams,
  SemanticSearchParams,
  QueryResult,
  SubQueryResult,
  TokenSavingsEntry,
  QueryStatsEntry,
  StorageStats,
  SectionInput,
  VectorSearchEntry,
  VectorSearchResult
} from './context.types';

// Utilities
export {
  estimateTokens,
  computeChecksum,
  cosineSimilarity,
  splitContent,
  forceSplit,
  generateId,
  generateShortId
} from './context.utils';

// Cache (Bloom filter)
export {
  createBloomFilter,
  bloomAdd,
  bloomMightContain,
  getBloomHashes,
  rebuildBloomFilterForStore,
  mightContainTerm
} from './context-cache';

// Storage operations
export type { StorageDependencies } from './context-storage';
export {
  createStore,
  addSection,
  addSectionsBatch,
  removeSection,
  deleteStore,
  persistSummary,
  prepareSummaryLevel
} from './context-storage';

// Search operations
export type { SearchDependencies } from './context-search';
export {
  executeGrep,
  executeSlice,
  getSection,
  executeSemanticSearch,
  searchStoreOptimized
} from './context-search';

// Session management
export type { SessionDependencies } from './context-session';
export {
  startSession,
  endSession,
  updateSessionAfterQuery,
  getSessionStats,
  updateSessionTokens
} from './context-session';

// Analytics
export type { AnalyticsDependencies } from './context-analytics';
export {
  getTokenSavingsHistory,
  getQueryStats,
  getStorageStats,
  getStoreStats
} from './context-analytics';

// Serialization (import/export)
export type { SerializationDependencies } from './context-serialization';
export { exportStore, importStore } from './context-serialization';

// Query engine
export type { QueryEngineDependencies } from './context-query-engine';
export { executeQuery } from './context-query-engine';
