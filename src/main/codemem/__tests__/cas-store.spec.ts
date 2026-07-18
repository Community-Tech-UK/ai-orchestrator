import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import { vacuumFreelistPages } from '../cas-workspace-index-maintenance';
import type { Chunk } from '../types';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';

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
  let db: SqliteDriver;
  let store: CasStore;

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    migrate(db);
    store = new CasStore(db);
  });

  it('migrates codemem search tables idempotently', () => {
    migrate(db);
    const tableNames = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'virtual')
    `).all() as { name: string }[];
    const names = tableNames.map((row) => row.name);

    expect(names).toContain('workspace_chunks');
    expect(names).toContain('code_fts');
    expect(names).toContain('code_index_status');
  });

  it('enables incremental vacuum for new codemem databases', () => {
    const vacuumDb = defaultDriverFactory(':memory:');
    migrate(vacuumDb);

    expect(vacuumDb.pragma('auto_vacuum', { simple: true })).toBe(2);

    vacuumDb.close();
  });

  it('runs full VACUUM once for legacy codemem databases before incremental vacuum can work', () => {
    const calls: string[] = [];
    const legacyDb = {
      pragma: (source: string) => {
        calls.push(`pragma:${source}`);
        return source === 'auto_vacuum' ? 0 : [];
      },
      exec: (sql: string) => {
        calls.push(`exec:${sql}`);
      },
    } as unknown as SqliteDriver;

    vacuumFreelistPages(legacyDb);

    expect(calls).toEqual([
      'pragma:auto_vacuum',
      'pragma:auto_vacuum = INCREMENTAL',
      'exec:VACUUM',
    ]);
  });

  it('clears stale unknown primary languages when migrating from schema version 3', () => {
    const legacyDb = defaultDriverFactory(':memory:');
    legacyDb.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE workspace_root (
        workspace_hash TEXT PRIMARY KEY,
        abs_path TEXT NOT NULL UNIQUE,
        head_commit TEXT,
        primary_language TEXT,
        last_indexed_at INTEGER NOT NULL,
        merkle_root_hash TEXT,
        pagerank_json TEXT
      );
    `);

    const insertVersion = legacyDb.prepare(
      'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
    );
    for (const version of [1, 2, 3]) {
      insertVersion.run(version, 1_000);
    }

    const insertWorkspace = legacyDb.prepare(`
      INSERT INTO workspace_root (
        workspace_hash,
        abs_path,
        head_commit,
        primary_language,
        last_indexed_at,
        merkle_root_hash,
        pagerank_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertWorkspace.run('w-known', '/repo-known', null, 'typescript', 1_000, null, null);
    insertWorkspace.run('w-unknown', '/repo-unknown', null, 'unknown', 1_000, null, null);

    migrate(legacyDb);

    const rows = legacyDb.prepare(`
      SELECT workspace_hash, primary_language
      FROM workspace_root
      ORDER BY workspace_hash ASC
    `).all();
    const version = legacyDb.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
      v: number | null;
    };

    expect(rows).toEqual([
      { workspace_hash: 'w-known', primary_language: 'typescript' },
      { workspace_hash: 'w-unknown', primary_language: null },
    ]);
    expect(version.v).toBe(4);

    legacyDb.close();
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

  it('hydrates multiple chunks with one bounded query', () => {
    store.upsertChunk(sampleChunk({ contentHash: 'a'.repeat(64), name: 'alpha' }));
    store.upsertChunk(sampleChunk({ contentHash: 'c'.repeat(64), name: 'charlie' }));

    const chunks = store.getChunks([
      'c'.repeat(64),
      'missing',
      'a'.repeat(64),
      'c'.repeat(64),
    ]);

    expect([...chunks.keys()]).toEqual(['a'.repeat(64), 'c'.repeat(64)]);
    expect(chunks.get('a'.repeat(64))?.name).toBe('alpha');
    expect(chunks.get('c'.repeat(64))?.name).toBe('charlie');
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

  it('counts and pages manifest entries without requiring a full materialized read', () => {
    store.upsertManifestEntry({
      workspaceHash: 'w1',
      pathFromRoot: 'src/b.ts',
      contentHash: 'c2',
      merkleLeafHash: 'm2',
      mtime: 2_000,
    });
    store.upsertManifestEntry({
      workspaceHash: 'w1',
      pathFromRoot: 'src/a.ts',
      contentHash: 'c1',
      merkleLeafHash: 'm1',
      mtime: 1_000,
    });

    expect(store.countManifestEntries('w1')).toBe(2);
    expect(store.countManifestEntries('other-workspace')).toBe(0);
    expect(store.listManifestEntries('w1', { limit: 1 })).toEqual([
      expect.objectContaining({ pathFromRoot: 'src/a.ts' }),
    ]);
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

  it('countWorkspaceSymbols returns the row count without materializing symbols', () => {
    expect(store.countWorkspaceSymbols('w1')).toBe(0);
    store.replaceWorkspaceSymbolsForFile('w1', 'src/a.ts', [
      {
        workspaceHash: 'w1',
        symbolId: 'sym-1',
        pathFromRoot: 'src/a.ts',
        name: 'alpha',
        kind: 'function',
        containerName: null,
        startLine: 0,
        startCharacter: 0,
        endLine: 1,
        endCharacter: 1,
        signature: 'alpha()',
        docComment: null,
      },
      {
        workspaceHash: 'w1',
        symbolId: 'sym-2',
        pathFromRoot: 'src/a.ts',
        name: 'beta',
        kind: 'function',
        containerName: null,
        startLine: 2,
        startCharacter: 0,
        endLine: 3,
        endCharacter: 1,
        signature: 'beta()',
        docComment: null,
      },
    ]);
    expect(store.countWorkspaceSymbols('w1')).toBe(2);
    expect(store.countWorkspaceSymbols('other-workspace')).toBe(0);
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

  it('lists workspace index stats and deletes one workspace index without deleting shared chunks', () => {
    store.upsertChunk(sampleChunk({ contentHash: 'c1', rawText: 'shared chunk' }));
    store.upsertWorkspaceRoot({
      workspaceHash: 'workspace-a',
      absPath: '/repo-a',
      headCommit: null,
      primaryLanguage: 'typescript',
      lastIndexedAt: 100,
      merkleRootHash: null,
      pagerankJson: null,
    });
    store.upsertManifestEntry({
      workspaceHash: 'workspace-a',
      pathFromRoot: 'src/a.ts',
      contentHash: 'c1',
      merkleLeafHash: 'm1',
      mtime: 1,
    });
    store.replaceWorkspaceChunksForFile('workspace-a', 'src/a.ts', [{
      workspaceHash: 'workspace-a',
      pathFromRoot: 'src/a.ts',
      chunkIndex: 0,
      contentHash: 'c1',
      startLine: 1,
      endLine: 1,
      language: 'typescript',
      chunkType: 'function',
      name: 'shared',
      updatedAt: 1,
    }]);

    expect(store.listWorkspaceIndexStats()).toEqual([
      expect.objectContaining({ workspaceHash: 'workspace-a', manifestEntries: 1, workspaceChunks: 1 }),
    ]);

    store.deleteWorkspaceIndex('workspace-a');
    expect(store.getWorkspaceRoot('workspace-a')).toBeNull();
    expect(store.countManifestEntries('workspace-a')).toBe(0);
    expect(store.getChunk('c1')).toEqual(expect.objectContaining({ rawText: 'shared chunk' }));
    expect(store.searchWorkspaceChunks('workspace-a', 'shared', 5)).toHaveLength(0);
  });

  it('prunes unreferenced chunks and legacy merkle rows without deleting live chunks', () => {
    const liveHash = 'f'.repeat(64);
    const orphanHash = '0'.repeat(64);
    store.upsertChunk(sampleChunk({
      contentHash: liveHash,
      name: 'liveChunk',
      rawText: 'export function liveChunk() { return true; }',
    }));
    store.upsertChunk(sampleChunk({
      contentHash: orphanHash,
      name: 'orphanChunk',
      rawText: 'export function orphanChunk() { return false; }',
    }));
    store.replaceWorkspaceChunksForFile('workspace-a', 'src/live.ts', [{
      workspaceHash: 'workspace-a',
      pathFromRoot: 'src/live.ts',
      chunkIndex: 0,
      contentHash: liveHash,
      startLine: 1,
      endLine: 1,
      language: 'typescript',
      chunkType: 'function',
      name: 'liveChunk',
      updatedAt: 1,
    }]);
    db.prepare(
      'INSERT INTO merkle_nodes (node_hash, kind, children_json) VALUES (?, ?, ?)',
    ).run('legacy-node', 'file', '[]');

    expect(store.pruneUnreferencedChunks()).toBe(1);
    expect(store.clearLegacyMerkleNodes()).toBe(1);

    expect(store.getChunk(liveHash)).toEqual(expect.objectContaining({ name: 'liveChunk' }));
    expect(store.getChunk(orphanHash)).toBeNull();
    expect(store.searchWorkspaceChunks('workspace-a', 'liveChunk', 5)).toHaveLength(1);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM merkle_nodes').get(),
    ).toEqual({ count: 0 });
  });
});
