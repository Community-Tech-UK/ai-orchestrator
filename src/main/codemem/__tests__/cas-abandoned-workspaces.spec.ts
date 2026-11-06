import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import {
  listAbandonedWorkspaces,
  mergeSearchIndex,
  pruneAbandonedWorkspaces,
  pruneUnreferencedChunks,
} from '../cas-workspace-index-maintenance';
import type { Chunk, WorkspaceHash } from '../types';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';

const NOW = 10_000_000;

function chunk(contentHash: string, rawText: string): Chunk {
  return {
    contentHash,
    astNormalizedHash: contentHash,
    language: 'typescript',
    chunkType: 'function',
    name: 'indexedThing',
    signature: null,
    docComment: null,
    symbolsJson: '[]',
    importsJson: '[]',
    exportsJson: '[]',
    rawText,
  };
}

describe('abandoned workspace cleanup', () => {
  let db: SqliteDriver;
  let store: CasStore;

  /** Chunk, symbol and manifest rows, as a cold index writes them file by file. */
  function seedRows(workspaceHash: WorkspaceHash, files: number): void {
    for (let file = 0; file < files; file += 1) {
      const pathFromRoot = `src/${workspaceHash}-${file}.ts`;
      const contentHash = `${workspaceHash}-${file}`.padEnd(64, '0');
      store.upsertChunk(chunk(contentHash, `export const ${workspaceHash}Needle${file} = true;`));
      store.replaceWorkspaceChunksForFile(workspaceHash, pathFromRoot, [{
        workspaceHash,
        pathFromRoot,
        chunkIndex: 0,
        contentHash,
        startLine: 1,
        endLine: 1,
        language: 'typescript',
        chunkType: 'function',
        name: 'indexedThing',
        updatedAt: 1,
      }]);
      store.upsertManifestEntry({
        workspaceHash,
        pathFromRoot,
        contentHash,
        merkleLeafHash: contentHash,
        mtime: 1,
      });
      db.prepare(`
        INSERT INTO workspace_symbols
          (workspace_hash, symbol_id, path_from_root, name, kind, start_line, start_character)
        VALUES (?, ?, ?, 'indexedThing', 'function', 1, 0)
      `).run(workspaceHash, `symbol-${file}`, pathFromRoot);
    }
  }

  function register(workspaceHash: WorkspaceHash): void {
    store.upsertWorkspaceRoot({
      workspaceHash,
      absPath: `/repo/${workspaceHash}`,
      headCommit: null,
      primaryLanguage: 'typescript',
      lastIndexedAt: 1,
      merkleRootHash: null,
      pagerankJson: null,
    });
  }

  function setStatus(workspaceHash: WorkspaceHash, state: string, updatedAt: number): void {
    db.prepare(`
      INSERT INTO code_index_status (workspace_hash, abs_path, state, phase, updated_at)
      VALUES (?, ?, ?, 'none', ?)
      ON CONFLICT(workspace_hash) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
    `).run(workspaceHash, `/repo/.worktrees/${workspaceHash}`, state, updatedAt);
  }

  function rowCount(table: string, workspaceHash: WorkspaceHash): number {
    return db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_hash = ?`)
      .get<{ n: number }>(workspaceHash)?.n ?? -1;
  }

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    migrate(db);
    store = new CasStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('finds rows left by a cancelled index that never registered its workspace', () => {
    seedRows('cancelled', 2);
    setStatus('cancelled', 'cancelled', 1);
    seedRows('live', 1);
    register('live');

    expect(listAbandonedWorkspaces(db, NOW)).toEqual(['cancelled']);
  });

  it('removes every trace of an abandoned workspace and nothing of a registered one', () => {
    seedRows('cancelled', 3);
    setStatus('cancelled', 'cancelled', 1);
    seedRows('live', 2);
    register('live');

    const result = pruneAbandonedWorkspaces(db, { now: () => NOW });

    expect(result).toEqual({ deletedWorkspaces: 1, deletedChunks: 3, remainingWorkspaces: 0 });
    for (const table of ['workspace_chunks', 'workspace_symbols', 'workspace_manifest', 'code_index_status']) {
      expect(rowCount(table, 'cancelled')).toBe(0);
    }
    expect(rowCount('workspace_chunks', 'live')).toBe(2);
    expect(rowCount('workspace_symbols', 'live')).toBe(2);
    expect(store.getWorkspaceRoot('live')).not.toBeNull();
    expect(store.searchWorkspaceChunks('live', 'liveNeedle0', 5)).toHaveLength(1);
  });

  it('removes the search entries, not just the table rows', () => {
    seedRows('cancelled', 1);
    const [{ id }] = db
      .prepare("SELECT id FROM workspace_chunks WHERE workspace_hash = 'cancelled'")
      .all<{ id: number }>();
    const matching = (): number => db
      .prepare('SELECT COUNT(*) AS n FROM code_fts WHERE code_fts MATCH ? AND rowid = ?')
      .get<{ n: number }>('cancelledNeedle0', id)?.n ?? -1;
    expect(matching()).toBe(1);

    pruneAbandonedWorkspaces(db, { now: () => NOW });

    expect(matching()).toBe(0);
  });

  it('cleans up status rows that have no other data', () => {
    setStatus('empty-run', 'failed', 1);

    expect(pruneAbandonedWorkspaces(db, { now: () => NOW }).deletedWorkspaces).toBe(1);
    expect(rowCount('code_index_status', 'empty-run')).toBe(0);
  });

  it('leaves a workspace alone while its first index is still running', () => {
    seedRows('indexing', 2);
    setStatus('indexing', 'running', NOW - 1_000);

    expect(pruneAbandonedWorkspaces(db, { now: () => NOW }))
      .toEqual({ deletedWorkspaces: 0, deletedChunks: 0, remainingWorkspaces: 0 });
    expect(rowCount('workspace_chunks', 'indexing')).toBe(2);
  });

  it('treats a run that has gone silent as dead', () => {
    seedRows('crashed', 1);
    setStatus('crashed', 'running', NOW - 2 * 60 * 60 * 1000);

    expect(pruneAbandonedWorkspaces(db, { now: () => NOW }).deletedWorkspaces).toBe(1);
    expect(rowCount('workspace_chunks', 'crashed')).toBe(0);
  });

  it('stops at the time budget and finishes on a later call', () => {
    seedRows('first', 3);
    seedRows('second', 3);
    let clock = NOW;
    const now = (): number => {
      clock += 400;
      return clock;
    };

    const partial = pruneAbandonedWorkspaces(db, { now, timeBudgetMs: 1_000, batchRows: 1 });

    expect(partial.deletedWorkspaces).toBe(0);
    expect(partial.remainingWorkspaces).toBe(2);
    expect(partial.deletedChunks).toBeGreaterThan(0);

    const rest = pruneAbandonedWorkspaces(db, { now: () => NOW, batchRows: 1 });

    expect(rest.deletedWorkspaces).toBe(2);
    expect(rest.remainingWorkspaces).toBe(0);
    expect(rowCount('workspace_chunks', 'first') + rowCount('workspace_chunks', 'second')).toBe(0);
  });

  it('deletes something even when listing the workspaces took longer than the budget', () => {
    seedRows('slow-listing', 2);
    let calls = 0;

    const result = pruneAbandonedWorkspaces(db, {
      now: () => {
        calls += 1;
        return calls === 1 ? NOW : NOW + 10_000;
      },
      timeBudgetMs: 500,
      batchRows: 1,
    });

    expect(result.deletedChunks).toBeGreaterThan(0);
  });

  it('keeps a workspace listable until its last batch, so an interrupted run resumes', () => {
    seedRows('big', 4);
    let clock = NOW;
    pruneAbandonedWorkspaces(db, {
      now: () => {
        clock += 500;
        return clock;
      },
      timeBudgetMs: 1_000,
      batchRows: 1,
    });

    expect(listAbandonedWorkspaces(db, NOW)).toEqual(['big']);
  });

  it('stops deleting a workspace that a new index run has claimed mid-burst', () => {
    seedRows('reclaimed', 3);
    let checks = 0;
    const result = pruneAbandonedWorkspaces(db, {
      batchRows: 1,
      now: () => {
        checks += 1;
        if (checks === 5) setStatus('reclaimed', 'running', NOW);
        return NOW;
      },
    });

    expect(result.deletedWorkspaces).toBe(0);
    expect(result.remainingWorkspaces).toBe(0);
    expect(rowCount('workspace_chunks', 'reclaimed')).toBeGreaterThan(0);
  });

  it('keeps manifest rows until the chunks and symbols are gone, so a new cold index can still clear them', () => {
    seedRows('rewarmed', 3);
    let clock = NOW;
    pruneAbandonedWorkspaces(db, {
      now: () => {
        clock += 400;
        return clock;
      },
      timeBudgetMs: 1_000,
      batchRows: 1,
    });
    expect(rowCount('workspace_chunks', 'rewarmed')).toBeGreaterThan(0);
    expect(rowCount('workspace_manifest', 'rewarmed')).toBe(3);

    // What `coldIndex` does before it starts writing.
    for (const entry of store.listManifestEntries('rewarmed')) {
      store.deleteManifestEntry('rewarmed', entry.pathFromRoot);
      store.deleteWorkspaceSymbolsForFile('rewarmed', entry.pathFromRoot);
      store.deleteWorkspaceChunksForFile('rewarmed', entry.pathFromRoot);
    }

    expect(rowCount('workspace_chunks', 'rewarmed')).toBe(0);
    expect(rowCount('workspace_symbols', 'rewarmed')).toBe(0);
  });

  describe('releasing deleted space', () => {
    /** A clock that allows one pass of a budgeted loop, then says the budget has gone. */
    function onePassClock(): () => number {
      let clock = NOW;
      return () => {
        clock += 1_000;
        return clock;
      };
    }

    function chunkCount(): number {
      return db.prepare('SELECT COUNT(*) AS n FROM chunks').get<{ n: number }>()?.n ?? -1;
    }

    it('deletes unreferenced chunk text a batch at a time, resuming where it stopped', () => {
      seedRows('cancelled', 5);
      seedRows('live', 2);
      register('live');
      pruneAbandonedWorkspaces(db, { now: () => NOW });
      const options = { now: onePassClock(), timeBudgetMs: 1_500, batchRows: 2 };

      const first = pruneUnreferencedChunks(db, options);

      expect(first.resumeAfter).not.toBeNull();
      expect(chunkCount()).toBeGreaterThan(2);

      let after = first.resumeAfter;
      while (after !== null) {
        after = pruneUnreferencedChunks(db, { ...options, after }).resumeAfter;
      }
      expect(chunkCount()).toBe(2);
    });

    it('leaves chunk text that a registered workspace still uses', () => {
      seedRows('live', 3);
      register('live');

      expect(pruneUnreferencedChunks(db)).toEqual({ deleted: 0, resumeAfter: null });
      expect(chunkCount()).toBe(3);
    });

    it('merges the search index until no work is left, keeping live results', () => {
      seedRows('cancelled', 4);
      seedRows('live', 2);
      register('live');
      pruneAbandonedWorkspaces(db, { now: () => NOW });

      expect(mergeSearchIndex(db)).toBe(true);

      expect(store.searchWorkspaceChunks('live', 'liveNeedle1', 5)).toHaveLength(1);
      expect(mergeSearchIndex(db, { mergeStarted: true })).toBe(true);
    });

    it('stops merging at the time budget and finishes on a later call', () => {
      seedRows('live', 4);
      register('live');

      expect(mergeSearchIndex(db, { now: onePassClock(), timeBudgetMs: 1_500 })).toBe(false);
      expect(mergeSearchIndex(db, { mergeStarted: true })).toBe(true);
      expect(store.searchWorkspaceChunks('live', 'liveNeedle3', 5)).toHaveLength(1);
    });

    it('starts the full merge once only, so new index rows cannot restart it', () => {
      const merge = vi.fn();
      let changes = 0;
      const fake = {
        prepare: (sql: string) => (sql.includes("'merge'")
          ? { run: (pages: number) => { merge(pages); changes += merge.mock.calls.length < 3 ? 2 : 1; } }
          : { get: () => ({ changes }) }),
      } as unknown as SqliteDriver;

      expect(mergeSearchIndex(fake)).toBe(true);
      expect(merge.mock.calls.map(([pages]) => Math.sign(pages))).toEqual([-1, 1, 1]);

      merge.mockClear();
      expect(mergeSearchIndex(fake, { mergeStarted: true })).toBe(true);
      expect(Math.sign(merge.mock.calls[0][0])).toBe(1);
    });

    it('finishes the chunk walk before merging, and does not repeat it between merge steps', () => {
      seedRows('cancelled', 2);
      pruneAbandonedWorkspaces(db, { now: () => NOW });

      expect(store.releaseDeletedSpace()).toEqual({ deletedChunks: 2, finished: false });
      expect(chunkCount()).toBe(0);

      expect(store.releaseDeletedSpace({ now: onePassClock(), timeBudgetMs: 1_500 }))
        .toEqual({ deletedChunks: 0, finished: false });
      seedRows('later', 1);
      db.prepare("DELETE FROM workspace_chunks WHERE workspace_hash = 'later'").run();

      expect(store.releaseDeletedSpace()).toEqual({ deletedChunks: 0, finished: true });
      expect(chunkCount()).toBe(1);
    });

    it('starts again when a workspace is deleted partway through, so its chunk text is not stranded', () => {
      seedRows('first', 1);
      pruneAbandonedWorkspaces(db, { now: () => NOW });
      store.releaseDeletedSpace();

      seedRows('second', 1);
      register('second');
      store.deleteWorkspaceIndex('second');

      expect(store.releaseDeletedSpace()).toEqual({ deletedChunks: 1, finished: false });
      expect(store.releaseDeletedSpace()).toEqual({ deletedChunks: 0, finished: true });
      expect(chunkCount()).toBe(0);
    });

    it('starts again when an abandoned workspace is removed partway through', () => {
      seedRows('first', 1);
      pruneAbandonedWorkspaces(db, { now: () => NOW });
      store.releaseDeletedSpace();

      seedRows('second', 1);
      expect(store.pruneAbandonedWorkspaces({ now: () => NOW }).deletedWorkspaces).toBe(1);

      expect(store.releaseDeletedSpace()).toEqual({ deletedChunks: 1, finished: false });
      expect(chunkCount()).toBe(0);
    });

    it('does not start again when a clean-up pass finds nothing to delete', () => {
      seedRows('first', 1);
      pruneAbandonedWorkspaces(db, { now: () => NOW });
      store.releaseDeletedSpace();

      store.pruneAbandonedWorkspaces({ now: () => NOW });

      expect(store.releaseDeletedSpace()).toEqual({ deletedChunks: 0, finished: true });
    });

    it('walks the chunks again on the next run', () => {
      seedRows('cancelled', 1);
      pruneAbandonedWorkspaces(db, { now: () => NOW });
      store.releaseDeletedSpace();
      store.releaseDeletedSpace();

      seedRows('second', 1);
      db.prepare("DELETE FROM workspace_chunks WHERE workspace_hash = 'second'").run();

      expect(store.releaseDeletedSpace()).toEqual({ deletedChunks: 1, finished: false });
    });
  });
});
