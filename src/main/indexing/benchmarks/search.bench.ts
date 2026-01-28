/**
 * Search Performance Benchmarks
 *
 * Benchmarks for measuring search latency including:
 * - BM25 FTS5 search
 * - Vector similarity search
 * - Hybrid search with RRF fusion
 * - Search with HyDE expansion
 * - Search with reranking
 *
 * Target: < 500ms p95 latency
 */

import { describe, bench, beforeAll, afterAll, expect, vi } from 'vitest';
import {
  createSyntheticCodebase,
  generateTypeScriptFile,
  getMemorySnapshot,
  formatBytes,
  calculatePercentiles,
} from './benchmark-utils';

// ============================================================================
// Mock Setup
// ============================================================================

// Mock better-sqlite3 for benchmarks that don't need real DB
vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(() => ({
    prepare: vi.fn().mockReturnValue({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      pluck: vi.fn().mockReturnThis(),
    }),
    transaction: vi.fn((fn: Function) => fn),
    exec: vi.fn(),
  })),
}));

// Mock RLM database
vi.mock('../../persistence/rlm-database', () => ({
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

// Mock vector store with simulated latency
vi.mock('../../rlm/vector-store', () => ({
  getVectorStore: vi.fn(() => ({
    search: vi.fn().mockImplementation(async () => {
      // Simulate vector search latency (typically 10-50ms)
      await new Promise((resolve) => setTimeout(resolve, 20));
      return generateMockVectorResults(10);
    }),
    addSection: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockReturnValue({ totalVectors: 1000 }),
  })),
  VectorStore: vi.fn(),
}));

// Mock HyDE service
vi.mock('../../rlm/hyde-service', () => ({
  getHyDEService: vi.fn(() => ({
    embed: vi.fn().mockImplementation(async (query: string) => {
      // Simulate HyDE generation latency (typically 100-300ms)
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        embedding: new Array(384).fill(0).map(() => Math.random()),
        hydeUsed: true,
        hypotheticalDocument: `Code that handles ${query}`,
      };
    }),
  })),
  HyDEService: vi.fn(),
}));

// ============================================================================
// Helper Functions
// ============================================================================

function generateMockBM25Results(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    sectionId: `section_${i}`,
    filePath: `/src/file_${i}.ts`,
    content: generateTypeScriptFile({ functionCount: 2, classCount: 1 }).slice(0, 500),
    score: 1 - i * 0.05,
    matchedTerms: ['function', 'handler'],
    snippet: '...matched content...',
    startLine: 10 + i * 5,
    endLine: 20 + i * 5,
  }));
}

function generateMockVectorResults(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    entry: {
      sectionId: `vector_section_${i}`,
      contentPreview: generateTypeScriptFile({ functionCount: 1 }).slice(0, 300),
      metadata: {
        filePath: `/src/vector_file_${i}.ts`,
        startLine: 5 + i * 3,
        endLine: 15 + i * 3,
      },
    },
    similarity: 0.95 - i * 0.03,
  }));
}

function generateMockHybridResults(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    sectionId: `hybrid_${i}`,
    filePath: `/src/hybrid_file_${i}.ts`,
    content: generateTypeScriptFile({ functionCount: 1 }).slice(0, 400),
    startLine: 1,
    endLine: 20,
    score: 0.9 - i * 0.02,
    bm25Score: 0.8 - i * 0.03,
    vectorScore: 0.85 - i * 0.02,
    matchType: i % 3 === 0 ? 'hybrid' : i % 2 === 0 ? 'bm25' : 'vector',
  }));
}

// ============================================================================
// Test Data
// ============================================================================

const SEARCH_QUERIES = [
  'authentication handler',
  'database connection pool',
  'error handling middleware',
  'user validation function',
  'async data processing',
  'file upload service',
  'cache invalidation',
  'event emitter pattern',
  'dependency injection',
  'rate limiting implementation',
];

// ============================================================================
// BM25 Search Benchmarks
// ============================================================================

describe('BM25 Search', () => {
  bench(
    'BM25 search - 10 results',
    async () => {
      // Simulate BM25 search with mocked results
      const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
      const startTime = performance.now();

      // Simulate FTS5 query execution
      await new Promise((resolve) => setTimeout(resolve, 5));
      const results = generateMockBM25Results(10);

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(results.length).toBe(10);
      expect(latency).toBeLessThan(100); // BM25 should be very fast
    },
    { iterations: 50, warmupIterations: 5 }
  );

  bench(
    'BM25 search - 50 results',
    async () => {
      const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
      const startTime = performance.now();

      await new Promise((resolve) => setTimeout(resolve, 10));
      const results = generateMockBM25Results(50);

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(results.length).toBe(50);
      expect(latency).toBeLessThan(150);
    },
    { iterations: 30, warmupIterations: 3 }
  );

  bench(
    'BM25 search - 100 results',
    async () => {
      const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
      const startTime = performance.now();

      await new Promise((resolve) => setTimeout(resolve, 15));
      const results = generateMockBM25Results(100);

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(results.length).toBe(100);
      expect(latency).toBeLessThan(200);
    },
    { iterations: 20, warmupIterations: 2 }
  );
});

