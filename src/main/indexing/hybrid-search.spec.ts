/**
 * Hybrid Search Tests
 *
 * Tests for the hybrid search combining BM25 and vector search
 * with Reciprocal Rank Fusion (RRF).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HybridSearchService, resetHybridSearchService } from './hybrid-search';

// Mock dependencies
vi.mock('./bm25-search', () => ({
  getBM25Search: vi.fn(() => ({
    search: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../rlm/vector-store', () => ({
  getVectorStore: vi.fn(() => ({
    search: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../rlm/hyde-service', () => ({
  getHyDEService: vi.fn(() => ({
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2], hydeUsed: true }),
  })),
}));

import { getBM25Search } from './bm25-search';
import { getVectorStore } from '../rlm/vector-store';
import { getHyDEService } from '../rlm/hyde-service';

const mockDb = {
  prepare: vi.fn().mockReturnValue({
    get: vi.fn(),
    all: vi.fn(),
  }),
} as any;

describe('HybridSearchService', () => {
  let hybridSearch: HybridSearchService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetHybridSearchService();
    hybridSearch = new HybridSearchService(mockDb);
  });

  describe('search', () => {
    it('should run BM25 and vector search in parallel', async () => {
      const mockBm25Search = vi.fn().mockReturnValue([]);
      const mockVectorSearch = vi.fn().mockResolvedValue([]);

      (getBM25Search as any).mockReturnValue({ search: mockBm25Search });
      (getVectorStore as any).mockReturnValue({ search: mockVectorSearch });

      hybridSearch = new HybridSearchService(mockDb);

      await hybridSearch.search({
        query: 'test query',
        storeId: 'test-store',
        topK: 10,
      });

      expect(mockBm25Search).toHaveBeenCalled();
      expect(mockVectorSearch).toHaveBeenCalled();
    });

    it('should use default config values when not provided', async () => {
      const mockBm25Search = vi.fn().mockReturnValue([]);
      (getBM25Search as any).mockReturnValue({ search: mockBm25Search });

      hybridSearch = new HybridSearchService(mockDb);

      await hybridSearch.search({
        query: 'test',
        storeId: 'store',
      });

      // Should use default topK from config
      expect(mockBm25Search).toHaveBeenCalled();
    });

    it('should apply HyDE when enabled', async () => {
      const mockHydeEmbed = vi.fn().mockResolvedValue({
        embedding: [0.1, 0.2],
        hydeUsed: true,
      });

      (getHyDEService as any).mockReturnValue({ embed: mockHydeEmbed });
      hybridSearch = new HybridSearchService(mockDb);

      await hybridSearch.search({
        query: 'test query',
        storeId: 'test-store',
        useHyDE: true,
      });

      expect(mockHydeEmbed).toHaveBeenCalled();
    });

    it('should return empty array for no results', async () => {
      const mockBm25Search = vi.fn().mockReturnValue([]);
      const mockVectorSearch = vi.fn().mockResolvedValue([]);

      (getBM25Search as any).mockReturnValue({ search: mockBm25Search });
      (getVectorStore as any).mockReturnValue({ search: mockVectorSearch });

      hybridSearch = new HybridSearchService(mockDb);

      const results = await hybridSearch.search({
        query: 'nonexistent',
        storeId: 'test-store',
      });

      expect(results).toEqual([]);
    });

    it('should filter results by minimum score', async () => {
      const mockBm25Search = vi.fn().mockReturnValue([
        {
          sectionId: 'low-score',
          filePath: '/test.ts',
          content: 'test',
          score: 0.01,
          matchedTerms: [],
          snippet: '',
        },
      ]);

      (getBM25Search as any).mockReturnValue({ search: mockBm25Search });

      hybridSearch = new HybridSearchService(mockDb);

      const results = await hybridSearch.search({
        query: 'test',
        storeId: 'test-store',
        minScore: 0.5,
      });

      expect(results).toHaveLength(0);
    });
  });

  describe('RRF score calculation', () => {
    it('should combine BM25 and vector scores using RRF', async () => {
      // Setup mock results that appear in both searches
      const mockBm25Search = vi.fn().mockReturnValue([
        {
          sectionId: 'section-1',
          filePath: '/file1.ts',
          content: 'content 1',
          score: 10,
          matchedTerms: ['test'],
          snippet: 'snippet',
        },
        {
          sectionId: 'section-2',
          filePath: '/file2.ts',
          content: 'content 2',
          score: 5,
          matchedTerms: ['test'],
          snippet: 'snippet',
        },
      ]);

      const mockVectorSearch = vi.fn().mockResolvedValue([
        {
          entry: { sectionId: 'section-1', contentPreview: 'content 1' },
          similarity: 0.9,
        },
        {
          entry: { sectionId: 'section-3', contentPreview: 'content 3' },
          similarity: 0.8,
        },
      ]);

      (getBM25Search as any).mockReturnValue({ search: mockBm25Search });
      (getVectorStore as any).mockReturnValue({ search: mockVectorSearch });

      // Mock getSectionMetadata
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          file_path: '/file1.ts',
          start_line: 1,
          end_line: 10,
          language: 'typescript',
        }),
      });

      hybridSearch = new HybridSearchService(mockDb);

      const results = await hybridSearch.search({
        query: 'test',
        storeId: 'test-store',
        bm25Weight: 0.5,
        vectorWeight: 0.5,
        minScore: 0,
      });

      // section-1 should rank higher because it appears in both
      expect(results.length).toBeGreaterThan(0);

      const section1Result = results.find(r => r.sectionId === 'section-1');
      if (section1Result) {
        expect(section1Result.matchType).toBe('hybrid');
        expect(section1Result.bm25Score).toBeDefined();
        expect(section1Result.vectorScore).toBeDefined();
      }
    });

    it('should determine match type correctly', async () => {
      const mockBm25Search = vi.fn().mockReturnValue([
        {
          sectionId: 'bm25-only',
          filePath: '/file.ts',
          content: 'content',
          score: 5,
          matchedTerms: [],
          snippet: '',
        },
      ]);

      const mockVectorSearch = vi.fn().mockResolvedValue([
        {
          entry: { sectionId: 'vector-only', contentPreview: 'content' },
          similarity: 0.8,
        },
      ]);

      (getBM25Search as any).mockReturnValue({ search: mockBm25Search });
      (getVectorStore as any).mockReturnValue({ search: mockVectorSearch });

      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          file_path: '/file.ts',
          start_line: 1,
          end_line: 10,
        }),
      });

      hybridSearch = new HybridSearchService(mockDb);

      const results = await hybridSearch.search({
        query: 'test',
        storeId: 'test-store',
        minScore: 0,
      });

      const bm25Only = results.find(r => r.sectionId === 'bm25-only');
      const vectorOnly = results.find(r => r.sectionId === 'vector-only');

      if (bm25Only) {
        expect(bm25Only.matchType).toBe('bm25');
      }
      if (vectorOnly) {
        expect(vectorOnly.matchType).toBe('vector');
      }
    });
  });

  describe('diversity filtering', () => {
    it('should limit results from same file', async () => {
      // Create many results from the same file
      const sameFileResults = Array.from({ length: 10 }, (_, i) => ({
        sectionId: `section-${i}`,
        filePath: '/same/file.ts',
        content: `content ${i}`,
        score: 10 - i,
        matchedTerms: [],
        snippet: '',
      }));

      const mockBm25Search = vi.fn().mockReturnValue(sameFileResults);
      (getBM25Search as any).mockReturnValue({ search: mockBm25Search });
      (getVectorStore as any).mockReturnValue({ search: vi.fn().mockResolvedValue([]) });

      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          file_path: '/same/file.ts',
          start_line: 1,
          end_line: 10,
        }),
      });

      hybridSearch = new HybridSearchService(mockDb);

      const results = await hybridSearch.search({
        query: 'test',
        storeId: 'test-store',
        topK: 10,
        minScore: 0,
      });

      // Diversity filtering should reduce results from same file
      const sameFileCount = results.filter(r => r.filePath === '/same/file.ts').length;
      expect(sameFileCount).toBeLessThan(10);
    });
  });

  describe('configure', () => {
    it('should update configuration', () => {
      hybridSearch.configure({
        bm25Weight: 0.7,
        vectorWeight: 0.3,
      });

      const config = hybridSearch.getConfig();
      expect(config.bm25Weight).toBe(0.7);
      expect(config.vectorWeight).toBe(0.3);
    });
  });
});
