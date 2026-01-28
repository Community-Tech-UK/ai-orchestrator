/**
 * Codebase Indexing System Types
 *
 * Types for the Cursor-like codebase indexing system that provides
 * intelligent, semantic code search capabilities.
 */

// ============================================================================
// Merkle Tree Types
// ============================================================================

export interface MerkleNode {
  hash: string;
  path: string;
  isDirectory: boolean;
  children?: Map<string, MerkleNode>;
  modifiedAt?: number;
  size?: number;
}

export interface MerkleTreeConfig {
  ignorePatterns: string[];
  includeExtensions: string[];
  hashAlgorithm: 'xxhash' | 'md5' | 'sha256';
}

export interface ChangedFile {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  oldHash?: string;
  newHash?: string;
}

// ============================================================================
// Tree-sitter Chunking Types
// ============================================================================

export type ChunkType =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'import'
  | 'export'
  | 'block'
  | 'module'
  | 'constant'
  | 'variable';

export interface TreeSitterChunk {
  content: string;
  type: ChunkType;
  name?: string;
  language: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  tokens: number;
  nodeType: string;
  parentType?: string;
  signature?: string;
  docComment?: string;
}

export interface ChunkConfig {
  maxTokens: number;
  minTokens: number;
  overlapTokens: number;
  preserveImports: boolean;
  preserveComments: boolean;
}

// ============================================================================
// File Metadata Types
// ============================================================================

export interface FileMetadata {
  path: string;
  relativePath: string;
  language: string;
  size: number;
  lines: number;
  hash: string;
  lastModified: number;
  imports: ImportInfo[];
  exports: ExportInfo[];
  symbols: SymbolInfo[];
  framework?: FrameworkType;
  isEntryPoint?: boolean;
  isTestFile?: boolean;
  isConfigFile?: boolean;
}

export type FrameworkType =
  | 'angular'
  | 'react'
  | 'vue'
  | 'svelte'
  | 'express'
  | 'fastapi'
  | 'nestjs'
  | 'django'
  | 'rails'
  | 'spring';

export interface ImportInfo {
  source: string;
  specifiers: string[];
  isTypeOnly: boolean;
  isDefault: boolean;
  line: number;
}

export interface ExportInfo {
  name: string;
  type: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'default' | 'namespace';
  line: number;
  isDefault: boolean;
}

export interface SymbolInfo {
  name: string;
  type: SymbolType;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  signature?: string;
  docComment?: string;
  visibility?: 'public' | 'private' | 'protected';
  isAsync?: boolean;
  isStatic?: boolean;
  isExported?: boolean;
}

export type SymbolType =
  | 'function'
  | 'class'
  | 'method'
  | 'property'
  | 'variable'
  | 'interface'
  | 'type'
  | 'constant'
  | 'enum'
  | 'namespace';

// ============================================================================
// Indexing Types
// ============================================================================

export interface IndexingConfig {
  // Concurrency
  maxConcurrentFiles: number;
  batchSize: number;

  // Throttling
  minIntervalMs: number;
  maxTokensPerMinute: number;

  // Chunking
  maxChunkTokens: number;
  minChunkTokens: number;
  overlapTokens: number;

  // Filtering
  includePatterns: string[];
  excludePatterns: string[];
  maxFileSize: number;

  // Embedding
  embeddingProvider: 'auto' | 'ollama' | 'openai' | 'voyage' | 'local';
  embeddingModel?: string;

  // Persistence
  persistAfterBatch: boolean;
  compactOnCompletion: boolean;
}

export interface IndexingProgress {
  status: IndexingStatus;
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  embeddedChunks: number;
  currentFile?: string;
  startedAt?: number;
  completedAt?: number;
  errorMessage?: string;
  eta?: number;
}

export type IndexingStatus =
  | 'idle'
  | 'scanning'
  | 'chunking'
  | 'embedding'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface IndexingStats {
  filesIndexed: number;
  chunksCreated: number;
  tokensProcessed: number;
  embeddingsCreated: number;
  duration: number;
  errors: IndexingError[];
}

export interface IndexingError {
  file: string;
  error: string;
  recoverable: boolean;
}

export interface IndexStats {
  storeId: string;
  totalFiles: number;
  totalChunks: number;
  totalTokens: number;
  totalEmbeddings: number;
  lastIndexedAt: number;
  indexSize: number;
}

// ============================================================================
// Search Types
// ============================================================================

