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
export { HybridSearchService, getHybridSearchService, resetHybridSearchService } from './hybrid-search';
export { CrossEncoderReranker, getCrossEncoderReranker, resetCrossEncoderReranker } from './reranker';
export { CodebaseFileWatcher, getCodebaseFileWatcher, resetCodebaseFileWatcher } from './file-watcher';
export { ContextAssembler, getContextAssembler, resetContextAssembler } from './context-assembler';
export type { AssembleContextOptions } from './context-assembler';
export { SearchAnalytics, getSearchAnalytics, resetSearchAnalytics } from './search-analytics';
export type { LogSearchOptions } from './search-analytics';
