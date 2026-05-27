import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import type { Chunk } from '../types';

const sampleChunk = (overrides: Partial<Chunk> = {}): Chunk => ({
  contentHash: 'a'.repeat(64),
  astNormalizedHash: 'b'.repeat(64),
  language: 'typescript',
  chunkType: 'function',
  name: 'foo',
  signature: '() => number',
  docComment: null,
  symbolsJson: '[]',
  importsJson: '[]',
  exportsJson: '[]',
  rawText: 'function foo() { return 1; }',
  ...overrides,
});

describe('CasStore', () => {
  let db: Database.Database;
  let store: CasStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
  });

  it('migrates codemem search tables idempotently', () => {
    migrate(db);
    const tableNames = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'virtual')
    `).all() as Array<{ name: string }>;
    const names = tableNames.map((row) => row.name);

    expect(names).toContain('workspace_chunks');
    expect(names).toContain('code_fts');
    expect(names).toContain('code_index_status');
  });

  it('upsertChunk inserts a new chunk', () => {
    store.upsertChunk(sampleChunk());
    expect(store.getChunk('a'.repeat(64))).toMatchObject({ name: 'foo' });
  });

  it('upsertChunk is idempotent on contentHash', () => {
    store.upsertChunk(sampleChunk());
    store.upsertChunk(sampleChunk({ name: 'foo-renamed' }));
    expect(store.getChunk('a'.repeat(64))?.name).toBe('foo');
  });

  it('upsertManifestEntry replaces previous entry for same workspace/path', () => {
    store.upsertManifestEntry({
      workspaceHash: 'w1',
      pathFromRoot: 'src/a.ts',
      contentHash: 'c1',
      merkleLeafHash: 'm1',
      mtime: 1000,
    });
    store.upsertManifestEntry({
      workspaceHash: 'w1',
      pathFromRoot: 'src/a.ts',
      contentHash: 'c2',
      merkleLeafHash: 'm2',
      mtime: 2000,
    });
    const rows = store.listManifestEntries('w1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contentHash).toBe('c2');
  });

  it('upsertWorkspaceRoot writes and reads back', () => {
    store.upsertWorkspaceRoot({
      workspaceHash: 'w1',
      absPath: '/repo',
      headCommit: 'abc',
      primaryLanguage: 'typescript',
      lastIndexedAt: 1234,
      merkleRootHash: 'root1',
      pagerankJson: null,
    });
    expect(store.getWorkspaceRoot('w1')?.absPath).toBe('/repo');
  });

  it('upsertMerkleNode is idempotent on nodeHash', () => {
    store.upsertMerkleNode({ nodeHash: 'n1', kind: 'file', childrenJson: '[]' });
    store.upsertMerkleNode({ nodeHash: 'n1', kind: 'file', childrenJson: '[]' });
    expect(store.getMerkleNode('n1')).toMatchObject({ kind: 'file' });
  });

  it('replaceWorkspaceSymbolsForFile replaces file-scoped symbol rows', () => {
    store.replaceWorkspaceSymbolsForFile('w1', 'src/a.ts', [
      {
        workspaceHash: 'w1',
        symbolId: 'sym-1',
        pathFromRoot: 'src/a.ts',
        name: 'add',
        kind: 'function',
        containerName: null,
        startLine: 0,
        startCharacter: 0,
        endLine: 2,
        endCharacter: 1,
        signature: 'add(a, b)',
        docComment: null,
      },
    ]);
    store.replaceWorkspaceSymbolsForFile('w1', 'src/a.ts', [
      {
        workspaceHash: 'w1',
        symbolId: 'sym-2',
        pathFromRoot: 'src/a.ts',
        name: 'subtract',
        kind: 'function',
        containerName: null,
        startLine: 4,
        startCharacter: 0,
        endLine: 6,
        endCharacter: 1,
        signature: 'subtract(a, b)',
        docComment: null,
      },
    ]);

    const symbols = store.listWorkspaceSymbols('w1');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('subtract');
  });

  it('replaceWorkspaceSymbolsForFile tolerates duplicate symbol ids in a single extraction batch', () => {
    store.replaceWorkspaceSymbolsForFile('w1', 'src/a.ts', [
      {
        workspaceHash: 'w1',
        symbolId: 'sym-1',
        pathFromRoot: 'src/a.ts',
        name: 'first',
        kind: 'function',
        containerName: null,
        startLine: 0,
        startCharacter: 0,
        endLine: 2,
        endCharacter: 1,
        signature: 'first()',
        docComment: null,
      },
      {
        workspaceHash: 'w1',
        symbolId: 'sym-1',
        pathFromRoot: 'src/a.ts',
        name: 'second',
        kind: 'function',
        containerName: null,
        startLine: 3,
        startCharacter: 0,
        endLine: 5,
        endCharacter: 1,
        signature: 'second()',
        docComment: null,
      },
    ]);

    const symbols = store.listWorkspaceSymbols('w1');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('second');
  });

  it('searchWorkspaceSymbols finds exact and partial matches', () => {
    store.replaceWorkspaceSymbolsForFile('w1', 'src/a.ts', [
      {
        workspaceHash: 'w1',
        symbolId: 'sym-1',
        pathFromRoot: 'src/a.ts',
        name: 'add',
        kind: 'function',
        containerName: null,
        startLine: 0,
        startCharacter: 0,
        endLine: 2,
        endCharacter: 1,
        signature: 'add(a, b)',
        docComment: null,
      },
      {
        workspaceHash: 'w1',
        symbolId: 'sym-2',
        pathFromRoot: 'src/a.ts',
        name: 'addressBook',
        kind: 'class',
        containerName: null,
        startLine: 4,
        startCharacter: 0,
        endLine: 8,
        endCharacter: 1,
        signature: 'class AddressBook',
        docComment: null,
      },
    ]);

    const symbols = store.searchWorkspaceSymbols('w1', 'add');
    expect(symbols.map((symbol) => symbol.name)).toEqual(['add', 'addressBook']);
  });

  it('replaces workspace chunk rows and contentless FTS rows for one file', () => {
    store.upsertChunk(sampleChunk({
      contentHash: 'c'.repeat(64),
      name: 'issueSessionToken',
      symbolsJson: JSON.stringify(['issueSessionToken']),
      rawText: 'export function issueSessionToken(userId: string) { return `session:${userId}`; }',
    }));
    store.replaceWorkspaceChunksForFile('w1', 'src/auth.ts', [
      {
        workspaceHash: 'w1',
        pathFromRoot: 'src/auth.ts',
        chunkIndex: 0,
        contentHash: 'c'.repeat(64),
        startLine: 1,
        endLine: 3,
        language: 'typescript',
        chunkType: 'function',
        name: 'issueSessionToken',
        updatedAt: 1_000,
      },
    ]);

    const hits = store.searchWorkspaceChunks('w1', 'issue session token', 5);
    expect(hits[0]).toEqual(expect.objectContaining({
      pathFromRoot: 'src/auth.ts',
      contentHash: 'c'.repeat(64),
      startLine: 1,
      endLine: 3,
      name: 'issueSessionToken',
    }));

    store.upsertChunk(sampleChunk({
      contentHash: 'd'.repeat(64),
      name: 'refreshSessionToken',
      symbolsJson: JSON.stringify(['refreshSessionToken']),
      rawText: 'export function refreshSessionToken(userId: string) { return `refresh:${userId}`; }',
    }));
    store.replaceWorkspaceChunksForFile('w1', 'src/auth.ts', [
      {
        workspaceHash: 'w1',
        pathFromRoot: 'src/auth.ts',
        chunkIndex: 0,
        contentHash: 'd'.repeat(64),
        startLine: 1,
        endLine: 3,
        language: 'typescript',
        chunkType: 'function',
        name: 'refreshSessionToken',
        updatedAt: 2_000,
      },
    ]);

    expect(store.searchWorkspaceChunks('w1', 'issue session token', 5)).toHaveLength(0);
    expect(store.searchWorkspaceChunks('w1', 'refresh session token', 5)[0]).toEqual(
      expect.objectContaining({ contentHash: 'd'.repeat(64) }),
    );
  });

  it('deletes workspace chunk and FTS rows for one file', () => {
    store.upsertChunk(sampleChunk({
      contentHash: 'e'.repeat(64),
      name: 'deleteMe',
      rawText: 'export function deleteMe() { return true; }',
    }));
    store.replaceWorkspaceChunksForFile('w1', 'src/delete.ts', [
      {
        workspaceHash: 'w1',
        pathFromRoot: 'src/delete.ts',
        chunkIndex: 0,
        contentHash: 'e'.repeat(64),
        startLine: 1,
        endLine: 2,
        language: 'typescript',
        chunkType: 'function',
        name: 'deleteMe',
        updatedAt: 1,
      },
    ]);

    store.deleteWorkspaceChunksForFile('w1', 'src/delete.ts');

    expect(store.searchWorkspaceChunks('w1', 'deleteMe', 5)).toHaveLength(0);
  });

  it('writes index status and cancellation flags', () => {
    store.upsertIndexStatus({
      workspaceHash: 'w1',
      absPath: '/repo',
      state: 'running',
      phase: 'chunking',
      totalFiles: 10,
      processedFiles: 4,
      totalChunks: 8,
      processedChunks: 3,
      currentPath: 'src/auth.ts',
      startedAt: 100,
      updatedAt: 200,
      completedAt: null,
      errorMessage: null,
      cancelRequested: false,
    });

    expect(store.getIndexStatus('w1')).toEqual(expect.objectContaining({
      workspaceHash: 'w1',
      state: 'running',
      phase: 'chunking',
      processedFiles: 4,
      cancelRequested: false,
    }));

    store.requestCancel('w1');
    expect(store.isCancelRequested('w1')).toBe(true);
    store.clearCancel('w1');
    expect(store.isCancelRequested('w1')).toBe(false);
  });
});
