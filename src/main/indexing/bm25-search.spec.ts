/**
 * BM25 Search Tests
 *
 * Tests for the BM25 full-text search functionality.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BM25Search, resetBM25Search } from './bm25-search';

// Mock better-sqlite3
const mockPrepare = vi.fn();
const mockGet = vi.fn();
const mockAll = vi.fn();
const mockRun = vi.fn();

const mockDb = {
  prepare: mockPrepare,
} as any;

describe('BM25Search', () => {
  let bm25: BM25Search;

  beforeEach(() => {
    vi.clearAllMocks();
    resetBM25Search();

    // Setup default mock behavior
    mockPrepare.mockReturnValue({
      get: mockGet,
      all: mockAll,
      run: mockRun,
    });

    bm25 = new BM25Search(mockDb);
  });

  describe('search', () => {
    it('should return empty results for empty query', () => {
      const results = bm25.search({
        query: '',
        storeId: 'test-store',
      });

      expect(results).toEqual([]);
      expect(mockPrepare).not.toHaveBeenCalled();
    });

    it('should return empty results for whitespace-only query', () => {
      const results = bm25.search({
        query: '   ',
        storeId: 'test-store',
      });

      expect(results).toEqual([]);
    });

    it('should build FTS query from search terms', () => {
      mockAll.mockReturnValue([]);

      bm25.search({
        query: 'function async',
        storeId: 'test-store',
        limit: 10,
      });

      expect(mockPrepare).toHaveBeenCalled();
      const sql = mockPrepare.mock.calls[0][0];
      expect(sql).toContain('MATCH');
      expect(sql).toContain('store_id');
    });

    it('should apply file pattern filters with GLOB', () => {
      mockAll.mockReturnValue([]);

      bm25.search({
        query: 'test',
        storeId: 'test-store',
        filePatterns: ['*.ts', 'src/**/*.js'],
      });

      expect(mockPrepare).toHaveBeenCalled();
      const sql = mockPrepare.mock.calls[0][0];
      expect(sql).toContain('GLOB');
    });

    it('should map database rows to BM25SearchResult', () => {
      mockAll.mockReturnValue([
        {
          section_id: 'section-1',
          file_path: '/test/file.ts',
          content: 'function test() { return true; }',
          score: -5.5,
          snippet: '<mark>function</mark> test()',
        },
      ]);

      const results = bm25.search({
        query: 'function',
        storeId: 'test-store',
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        sectionId: 'section-1',
        filePath: '/test/file.ts',
        content: 'function test() { return true; }',
        score: 5.5, // Absolute value
        matchedTerms: ['function'],
        snippet: '<mark>function</mark> test()',
      });
    });

    it('should use default limit and offset', () => {
      mockAll.mockReturnValue([]);

      bm25.search({
        query: 'test',
        storeId: 'test-store',
      });

      // Check that limit (50) and offset (0) are passed
      const allArgs = mockAll.mock.calls[0];
      expect(allArgs).toContain(50); // default limit
      expect(allArgs).toContain(0); // default offset
    });

    it('should boost symbols when enabled', () => {
      mockAll.mockReturnValue([]);

      bm25.search({
        query: 'test',
        storeId: 'test-store',
        boostSymbols: true,
      });

      const sql = mockPrepare.mock.calls[0][0];
      expect(sql).toContain('bm25');
      expect(sql).toContain('1.0, 0.5, 1.0, 2.0'); // boosted weights
    });

    it('should use equal weights when boost disabled', () => {
      mockAll.mockReturnValue([]);

      bm25.search({
        query: 'test',
        storeId: 'test-store',
        boostSymbols: false,
      });

      const sql = mockPrepare.mock.calls[0][0];
      expect(sql).toContain('1.0, 1.0, 1.0, 1.0'); // equal weights
    });

    it('should handle database errors gracefully', () => {
      mockAll.mockImplementation(() => {
        throw new Error('Database error');
      });

      const results = bm25.search({
        query: 'test',
        storeId: 'test-store',
      });

      expect(results).toEqual([]);
    });

    it('should find matched terms in content', () => {
      mockAll.mockReturnValue([
        {
          section_id: 'section-1',
          file_path: '/test/file.ts',
          content: 'async function testFunction() { await doSomething(); }',
          score: -3.0,
          snippet: 'async function...',
        },
      ]);

      const results = bm25.search({
        query: 'async function test',
        storeId: 'test-store',
      });

      expect(results[0].matchedTerms).toContain('async');
      expect(results[0].matchedTerms).toContain('function');
      expect(results[0].matchedTerms).toContain('test');
    });
  });

  describe('addDocument', () => {
    it('should insert document into FTS index', () => {
      bm25.addDocument({
        storeId: 'test-store',
        sectionId: 'section-1',
        filePath: '/test/file.ts',
        content: 'function test() {}',
        symbols: ['test'],
      });

      expect(mockPrepare).toHaveBeenCalled();
      const sql = mockPrepare.mock.calls[0][0];
      expect(sql).toContain('INSERT INTO code_fts');
      expect(mockRun).toHaveBeenCalledWith(
        'test-store',
        'section-1',
        '/test/file.ts',
        'function test() {}',
        'test'
      );
    });

    it('should join symbols with space', () => {
      bm25.addDocument({
        storeId: 'test-store',
        sectionId: 'section-1',
        filePath: '/test/file.ts',
        content: 'content',
        symbols: ['foo', 'bar', 'baz'],
      });

      expect(mockRun).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        'foo bar baz'
      );
    });

    it('should handle empty symbols array', () => {
      bm25.addDocument({
        storeId: 'test-store',
        sectionId: 'section-1',
        filePath: '/test/file.ts',
        content: 'content',
      });

      expect(mockRun).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        '' // empty string for no symbols
      );
    });
  });

  describe('removeDocument', () => {
    it('should delete document from FTS index', () => {
      bm25.removeDocument('section-1');

      expect(mockPrepare).toHaveBeenCalled();
      const sql = mockPrepare.mock.calls[0][0];
      expect(sql).toContain('DELETE FROM code_fts');
      expect(sql).toContain('section_id');
      expect(mockRun).toHaveBeenCalledWith('section-1');
    });
  });

  describe('clearStore', () => {
    it('should delete all documents for a store', () => {
      bm25.clearStore('test-store');

      expect(mockPrepare).toHaveBeenCalled();
      const sql = mockPrepare.mock.calls[0][0];
      expect(sql).toContain('DELETE FROM code_fts');
      expect(sql).toContain('store_id');
      expect(mockRun).toHaveBeenCalledWith('test-store');
    });
  });

  describe('getStats', () => {
    it('should return document count', () => {
      mockGet.mockReturnValue({ count: 42 });

      const stats = bm25.getStats('test-store');

      expect(stats.documentCount).toBe(42);
    });

    it('should return zero for empty index', () => {
      mockGet.mockReturnValue(undefined);

      const stats = bm25.getStats('test-store');

      expect(stats.documentCount).toBe(0);
    });

    it('should handle errors gracefully', () => {
      mockGet.mockImplementation(() => {
        throw new Error('Database error');
      });

      const stats = bm25.getStats('test-store');

      expect(stats).toEqual({ documentCount: 0, uniqueTerms: 0 });
    });
  });

  describe('rebuildIndex', () => {
    it('should optimize the FTS index', () => {
      bm25.rebuildIndex();

      expect(mockPrepare).toHaveBeenCalled();
      const sql = mockPrepare.mock.calls[0][0];
      expect(sql).toContain('optimize');
    });
  });
});