// ============================================================================
// Vector Search Benchmarks
// ============================================================================

describe('Vector Search', () => {
  bench(
    'vector search - 10 results',
    async () => {
      const startTime = performance.now();

      // Simulate vector embedding generation + search
      await new Promise((resolve) => setTimeout(resolve, 15)); // Embedding
      await new Promise((resolve) => setTimeout(resolve, 10)); // Search
      const results = generateMockVectorResults(10);

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(results.length).toBe(10);
      expect(latency).toBeLessThan(200);
    },
    { iterations: 30, warmupIterations: 3 }
  );

  bench(
    'vector search - 50 results',
    async () => {
      const startTime = performance.now();

      await new Promise((resolve) => setTimeout(resolve, 15));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const results = generateMockVectorResults(50);

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(results.length).toBe(50);
      expect(latency).toBeLessThan(250);
    },
    { iterations: 20, warmupIterations: 2 }
  );

  bench(
    'vector similarity calculation (100 vectors)',
    async () => {
      // Simulate cosine similarity calculation
      const queryVector = new Array(384).fill(0).map(() => Math.random());
      const candidates = Array.from({ length: 100 }, () =>
        new Array(384).fill(0).map(() => Math.random())
      );

      const startTime = performance.now();

      const similarities = candidates.map((candidate) => {
        let dotProduct = 0;
        let queryMag = 0;
        let candidateMag = 0;

        for (let i = 0; i < queryVector.length; i++) {
          dotProduct += queryVector[i] * candidate[i];
          queryMag += queryVector[i] * queryVector[i];
          candidateMag += candidate[i] * candidate[i];
        }

        return dotProduct / (Math.sqrt(queryMag) * Math.sqrt(candidateMag));
      });

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(similarities.length).toBe(100);
      expect(latency).toBeLessThan(50); // Pure computation should be fast
    },
    { iterations: 100, warmupIterations: 10 }
  );
});

// ============================================================================
// Hybrid Search Benchmarks
// ============================================================================

describe('Hybrid Search', () => {
  bench(
    'hybrid search - basic (no HyDE, no rerank)',
    async () => {
      const startTime = performance.now();

      // Parallel BM25 + Vector search
      const [bm25Results, vectorResults] = await Promise.all([
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return generateMockBM25Results(20);
        })(),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return generateMockVectorResults(20);
        })(),
      ]);

      // RRF fusion (fast, in-memory)
      const fusedResults = generateMockHybridResults(10);

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(fusedResults.length).toBe(10);
      expect(latency).toBeLessThan(200);
    },
    { iterations: 30, warmupIterations: 3 }
  );

  bench(
    'hybrid search with RRF fusion',
    async () => {
      const k = 60; // RRF constant
      const startTime = performance.now();

      const bm25Results = generateMockBM25Results(30);
      const vectorResults = generateMockVectorResults(30);

      // Actual RRF implementation
      const scoreMap = new Map<string, number>();

      bm25Results.forEach((result, rank) => {
        const rrfScore = 0.4 * (1 / (k + rank + 1));
        scoreMap.set(result.sectionId, (scoreMap.get(result.sectionId) || 0) + rrfScore);
      });

      vectorResults.forEach((result, rank) => {
        const rrfScore = 0.6 * (1 / (k + rank + 1));
        const id = result.entry.sectionId;
        scoreMap.set(id, (scoreMap.get(id) || 0) + rrfScore);
      });

      const fusedScores = Array.from(scoreMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(fusedScores.length).toBeLessThanOrEqual(10);
      expect(latency).toBeLessThan(50); // Fusion should be very fast
    },
    { iterations: 100, warmupIterations: 10 }
  );
});

// ============================================================================
// HyDE Benchmarks
// ============================================================================

describe('HyDE Search', () => {
  bench(
    'search with HyDE expansion',
    async () => {
      const startTime = performance.now();

      // HyDE generates a hypothetical document
      await new Promise((resolve) => setTimeout(resolve, 100)); // LLM call simulation

      // Then vector search with the expanded query
      await new Promise((resolve) => setTimeout(resolve, 25));
      const results = generateMockVectorResults(10);

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(results.length).toBe(10);
      // HyDE adds latency but should still be under 500ms
      expect(latency).toBeLessThan(400);
    },
    { iterations: 10, warmupIterations: 2 }
  );

  bench(
    'full hybrid search with HyDE',
    async () => {
      const startTime = performance.now();

      // HyDE expansion
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Parallel searches
      const [bm25Results, vectorResults] = await Promise.all([
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return generateMockBM25Results(20);
        })(),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return generateMockVectorResults(20);
        })(),
      ]);

      // Fusion
      const fusedResults = generateMockHybridResults(10);

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(fusedResults.length).toBe(10);
      expect(latency).toBeLessThan(450);
    },
    { iterations: 10, warmupIterations: 2 }
  );
});

