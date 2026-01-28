/**
 * Codebase Indexing Service
 *
 * Main orchestrator for codebase indexing. Coordinates file scanning,
 * chunking, metadata extraction, and embedding generation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { glob } from 'glob';
import type {
  IndexingConfig,
  IndexingProgress,
  IndexingStats,
  IndexingError,
  IndexStats,
  FileMetadata,
  ProcessedChunk,
  ChangedFile,
  MerkleNode,
} from '../../shared/types/codebase.types';
import { DEFAULT_INDEXING_CONFIG, shouldIncludeFile, getLanguageFromExtension } from './config';
import { MerkleTreeManager, getMerkleTreeManager } from './merkle-tree';
import { TreeSitterChunker, getTreeSitterChunker } from './tree-sitter-chunker';
import { MetadataExtractor, getMetadataExtractor } from './metadata-extractor';
import { BM25Search, getBM25Search } from './bm25-search';
import { VectorStore, getVectorStore } from '../rlm/vector-store';
import { RLMContextManager } from '../rlm/context-manager';
import { RLMDatabase } from '../persistence/rlm-database';
import { generateId } from '../rlm/context/context.utils';

// ============================================================================
// Types
// ============================================================================

interface IndexingState {
  status: IndexingProgress['status'];
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  embeddedChunks: number;
  currentFile?: string;
  startedAt?: number;
  completedAt?: number;
  errorMessage?: string;
  errors: IndexingError[];
  cancelled: boolean;
}

// ============================================================================
// CodebaseIndexingService Class
// ============================================================================

export class CodebaseIndexingService extends EventEmitter {
  private config: IndexingConfig;
  private db: RLMDatabase;
  private merkleTree: MerkleTreeManager;
  private chunker: TreeSitterChunker;
  private metadataExtractor: MetadataExtractor;
  private vectorStore: VectorStore;
  private bm25: BM25Search;
  private contextManager: RLMContextManager;

  private state: IndexingState = {
    status: 'idle',
    totalFiles: 0,
    processedFiles: 0,
    totalChunks: 0,
    embeddedChunks: 0,
    errors: [],
    cancelled: false,
  };

  constructor(config: Partial<IndexingConfig> = {}) {
    super();
    this.config = { ...DEFAULT_INDEXING_CONFIG, ...config };

    this.db = RLMDatabase.getInstance();
    this.merkleTree = getMerkleTreeManager();
    this.chunker = getTreeSitterChunker({
      maxTokens: this.config.maxChunkTokens,
      minTokens: this.config.minChunkTokens,
      overlapTokens: this.config.overlapTokens,
    });
    this.metadataExtractor = getMetadataExtractor();
    this.vectorStore = getVectorStore();
    this.bm25 = getBM25Search(this.db['db']);
    this.contextManager = RLMContextManager.getInstance();
  }

  /**
   * Index a codebase directory into a store.
   */
  async indexCodebase(
    storeId: string,
    rootPath: string,
    options: { force?: boolean; filePatterns?: string[] } = {}
  ): Promise<IndexingStats> {
    const { force = false, filePatterns } = options;
    const absoluteRoot = path.resolve(rootPath);

    this.resetState();
    this.state.status = 'scanning';
    this.state.startedAt = Date.now();
    this.emitProgress();

    try {
      // Build or load merkle tree for change detection
      const { changedFiles, currentTree } = await this.detectChanges(storeId, absoluteRoot, force);

      if (changedFiles.length === 0 && !force) {
        this.state.status = 'complete';
        this.state.completedAt = Date.now();
        this.emitProgress();

        return this.buildStats();
      }

      // Scan files to process
      const filesToProcess = force
        ? await this.scanDirectory(absoluteRoot, filePatterns)
        : changedFiles.filter((f) => f.type !== 'deleted').map((f) => path.join(absoluteRoot, f.path));

      this.state.totalFiles = filesToProcess.length;
      this.emitProgress();

      // Process files in batches
      this.state.status = 'chunking';
      const allChunks: ProcessedChunk[] = [];

      for (let i = 0; i < filesToProcess.length; i += this.config.batchSize) {
        if (this.state.cancelled) {
          this.state.status = 'cancelled';
          this.emitProgress();
          return this.buildStats();
        }

        const batch = filesToProcess.slice(i, i + this.config.batchSize);
        const batchChunks = await this.processBatch(batch, absoluteRoot);
        allChunks.push(...batchChunks);

        // Persist batch if configured
        if (this.config.persistAfterBatch) {
          await this.persistChunks(storeId, batchChunks);
        }
      }

      // Handle deletions
      const deletedFiles = changedFiles.filter((f) => f.type === 'deleted');
      for (const file of deletedFiles) {
        await this.removeFileFromIndex(storeId, file.path);
      }

      // Persist all chunks if not done incrementally
      if (!this.config.persistAfterBatch) {
        await this.persistChunks(storeId, allChunks);
      }

      // Generate embeddings
      this.state.status = 'embedding';
      this.emitProgress();
      await this.generateEmbeddings(storeId, allChunks);

      // Save merkle tree
      await this.saveMerkleTree(storeId, absoluteRoot, currentTree);

      // Compact if configured
      if (this.config.compactOnCompletion) {
        this.bm25.rebuildIndex();
      }

      this.state.status = 'complete';
      this.state.completedAt = Date.now();
      this.emitProgress();

      return this.buildStats();
    } catch (error) {
      this.state.status = 'error';
      this.state.errorMessage = error instanceof Error ? error.message : String(error);
      this.emitProgress();
      throw error;
    }
  }

  /**
   * Index a single file.
   */
  async indexFile(storeId: string, filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);

    try {
      const content = await fs.promises.readFile(absolutePath, 'utf-8');
      const language = getLanguageFromExtension(filePath);
      const metadata = await this.metadataExtractor.extractFileMetadata(absolutePath, content);

      // Remove existing sections for this file
      await this.removeFileFromIndex(storeId, absolutePath);

      // Chunk the file
      const chunks = this.chunker.chunk(content, language, filePath);

      // Create processed chunks with metadata
      const processedChunks: ProcessedChunk[] = chunks.map((chunk) => ({
        ...chunk,
        filePath: absolutePath,
        metadata,
      }));

      // Persist and embed
      await this.persistChunks(storeId, processedChunks);
      await this.generateEmbeddings(storeId, processedChunks);

      this.emit('file:indexed', { storeId, filePath: absolutePath });
    } catch (error) {
      this.emit('file:error', {
        storeId,
        filePath: absolutePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Remove a file from the index.
   */
  async removeFile(storeId: string, filePath: string): Promise<void> {
    await this.removeFileFromIndex(storeId, filePath);
    this.emit('file:removed', { storeId, filePath });
  }

  /**
   * Get indexing progress.
   */
  getProgress(): IndexingProgress {
    return {
      status: this.state.status,
      totalFiles: this.state.totalFiles,
      processedFiles: this.state.processedFiles,
      totalChunks: this.state.totalChunks,
      embeddedChunks: this.state.embeddedChunks,
      currentFile: this.state.currentFile,
      startedAt: this.state.startedAt,
      completedAt: this.state.completedAt,
      errorMessage: this.state.errorMessage,
    };
  }

  /**
   * Get index statistics for a store.
   */
  async getStats(storeId: string): Promise<IndexStats> {
    const ftsStats = this.bm25.getStats(storeId);
    const vectorStats = await this.vectorStore.getStats();
    const storeStats = this.contextManager.getStoreStats(storeId);

    return {
      storeId,
      totalFiles: 0, // Would need to track this
      totalChunks: storeStats?.sections || 0,
      totalTokens: storeStats?.totalTokens || 0,
      totalEmbeddings: vectorStats?.totalVectors || 0,
      lastIndexedAt: Date.now(),
      indexSize: 0, // Would need to calculate
    };
  }

  /**
   * Cancel ongoing indexing.
   */
  cancel(): void {
    this.state.cancelled = true;
    this.emit('indexing:cancelled');
  }

  /**
   * Configure the indexing service.
   */
  configure(config: Partial<IndexingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ==========================================================================
  // Private: Change Detection
  // ==========================================================================

  private async detectChanges(
    storeId: string,
    rootPath: string,
    force: boolean
  ): Promise<{ changedFiles: ChangedFile[]; currentTree: MerkleNode }> {
    // Build current tree
    const currentTree = await this.merkleTree.buildTree(rootPath);

    if (force) {
      return {
        changedFiles: this.merkleTree.collectAllFilePaths(currentTree).map((p) => ({
          path: p,
          type: 'added' as const,
        })),
        currentTree,
      };
    }

    // Load previous tree
    const previousTree = await this.loadMerkleTree(storeId, rootPath);

    if (!previousTree) {
      return {
        changedFiles: this.merkleTree.collectAllFilePaths(currentTree).map((p) => ({
          path: p,
          type: 'added' as const,
        })),
        currentTree,
      };
    }

    // Diff trees
    const changedFiles = this.merkleTree.diffTrees(previousTree, currentTree);

    return { changedFiles, currentTree };
  }

  private async loadMerkleTree(storeId: string, rootPath: string): Promise<MerkleNode | null> {
    try {
      const stmt = this.db['db'].prepare(`
        SELECT tree_blob FROM codebase_trees
        WHERE store_id = ? AND root_path = ?
        ORDER BY created_at DESC LIMIT 1
      `);

      const row = stmt.get(storeId, rootPath) as { tree_blob: Buffer } | undefined;

      if (row && row.tree_blob) {
        return this.merkleTree.deserialize(row.tree_blob);
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private async saveMerkleTree(storeId: string, rootPath: string, tree: MerkleNode): Promise<void> {
    const treeBlob = this.merkleTree.serialize(tree);
    const stats = this.merkleTree.getTreeStats(tree);

    try {
      const stmt = this.db['db'].prepare(`
        INSERT INTO codebase_trees (id, store_id, root_path, tree_blob, file_count, total_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        generateId('tree'),
        storeId,
        rootPath,
        treeBlob,
        stats.fileCount,
        stats.totalSize,
        Date.now()
      );
    } catch (error) {
      console.error('Failed to save merkle tree:', error);
    }
  }

  // ==========================================================================
  // Private: File Scanning
  // ==========================================================================

  private async scanDirectory(rootPath: string, patterns?: string[]): Promise<string[]> {
    const includePatterns = patterns || this.config.includePatterns;
    const files: string[] = [];

    for (const pattern of includePatterns) {
      const matches = await glob(pattern, {
        cwd: rootPath,
        ignore: this.config.excludePatterns,
        absolute: true,
        nodir: true,
      });
      files.push(...matches);
    }

    // Dedupe and filter
    const uniqueFiles = [...new Set(files)];
    const validFiles: string[] = [];

    for (const file of uniqueFiles) {
      try {
        const stats = await fs.promises.stat(file);
        if (shouldIncludeFile(file, this.config, stats.size)) {
          validFiles.push(file);
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }

    return validFiles;
  }

  // ==========================================================================
  // Private: Processing
  // ==========================================================================

  private async processBatch(files: string[], rootPath: string): Promise<ProcessedChunk[]> {
    const allChunks: ProcessedChunk[] = [];

    await Promise.all(
      files.map(async (filePath) => {
        if (this.state.cancelled) return;

        this.state.currentFile = filePath;
        this.emitProgress();

        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const language = getLanguageFromExtension(filePath);
          const relativePath = path.relative(rootPath, filePath);

          // Extract metadata
          const metadata = await this.metadataExtractor.extractFileMetadata(filePath, content);

          // Chunk the file
          const chunks = this.chunker.chunk(content, language, filePath);

          // Create processed chunks with metadata
          for (const chunk of chunks) {
            allChunks.push({
              ...chunk,
              filePath,
              metadata,
            });
            this.state.totalChunks++;
          }

          this.state.processedFiles++;
          this.emitProgress();
        } catch (error) {
          this.state.errors.push({
            file: filePath,
            error: error instanceof Error ? error.message : String(error),
            recoverable: true,
          });
        }
      })
    );

    return allChunks;
  }

  private async persistChunks(storeId: string, chunks: ProcessedChunk[]): Promise<void> {
    for (const chunk of chunks) {
      const sectionId = generateId('sec');

      // Add to context store
      this.contextManager.addSection(
        storeId,
        'file',
        chunk.name || path.basename(chunk.filePath),
        chunk.content,
        {
          filePath: chunk.filePath,
          language: chunk.language,
        }
      );

      // Add to FTS index
      const symbols = chunk.metadata.symbols.map((s) => s.name);
      this.bm25.addDocument({
        storeId,
        sectionId,
        filePath: chunk.filePath,
        content: chunk.content,
        symbols,
      });

      // Save file metadata
      await this.saveFileMetadata(storeId, chunk.metadata);
    }
  }

  private async saveFileMetadata(storeId: string, metadata: FileMetadata): Promise<void> {
    try {
      const stmt = this.db['db'].prepare(`
        INSERT OR REPLACE INTO file_metadata (
          id, store_id, path, relative_path, language, size, lines, hash,
          last_modified, is_entry_point, is_test_file, is_config_file,
          framework, imports_json, exports_json, symbols_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        generateId('meta'),
        storeId,
        metadata.path,
        metadata.relativePath,
        metadata.language,
        metadata.size,
        metadata.lines,
        metadata.hash,
        metadata.lastModified,
        metadata.isEntryPoint ? 1 : 0,
        metadata.isTestFile ? 1 : 0,
        metadata.isConfigFile ? 1 : 0,
        metadata.framework || null,
        JSON.stringify(metadata.imports),
        JSON.stringify(metadata.exports),
        JSON.stringify(metadata.symbols),
        Date.now(),
        Date.now()
      );
    } catch (error) {
      console.error('Failed to save file metadata:', error);
    }
  }

  // ==========================================================================
  // Private: Embedding Generation
  // ==========================================================================

  private async generateEmbeddings(storeId: string, chunks: ProcessedChunk[]): Promise<void> {
    // Throttle embedding generation
    for (let i = 0; i < chunks.length; i++) {
      if (this.state.cancelled) break;

      const chunk = chunks[i];

      try {
        await this.vectorStore.addSection(storeId, generateId('sec'), chunk.content);
        this.state.embeddedChunks++;

        // Throttle
        if (i > 0 && i % 10 === 0) {
          await new Promise((resolve) => setTimeout(resolve, this.config.minIntervalMs));
        }

        this.emitProgress();
      } catch (error) {
        console.error(`Failed to embed chunk from ${chunk.filePath}:`, error);
      }
    }
  }

  // ==========================================================================
  // Private: Removal
  // ==========================================================================

  private async removeFileFromIndex(storeId: string, filePath: string): Promise<void> {
    try {
      // Get sections for this file
      const stmt = this.db['db'].prepare(`
        SELECT id FROM context_sections
        WHERE store_id = ? AND file_path = ?
      `);

      const sections = stmt.all(storeId, filePath) as Array<{ id: string }>;

      for (const section of sections) {
        // Remove from FTS
        this.bm25.removeDocument(section.id);

        // Remove from vector store
        await this.vectorStore.removeSection(section.id);

        // Remove from context store
        this.contextManager.removeSection(storeId, section.id);
      }

      // Remove metadata
      const metaStmt = this.db['db'].prepare(`
        DELETE FROM file_metadata WHERE store_id = ? AND path = ?
      `);
      metaStmt.run(storeId, filePath);
    } catch (error) {
      console.error(`Failed to remove file from index: ${filePath}`, error);
    }
  }

  // ==========================================================================
  // Private: State Management
  // ==========================================================================

  private resetState(): void {
    this.state = {
      status: 'idle',
      totalFiles: 0,
      processedFiles: 0,
      totalChunks: 0,
      embeddedChunks: 0,
      errors: [],
      cancelled: false,
    };
  }

  private emitProgress(): void {
    this.emit('progress', this.getProgress());
  }

  private buildStats(): IndexingStats {
    return {
      filesIndexed: this.state.processedFiles,
      chunksCreated: this.state.totalChunks,
      tokensProcessed: 0, // Would need to sum from chunks
      embeddingsCreated: this.state.embeddedChunks,
      duration: (this.state.completedAt || Date.now()) - (this.state.startedAt || Date.now()),
      errors: this.state.errors,
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let codebaseIndexingServiceInstance: CodebaseIndexingService | null = null;

export function getCodebaseIndexingService(
  config?: Partial<IndexingConfig>
): CodebaseIndexingService {
  if (!codebaseIndexingServiceInstance) {
    codebaseIndexingServiceInstance = new CodebaseIndexingService(config);
  }
  return codebaseIndexingServiceInstance;
}

export function resetCodebaseIndexingService(): void {
  codebaseIndexingServiceInstance = null;
}
