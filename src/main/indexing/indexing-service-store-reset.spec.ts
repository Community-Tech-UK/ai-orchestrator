import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const statements: Array<{
    sql: string;
    run: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
  }> = [];

  const prepare = vi.fn((sql: string) => {
    const statement = {
      sql,
      run: vi.fn(),
      get: vi.fn(() => {
        if (sql.includes('SELECT tree_blob')) {
          return mocks.treeRow;
        }
        return undefined;
      }),
      all: vi.fn(() => []),
    };
    statements.push(statement);
    return statement;
  });

  return {
    statements,
    treeRow: undefined as { tree_blob: Buffer } | undefined,
    dbDriver: {
      prepare,
    },
    merkleTree: {
      buildTree: vi.fn(),
      collectAllFilePaths: vi.fn(),
      diffTrees: vi.fn(),
      deserialize: vi.fn(),
      serialize: vi.fn(),
      getTreeStats: vi.fn(),
    },
    chunker: {
      chunk: vi.fn(),
    },
    metadataExtractor: {
      extractFileMetadata: vi.fn(),
    },
    vectorStore: {
      addSection: vi.fn(),
      clearStore: vi.fn(),
      getStats: vi.fn(),
      removeSection: vi.fn(),
    },
    bm25: {
      addDocument: vi.fn(),
      clearStore: vi.fn(),
      getStats: vi.fn(),
      rebuildIndex: vi.fn(),
      removeDocument: vi.fn(),
    },
    contextManager: {
      addSection: vi.fn(),
      getStoreStats: vi.fn(),
      listSections: vi.fn(),
      removeSection: vi.fn(),
    },
  };
});

vi.mock('../persistence/rlm-database', () => ({
  RLMDatabase: {
    getInstance: vi.fn(() => ({ db: mocks.dbDriver })),
  },
}));

vi.mock('./merkle-tree', () => ({
  getMerkleTreeManager: vi.fn(() => mocks.merkleTree),
  MerkleTreeManager: vi.fn(),
}));

vi.mock('./tree-sitter-chunker', () => ({
  getTreeSitterChunker: vi.fn(() => mocks.chunker),
  TreeSitterChunker: vi.fn(),
}));

vi.mock('./metadata-extractor', () => ({
  getMetadataExtractor: vi.fn(() => mocks.metadataExtractor),
  MetadataExtractor: vi.fn(),
}));

vi.mock('../rlm/vector-store', () => ({
  getVectorStore: vi.fn(() => mocks.vectorStore),
  VectorStore: vi.fn(),
}));

vi.mock('./bm25-search', () => ({
  getBM25Search: vi.fn(() => mocks.bm25),
  BM25Search: vi.fn(),
}));

vi.mock('../rlm/context-manager', () => ({
  RLMContextManager: {
    getInstance: vi.fn(() => mocks.contextManager),
  },
}));

