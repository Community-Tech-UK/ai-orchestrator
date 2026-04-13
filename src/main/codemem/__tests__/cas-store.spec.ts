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
});
