/**
 * Indexing Performance Benchmarks
 *
 * Benchmarks for measuring indexing throughput including:
 * - File scanning (glob matching)
 * - Merkle tree build/diff
 * - Code chunking (by language, by file size)
 * - Full indexing pipeline
 *
 * Target: 1000 files/min (16.67 files/sec)
 */

import { describe, bench, beforeAll, afterAll, expect } from 'vitest';
import * as path from 'path';
import {
  createSyntheticCodebase,
  createLargeFile,
  generateTypeScriptFile,
  generatePythonFile,
  getMemorySnapshot,
  formatBytes,
} from './benchmark-utils';

// Mock dependencies for isolated benchmarks
const mockDb = {
  prepare: () => ({
    run: () => {},
    get: () => undefined,
    all: () => [],
  }),
  transaction: (fn: Function) => fn,
  exec: () => {},
};

// ============================================================================
// Test Setup
// ============================================================================

let smallCodebase: { rootPath: string; cleanup: () => Promise<void> };
let mediumCodebase: { rootPath: string; cleanup: () => Promise<void> };

beforeAll(async () => {
  // Create test codebases
  smallCodebase = await createSyntheticCodebase({
    fileCount: 100,
    avgFileSize: 2000,
    maxDepth: 3,
  });

  mediumCodebase = await createSyntheticCodebase({
    fileCount: 500,
    avgFileSize: 3000,
    maxDepth: 4,
  });
}, 60000); // 60s timeout for setup

afterAll(async () => {
  await smallCodebase?.cleanup();
  await mediumCodebase?.cleanup();
});

// ============================================================================
// File Scanning Benchmarks
// ============================================================================

describe('File Scanning', () => {
  bench(
    'glob - scan 100 files',
    async () => {
      const { glob } = await import('glob');
      const patterns = ['**/*.ts', '**/*.js', '**/*.py'];
      const files: string[] = [];

      for (const pattern of patterns) {
        const matches = await glob(pattern, {
          cwd: smallCodebase.rootPath,
          ignore: ['**/node_modules/**', '**/.git/**'],
          absolute: true,
          nodir: true,
        });
        files.push(...matches);
      }

      expect(files.length).toBeGreaterThan(0);
    },
    { iterations: 10, warmupIterations: 2 }
  );

  bench(
    'glob - scan 500 files',
    async () => {
      const { glob } = await import('glob');
      const patterns = ['**/*.ts', '**/*.js', '**/*.py'];
      const files: string[] = [];

      for (const pattern of patterns) {
        const matches = await glob(pattern, {
          cwd: mediumCodebase.rootPath,
          ignore: ['**/node_modules/**', '**/.git/**'],
          absolute: true,
          nodir: true,
        });
        files.push(...matches);
      }

      expect(files.length).toBeGreaterThan(0);
    },
    { iterations: 5, warmupIterations: 1 }
  );
});

// ============================================================================
// Merkle Tree Benchmarks
// ============================================================================

