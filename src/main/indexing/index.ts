/**
 * Codebase Indexing System
 *
 * A Cursor-like codebase indexing system providing intelligent,
 * semantic code search capabilities.
 *
 * @module indexing
 */

// Configuration
export * from './config';

// Types (re-export from shared)
export type {
  MerkleNode,
  MerkleTreeConfig,
  ChangedFile,
  TreeSitterChunk,
  ChunkConfig,
  ChunkType,
  FileMetadata,
  ImportInfo,
  ExportInfo,
  SymbolInfo,
  SymbolType,
  FrameworkType,
  IndexingConfig,
  IndexingProgress,
  IndexingStatus,
  IndexingStats,
  IndexingError,
  IndexStats,
  BM25SearchOptions,
  BM25SearchResult,
  HybridSearchOptions,
  HybridSearchResult,
  SymbolSearchResult,
  SearchConfig,
  RerankerConfig,
  RerankResult,
  FileWatcherConfig,
  WatcherStatus,
  FileChangeEvent,
  AssembledContext,
  ContextChunk,
  SymbolContext,
  ModuleContext,
  SearchEvent,
  QueryPattern,
  SearchMetrics,
  ProcessedChunk,
} from '../../shared/types/codebase.types';

// Core Services
export { MerkleTreeManager, getMerkleTreeManager, resetMerkleTreeManager } from './merkle-tree';
export { TreeSitterChunker, getTreeSitterChunker, resetTreeSitterChunker } from './tree-sitter-chunker';
export { MetadataExtractor, getMetadataExtractor, resetMetadataExtractor } from './metadata-extractor';
export { CodebaseIndexingService, getCodebaseIndexingService, resetCodebaseIndexingService } from './indexing-service';
export { BM25Search, getBM25Search, resetBM25Search } from './bm25-search';
export { CrossEncoderReranker, getCrossEncoderReranker, resetCrossEncoderReranker } from './reranker';
export { CodebaseFileWatcher, getCodebaseFileWatcher, resetCodebaseFileWatcher } from './file-watcher';
export { SearchAnalytics, getSearchAnalytics, resetSearchAnalytics } from './search-analytics';
export type { LogSearchOptions } from './search-analytics';
export {
  CodebaseIndexingAutoCoordinator,
  getCodebaseIndexingAutoCoordinator,
  resetCodebaseIndexingAutoCoordinatorForTesting,
} from './codebase-indexing-auto-coordinator';
export type {
  CodebaseIndexingAutoCoordinatorOptions,
  AutoIndexingTarget,
  AutoIndexFileWatcherTarget,
  AutoIndexContextManagerTarget,
  AutoIndexProjectRegistryTarget,
  AutoIndexSettingsTarget,
  CodebaseAutoStatusEvent,
  PreflightResult as CodebaseAutoIndexPreflightResult,
} from './codebase-indexing-auto-coordinator';
export type {
  CodebaseAutoIndexStatus,
  CodebaseAutoIndexState,
  CodebaseAutoIndexSkipReason,
} from '../../shared/types/codebase.types';
