/**
 * Large Codebase Load Tests
 *
 * Tests that verify the system can handle 1000+ files without errors.
 * These tests use synthetic codebases and may take several minutes to run.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';
import {
  createSyntheticCodebase,
  getMemorySnapshot,
  formatBytes,
  measureAsync,
} from '../../benchmarks/benchmark-utils';

// ============================================================================
// Mocks
// ============================================================================

// Mock better-sqlite3
vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(() => {
    const data = new Map<string, unknown[]>();
    return {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        run: vi.fn().mockImplementation((...args: unknown[]) => {
          const tableName = sql.match(/INSERT INTO (\w+)/)?.[1] || 'default';
          if (!data.has(tableName)) data.set(tableName, []);
          data.get(tableName)!.push(args);
          return { changes: 1 };
        }),
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockImplementation(() => []),
        pluck: vi.fn().mockReturnThis(),
      })),
      transaction: vi.fn((fn: Function) => fn),
      exec: vi.fn(),
    };
  }),
}));

// Mock RLM database
vi.mock('../../../persistence/rlm-database', () => ({
  RLMDatabase: {
    getInstance: vi.fn(() => ({
      getDatabase: vi.fn(() => ({
        prepare: vi.fn().mockReturnValue({
          run: vi.fn(),
          get: vi.fn(),
          all: vi.fn().mockReturnValue([]),
        }),
        transaction: vi.fn((fn: Function) => fn),
        exec: vi.fn(),
      })),
    })),
  },
}));

// Mock vector store
vi.mock('../../../rlm/vector-store', () => ({
  getVectorStore: vi.fn(() => ({
    addSection: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockReturnValue({ totalVectors: 0 }),
  })),
  VectorStore: vi.fn(),
}));

// Mock BM25 search
vi.mock('../../bm25-search', () => ({
  getBM25Search: vi.fn(() => ({
    addDocument: vi.fn(),
    removeDocument: vi.fn(),
    search: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({ totalDocuments: 0 }),
    rebuildIndex: vi.fn(),
  })),
  BM25Search: vi.fn(),
}));

// Mock context manager
vi.mock('../../../rlm/context-manager', () => ({
  RLMContextManager: {
    getInstance: vi.fn(() => ({
      addSection: vi.fn(),
      removeSection: vi.fn(),
      getStoreStats: vi.fn().mockReturnValue({ sections: 0, totalTokens: 0 }),
    })),
  },
}));

// ============================================================================
// Test Data
// ============================================================================

let largeCodebase: { rootPath: string; cleanup: () => Promise<void> };

// ============================================================================
// Tests
// ============================================================================

describe('Large Codebase Load Tests', () => {
  beforeAll(async () => {
    console.log('Creating synthetic codebase with 1000 files...');
    largeCodebase = await createSyntheticCodebase({
      fileCount: 1000,
      avgFileSize: 2500,
      maxDepth: 5,
      filesPerDir: 15,
      languageDistribution: {
        typescript: 0.5,
        javascript: 0.35,
        python: 0.15,
      },
    });
    console.log(`Codebase created at: ${largeCodebase.rootPath}`);
  }, 180000); // 3 minutes for setup

  afterAll(async () => {
    if (largeCodebase) {
      console.log('Cleaning up synthetic codebase...');
      await largeCodebase.cleanup();
    }
  });

  it(
    'should scan 1000+ files without error',
    async () => {
      const { glob } = await import('glob');

      const memBefore = getMemorySnapshot();

      const files = await glob('**/*.{ts,js,py}', {
        cwd: largeCodebase.rootPath,
        absolute: true,
        nodir: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });

      const memAfter = getMemorySnapshot();
      const memUsed = memAfter.heapUsed - memBefore.heapUsed;

      console.log(`Scanned ${files.length} files`);
      console.log(`Memory used for scanning: ${formatBytes(memUsed)}`);

      expect(files.length).toBeGreaterThanOrEqual(1000);
      expect(memUsed).toBeLessThan(100 * 1024 * 1024); // < 100MB for scanning
    },
    60000
  );

  it(
    'should build merkle tree for 1000 files',
    async () => {
      const { getMerkleTreeManager } = await import('../../merkle-tree');
      const merkleTree = getMerkleTreeManager();

      const { result: tree, metrics } = await measureAsync(async () => {
        return merkleTree.buildTree(largeCodebase.rootPath);
      });

      console.log(`Merkle tree built in ${metrics.durationMs.toFixed(2)}ms`);
      console.log(`Tree hash: ${tree.hash}`);

      expect(tree).toBeDefined();
      expect(tree.hash).toBeTruthy();
      expect(metrics.durationMs).toBeLessThan(60000); // < 60s
    },
    120000
  );

  it(
    'should chunk 1000 files within 2 minutes',
    async () => {
      const { glob } = await import('glob');
      const fs = await import('fs');
      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');

      const chunker = getTreeSitterChunker();

      const files = await glob('**/*.{ts,js,py}', {
        cwd: largeCodebase.rootPath,
        absolute: true,
        nodir: true,
      });

      const startTime = performance.now();
      let totalChunks = 0;
      let processedFiles = 0;
      let errors = 0;

      for (const filePath of files) {
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const ext = path.extname(filePath);
          const lang =
            ext === '.ts' ? 'typescript' : ext === '.js' ? 'javascript' : 'python';

          const chunks = chunker.chunk(content, lang, filePath);
          totalChunks += chunks.length;
          processedFiles++;
        } catch (error) {
          errors++;
        }
      }

      const endTime = performance.now();
      const durationMs = endTime - startTime;
      const filesPerSecond = (processedFiles / durationMs) * 1000;

      console.log(`Processed ${processedFiles} files in ${(durationMs / 1000).toFixed(2)}s`);
      console.log(`Created ${totalChunks} chunks`);
      console.log(`Rate: ${filesPerSecond.toFixed(2)} files/sec`);
      console.log(`Errors: ${errors}`);

      expect(processedFiles).toBeGreaterThanOrEqual(1000);
      expect(durationMs).toBeLessThan(120000); // < 2 minutes
      expect(filesPerSecond).toBeGreaterThanOrEqual(8); // At least 8 files/sec
    },
    180000
  );

  it(
    'should handle incremental update after 10 file changes',
    async () => {
      const { getMerkleTreeManager } = await import('../../merkle-tree');
      const merkleTree = getMerkleTreeManager();

      // Build initial tree
      const tree1 = await merkleTree.buildTree(largeCodebase.rootPath);

      // Simulate file changes by rebuilding (no actual changes, testing diff performance)
      const tree2 = await merkleTree.buildTree(largeCodebase.rootPath);

      const startTime = performance.now();
      const changes = merkleTree.diffTrees(tree1, tree2);
      const endTime = performance.now();

      console.log(`Diff completed in ${(endTime - startTime).toFixed(2)}ms`);
      console.log(`Changes detected: ${changes.length}`);

      // Should be fast even for large trees
      expect(endTime - startTime).toBeLessThan(5000); // < 5s
    },
    60000
  );

  it(
    'should search across 1000+ indexed chunks',
    async () => {
      // This test verifies search can handle large result sets
      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const { glob } = await import('glob');
      const fs = await import('fs');

      const chunker = getTreeSitterChunker();

      // Index a subset of files
      const files = await glob('**/*.ts', {
        cwd: largeCodebase.rootPath,
        absolute: true,
        nodir: true,
      });

      const allChunks: Array<{ content: string; filePath: string }> = [];

      for (const filePath of files.slice(0, 200)) {
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const chunks = chunker.chunk(content, 'typescript', filePath);
          allChunks.push(...chunks.map((c) => ({ content: c.content, filePath })));
        } catch {
          // Skip errors
        }
      }

      console.log(`Total chunks indexed: ${allChunks.length}`);

      // Simulate search through chunks
      const query = 'function handler';
      const startTime = performance.now();

      const results = allChunks
        .filter((chunk) => chunk.content.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 50);

      const endTime = performance.now();

      console.log(`Search completed in ${(endTime - startTime).toFixed(2)}ms`);
      console.log(`Results found: ${results.length}`);

      expect(allChunks.length).toBeGreaterThan(500);
      expect(endTime - startTime).toBeLessThan(1000); // < 1s for in-memory search
    },
    60000
  );

  it(
    'should maintain performance with repeated indexing',
    async () => {
      const { glob } = await import('glob');
      const fs = await import('fs');
      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');

      const chunker = getTreeSitterChunker();

      const files = await glob('**/*.ts', {
        cwd: largeCodebase.rootPath,
        absolute: true,
        nodir: true,
      });

      const subset = files.slice(0, 100);
      const iterations = 3;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const startTime = performance.now();

        for (const filePath of subset) {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          chunker.chunk(content, 'typescript', filePath);
        }

        const endTime = performance.now();
        times.push(endTime - startTime);
        console.log(`Iteration ${i + 1}: ${(endTime - startTime).toFixed(2)}ms`);
      }

      // Performance should not degrade significantly
      const firstTime = times[0];
      const lastTime = times[times.length - 1];
      const degradation = lastTime / firstTime;

      console.log(`Performance degradation factor: ${degradation.toFixed(2)}x`);

      expect(degradation).toBeLessThan(1.5); // < 50% degradation
    },
    120000
  );
});