describe('Merkle Tree', () => {
  bench(
    'build tree - 100 files',
    async () => {
      // Import and use merkle tree manager
      // Note: Using dynamic import to avoid module initialization issues
      const { getMerkleTreeManager } = await import('../merkle-tree');
      const merkleTree = getMerkleTreeManager();

      const tree = await merkleTree.buildTree(smallCodebase.rootPath);
      expect(tree).toBeDefined();
      expect(tree.hash).toBeTruthy();
    },
    { iterations: 5, warmupIterations: 1 }
  );

  bench(
    'build tree - 500 files',
    async () => {
      const { getMerkleTreeManager } = await import('../merkle-tree');
      const merkleTree = getMerkleTreeManager();

      const tree = await merkleTree.buildTree(mediumCodebase.rootPath);
      expect(tree).toBeDefined();
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'diff trees - detect changes',
    async () => {
      const { getMerkleTreeManager } = await import('../merkle-tree');
      const merkleTree = getMerkleTreeManager();

      // Build two trees (simulating before/after)
      const tree1 = await merkleTree.buildTree(smallCodebase.rootPath);
      const tree2 = await merkleTree.buildTree(smallCodebase.rootPath);

      // Diff should find no changes (same tree)
      const changes = merkleTree.diffTrees(tree1, tree2);
      expect(changes.length).toBe(0);
    },
    { iterations: 5, warmupIterations: 1 }
  );

  bench(
    'serialize/deserialize tree',
    async () => {
      const { getMerkleTreeManager } = await import('../merkle-tree');
      const merkleTree = getMerkleTreeManager();

      const tree = await merkleTree.buildTree(smallCodebase.rootPath);
      const serialized = merkleTree.serialize(tree);
      const deserialized = merkleTree.deserialize(serialized);

      expect(deserialized.hash).toBe(tree.hash);
    },
    { iterations: 10, warmupIterations: 2 }
  );
});

// ============================================================================
// Code Chunking Benchmarks
// ============================================================================

describe('Code Chunking', () => {
  const smallTsContent = generateTypeScriptFile({
    functionCount: 5,
    classCount: 2,
    includeComments: true,
  });

  const largeTsContent = generateTypeScriptFile({
    functionCount: 50,
    classCount: 10,
    includeComments: true,
  });

  const pyContent = generatePythonFile({
    functionCount: 20,
    classCount: 5,
    includeComments: true,
  });

  bench(
    'chunk small TypeScript file (~2KB)',
    async () => {
      const { getTreeSitterChunker } = await import('../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      const chunks = chunker.chunk(smallTsContent, 'typescript', 'test.ts');
      expect(chunks.length).toBeGreaterThan(0);
    },
    { iterations: 20, warmupIterations: 3 }
  );

  bench(
    'chunk large TypeScript file (~20KB)',
    async () => {
      const { getTreeSitterChunker } = await import('../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      const chunks = chunker.chunk(largeTsContent, 'typescript', 'test.ts');
      expect(chunks.length).toBeGreaterThan(0);
    },
    { iterations: 10, warmupIterations: 2 }
  );

  bench(
    'chunk Python file',
    async () => {
      const { getTreeSitterChunker } = await import('../tree-sitter-chunker');
      const chunker = getTreeSitterChunker();

      const chunks = chunker.chunk(pyContent, 'python', 'test.py');
      expect(chunks.length).toBeGreaterThan(0);
    },
    { iterations: 15, warmupIterations: 2 }
  );

  bench(
    'chunk 100KB file',
    async () => {
      const { filePath, cleanup } = await createLargeFile(100 * 1024, 'typescript');

      try {
        const fs = await import('fs');
        const content = await fs.promises.readFile(filePath, 'utf-8');

        const { getTreeSitterChunker } = await import('../tree-sitter-chunker');
        const chunker = getTreeSitterChunker();

        const chunks = chunker.chunk(content, 'typescript', filePath);
        expect(chunks.length).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    },
    { iterations: 5, warmupIterations: 1 }
  );
});

// ============================================================================
// Metadata Extraction Benchmarks
// ============================================================================

describe('Metadata Extraction', () => {
  const tsContent = generateTypeScriptFile({
    functionCount: 10,
    classCount: 3,
    importCount: 5,
    includeComments: true,
  });

  bench(
    'extract file metadata - TypeScript',
    async () => {
      const { getMetadataExtractor } = await import('../metadata-extractor');
      const extractor = getMetadataExtractor();

      const metadata = await extractor.extractFileMetadata('/test/file.ts', tsContent);

      expect(metadata.language).toBe('typescript');
      expect(metadata.imports.length).toBeGreaterThan(0);
      expect(metadata.symbols.length).toBeGreaterThan(0);
    },
    { iterations: 15, warmupIterations: 2 }
  );

  bench(
    'extract symbols only',
    async () => {
      const { getMetadataExtractor } = await import('../metadata-extractor');
      const extractor = getMetadataExtractor();

      // Extract symbols is typically called as part of metadata extraction
      const metadata = await extractor.extractFileMetadata('/test/file.ts', tsContent);
      expect(metadata.symbols).toBeDefined();
    },
    { iterations: 20, warmupIterations: 3 }
  );
});

// ============================================================================
// Full Indexing Pipeline Benchmarks
// ============================================================================

describe('Full Indexing Pipeline', () => {
  bench(
    'index 100 files (no embeddings)',
    async () => {
      // This benchmark tests the full pipeline except embedding generation
      // which would require external API calls
      const memBefore = getMemorySnapshot();

      const { glob } = await import('glob');
      const fs = await import('fs');
      const { getTreeSitterChunker } = await import('../tree-sitter-chunker');
      const { getMetadataExtractor } = await import('../metadata-extractor');

      const chunker = getTreeSitterChunker();
      const extractor = getMetadataExtractor();

      // 1. Scan files
      const files = await glob('**/*.{ts,js,py}', {
        cwd: smallCodebase.rootPath,
        absolute: true,
        nodir: true,
      });

      let totalChunks = 0;

      // 2. Process each file
      for (const filePath of files.slice(0, 100)) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const ext = path.extname(filePath);
        const lang =
          ext === '.ts' ? 'typescript' : ext === '.js' ? 'javascript' : 'python';

        // Extract metadata
        await extractor.extractFileMetadata(filePath, content);

        // Chunk the file
        const chunks = chunker.chunk(content, lang, filePath);
        totalChunks += chunks.length;
      }

      const memAfter = getMemorySnapshot();
      const memUsed = memAfter.heapUsed - memBefore.heapUsed;

      expect(totalChunks).toBeGreaterThan(0);
      // Memory should stay under 500MB
      expect(memUsed).toBeLessThan(500 * 1024 * 1024);
    },
    { iterations: 3, warmupIterations: 1, time: 120000 }
  );
});

// ============================================================================
// Memory Usage Benchmarks
// ============================================================================

describe('Memory Usage', () => {
  bench(
    'memory footprint - process 100 files',
    async () => {
      const memBefore = getMemorySnapshot();

      const { glob } = await import('glob');
      const fs = await import('fs');
      const { getTreeSitterChunker } = await import('../tree-sitter-chunker');

      const chunker = getTreeSitterChunker();

      const files = await glob('**/*.{ts,js,py}', {
        cwd: smallCodebase.rootPath,
        absolute: true,
        nodir: true,
      });

      const allChunks: unknown[] = [];

      for (const filePath of files) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const ext = path.extname(filePath);
        const lang =
          ext === '.ts' ? 'typescript' : ext === '.js' ? 'javascript' : 'python';

        const chunks = chunker.chunk(content, lang, filePath);
        allChunks.push(...chunks);
      }

      const memAfter = getMemorySnapshot();
      const memUsed = memAfter.heapUsed - memBefore.heapUsed;

      console.log(`Memory used for ${files.length} files: ${formatBytes(memUsed)}`);
      console.log(`Total chunks: ${allChunks.length}`);
      console.log(`Memory per file: ${formatBytes(memUsed / files.length)}`);

      // Verify memory usage is reasonable
      expect(memUsed).toBeLessThan(200 * 1024 * 1024); // < 200MB for 100 files
    },
    { iterations: 3, warmupIterations: 1 }
  );
});

// ============================================================================
// Throughput Verification
// ============================================================================

describe('Throughput Targets', () => {
  bench(
    'verify 1000 files/min target (extrapolated from 100 files)',
    async () => {
      const startTime = performance.now();

      const { glob } = await import('glob');
      const fs = await import('fs');
      const { getTreeSitterChunker } = await import('../tree-sitter-chunker');
      const { getMetadataExtractor } = await import('../metadata-extractor');

      const chunker = getTreeSitterChunker();
      const extractor = getMetadataExtractor();

      const files = await glob('**/*.{ts,js,py}', {
        cwd: smallCodebase.rootPath,
        absolute: true,
        nodir: true,
      });

      const filesToProcess = files.slice(0, 100);

      for (const filePath of filesToProcess) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const ext = path.extname(filePath);
        const lang =
          ext === '.ts' ? 'typescript' : ext === '.js' ? 'javascript' : 'python';

        await extractor.extractFileMetadata(filePath, content);
        chunker.chunk(content, lang, filePath);
      }

      const endTime = performance.now();
      const durationMs = endTime - startTime;
      const filesPerSecond = (filesToProcess.length / durationMs) * 1000;
      const filesPerMinute = filesPerSecond * 60;

      console.log(`Processed ${filesToProcess.length} files in ${durationMs.toFixed(2)}ms`);
      console.log(`Rate: ${filesPerSecond.toFixed(2)} files/sec`);
      console.log(`Extrapolated: ${filesPerMinute.toFixed(0)} files/min`);

      // Target: 1000 files/min = 16.67 files/sec
      // We expect at least this rate without embeddings
      expect(filesPerSecond).toBeGreaterThanOrEqual(16.67);
    },
    { iterations: 3, warmupIterations: 1 }
  );
});
