# Codebase Indexing API Reference

Complete API reference for the codebase indexing system.

## Table of Contents

- [CodebaseIndexingService](#codebaseindexingservice)
- [HybridSearchService (removed)](#hybridsearchservice-removed-2026-06)
- [BM25Search](#bm25search)
- [MerkleTreeManager](#merkletreemanager)
- [TreeSitterChunker](#treesitterchunker)
- [MetadataExtractor](#metadataextractor)
- [CrossEncoderReranker](#crossencoderreranker)
- [CodebaseFileWatcher](#codebasefilewatcher)
- [IPC Channels](#ipc-channels)
- [Type Definitions](#type-definitions)

---

## CodebaseIndexingService

Main orchestrator for codebase indexing operations.

**Location:** `src/main/indexing/indexing-service.ts`

### Constructor

```typescript
constructor(config?: Partial<IndexingConfig>)
```

### Methods

#### indexCodebase

Index a codebase directory.

```typescript
async indexCodebase(
  storeId: string,
  rootPath: string,
  options?: { force?: boolean; filePatterns?: string[] }
): Promise<IndexingStats>
```

**Parameters:**
- `storeId` - Unique identifier for the index store
- `rootPath` - Absolute path to the codebase root
- `options.force` - If true, reindex all files ignoring cache
- `options.filePatterns` - Override default file patterns

**Returns:** `IndexingStats` with indexing results

**Example:**
```typescript
const stats = await indexingService.indexCodebase(
  'project-123',
  '/home/user/project',
  { force: true }
);
```

#### indexFile

Index a single file.

```typescript
async indexFile(storeId: string, filePath: string): Promise<void>
```

**Parameters:**
- `storeId` - Index store identifier
- `filePath` - Absolute path to the file

#### removeFile

Remove a file from the index.

```typescript
async removeFile(storeId: string, filePath: string): Promise<void>
```

#### getProgress

Get current indexing progress.

```typescript
getProgress(): IndexingProgress
```

**Returns:**
```typescript
{
  status: 'idle' | 'scanning' | 'chunking' | 'complete' | 'error' | 'cancelled',
  totalFiles: number,
  processedFiles: number,
  totalChunks: number,
  currentFile?: string,
  startedAt?: number,
  completedAt?: number,
  errorMessage?: string
}
```

#### getStats

Get index statistics.

```typescript
async getStats(storeId: string): Promise<IndexStats>
```

#### cancel

Cancel ongoing indexing.

```typescript
cancel(): void
```

#### configure

Update configuration.

```typescript
configure(config: Partial<IndexingConfig>): void
```

### Events

```typescript
indexingService.on('progress', (progress: IndexingProgress) => {});
indexingService.on('file:indexed', ({ storeId, filePath }) => {});
indexingService.on('file:error', ({ storeId, filePath, error }) => {});
indexingService.on('file:removed', ({ storeId, filePath }) => {});
indexingService.on('indexing:cancelled', () => {});
```

---

## HybridSearchService (removed 2026-06)

`HybridSearchService` and `ContextAssembler` combined BM25 with vector search over
code embeddings (RRF fusion + HyDE expansion). They were **removed in 2026-06**: no
read path ever consumed code embeddings, so the entire code-vector pipeline (embedding
generation in `CodebaseIndexingService` plus the hybrid reader) was deleted. See
`docs/plans/2026-06-06-code-vector-search-removal-plan_completed.md`.

Code search now runs through the codemem retrieval path
(`getCodeRetrievalService().search(...)` — BM25 full-text + symbols, with a ripgrep
fallback). See [docs/CODEBASE_INDEXING.md](./CODEBASE_INDEXING.md).

The `HybridSearchOptions` / `HybridSearchResult` **types** are retained as the
renderer-compatible shape that codemem results are mapped into (`matchType` is `'bm25'`
or `'hybrid'` for symbol hits); code is not embedded into a vector store. The shared
`VectorStore` / `EmbeddingService` stack remains in use for non-code memory.

---

## BM25Search

SQLite FTS5-based keyword search.

**Location:** `src/main/indexing/bm25-search.ts`

### Methods

#### search

Perform keyword search.

```typescript
search(options: BM25SearchOptions): BM25SearchResult[]
```

**Parameters:**
```typescript
interface BM25SearchOptions {
  query: string;
  storeId: string;
  limit?: number;          // Max results (default: 50)
  offset?: number;         // Pagination offset
  filePatterns?: string[]; // Filter by file patterns
  boostSymbols?: boolean;  // Boost symbol matches (default: true)
}
```

**Returns:**
```typescript
interface BM25SearchResult {
  sectionId: string;
  filePath: string;
  content: string;
  score: number;
  matchedTerms: string[];
  snippet: string;
  startLine?: number;
  endLine?: number;
}
```

#### addDocument

Add a document to the index.

```typescript
addDocument(doc: {
  storeId: string;
  sectionId: string;
  filePath: string;
  content: string;
  symbols?: string[];
}): void
```

#### removeDocument

Remove a document from the index.

```typescript
removeDocument(sectionId: string): void
```

#### getStats

Get FTS index statistics.

```typescript
getStats(storeId: string): { totalDocuments: number; totalTokens: number }
```

#### rebuildIndex

Optimize the FTS index.

```typescript
rebuildIndex(): void
```

---

## MerkleTreeManager

Efficient change detection using content hashing.

**Location:** `src/main/indexing/merkle-tree.ts`

### Methods

#### buildTree

Build a merkle tree from a directory.

```typescript
async buildTree(rootPath: string): Promise<MerkleNode>
```

**Returns:**
```typescript
interface MerkleNode {
  hash: string;
  path: string;
  isDirectory: boolean;
  children?: Map<string, MerkleNode>;
  modifiedAt?: number;
  size?: number;
}
```

#### diffTrees

Find changes between two trees.

```typescript
diffTrees(oldTree: MerkleNode, newTree: MerkleNode): ChangedFile[]
```

**Returns:**
```typescript
interface ChangedFile {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  oldHash?: string;
  newHash?: string;
}
```

#### serialize / deserialize

Persist and restore trees.

```typescript
serialize(tree: MerkleNode): Buffer
deserialize(data: Buffer): MerkleNode
```

#### collectAllFilePaths

Get all file paths in a tree.

```typescript
collectAllFilePaths(tree: MerkleNode): string[]
```

#### getTreeStats

Get tree statistics.

```typescript
getTreeStats(tree: MerkleNode): { fileCount: number; totalSize: number }
```

---

## TreeSitterChunker

Language-aware code chunking.

**Location:** `src/main/indexing/tree-sitter-chunker.ts`

### Constructor

```typescript
constructor(config?: Partial<ChunkConfig>)
```

### Methods

#### chunk

Split code into semantic chunks.

```typescript
chunk(content: string, language: string, filePath: string): TreeSitterChunk[]
```

**Parameters:**
- `content` - File content
- `language` - Language identifier (e.g., 'typescript', 'python')
- `filePath` - Original file path (for metadata)

**Returns:**
```typescript
interface TreeSitterChunk {
  content: string;
  type: ChunkType;        // 'function' | 'class' | 'method' | etc.
  name?: string;          // Symbol name if applicable
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
```

---

## MetadataExtractor

Extract file metadata including imports, exports, and symbols.

**Location:** `src/main/indexing/metadata-extractor.ts`

### Methods

#### extractFileMetadata

Extract metadata from a file.

```typescript
async extractFileMetadata(filePath: string, content: string): Promise<FileMetadata>
```

**Returns:**
```typescript
interface FileMetadata {
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
```

---

## CrossEncoderReranker

Rerank results using cross-encoder scoring.

**Location:** `src/main/indexing/reranker.ts`

### Constructor

```typescript
constructor(config: RerankerConfig)
```

**Config:**
```typescript
interface RerankerConfig {
  provider: 'cohere' | 'voyage' | 'local';
  model?: string;
  apiKey?: string;
  batchSize?: number;
  maxCandidates?: number;
}
```

### Methods

#### rerank

Rerank search candidates.

```typescript
async rerank(query: string, candidates: HybridSearchResult[]): Promise<HybridSearchResult[]>
```

---

## CodebaseFileWatcher

Watch for file changes and trigger re-indexing.

**Location:** `src/main/indexing/file-watcher.ts`

### Constructor

```typescript
constructor(
  storeId: string,
  rootPath: string,
  config: FileWatcherConfig
)
```

**Config:**
```typescript
interface FileWatcherConfig {
  debounceMs: number;         // Debounce delay (default: 500)
  ignorePatterns: string[];   // Patterns to ignore
  maxPendingChanges: number;  // Max queued changes (default: 1000)
  autoIndex: boolean;         // Auto-reindex on changes (default: true)
}
```

### Methods

#### start

Start watching for changes.

```typescript
start(): void
```

#### stop

Stop watching.

```typescript
stop(): void
```

#### getStatus

Get watcher status.

```typescript
getStatus(): WatcherStatus
```

### Events

```typescript
watcher.on('started', () => {});
watcher.on('stopped', () => {});
watcher.on('changes:detected', ({ count }) => {});
watcher.on('changes:processed', ({ count }) => {});
```

---

## IPC Channels

For Electron renderer-to-main communication.

### Indexing Channels

| Channel | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `codebase:index:store` | invoke | `{storeId, rootPath, options?}` | `IndexingStats` |
| `codebase:index:file` | invoke | `{storeId, filePath}` | `void` |
| `codebase:index:cancel` | invoke | `void` | `void` |
| `codebase:index:status` | invoke | `void` | `IndexingProgress` |
| `codebase:index:stats` | invoke | `{storeId}` | `IndexStats` |
| `codebase:index:progress` | on | - | `IndexingProgress` |

### Search Channels

| Channel | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `codebase:search` | invoke | `HybridSearchOptions` | `HybridSearchResult[]` |
| `codebase:search:symbols` | invoke | `{storeId, query}` | `SymbolSearchResult[]` |

### Watcher Channels

| Channel | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `codebase:watcher:start` | invoke | `{storeId, rootPath}` | `void` |
| `codebase:watcher:stop` | invoke | `{storeId}` | `void` |
| `codebase:watcher:status` | invoke | `{storeId}` | `WatcherStatus` |
| `codebase:watcher:changes` | on | - | `{storeId, count}` |

---

## Type Definitions

All types are exported from `src/shared/types/codebase.types.ts`.

### IndexingConfig

```typescript
interface IndexingConfig {
  maxConcurrentFiles: number;
  batchSize: number;
  minIntervalMs: number;
  maxTokensPerMinute: number;
  maxChunkTokens: number;
  minChunkTokens: number;
  overlapTokens: number;
  includePatterns: string[];
  excludePatterns: string[];
  maxFileSize: number;
  persistAfterBatch: boolean;
  compactOnCompletion: boolean;
}
// Note: embeddingProvider / embeddingModel were removed in 2026-06 along with
// code-embedding generation (code chunks are not embedded into a vector store).
```

### SearchConfig

```typescript
interface SearchConfig {
  bm25Weight: number;
  vectorWeight: number;
  useHyDE: boolean;
  hydeContextHints: 'auto' | 'code' | 'documentation' | 'none';
  useReranking: boolean;
  rerankerProvider: 'cohere' | 'voyage' | 'local';
  rerankerModel?: string;
  defaultTopK: number;
  maxTopK: number;
  minScore: number;
  diversityThreshold: number;
}
```

### ChunkType

```typescript
type ChunkType =
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
```

### SymbolType

```typescript
type SymbolType =
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
```

### FrameworkType

```typescript
type FrameworkType =
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
```

---

## Singleton Access

Most services have singleton accessors:

```typescript
import { getCodebaseIndexingService } from './indexing/indexing-service';
import { getBM25Search } from './indexing/bm25-search';
import { getMerkleTreeManager } from './indexing/merkle-tree';
import { getTreeSitterChunker } from './indexing/tree-sitter-chunker';
import { getMetadataExtractor } from './indexing/metadata-extractor';

// Reset singletons (useful for testing)
import { resetCodebaseIndexingService } from './indexing/indexing-service';
```
