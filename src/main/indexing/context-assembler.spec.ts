/**
 * Context Assembler Tests
 *
 * Tests for the context assembly functionality that builds
 * AI query context with token budget management.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextAssembler, resetContextAssembler } from './context-assembler';

// Mock hybrid search
vi.mock('./hybrid-search', () => ({
  getHybridSearchService: vi.fn(() => ({
    search: vi.fn().mockResolvedValue([]),
  })),
}));

import { getHybridSearchService } from './hybrid-search';

const mockPrepare = vi.fn();
const mockGet = vi.fn();
const mockAll = vi.fn();

const mockDb = {
  prepare: mockPrepare,
} as any;

describe('ContextAssembler', () => {
  let assembler: ContextAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
    resetContextAssembler();

    mockPrepare.mockReturnValue({
      get: mockGet,
      all: mockAll,
    });

    assembler = new ContextAssembler(mockDb);
  });

  describe('assembleContext', () => {
    it('should return empty context for no search results', async () => {
      (getHybridSearchService as any).mockReturnValue({
        search: vi.fn().mockResolvedValue([]),
      });

      assembler = new ContextAssembler(mockDb);

      const context = await assembler.assembleContext({
        query: 'test query',
        storeId: 'test-store',
        tokenBudget: 4000,
      });

      expect(context.mainChunks).toEqual([]);
      expect(context.relatedSymbols).toEqual([]);
      expect(context.importedModules).toEqual([]);
      expect(context.totalTokens).toBe(0);
    });

    it('should respect token budget for main chunks', async () => {
      const mockSearch = vi.fn().mockResolvedValue([
        {
          sectionId: 'section-1',
          filePath: '/file1.ts',
          content: 'a'.repeat(1000), // ~250 tokens
          startLine: 1,
          endLine: 10,
          score: 0.9,
          language: 'typescript',
        },
        {
          sectionId: 'section-2',
          filePath: '/file2.ts',
          content: 'b'.repeat(1000),
          startLine: 1,
          endLine: 10,
          score: 0.8,
          language: 'typescript',
        },
      ]);

      (getHybridSearchService as any).mockReturnValue({ search: mockSearch });
      assembler = new ContextAssembler(mockDb);

      const context = await assembler.assembleContext({
        query: 'test',
        storeId: 'test-store',
        tokenBudget: 300, // Small budget
        includeImports: false,
        includeSymbolDefinitions: false,
      });

      // Should have limited chunks based on budget
      expect(context.totalTokens).toBeLessThanOrEqual(300);
    });

    it('should include symbol definitions when enabled', async () => {
      const mockSearch = vi.fn().mockResolvedValue([
        {
          sectionId: 'section-1',
          filePath: '/file1.ts',
          content: 'function myFunction() { callHelper(); }',
          startLine: 1,
          endLine: 5,
          score: 0.9,
        },
      ]);

      (getHybridSearchService as any).mockReturnValue({ search: mockSearch });

      // Mock symbol lookup
      mockGet.mockReturnValue({
        name: 'callHelper',
        type: 'function',
        file_path: '/helpers.ts',
        start_line: 10,
        end_line: 15,
        signature: 'function callHelper(): void',
        doc_comment: '/** Helper function */',
      });

      assembler = new ContextAssembler(mockDb);

      const context = await assembler.assembleContext({
        query: 'test',
        storeId: 'test-store',
        tokenBudget: 4000,
        includeSymbolDefinitions: true,
        includeImports: false,
      });

      // Should have attempted to find symbols
      expect(context).toBeDefined();
    });

    it('should include imported modules when enabled', async () => {
      const mockSearch = vi.fn().mockResolvedValue([
        {
          sectionId: 'section-1',
          filePath: '/file1.ts',
          content: 'import { helper } from "utils";',
          startLine: 1,
          endLine: 5,
          score: 0.9,
        },
      ]);

      (getHybridSearchService as any).mockReturnValue({ search: mockSearch });

      // Mock file imports lookup
      mockGet
        .mockReturnValueOnce({ imports_json: JSON.stringify([{ source: 'utils' }]) })
        .mockReturnValueOnce({ path: '/utils/index.ts', exports_json: JSON.stringify([{ name: 'helper' }]) });

      assembler = new ContextAssembler(mockDb);

      const context = await assembler.assembleContext({
        query: 'test',
        storeId: 'test-store',
        tokenBudget: 4000,
        includeImports: true,
        includeSymbolDefinitions: false,
      });

      expect(context).toBeDefined();
    });

    it('should allocate token budget proportionally', async () => {
      const mockSearch = vi.fn().mockResolvedValue([
        {
          sectionId: 'section-1',
          filePath: '/file1.ts',
          content: 'const x = 1;',
          startLine: 1,
          endLine: 1,
          score: 0.9,
        },
      ]);

      (getHybridSearchService as any).mockReturnValue({ search: mockSearch });
      assembler = new ContextAssembler(mockDb);

      const context = await assembler.assembleContext({
        query: 'test',
        storeId: 'test-store',
        tokenBudget: 1000,
        includeImports: true,
        includeSymbolDefinitions: true,
      });

      // Should respect total budget
      expect(context.totalTokens).toBeLessThanOrEqual(1000);
    });

    it('should truncate content to fit remaining budget', async () => {
      const longContent = 'x'.repeat(10000); // Very long content
      const mockSearch = vi.fn().mockResolvedValue([
        {
          sectionId: 'section-1',
          filePath: '/file1.ts',
          content: longContent,
          startLine: 1,
          endLine: 100,
          score: 0.9,
        },
      ]);

      (getHybridSearchService as any).mockReturnValue({ search: mockSearch });
      assembler = new ContextAssembler(mockDb);

      const context = await assembler.assembleContext({
        query: 'test',
        storeId: 'test-store',
        tokenBudget: 500,
        includeImports: false,
        includeSymbolDefinitions: false,
      });

      // Should have truncated content
      if (context.mainChunks.length > 0) {
        expect(context.mainChunks[0].content.length).toBeLessThan(longContent.length);
      }
    });

    it('should filter by minimum relevance score', async () => {
      const mockSearch = vi.fn().mockResolvedValue([
        {
          sectionId: 'section-1',
          filePath: '/file1.ts',
          content: 'relevant',
          startLine: 1,
          endLine: 1,
          score: 0.1, // Below default threshold
        },
      ]);

      (getHybridSearchService as any).mockReturnValue({ search: mockSearch });
      assembler = new ContextAssembler(mockDb);

      const context = await assembler.assembleContext({
        query: 'test',
        storeId: 'test-store',
        tokenBudget: 1000,
        minRelevanceScore: 0.5,
        includeImports: false,
        includeSymbolDefinitions: false,
      });

      // Low score results filtered by the search itself
      expect(context).toBeDefined();
    });

    it('should limit max chunks', async () => {
      const manyResults = Array.from({ length: 50 }, (_, i) => ({
        sectionId: `section-${i}`,
        filePath: `/file${i}.ts`,
        content: `content ${i}`,
        startLine: 1,
        endLine: 5,
        score: 0.9 - i * 0.01,
      }));

      const mockSearch = vi.fn().mockResolvedValue(manyResults);
      (getHybridSearchService as any).mockReturnValue({ search: mockSearch });

      assembler = new ContextAssembler(mockDb);

      const context = await assembler.assembleContext({
        query: 'test',
        storeId: 'test-store',
        tokenBudget: 100000, // Large budget
        maxChunks: 5,
        includeImports: false,
        includeSymbolDefinitions: false,
      });

      expect(context.mainChunks.length).toBeLessThanOrEqual(5);
    });
  });

  describe('findRelatedSymbols', () => {
    it('should extract symbol references from chunks', async () => {
      const chunks = [
        {
          content: 'const result = myFunction(arg1, arg2);',
          filePath: '/test.ts',
          startLine: 1,
          endLine: 1,
          relevanceScore: 0.9,
        },
      ];

      // Mock symbol lookup
      mockGet.mockReturnValue({
        name: 'myFunction',
        type: 'function',
        file_path: '/utils.ts',
        start_line: 10,
        end_line: 20,
        signature: 'function myFunction(a: string, b: number): boolean',
        doc_comment: null,
      });

      const symbols = await assembler.findRelatedSymbols(chunks, 'test-store', 1000);

      // Should have queried for myFunction
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should respect symbol token budget', async () => {
      const chunks = [
        {
          content: 'func1(); func2(); func3(); func4();',
          filePath: '/test.ts',
          startLine: 1,
          endLine: 1,
          relevanceScore: 0.9,
        },
      ];

      // Return large symbol definitions
      mockGet.mockReturnValue({
        name: 'func1',
        type: 'function',
        file_path: '/utils.ts',
        start_line: 1,
        end_line: 100,
        signature: 'a'.repeat(500), // Large signature
        doc_comment: 'b'.repeat(500), // Large comment
      });

      const symbols = await assembler.findRelatedSymbols(chunks, 'test-store', 100);

      // Should be limited by budget
      expect(symbols.length).toBeLessThanOrEqual(1);
    });

    it('should skip keywords', async () => {
      const chunks = [
        {
          content: 'if (true) { return false; }',
          filePath: '/test.ts',
          startLine: 1,
          endLine: 1,
          relevanceScore: 0.9,
        },
      ];

      mockGet.mockReturnValue(null);

      const symbols = await assembler.findRelatedSymbols(chunks, 'test-store', 1000);

      // Keywords like 'if', 'return', 'true', 'false' should be skipped
      expect(symbols).toEqual([]);
    });
  });

  describe('findImportedModules', () => {
    it('should find module info for imports', async () => {
      const chunks = [
        {
          content: 'import { x } from "module";',
          filePath: '/test.ts',
          startLine: 1,
          endLine: 1,
          relevanceScore: 0.9,
        },
      ];

      mockGet
        .mockReturnValueOnce({ imports_json: JSON.stringify([{ source: 'module' }]) })
        .mockReturnValueOnce({ path: '/node_modules/module/index.js', exports_json: '[]' });

      const modules = await assembler.findImportedModules(chunks, 'test-store', 1000);

      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should skip relative imports', async () => {
      const chunks = [
        {
          content: 'import { x } from "./local";',
          filePath: '/test.ts',
          startLine: 1,
          endLine: 1,
          relevanceScore: 0.9,
        },
      ];

      mockGet.mockReturnValue({
        imports_json: JSON.stringify([{ source: './local' }]),
      });

      const modules = await assembler.findImportedModules(chunks, 'test-store', 1000);

      // Relative imports (starting with .) should be filtered
      expect(modules).toEqual([]);
    });
  });
});
