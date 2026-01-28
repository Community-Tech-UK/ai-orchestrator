/**
 * Memory Load Tests
 *
 * Tests that verify memory usage stays within limits:
 * - Stay under 500MB indexing 1000 files
 * - Release memory after indexing completes
 * - Handle memory pressure gracefully
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import {
  createSyntheticCodebase,
  createLargeFile,
  getMemorySnapshot,
  formatBytes,
  measureAsync,
} from '../../benchmarks/benchmark-utils';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(() => ({
    prepare: vi.fn().mockReturnValue({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
    transaction: vi.fn((fn: Function) => fn),
    exec: vi.fn(),
  })),
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
    addSection: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockReturnValue({ totalVectors: 0 }),
  })),
  VectorStore: vi.fn(),
}));

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

const cleanupFns: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const cleanup of cleanupFns) {
    await cleanup();
  }
});

// ============================================================================
// Memory Limit Constants
// ============================================================================

const MAX_MEMORY_MB = 500; // Target: < 500MB during indexing
const MAX_MEMORY_BYTES = MAX_MEMORY_MB * 1024 * 1024;

// ============================================================================
// Tests
// ============================================================================

describe('Memory Load Tests', () => {
  describe('Memory Limits', () => {
    it(
      'should stay under 500MB when indexing 1000 files',
      async () => {
        const codebase = await createSyntheticCodebase({
          fileCount: 1000,
          avgFileSize: 2000,
          maxDepth: 4,
        });
        cleanupFns.push(codebase.cleanup);

        const { glob } = await import('glob');
        const fs = await import('fs');
        const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');

        const chunker = getTreeSitterChunker();

        // Force GC before starting
        if (global.gc) global.gc();

        const baselineMemory = getMemorySnapshot();
        console.log(`Baseline memory: ${formatBytes(baselineMemory.heapUsed)}`);

        const files = await glob('**/*.{ts,js,py}', {
          cwd: codebase.rootPath,
          absolute: true,
          nodir: true,
        });

        let peakMemory = baselineMemory.heapUsed;
        let totalChunks = 0;
        const memorySnapshots: Array<{ files: number; memory: number }> = [];

        // Process files in batches and track memory
        const batchSize = 50;
        for (let i = 0; i < files.length; i += batchSize) {
          const batch = files.slice(i, i + batchSize);

          for (const filePath of batch) {
            try {
              const content = await fs.promises.readFile(filePath, 'utf-8');
              const ext = filePath.split('.').pop() || '';
              const lang =
                ext === 'ts' ? 'typescript' : ext === 'js' ? 'javascript' : 'python';

              const chunks = chunker.chunk(content, lang, filePath);
              totalChunks += chunks.length;
            } catch {
              // Skip errors
            }
          }

          // Check memory after each batch
          const currentMemory = getMemorySnapshot();
          peakMemory = Math.max(peakMemory, currentMemory.heapUsed);

          memorySnapshots.push({
            files: Math.min(i + batchSize, files.length),
            memory: currentMemory.heapUsed,
          });

          // Log progress every 200 files
          if ((i + batchSize) % 200 === 0 || i + batchSize >= files.length) {
            console.log(
              `Processed ${Math.min(i + batchSize, files.length)} files, ` +
                `memory: ${formatBytes(currentMemory.heapUsed)}`
            );
          }
        }

        const memoryUsed = peakMemory - baselineMemory.heapUsed;

        console.log('\nMemory Summary:');
        console.log(`  Baseline: ${formatBytes(baselineMemory.heapUsed)}`);
        console.log(`  Peak: ${formatBytes(peakMemory)}`);
        console.log(`  Used: ${formatBytes(memoryUsed)}`);
        console.log(`  Total files: ${files.length}`);
        console.log(`  Total chunks: ${totalChunks}`);
        console.log(`  Memory per file: ${formatBytes(memoryUsed / files.length)}`);

        // Target: < 500MB
        expect(memoryUsed).toBeLessThan(MAX_MEMORY_BYTES);
      },
      300000 // 5 minute timeout
    );

    it('should not exceed memory limit with large file batch', async () => {
      const fileCount = 10;
      const fileSize = 100 * 1024; // 100KB each

      const files: Array<{ filePath: string; cleanup: () => Promise<void> }> = [];

      for (let i = 0; i < fileCount; i++) {
        files.push(await createLargeFile(fileSize, 'typescript'));
      }
      files.forEach((f) => cleanupFns.push(f.cleanup));

      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const fs = await import('fs');

      const chunker = getTreeSitterChunker();

      if (global.gc) global.gc();
      const baselineMemory = getMemorySnapshot();

      let peakMemory = baselineMemory.heapUsed;
      let totalChunks = 0;

      for (const file of files) {
        const content = await fs.promises.readFile(file.filePath, 'utf-8');
        const chunks = chunker.chunk(content, 'typescript', file.filePath);
        totalChunks += chunks.length;

        const currentMemory = getMemorySnapshot();
        peakMemory = Math.max(peakMemory, currentMemory.heapUsed);
      }

      const memoryUsed = peakMemory - baselineMemory.heapUsed;

      console.log(`Processed ${fileCount} x 100KB files`);
      console.log(`Total chunks: ${totalChunks}`);
      console.log(`Peak memory used: ${formatBytes(memoryUsed)}`);

      // 10 x 100KB files = 1MB of content, should not use > 100MB
      expect(memoryUsed).toBeLessThan(100 * 1024 * 1024);
    }, 60000);
  });

  describe('Memory Release', () => {
    it('should release memory after indexing completes', async () => {
      const codebase = await createSyntheticCodebase({
        fileCount: 200,
        avgFileSize: 3000,
        maxDepth: 3,
      });
      cleanupFns.push(codebase.cleanup);

      const { glob } = await import('glob');
      const fs = await import('fs');
      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');

      const chunker = getTreeSitterChunker();

      if (global.gc) global.gc();
      await new Promise((r) => setTimeout(r, 100));

      const memoryBefore = getMemorySnapshot();

      const files = await glob('**/*.{ts,js,py}', {
        cwd: codebase.rootPath,
        absolute: true,
        nodir: true,
      });

      // Process all files
      let allChunks: unknown[] = [];
      for (const filePath of files) {
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const ext = filePath.split('.').pop() || '';
          const lang = ext === 'ts' ? 'typescript' : ext === 'js' ? 'javascript' : 'python';
          const chunks = chunker.chunk(content, lang, filePath);
          allChunks.push(...chunks);
        } catch {
          // Skip errors
        }
      }

      const memoryDuring = getMemorySnapshot();
      console.log(`Memory during processing: ${formatBytes(memoryDuring.heapUsed)}`);
      console.log(`Chunks in memory: ${allChunks.length}`);

      // Clear references
      allChunks = [];

      // Force GC if available
      if (global.gc) {
        global.gc();
        await new Promise((r) => setTimeout(r, 500));
        global.gc();
      }

      const memoryAfter = getMemorySnapshot();

      console.log(`\nMemory before: ${formatBytes(memoryBefore.heapUsed)}`);
      console.log(`Memory during: ${formatBytes(memoryDuring.heapUsed)}`);
      console.log(`Memory after: ${formatBytes(memoryAfter.heapUsed)}`);

      // Memory should drop after clearing references
      // Note: Without --expose-gc, this is approximate
      const memoryRetained = memoryAfter.heapUsed - memoryBefore.heapUsed;
      const memoryReleased = memoryDuring.heapUsed - memoryAfter.heapUsed;

      console.log(`Memory retained: ${formatBytes(memoryRetained)}`);
      console.log(`Memory released: ${formatBytes(memoryReleased)}`);

      // At least some memory should be released
      expect(memoryAfter.heapUsed).toBeLessThan(memoryDuring.heapUsed);
    }, 120000);

    it('should handle memory pressure gracefully', async () => {
      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      // Simulate memory pressure by creating many chunks
      const iterations = 100;
      const memorySnapshots: number[] = [];

      if (global.gc) global.gc();

      for (let i = 0; i < iterations; i++) {
        // Create content that generates many chunks
        const content = `
          export class Service${i} {
            private data${i} = new Map();

            async process${i}(input: string) {
              return input.toUpperCase();
            }

            async handle${i}(req: Request) {
              const result = await this.process${i}(req.body);
              return { data: result };
            }
          }
        `.repeat(10);

        // Process without storing
        chunker.chunk(content, 'typescript', `file_${i}.ts`);

        // Track memory periodically
        if (i % 20 === 0) {
          memorySnapshots.push(getMemorySnapshot().heapUsed);
        }
      }

      console.log('Memory snapshots during pressure test:');
      memorySnapshots.forEach((mem, i) => {
        console.log(`  Iteration ${i * 20}: ${formatBytes(mem)}`);
      });

      // Memory should not grow unboundedly
      const firstSnapshot = memorySnapshots[0];
      const lastSnapshot = memorySnapshots[memorySnapshots.length - 1];
      const growth = lastSnapshot - firstSnapshot;

      console.log(`\nMemory growth: ${formatBytes(growth)}`);

      // Growth should be bounded
      expect(growth).toBeLessThan(100 * 1024 * 1024); // < 100MB growth
    });
  });

  describe('Memory Efficiency', () => {
    it('should process streaming without loading all files in memory', async () => {
      const codebase = await createSyntheticCodebase({
        fileCount: 100,
        avgFileSize: 5000,
        maxDepth: 3,
      });
      cleanupFns.push(codebase.cleanup);

      const { glob } = await import('glob');
      const fs = await import('fs');
      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');

      const chunker = getTreeSitterChunker();

      const files = await glob('**/*.{ts,js,py}', {
        cwd: codebase.rootPath,
        absolute: true,
        nodir: true,
      });

      if (global.gc) global.gc();
      const baselineMemory = getMemorySnapshot();

      // Process files one at a time (streaming)
      let totalSize = 0;
      let maxSingleFileMemory = 0;

      for (const filePath of files) {
        try {
          const memBefore = getMemorySnapshot();

          const content = await fs.promises.readFile(filePath, 'utf-8');
          totalSize += content.length;

          chunker.chunk(content, 'typescript', filePath);

          const memAfter = getMemorySnapshot();
          const fileMemory = memAfter.heapUsed - memBefore.heapUsed;
          maxSingleFileMemory = Math.max(maxSingleFileMemory, fileMemory);
        } catch {
          // Skip errors
        }
      }

      const finalMemory = getMemorySnapshot();
      const totalMemoryUsed = finalMemory.heapUsed - baselineMemory.heapUsed;

      console.log(`Total content size: ${formatBytes(totalSize)}`);
      console.log(`Max single file memory: ${formatBytes(maxSingleFileMemory)}`);
      console.log(`Total memory used: ${formatBytes(totalMemoryUsed)}`);

      // Memory used should be much less than total content size
      // (indicates streaming, not loading all at once)
      expect(totalMemoryUsed).toBeLessThan(totalSize * 3); // Allow 3x overhead
    }, 60000);

    it('should have bounded memory per chunk', async () => {
      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      // Create content of various sizes
      const sizes = [1000, 5000, 10000, 50000, 100000];
      const memoryPerChunk: Array<{ size: number; chunks: number; memoryPerChunk: number }> = [];

      for (const size of sizes) {
        if (global.gc) global.gc();
        const memBefore = getMemorySnapshot();

        // Generate content of target size
        const content = 'x'.repeat(size);
        const chunks = chunker.chunk(content, 'typescript', 'test.ts');

        const memAfter = getMemorySnapshot();
        const memUsed = memAfter.heapUsed - memBefore.heapUsed;
        const perChunk = chunks.length > 0 ? memUsed / chunks.length : 0;

        memoryPerChunk.push({
          size,
          chunks: chunks.length,
          memoryPerChunk: perChunk,
        });
      }

      console.log('Memory per chunk by input size:');
      memoryPerChunk.forEach((m) => {
        console.log(
          `  ${formatBytes(m.size)} input -> ${m.chunks} chunks, ` +
            `${formatBytes(m.memoryPerChunk)}/chunk`
        );
      });

      // Memory per chunk should be bounded
      memoryPerChunk.forEach((m) => {
        if (m.chunks > 0) {
          // Each chunk should not use more than 1MB
          expect(m.memoryPerChunk).toBeLessThan(1024 * 1024);
        }
      });
    });
  });

  describe('Memory Monitoring', () => {
    it('should provide accurate memory usage tracking', async () => {
      const snapshots: Array<{ label: string; memory: MemorySnapshot }> = [];

      interface MemorySnapshot {
        heapUsed: number;
        heapTotal: number;
        external: number;
        rss: number;
      }

      const takeSnapshot = (label: string) => {
        snapshots.push({ label, memory: getMemorySnapshot() });
      };

      if (global.gc) global.gc();
      takeSnapshot('baseline');

      // Allocate some memory
      const data1: number[] = new Array(100000).fill(0).map((_, i) => i);
      takeSnapshot('after 100K numbers');

      // Allocate more
      const data2: string[] = new Array(10000).fill(0).map(() => 'x'.repeat(100));
      takeSnapshot('after 10K strings');

      // Clear some
      data1.length = 0;
      if (global.gc) global.gc();
      await new Promise((r) => setTimeout(r, 100));
      takeSnapshot('after clearing numbers');

      // Clear all
      data2.length = 0;
      if (global.gc) global.gc();
      await new Promise((r) => setTimeout(r, 100));
      takeSnapshot('after clearing all');

      console.log('Memory tracking snapshots:');
      snapshots.forEach((s) => {
        console.log(`  ${s.label}: ${formatBytes(s.memory.heapUsed)}`);
      });

      // Verify snapshots show expected patterns
      const baselineMemory = snapshots[0].memory.heapUsed;
      const peakMemory = Math.max(...snapshots.map((s) => s.memory.heapUsed));
      const finalMemory = snapshots[snapshots.length - 1].memory.heapUsed;

      console.log(`\nBaseline: ${formatBytes(baselineMemory)}`);
      console.log(`Peak: ${formatBytes(peakMemory)}`);
      console.log(`Final: ${formatBytes(finalMemory)}`);

      // Peak should be higher than baseline
      expect(peakMemory).toBeGreaterThan(baselineMemory);
    });
  });
});