export interface BM25SearchOptions {
  query: string;
  storeId: string;
  limit?: number;
  offset?: number;
  filePatterns?: string[];
  boostSymbols?: boolean;
}

export interface BM25SearchResult {
  sectionId: string;
  filePath: string;
  content: string;
  score: number;
  matchedTerms: string[];
  snippet: string;
  startLine?: number;
  endLine?: number;
}

export interface HybridSearchOptions {
  query: string;
  storeId: string;
  topK?: number;
  useHyDE?: boolean;
  bm25Weight?: number;
  vectorWeight?: number;
  minScore?: number;
  rerank?: boolean;
  filePatterns?: string[];
}

export interface HybridSearchResult {
  sectionId: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  bm25Score?: number;
  vectorScore?: number;
  rerankScore?: number;
  matchType: 'bm25' | 'vector' | 'hybrid';
  language?: string;
  chunkType?: ChunkType;
  symbolName?: string;
}

export interface SymbolSearchResult {
  symbol: SymbolInfo;
  filePath: string;
  score: number;
  context?: string;
}

// ============================================================================
// Search Configuration
// ============================================================================

export interface SearchConfig {
  // Hybrid search weights
  bm25Weight: number;
  vectorWeight: number;

  // HyDE
  useHyDE: boolean;
  hydeContextHints: 'auto' | 'code' | 'documentation' | 'none';

  // Reranking
  useReranking: boolean;
  rerankerProvider: 'cohere' | 'voyage' | 'local';
  rerankerModel?: string;

  // Results
  defaultTopK: number;
  maxTopK: number;
  minScore: number;

  // Diversity
  diversityThreshold: number;
}

// ============================================================================
// Reranker Types
// ============================================================================

export interface RerankerConfig {
  provider: 'cohere' | 'voyage' | 'local';
  model?: string;
  apiKey?: string;
  batchSize?: number;
  maxCandidates?: number;
}

export interface RerankResult {
  index: number;
  score: number;
}

// ============================================================================
// File Watcher Types
// ============================================================================

export interface FileWatcherConfig {
  debounceMs: number;
  ignorePatterns: string[];
  maxPendingChanges: number;
  autoIndex: boolean;
}

export interface WatcherStatus {
  storeId: string;
  rootPath: string;
  isWatching: boolean;
  pendingChanges: number;
  lastProcessedAt?: number;
}

export interface FileChangeEvent {
  path: string;
  type: 'add' | 'change' | 'unlink';
  timestamp: number;
}

// ============================================================================
// Context Assembly Types
// ============================================================================

export interface AssembledContext {
  mainChunks: ContextChunk[];
  relatedSymbols: SymbolContext[];
  importedModules: ModuleContext[];
  totalTokens: number;
}

export interface ContextChunk {
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  relevanceScore: number;
  language?: string;
  chunkType?: ChunkType;
}

export interface SymbolContext {
  name: string;
  definition: string;
  filePath: string;
  line: number;
  usedBy: string[];
}

export interface ModuleContext {
  modulePath: string;
  exports: string[];
  summary?: string;
}

// ============================================================================
// Analytics Types
// ============================================================================

export interface SearchEvent {
  id: string;
  query: string;
  storeId: string;
  timestamp: number;
  resultsCount: number;
  topResultScore: number;
  clickedResults: number[];
  searchDurationMs: number;
  hydeUsed: boolean;
  rerankUsed: boolean;
}

export interface QueryPattern {
  pattern: string;
  frequency: number;
  avgResultScore: number;
  avgClickDepth: number;
  successRate: number;
}

export interface SearchMetrics {
  totalSearches: number;
  avgResultScore: number;
  avgClickDepth: number;
  zeroResultRate: number;
  avgSearchDuration: number;
}

// ============================================================================
// Processed Chunk (Internal)
// ============================================================================

export interface ProcessedChunk extends TreeSitterChunk {
  filePath: string;
  metadata: FileMetadata;
}

// ============================================================================
// IPC Payloads
// ============================================================================

export interface CodebaseIndexStorePayload {
  storeId: string;
  rootPath: string;
  options?: { force?: boolean; filePatterns?: string[] };
}

export interface CodebaseIndexFilePayload {
  storeId: string;
  filePath: string;
}

export interface CodebaseSearchPayload {
  options: HybridSearchOptions;
}

export interface CodebaseWatcherPayload {
  storeId: string;
  rootPath?: string;
}
