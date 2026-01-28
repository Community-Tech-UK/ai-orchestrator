/**
 * Large Files Load Tests
 *
 * Tests that verify the system handles large files correctly:
 * - Files >100KB should be chunked correctly
 * - Files at max size (1MB) should be handled
 * - Files exceeding max size (2MB) should be skipped
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createLargeFile,
  generateFileOfSize,
  getMemorySnapshot,
  formatBytes,
  measureAsync,
} from '../../benchmarks/benchmark-utils';
import { DEFAULT_INDEXING_CONFIG, shouldIncludeFile } from '../../config';

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

// ============================================================================
// Cleanup Helpers
// ============================================================================

const filesToCleanup: string[] = [];

afterEach(async () => {
  for (const file of filesToCleanup) {
    await fs.promises.unlink(file).catch(() => {});
  }
  filesToCleanup.length = 0;
});

// ============================================================================
// Tests
// ============================================================================

describe('Large Files Load Tests', () => {
  describe('File Size Handling', () => {
    it('should correctly chunk a 100KB file', async () => {
      const { filePath, cleanup } = await createLargeFile(100 * 1024, 'typescript');

      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
        const chunker = getTreeSitterChunker();

        const { result: chunks, metrics } = await measureAsync(async () => {
          return chunker.chunk(content, 'typescript', filePath);
        });

        console.log(`100KB file chunked in ${metrics.durationMs.toFixed(2)}ms`);
        console.log(`Created ${chunks.length} chunks`);
        console.log(`File size: ${formatBytes(content.length)}`);

        expect(chunks.length).toBeGreaterThan(0);
        expect(metrics.durationMs).toBeLessThan(5000); // < 5s

        // Verify chunk sizes are within limits
        for (const chunk of chunks) {
          expect(chunk.tokens).toBeLessThanOrEqual(DEFAULT_INDEXING_CONFIG.maxChunkTokens);
        }
      } finally {
        await cleanup();
      }
    });

    it('should handle file at max size (1MB)', async () => {
      const { filePath, cleanup } = await createLargeFile(1024 * 1024, 'typescript');

      try {
        const stats = await fs.promises.stat(filePath);

        // Should be included (at max size)
        const shouldInclude = shouldIncludeFile(filePath, DEFAULT_INDEXING_CONFIG, stats.size);
        expect(shouldInclude).toBe(true);

        const content = await fs.promises.readFile(filePath, 'utf-8');
        const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
        const chunker = getTreeSitterChunker();

        const memBefore = getMemorySnapshot();

        const { result: chunks, metrics } = await measureAsync(async () => {
          return chunker.chunk(content, 'typescript', filePath);
        });

        const memAfter = getMemorySnapshot();
        const memUsed = memAfter.heapUsed - memBefore.heapUsed;

        console.log(`1MB file chunked in ${metrics.durationMs.toFixed(2)}ms`);
        console.log(`Created ${chunks.length} chunks`);
        console.log(`Memory used: ${formatBytes(memUsed)}`);

        expect(chunks.length).toBeGreaterThan(0);
        expect(metrics.durationMs).toBeLessThan(30000); // < 30s
        expect(memUsed).toBeLessThan(100 * 1024 * 1024); // < 100MB memory overhead
      } finally {
        await cleanup();
      }
    }, 60000);

    it('should skip files exceeding max size (2MB)', async () => {
      const { filePath, cleanup } = await createLargeFile(2 * 1024 * 1024, 'typescript');

      try {
        const stats = await fs.promises.stat(filePath);

        // Should NOT be included (exceeds max size)
        const shouldInclude = shouldIncludeFile(filePath, DEFAULT_INDEXING_CONFIG, stats.size);
        expect(shouldInclude).toBe(false);

        console.log(`2MB file correctly excluded (size: ${formatBytes(stats.size)})`);
      } finally {
        await cleanup();
      }
    }, 30000);

    it('should handle files just under max size', async () => {
      // Create file just under 1MB limit
      const { filePath, cleanup } = await createLargeFile(1024 * 1024 - 1000, 'typescript');

      try {
        const stats = await fs.promises.stat(filePath);
        const shouldInclude = shouldIncludeFile(filePath, DEFAULT_INDEXING_CONFIG, stats.size);

        expect(shouldInclude).toBe(true);
        console.log(`File at ${formatBytes(stats.size)} correctly included`);
      } finally {
        await cleanup();
      }
    });

    it('should handle files just over max size', async () => {
      // Create file just over 1MB limit
      const { filePath, cleanup } = await createLargeFile(1024 * 1024 + 1000, 'typescript');

      try {
        const stats = await fs.promises.stat(filePath);
        const shouldInclude = shouldIncludeFile(filePath, DEFAULT_INDEXING_CONFIG, stats.size);

        expect(shouldInclude).toBe(false);
        console.log(`File at ${formatBytes(stats.size)} correctly excluded`);
      } finally {
        await cleanup();
      }
    });
  });

  describe('Chunking Quality for Large Files', () => {
    it('should create overlapping chunks for continuity', async () => {
      const { filePath, cleanup } = await createLargeFile(50 * 1024, 'typescript');

      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
        const chunker = getTreeSitterChunker();

        const chunks = chunker.chunk(content, 'typescript', filePath);

        // Verify chunks have reasonable overlap
        if (chunks.length > 1) {
          for (let i = 1; i < chunks.length; i++) {
            const prevChunk = chunks[i - 1];
            const currChunk = chunks[i];

            // Check line continuity (end of prev should be near start of current)
            const lineGap = currChunk.startLine - prevChunk.endLine;
            expect(lineGap).toBeLessThanOrEqual(50); // Reasonable gap

            console.log(
              `Chunk ${i}: lines ${currChunk.startLine}-${currChunk.endLine}, gap from prev: ${lineGap}`
            );
          }
        }
      } finally {
        await cleanup();
      }
    });

    it('should preserve function boundaries in large files', async () => {
      // Create a file with many functions
      const content = generateFileOfSize('typescript', 80 * 1024);
      const filePath = path.join(os.tmpdir(), `test-functions-${Date.now()}.ts`);
      await fs.promises.writeFile(filePath, content, 'utf-8');
      filesToCleanup.push(filePath);

      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      const chunks = chunker.chunk(content, 'typescript', filePath);

      // Check that chunks with type 'function' have complete function bodies
      const functionChunks = chunks.filter((c) => c.type === 'function');
      console.log(`Found ${functionChunks.length} function chunks`);

      for (const chunk of functionChunks) {
        // A complete function should have matching braces
        const openBraces = (chunk.content.match(/\{/g) || []).length;
        const closeBraces = (chunk.content.match(/\}/g) || []).length;

        // Allow small imbalance due to string content
        expect(Math.abs(openBraces - closeBraces)).toBeLessThanOrEqual(2);
      }
    });

    it('should handle file with very long lines', async () => {
      // Create a file with a very long line (e.g., minified-style)
      const longLine = 'const data = ' + JSON.stringify(Array(1000).fill('x')) + ';';
      const content = `// Regular comment\n${longLine}\n\nfunction test() { return true; }`;

      const filePath = path.join(os.tmpdir(), `test-longline-${Date.now()}.ts`);
      await fs.promises.writeFile(filePath, content, 'utf-8');
      filesToCleanup.push(filePath);

      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      // Should not throw
      const chunks = chunker.chunk(content, 'typescript', filePath);

      console.log(`File with long line created ${chunks.length} chunks`);
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe('Memory Efficiency', () => {
    it('should release memory after processing large file', async () => {
      const { filePath, cleanup } = await createLargeFile(500 * 1024, 'typescript');

      try {
        // Force GC if available
        if (global.gc) global.gc();
        const memBefore = getMemorySnapshot();

        const content = await fs.promises.readFile(filePath, 'utf-8');
        const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
        const chunker = getTreeSitterChunker();

        // Process the file
        const chunks = chunker.chunk(content, 'typescript', filePath);
        const chunkCount = chunks.length;

        // Clear references
        chunks.length = 0;

        // Force GC if available
        if (global.gc) global.gc();
        await new Promise((resolve) => setTimeout(resolve, 100));

        const memAfter = getMemorySnapshot();
        const memRetained = memAfter.heapUsed - memBefore.heapUsed;

        console.log(`Memory before: ${formatBytes(memBefore.heapUsed)}`);
        console.log(`Memory after: ${formatBytes(memAfter.heapUsed)}`);
        console.log(`Memory retained: ${formatBytes(memRetained)}`);
        console.log(`Chunks processed: ${chunkCount}`);

        // Memory should not grow excessively
        // Note: Without --expose-gc, this test is approximate
        expect(memRetained).toBeLessThan(50 * 1024 * 1024); // < 50MB retained
      } finally {
        await cleanup();
      }
    });

    it('should process multiple large files without memory leak', async () => {
      const fileCount = 5;
      const fileSize = 200 * 1024; // 200KB each

      const files: Array<{ filePath: string; cleanup: () => Promise<void> }> = [];

      // Create files
      for (let i = 0; i < fileCount; i++) {
        files.push(await createLargeFile(fileSize, 'typescript'));
      }

      try {
        const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
        const chunker = getTreeSitterChunker();

        if (global.gc) global.gc();
        const memStart = getMemorySnapshot();
        const memSnapshots: number[] = [memStart.heapUsed];

        let totalChunks = 0;

        for (let i = 0; i < files.length; i++) {
          const content = await fs.promises.readFile(files[i].filePath, 'utf-8');
          const chunks = chunker.chunk(content, 'typescript', files[i].filePath);
          totalChunks += chunks.length;

          if (global.gc) global.gc();
          memSnapshots.push(getMemorySnapshot().heapUsed);
        }

        // Check memory growth pattern
        console.log('Memory snapshots:');
        memSnapshots.forEach((mem, i) => {
          console.log(`  After file ${i}: ${formatBytes(mem)}`);
        });
        console.log(`Total chunks: ${totalChunks}`);

        // Memory should not grow linearly (indicates leak)
        const growth = memSnapshots[memSnapshots.length - 1] - memSnapshots[0];
        const avgGrowthPerFile = growth / fileCount;

        console.log(`Total memory growth: ${formatBytes(growth)}`);
        console.log(`Avg growth per file: ${formatBytes(avgGrowthPerFile)}`);

        // Each 200KB file should not add more than 10MB to memory
        expect(avgGrowthPerFile).toBeLessThan(10 * 1024 * 1024);
      } finally {
        for (const file of files) {
          await file.cleanup();
        }
      }
    }, 60000);
  });

  describe('Edge Cases', () => {
    it('should handle empty file', async () => {
      const filePath = path.join(os.tmpdir(), `test-empty-${Date.now()}.ts`);
      await fs.promises.writeFile(filePath, '', 'utf-8');
      filesToCleanup.push(filePath);

      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      const chunks = chunker.chunk('', 'typescript', filePath);
      expect(chunks).toEqual([]);
    });

    it('should handle file with only whitespace', async () => {
      const content = '   \n\n\t\t\n   ';
      const filePath = path.join(os.tmpdir(), `test-whitespace-${Date.now()}.ts`);
      await fs.promises.writeFile(filePath, content, 'utf-8');
      filesToCleanup.push(filePath);

      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      const chunks = chunker.chunk(content, 'typescript', filePath);
      // Should handle gracefully (might return empty or minimal chunks)
      expect(Array.isArray(chunks)).toBe(true);
    });

    it('should handle file with binary characters', async () => {
      // Include some binary/null characters
      const content = 'const x = 1;\x00\x01\x02const y = 2;';
      const filePath = path.join(os.tmpdir(), `test-binary-${Date.now()}.ts`);
      await fs.promises.writeFile(filePath, content, 'utf-8');
      filesToCleanup.push(filePath);

      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      // Should not throw
      const chunks = chunker.chunk(content, 'typescript', filePath);
      expect(Array.isArray(chunks)).toBe(true);
    });

    it('should handle deeply nested code', async () => {
      // Create deeply nested code
      let content = '';
      for (let i = 0; i < 20; i++) {
        content += `${'  '.repeat(i)}function level${i}() {\n`;
      }
      content += `${'  '.repeat(20)}return true;\n`;
      for (let i = 19; i >= 0; i--) {
        content += `${'  '.repeat(i)}}\n`;
      }

      const filePath = path.join(os.tmpdir(), `test-nested-${Date.now()}.ts`);
      await fs.promises.writeFile(filePath, content, 'utf-8');
      filesToCleanup.push(filePath);

      const { getTreeSitterChunker } = await import('../../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      const chunks = chunker.chunk(content, 'typescript', filePath);
      console.log(`Deeply nested code created ${chunks.length} chunks`);

      expect(chunks.length).toBeGreaterThan(0);
    });
  });
});
