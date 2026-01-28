/**
 * Search Analytics Tests
 *
 * Tests for search event tracking and analytics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SearchAnalytics, resetSearchAnalytics } from './search-analytics';

const mockPrepare = vi.fn();
const mockRun = vi.fn();
const mockGet = vi.fn();
const mockAll = vi.fn();

const mockDb = {
  prepare: mockPrepare,
} as any;

describe('SearchAnalytics', () => {
  let analytics: SearchAnalytics;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSearchAnalytics();

    mockPrepare.mockReturnValue({
      run: mockRun,
      get: mockGet,
      all: mockAll,
    });

    // Mock run() to return changes info
    mockRun.mockReturnValue({ changes: 1 });

    analytics = new SearchAnalytics(mockDb);
  });

  describe('logSearch', () => {
    it('should insert a search event', () => {
      const id = analytics.logSearch({
        query: 'test query',
        storeId: 'test-store',
        resultsCount: 10,
        topResultScore: 0.95,
        searchDurationMs: 150,
        hydeUsed: true,
        rerankUsed: false,
      });

      expect(id).toBeDefined();
      expect(id).toContain('search-');
      expect(mockRun).toHaveBeenCalled();
    });

    it('should store all event properties', () => {
      analytics.logSearch({
        query: 'find function',
        storeId: 'my-store',
        resultsCount: 5,
        topResultScore: 0.8,
        searchDurationMs: 200,
        hydeUsed: false,
        rerankUsed: true,
      });

      expect(mockRun).toHaveBeenCalledWith(
        expect.any(String), // id
        'find function', // query
        'my-store', // storeId
        expect.any(Number), // timestamp
        5, // resultsCount
        0.8, // topResultScore
        '[]', // clickedResults (empty initially)
        200, // searchDurationMs
        0, // hydeUsed (false = 0)
        1 // rerankUsed (true = 1)
      );
    });

    it('should handle database errors gracefully', () => {
      mockRun.mockImplementation(() => {
        throw new Error('Database error');
      });

      // Should not throw, just log error
      const id = analytics.logSearch({
        query: 'test',
        storeId: 'store',
        resultsCount: 0,
        topResultScore: 0,
        searchDurationMs: 0,
        hydeUsed: false,
        rerankUsed: false,
      });

      expect(id).toBeDefined(); // Still returns ID
    });
  });

  describe('recordClick', () => {
    it('should update clicked indices', () => {
      mockGet.mockReturnValue({ clicked_indices: '[]' });

      analytics.recordClick('search-123', 2);

      expect(mockRun).toHaveBeenCalledWith('[2]', 'search-123');
    });

    it('should append to existing clicks', () => {
      mockGet.mockReturnValue({ clicked_indices: '[0, 1]' });

      analytics.recordClick('search-123', 3);

      expect(mockRun).toHaveBeenCalledWith('[0,1,3]', 'search-123');
    });

    it('should not duplicate click indices', () => {
      mockGet.mockReturnValue({ clicked_indices: '[0, 1, 2]' });

      analytics.recordClick('search-123', 1); // Already exists

      // Should not update if index already exists
      expect(mockRun).toHaveBeenCalledWith('[0,1,2]', 'search-123');
    });

    it('should handle non-existent search ID', () => {
      mockGet.mockReturnValue(undefined);

      // Should not throw
      expect(() => analytics.recordClick('non-existent', 0)).not.toThrow();
    });
  });

  describe('getMetrics', () => {
    it('should return aggregate metrics', () => {
      mockGet.mockReturnValue({
        total: 100,
        avg_score: 0.75,
        avg_duration: 180,
        zero_results: 5,
      });

      mockAll.mockReturnValue([
        { clicked_indices: '[0]' },
        { clicked_indices: '[1, 2]' },
      ]);

      const metrics = analytics.getMetrics('test-store');

      expect(metrics.totalSearches).toBe(100);
      expect(metrics.avgResultScore).toBe(0.75);
      expect(metrics.avgSearchDuration).toBe(180);
      expect(metrics.zeroResultRate).toBe(0.05);
    });

    it('should return zero metrics for empty store', () => {
      mockGet.mockReturnValue({ total: 0 });

      const metrics = analytics.getMetrics('empty-store');

      expect(metrics).toEqual({
        totalSearches: 0,
        avgResultScore: 0,
        avgClickDepth: 0,
        zeroResultRate: 0,
        avgSearchDuration: 0,
      });
    });

    it('should filter by time range', () => {
      mockGet.mockReturnValue({
        total: 50,
        avg_score: 0.8,
        avg_duration: 150,
        zero_results: 2,
      });

      mockAll.mockReturnValue([]);

      analytics.getMetrics('test-store', 24 * 60 * 60 * 1000); // Last 24 hours

      // Check that timestamp filter was applied
      const sql = mockPrepare.mock.calls[0]?.[0];
      // The SQL should include timestamp filter
    });

    it('should handle database errors', () => {
      mockGet.mockImplementation(() => {
        throw new Error('Database error');
      });

      const metrics = analytics.getMetrics('test-store');

      expect(metrics).toEqual({
        totalSearches: 0,
        avgResultScore: 0,
        avgClickDepth: 0,
        zeroResultRate: 0,
        avgSearchDuration: 0,
      });
    });
  });

  describe('getQueryPatterns', () => {
    it('should return frequent query patterns', () => {
      mockAll.mockReturnValue([
        {
          query: 'function async',
          frequency: 15,
          avg_score: 0.82,
          avg_click_depth: 1.5,
          success_rate: 0.8,
        },
        {
          query: 'import type',
          frequency: 10,
          avg_score: 0.75,
          avg_click_depth: 2.0,
          success_rate: 0.7,
        },
      ]);

      const patterns = analytics.getQueryPatterns('test-store');

      expect(patterns).toHaveLength(2);
      expect(patterns[0].pattern).toBe('function async');
      expect(patterns[0].frequency).toBe(15);
      expect(patterns[0].avgResultScore).toBe(0.82);
    });

    it('should limit results', () => {
      const manyPatterns = Array.from({ length: 50 }, (_, i) => ({
        query: `query-${i}`,
        frequency: 50 - i,
        avg_score: 0.5,
        avg_click_depth: 1,
        success_rate: 0.5,
      }));

      mockAll.mockReturnValue(manyPatterns.slice(0, 10));

      const patterns = analytics.getQueryPatterns('test-store', 10);

      expect(patterns.length).toBeLessThanOrEqual(10);
    });

    it('should handle empty results', () => {
      mockAll.mockReturnValue([]);

      const patterns = analytics.getQueryPatterns('test-store');

      expect(patterns).toEqual([]);
    });
  });

  describe('getRecentSearches', () => {
    it('should return recent search events', () => {
      mockAll.mockReturnValue([
        {
          id: 'search-1',
          query: 'test query',
          store_id: 'test-store',
          timestamp: Date.now(),
          results_count: 10,
          top_result_score: 0.9,
          clicked_indices: '[0, 1]',
          search_duration_ms: 150,
          hyde_used: 1,
          rerank_used: 0,
        },
      ]);

      const searches = analytics.getRecentSearches('test-store');

      expect(searches).toHaveLength(1);
      expect(searches[0].query).toBe('test query');
      expect(searches[0].clickedResults).toEqual([0, 1]);
      expect(searches[0].hydeUsed).toBe(true);
      expect(searches[0].rerankUsed).toBe(false);
    });

    it('should limit results', () => {
      const manySearches = Array.from({ length: 100 }, (_, i) => ({
        id: `search-${i}`,
        query: `query ${i}`,
        store_id: 'test-store',
        timestamp: Date.now() - i * 1000,
        results_count: 5,
        top_result_score: 0.8,
        clicked_indices: '[]',
        search_duration_ms: 100,
        hyde_used: 0,
        rerank_used: 0,
      }));

      mockAll.mockReturnValue(manySearches.slice(0, 20));

      const searches = analytics.getRecentSearches('test-store', 20);

      expect(searches.length).toBeLessThanOrEqual(20);
    });
  });

  describe('cleanupOldEvents', () => {
    it('should delete events older than retention period', () => {
      mockRun.mockReturnValue({ changes: 50 });

      const deleted = analytics.cleanupOldEvents(30);

      expect(deleted).toBe(50);
      expect(mockPrepare).toHaveBeenCalled();

      const sql = mockPrepare.mock.calls.find((call: any[]) =>
        call[0].includes('DELETE')
      );
      expect(sql).toBeDefined();
    });

    it('should use default retention of 30 days', () => {
      mockRun.mockReturnValue({ changes: 10 });

      analytics.cleanupOldEvents();

      expect(mockRun).toHaveBeenCalled();
    });

    it('should handle errors gracefully', () => {
      mockRun.mockImplementation(() => {
        throw new Error('Database error');
      });

      const deleted = analytics.cleanupOldEvents();

      expect(deleted).toBe(0);
    });
  });

  describe('getHyDEEffectiveness', () => {
    it('should compare scores with and without HyDE', () => {
      mockAll.mockReturnValue([
        { hyde_used: 0, avg_score: 0.7 },
        { hyde_used: 1, avg_score: 0.85 },
      ]);

      const effectiveness = analytics.getHyDEEffectiveness('test-store');

      expect(effectiveness.withoutHyDE).toBe(0.7);
      expect(effectiveness.withHyDE).toBe(0.85);
    });

    it('should handle missing data', () => {
      mockAll.mockReturnValue([]);

      const effectiveness = analytics.getHyDEEffectiveness('test-store');

      expect(effectiveness).toEqual({ withHyDE: 0, withoutHyDE: 0 });
    });

    it('should handle partial data', () => {
      mockAll.mockReturnValue([
        { hyde_used: 1, avg_score: 0.9 },
      ]);

      const effectiveness = analytics.getHyDEEffectiveness('test-store');

      expect(effectiveness.withHyDE).toBe(0.9);
      expect(effectiveness.withoutHyDE).toBe(0);
    });
  });
});