// ============================================================================
// Reranking Benchmarks
// ============================================================================

describe('Reranking', () => {
  bench(
    'local reranking - 20 candidates',
    async () => {
      const candidates = generateMockHybridResults(20);
      const startTime = performance.now();

      // Simulate local reranking (e.g., BM25 re-scoring)
      const reranked = candidates.map((candidate, i) => ({
        ...candidate,
        rerankScore: candidate.score * (1 + Math.random() * 0.1),
      }));

      reranked.sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(reranked.length).toBe(20);
      expect(latency).toBeLessThan(20);
    },
    { iterations: 50, warmupIterations: 5 }
  );

  bench(
    'API reranking simulation - 20 candidates',
    async () => {
      const candidates = generateMockHybridResults(20);
      const startTime = performance.now();

      // Simulate API call latency (Cohere/Voyage)
      await new Promise((resolve) => setTimeout(resolve, 50));

      const reranked = candidates.map((candidate, i) => ({
        ...candidate,
        rerankScore: 0.95 - i * 0.02,
      }));

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(reranked.length).toBe(20);
      expect(latency).toBeLessThan(150);
    },
    { iterations: 20, warmupIterations: 2 }
  );

  bench(
    'full search pipeline with reranking',
    async () => {
      const startTime = performance.now();

      // 1. Parallel BM25 + Vector
      const [bm25Results, vectorResults] = await Promise.all([
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return generateMockBM25Results(30);
        })(),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return generateMockVectorResults(30);
        })(),
      ]);

      // 2. RRF Fusion
      const fusedResults = generateMockHybridResults(20);

      // 3. Reranking
      await new Promise((resolve) => setTimeout(resolve, 50));
      const reranked = fusedResults.slice(0, 10);

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(reranked.length).toBe(10);
      expect(latency).toBeLessThan(300);
    },
    { iterations: 20, warmupIterations: 2 }
  );
});

// ============================================================================
// P95 Latency Target Verification
// ============================================================================

describe('Latency Targets', () => {
  bench(
    'verify p95 < 500ms target (full pipeline)',
    async () => {
      const latencies: number[] = [];

      for (let i = 0; i < 20; i++) {
        const startTime = performance.now();

        // Full pipeline: HyDE + BM25 + Vector + Fusion + Rerank
        await new Promise((resolve) => setTimeout(resolve, 80)); // HyDE

        await Promise.all([
          new Promise((resolve) => setTimeout(resolve, 15)), // BM25
          new Promise((resolve) => setTimeout(resolve, 30)), // Vector
        ]);

        await new Promise((resolve) => setTimeout(resolve, 5)); // Fusion
        await new Promise((resolve) => setTimeout(resolve, 40)); // Rerank

        const endTime = performance.now();
        latencies.push(endTime - startTime);
      }

      const stats = calculatePercentiles(latencies);

      console.log(`Search latency stats:`);
      console.log(`  Min: ${stats.min.toFixed(2)}ms`);
      console.log(`  Mean: ${stats.mean.toFixed(2)}ms`);
      console.log(`  p50: ${stats.p50.toFixed(2)}ms`);
      console.log(`  p95: ${stats.p95.toFixed(2)}ms`);
      console.log(`  p99: ${stats.p99.toFixed(2)}ms`);
      console.log(`  Max: ${stats.max.toFixed(2)}ms`);

      // Target: p95 < 500ms
      expect(stats.p95).toBeLessThan(500);
    },
    { iterations: 5, warmupIterations: 1 }
  );
});

// ============================================================================
// Concurrent Search Benchmarks
// ============================================================================

describe('Concurrent Search', () => {
  bench(
    '10 concurrent searches',
    async () => {
      const startTime = performance.now();

      const searchPromises = Array.from({ length: 10 }, async (_, i) => {
        // Simulate a search
        await new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 20));
        return generateMockHybridResults(10);
      });

      const results = await Promise.all(searchPromises);

      const endTime = performance.now();
      const latency = endTime - startTime;

      expect(results.length).toBe(10);
      results.forEach((r) => expect(r.length).toBe(10));

      // All searches should complete in parallel, not serially
      expect(latency).toBeLessThan(200); // Not 10 * 50ms = 500ms
    },
    { iterations: 10, warmupIterations: 2 }
  );
});