describe('CodebaseIndexingService store reset', () => {
  const tree = {
    hash: 'empty',
    path: '.',
    isDirectory: true,
    children: new Map(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.statements.length = 0;
    mocks.treeRow = undefined;
    mocks.merkleTree.buildTree.mockResolvedValue(tree);
    mocks.merkleTree.collectAllFilePaths.mockReturnValue([]);
    mocks.merkleTree.diffTrees.mockReturnValue([]);
    mocks.merkleTree.deserialize.mockReturnValue(tree);
    mocks.merkleTree.serialize.mockReturnValue(Buffer.from('tree'));
    mocks.merkleTree.getTreeStats.mockReturnValue({ fileCount: 0, directoryCount: 1, totalSize: 0 });
    mocks.contextManager.listSections.mockReturnValue([{ id: 'sec-old' }, { id: 'vec-old' }]);
    mocks.contextManager.getStoreStats.mockReturnValue({ sections: 0, totalTokens: 0 });
    mocks.vectorStore.getStats.mockResolvedValue({ totalVectors: 0, storeCount: 0, storeStats: [] });
  });

  it('clears stale store artifacts before saving a first baseline tree', async () => {
    const { CodebaseIndexingService } = await import('./indexing-service');
    const service = new CodebaseIndexingService();

    await service.indexCodebase('store-1', '/workspace/project');

    expect(mocks.bm25.clearStore).toHaveBeenCalledWith('store-1');
    expect(mocks.vectorStore.clearStore).toHaveBeenCalledWith('store-1');
    expect(mocks.contextManager.removeSection).toHaveBeenCalledWith('store-1', 'sec-old');
    expect(mocks.contextManager.removeSection).toHaveBeenCalledWith('store-1', 'vec-old');

    const sql = mocks.statements.map((statement) => statement.sql.replace(/\s+/g, ' ').trim());
    expect(sql).toContain('DELETE FROM search_index WHERE store_id = ?');
    expect(sql).toContain('DELETE FROM vectors WHERE store_id = ?');
    expect(sql).toContain('DELETE FROM file_metadata WHERE store_id = ?');
    expect(sql).toContain('DELETE FROM codebase_trees WHERE store_id = ?');
    expect(sql.some((statement) => statement.includes('INSERT INTO codebase_trees'))).toBe(true);
  });

  it('does not clear an unchanged store that already has a baseline tree', async () => {
    mocks.treeRow = { tree_blob: Buffer.from('existing-tree') };

    const { CodebaseIndexingService } = await import('./indexing-service');
    const service = new CodebaseIndexingService();

    await service.indexCodebase('store-1', '/workspace/project');

    expect(mocks.bm25.clearStore).not.toHaveBeenCalled();
    expect(mocks.vectorStore.clearStore).not.toHaveBeenCalled();
    expect(mocks.contextManager.removeSection).not.toHaveBeenCalled();
  });

  it('exposes an explicit legacy store cleanup action', async () => {
    const { CodebaseIndexingService } = await import('./indexing-service');
    const service = new CodebaseIndexingService();

    await service.clearLegacyCodebaseStore('codebase:test');

    expect(mocks.bm25.clearStore).toHaveBeenCalledWith('codebase:test');
    expect(mocks.vectorStore.clearStore).toHaveBeenCalledWith('codebase:test');
    expect(mocks.contextManager.removeSection).toHaveBeenCalledWith('codebase:test', 'sec-old');
    expect(mocks.contextManager.removeSection).toHaveBeenCalledWith('codebase:test', 'vec-old');

    const sql = mocks.statements.map((statement) => statement.sql.replace(/\s+/g, ' ').trim());
    expect(sql).toContain('DELETE FROM codebase_trees WHERE store_id = ?');
  });

  it('uses the persisted context section id for BM25 and vector records', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'codebase-index-section-id-'));
    const filePath = path.join(tmpRoot, 'src/index.ts');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'export function bootstrap() { return true; }\n', 'utf8');

    mocks.contextManager.addSection.mockReturnValue({
      id: 'sec-context-1',
      type: 'file',
      name: 'bootstrap',
      content: 'export function bootstrap() { return true; }',
      tokens: 8,
      startOffset: 0,
      endOffset: 43,
      checksum: 'checksum',
      depth: 0,
      filePath,
      language: 'typescript',
    });
    mocks.metadataExtractor.extractFileMetadata.mockResolvedValue({
      path: filePath,
      relativePath: 'src/index.ts',
      language: 'typescript',
      size: 43,
      lines: 1,
      hash: 'hash',
      lastModified: 1000,
      imports: [],
      exports: [],
      symbols: [{ name: 'bootstrap', type: 'function', line: 1, column: 1 }],
    });
    mocks.chunker.chunk.mockReturnValue([
      {
        content: 'export function bootstrap() { return true; }',
        type: 'function',
        name: 'bootstrap',
        language: 'typescript',
        startByte: 0,
        endByte: 43,
        startLine: 1,
        endLine: 1,
        tokens: 8,
        nodeType: 'function_declaration',
      },
    ]);

    try {
      const { CodebaseIndexingService } = await import('./indexing-service');
      const service = new CodebaseIndexingService({ minIntervalMs: 0 });

      await service.indexFile('store-1', filePath);

      expect(mocks.bm25.addDocument).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: 'store-1', sectionId: 'sec-context-1' }),
      );
      expect(mocks.vectorStore.addSection).toHaveBeenCalledWith(
        'store-1',
        'sec-context-1',
        'export function bootstrap() { return true; }',
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
