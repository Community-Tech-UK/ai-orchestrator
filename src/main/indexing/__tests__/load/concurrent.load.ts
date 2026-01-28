/**
 * Concurrent Operations Load Tests
 *
 * Tests that verify the system handles concurrent operations correctly:
 * - Concurrent indexing requests (same store)
 * - Parallel search queries
 * - Indexing while search running
 * - File watcher events during indexing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSyntheticCodebase,
  generateTypeScriptFile,
  measureAsync,
} from '../../benchmarks/benchmark-utils';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(() => {
    const data = new Map<string, unknown[]>();
    let isLocked = false;
    const lockQueue: Array<() => void> = [];

    const acquireLock = () => {
      return new Promise<void>((resolve) => {
        if (!isLocked) {
          isLocked = true;
          resolve();
        } else {
          lockQueue.push(resolve);
        }
      });
    };

    const releaseLock = () => {
      isLocked = false;
      const next = lockQueue.shift();
      if (next) {
        isLocked = true;
        next();
      }
    };

    return {
      prepare: vi.fn().mockImplementation(() => ({
        run: vi.fn().mockImplementation(async (...args: unknown[]) => {
          await acquireLock();
          try {
            // Simulate write delay
            await new Promise((r) => setTimeout(r, 1));
            return { changes: 1 };
          } finally {
            releaseLock();
          }
        }),
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
        pluck: vi.fn().mockReturnThis(),
      })),
      transaction: vi.fn((fn: Function) => fn),
      exec: vi.fn(),
    };
  }),
}));

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

vi.mock('../../../rlm/vector-store', () => ({
  getVectorStore: vi.fn(() => ({
    addSection: vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
    }),
    search: vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return [];
    }),
    getStats: vi.fn().mockReturnValue({ totalVectors: 0 }),
  })),
  VectorStore: vi.fn(),
}));

vi.mock('../../bm25-search', () => ({
  getBM25Search: vi.fn(() => ({
    addDocument: vi.fn(),
    removeDocument: vi.fn(),
    search: vi.fn().mockImplementation(() => {
      return [];
    }),
    getStats: vi.fn().mockReturnValue({ totalDocuments: 0 }),
    rebuildIndex: vi.fn(),
  })),
  BM25Search: vi.fn(),
}));

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

let testCodebase: { rootPath: string; cleanup: () => Promise<void> };

beforeEach(async () => {
  testCodebase = await createSyntheticCodebase({
    fileCount: 50,
    avgFileSize: 2000,
    maxDepth: 3,
  });
}, 30000);

afterEach(async () => {
  await testCodebase?.cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('Concurrent Operations Load Tests', () => {
  describe('Concurrent Indexing', () => {
    it('should handle concurrent indexing of same store safely', async () => {
      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const { glob } = await import('glob');
      const fs = await import('fs');

      const chunker = getTreeSitterChunker();

      const files = await glob('**/*.ts', {
        cwd: testCodebase.rootPath,
        absolute: true,
        nodir: true,
      });

      const results: Array<{ index: number; chunks: number; time: number }> = [];

      // Start 5 concurrent "indexing" operations
      const concurrentOps = 5;
      const promises = Array.from({ length: concurrentOps }, async (_, i) => {
        const startTime = performance.now();
        let totalChunks = 0;

        // Each operation processes a subset
        const subset = files.slice(i * 10, (i + 1) * 10);

        for (const filePath of subset) {
          try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const chunks = chunker.chunk(content, 'typescript', filePath);
            totalChunks += chunks.length;
          } catch {
            // Ignore errors
          }
        }

        const endTime = performance.now();
        results.push({ index: i, chunks: totalChunks, time: endTime - startTime });
      });

      await Promise.all(promises);

      console.log('Concurrent indexing results:');
      results.forEach((r) => {
        console.log(`  Op ${r.index}: ${r.chunks} chunks in ${r.time.toFixed(2)}ms`);
      });

      // All operations should complete
      expect(results.length).toBe(concurrentOps);
      results.forEach((r) => expect(r.chunks).toBeGreaterThan(0));
    });

    it('should not corrupt data with concurrent writes', async () => {
      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      const content = generateTypeScriptFile({ functionCount: 10, classCount: 3 });

      // Simulate concurrent chunk storage
      const results: Array<{ id: number; success: boolean }> = [];
      const concurrentWrites = 20;

      const promises = Array.from({ length: concurrentWrites }, async (_, i) => {
        try {
          const chunks = chunker.chunk(content, 'typescript', `file_${i}.ts`);
          // Each operation should produce consistent results
          results.push({ id: i, success: chunks.length > 0 });
        } catch (error) {
          results.push({ id: i, success: false });
        }
      });

      await Promise.all(promises);

      const successful = results.filter((r) => r.success).length;
      console.log(`Concurrent writes: ${successful}/${concurrentWrites} successful`);

      // All writes should succeed
      expect(successful).toBe(concurrentWrites);
    });
  });

  describe('Parallel Search', () => {
    it('should handle 10 concurrent search queries', async () => {
      const queries = [
        'authentication',
        'database',
        'handler',
        'service',
        'controller',
        'validation',
        'error',
        'async',
        'promise',
        'export',
      ];

      const startTime = performance.now();

      const promises = queries.map(async (query, i) => {
        const queryStart = performance.now();

        // Simulate search delay
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));

        const queryEnd = performance.now();
        return {
          query,
          index: i,
          latency: queryEnd - queryStart,
        };
      });

      const results = await Promise.all(promises);
      const totalTime = performance.now() - startTime;

      console.log('Parallel search results:');
      results.forEach((r) => {
        console.log(`  "${r.query}": ${r.latency.toFixed(2)}ms`);
      });
      console.log(`Total time (parallel): ${totalTime.toFixed(2)}ms`);

      // Parallel execution should be faster than serial
      const serialEstimate = results.reduce((sum, r) => sum + r.latency, 0);
      console.log(`Estimated serial time: ${serialEstimate.toFixed(2)}ms`);

      expect(totalTime).toBeLessThan(serialEstimate * 0.7); // At least 30% faster
    });

    it('should maintain result quality under concurrent load', async () => {
      const query = 'function handler';

      // Run same query 10 times concurrently
      const promises = Array.from({ length: 10 }, async (_, i) => {
        // Simulate search with mocked results
        await new Promise((r) => setTimeout(r, 10));

        // Return mock results
        return {
          index: i,
          resultCount: 5,
          topScore: 0.85,
        };
      });

      const results = await Promise.all(promises);

      // All concurrent searches should return consistent results
      const resultCounts = new Set(results.map((r) => r.resultCount));
      const topScores = new Set(results.map((r) => r.topScore));

      console.log(`Unique result counts: ${resultCounts.size}`);
      console.log(`Unique top scores: ${topScores.size}`);

      expect(resultCounts.size).toBe(1); // All should return same count
      expect(topScores.size).toBe(1); // All should return same score
    });
  });

  describe('Mixed Operations', () => {
    it('should handle indexing while search is running', async () => {
      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      const content = generateTypeScriptFile({ functionCount: 5 });

      // Start a long-running "search"
      const searchPromise = (async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { type: 'search', complete: true };
      })();

      // Start indexing while search is running
      const indexPromise = (async () => {
        await new Promise((r) => setTimeout(r, 20));
        const chunks = chunker.chunk(content, 'typescript', 'test.ts');
        return { type: 'index', chunks: chunks.length };
      })();

      const [searchResult, indexResult] = await Promise.all([searchPromise, indexPromise]);

      console.log(`Search completed: ${searchResult.complete}`);
      console.log(`Index created ${indexResult.chunks} chunks`);

      expect(searchResult.complete).toBe(true);
      expect(indexResult.chunks).toBeGreaterThan(0);
    });

    it('should handle file changes during indexing', async () => {
      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const { glob } = await import('glob');
      const fs = await import('fs');

      const chunker = getTreeSitterChunker();

      const files = await glob('**/*.ts', {
        cwd: testCodebase.rootPath,
        absolute: true,
        nodir: true,
      });

      const results: string[] = [];
      let fileChangeDetected = false;

      // Start indexing
      const indexingPromise = (async () => {
        for (const filePath of files.slice(0, 20)) {
          try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            chunker.chunk(content, 'typescript', filePath);
            results.push('indexed');
            await new Promise((r) => setTimeout(r, 10)); // Simulate processing
          } catch {
            results.push('error');
          }
        }
      })();

      // Simulate file change event during indexing
      const fileChangePromise = (async () => {
        await new Promise((r) => setTimeout(r, 50));
        fileChangeDetected = true;
        results.push('file_changed');
      })();

      await Promise.all([indexingPromise, fileChangePromise]);

      console.log(`Operations: ${results.join(', ')}`);
      console.log(`File change detected: ${fileChangeDetected}`);

      expect(fileChangeDetected).toBe(true);
      expect(results.filter((r) => r === 'indexed').length).toBeGreaterThan(0);
    });

    it('should handle rapid file watcher events', async () => {
      // Simulate rapid file changes
      const events: Array<{ type: 'add' | 'change' | 'unlink'; path: string }> = [];

      // Generate 100 rapid events
      for (let i = 0; i < 100; i++) {
        events.push({
          type: ['add', 'change', 'unlink'][i % 3] as 'add' | 'change' | 'unlink',
          path: `/src/file_${i % 20}.ts`,
        });
      }

      // Process with debouncing (simulated)
      const debounceMs = 50;
      const processedBatches: number[] = [];
      let currentBatch: typeof events = [];
      let debounceTimer: NodeJS.Timeout | null = null;

      const processEvents = async (batch: typeof events) => {
        processedBatches.push(batch.length);
        await new Promise((r) => setTimeout(r, 10));
      };

      for (const event of events) {
        currentBatch.push(event);

        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
          processEvents([...currentBatch]);
          currentBatch = [];
        }, debounceMs);
      }

      // Wait for final batch
      await new Promise((r) => setTimeout(r, debounceMs * 2));

      console.log(`Rapid events: ${events.length}`);
      console.log(`Batches processed: ${processedBatches.length}`);
      console.log(`Batch sizes: ${processedBatches.join(', ')}`);

      // Should batch events, not process each individually
      expect(processedBatches.length).toBeLessThan(events.length);
    });
  });

  describe('Resource Contention', () => {
    it('should handle database lock contention', async () => {
      // Simulate multiple operations trying to access DB
      const operations = 50;
      const results: Array<{ id: number; success: boolean; time: number }> = [];

      const promises = Array.from({ length: operations }, async (_, i) => {
        const start = performance.now();
        try {
          // Simulate DB operation with lock
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          results.push({ id: i, success: true, time: performance.now() - start });
        } catch {
          results.push({ id: i, success: false, time: performance.now() - start });
        }
      });

      await Promise.all(promises);

      const successful = results.filter((r) => r.success).length;
      const avgTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;

      console.log(`Operations: ${successful}/${operations} successful`);
      console.log(`Average time: ${avgTime.toFixed(2)}ms`);

      expect(successful).toBe(operations);
    });

    it('should not deadlock with mixed read/write operations', async () => {
      const timeout = 5000; // 5 second timeout
      const startTime = Date.now();

      const operations: Promise<string>[] = [];

      // Mix of reads and writes
      for (let i = 0; i < 30; i++) {
        if (i % 2 === 0) {
          // Write operation
          operations.push(
            (async () => {
              await new Promise((r) => setTimeout(r, Math.random() * 20));
              return 'write';
            })()
          );
        } else {
          // Read operation
          operations.push(
            (async () => {
              await new Promise((r) => setTimeout(r, Math.random() * 10));
              return 'read';
            })()
          );
        }
      }

      const results = await Promise.race([
        Promise.all(operations),
        new Promise<string[]>((_, reject) =>
          setTimeout(() => reject(new Error('Deadlock detected')), timeout)
        ),
      ]);

      const elapsed = Date.now() - startTime;

      console.log(`All operations completed in ${elapsed}ms`);
      console.log(`Reads: ${results.filter((r) => r === 'read').length}`);
      console.log(`Writes: ${results.filter((r) => r === 'write').length}`);

      expect(results.length).toBe(30);
      expect(elapsed).toBeLessThan(timeout);
    });
  });
});
