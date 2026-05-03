import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../../main/db/sqlite-driver';
import * as schema from '../../../main/persistence/rlm/rlm-schema';
import {
  deleteProjectKnowledgeSourcesByKindNotSeen,
  getProjectKnowledgeSourceInventory,
  listProjectEvidenceForTarget,
  listProjectKnowledgeSources,
  upsertProjectKnowledgeSource,
} from '../../../main/persistence/rlm/rlm-project-knowledge';
import {
  PROJECT_CODE_INDEX_DOC_COMMENT_LIMIT,
  PROJECT_CODE_INDEX_SIGNATURE_LIMIT,
  PROJECT_CODE_INDEX_SYMBOL_PREVIEW_LIMIT,
  getProjectCodeIndexStatus,
  listProjectCodeSymbols,
  replaceProjectCodeSymbols,
  upsertProjectCodeIndexStatus,
} from '../../../main/persistence/rlm/rlm-project-code-index';

describe('project code index persistence', () => {
  let db: SqliteDriver;
  let rawDb: Database.Database;

  beforeEach(() => {
    rawDb = new Database(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = rawDb;
    schema.createTables(db);
    schema.createMigrationsTable(db);
    schema.runMigrations(db);
  });

  it('allows code_file sources and prunes only the requested source kind', () => {
    const codeFile = upsertProjectKnowledgeSource(db, {
      projectKey: '/fake/project',
      sourceKind: 'code_file',
      sourceUri: '/fake/project/src/main.ts',
      sourceTitle: 'src/main.ts',
      contentFingerprint: 'code-hash',
    }).source;
    const readme = upsertProjectKnowledgeSource(db, {
      projectKey: '/fake/project',
      sourceKind: 'readme',
      sourceUri: '/fake/project/README.md',
      sourceTitle: 'README.md',
      contentFingerprint: 'readme-hash',
    }).source;

    const deleted = deleteProjectKnowledgeSourcesByKindNotSeen(db, '/fake/project', 'readme', []);

    expect(deleted).toBe(1);
    expect(listProjectKnowledgeSources(db, '/fake/project')).toMatchObject([
      { id: codeFile.id, sourceKind: 'code_file' },
    ]);
    expect(listProjectKnowledgeSources(db, '/fake/project').some((source) => source.id === readme.id)).toBe(false);
  });

  it('stores snapshot-versioned status and normalizes stale indexing reads', () => {
    const staleStartedAt = Date.now() - 130_000;
    upsertProjectCodeIndexStatus(db, {
      projectKey: '/fake/project',
      workspaceHash: 'workspace-1',
      status: 'indexing',
      fileCount: 2,
      symbolCount: 3,
      syncStartedAt: staleStartedAt,
      updatedAt: staleStartedAt,
      metadata: { source: 'test' },
    });

    const status = getProjectCodeIndexStatus(db, '/fake/project', 120_000);

    expect(status).toMatchObject({
      projectKey: '/fake/project',
      workspaceHash: 'workspace-1',
      status: 'failed',
      fileCount: 2,
      symbolCount: 3,
      metadata: {
        snapshotVersion: 1,
        source: 'test',
        stale: true,
        reason: 'stale_indexing',
      },
    });
    expect(status.error ?? '').toContain('stale');
  });

  it('replaces symbols, truncates snippets, cascades with code_file sources, and synthesizes evidence', () => {
    const source = upsertProjectKnowledgeSource(db, {
      projectKey: '/fake/project',
      sourceKind: 'code_file',
      sourceUri: '/fake/project/src/main.ts',
      sourceTitle: 'src/main.ts',
      contentFingerprint: 'code-hash',
    }).source;
    replaceProjectCodeSymbols(db, '/fake/project', [
      {
        projectKey: '/fake/project',
        sourceId: source.id,
        workspaceHash: 'workspace-1',
        symbolId: 'symbol-1',
        pathFromRoot: 'src/main.ts',
        name: 'bootstrap',
        kind: 'function',
        startLine: 10,
        startCharacter: 2,
        endLine: null,
        endCharacter: null,
        signature: 's'.repeat(PROJECT_CODE_INDEX_SIGNATURE_LIMIT + 10),
        docComment: 'd'.repeat(PROJECT_CODE_INDEX_DOC_COMMENT_LIMIT + 10),
        metadata: { source: 'test' },
      },
    ]);

    const symbols = listProjectCodeSymbols(db, '/fake/project');
    expect(symbols).toMatchObject([
      {
        targetKind: 'code_symbol',
        targetId: 'symbol-1',
        name: 'bootstrap',
        endLine: 10,
        endCharacter: 2,
        metadata: {
          snapshotVersion: 1,
          source: 'test',
        },
      },
    ]);
    expect(symbols[0]?.signature).toHaveLength(PROJECT_CODE_INDEX_SIGNATURE_LIMIT);
    expect(symbols[0]?.docComment).toHaveLength(PROJECT_CODE_INDEX_DOC_COMMENT_LIMIT);
    expect(getProjectKnowledgeSourceInventory(db, '/fake/project')).toMatchObject({
      totalCodeSymbols: 1,
      byKind: { code_file: 1 },
    });
    expect(listProjectEvidenceForTarget(db, '/fake/project', 'code_symbol', 'symbol-1')).toMatchObject([
      {
        source: { sourceKind: 'code_file', sourceUri: '/fake/project/src/main.ts' },
        link: {
          targetKind: 'code_symbol',
          targetId: 'symbol-1',
          sourceSpan: {
            kind: 'file_lines',
            path: '/fake/project/src/main.ts',
            startLine: 10,
            endLine: 10,
            startColumn: 2,
            endColumn: 2,
          },
          metadata: {
            evidenceKind: 'definition_location',
            workspaceHash: 'workspace-1',
            snapshotVersion: 1,
          },
        },
      },
    ]);

    db.prepare('DELETE FROM project_knowledge_sources WHERE id = ?').run(source.id);
    expect(listProjectCodeSymbols(db, '/fake/project')).toHaveLength(0);
  });

  it('limits project symbol reads to a bounded preview', () => {
    const source = upsertProjectKnowledgeSource(db, {
      projectKey: '/fake/project',
      sourceKind: 'code_file',
      sourceUri: '/fake/project/src/main.ts',
      sourceTitle: 'src/main.ts',
      contentFingerprint: 'code-hash',
    }).source;
    replaceProjectCodeSymbols(
      db,
      '/fake/project',
      Array.from({ length: PROJECT_CODE_INDEX_SYMBOL_PREVIEW_LIMIT + 5 }, (_, index) => ({
        projectKey: '/fake/project',
        sourceId: source.id,
        workspaceHash: 'workspace-1',
        symbolId: `symbol-${index}`,
        pathFromRoot: 'src/main.ts',
        name: `symbol${index}`,
        kind: 'function',
        startLine: index + 1,
        startCharacter: 0,
      })),
    );

    expect(listProjectCodeSymbols(db, '/fake/project')).toHaveLength(PROJECT_CODE_INDEX_SYMBOL_PREVIEW_LIMIT);
  });
});
