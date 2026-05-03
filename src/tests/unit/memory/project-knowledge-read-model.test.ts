import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

let _testDb: InstanceType<typeof Database> | undefined;

vi.mock('../../../main/persistence/rlm-database', async () => {
  const BetterSQLite3 = (await import('better-sqlite3')).default;
  const schema = await import('../../../main/persistence/rlm/rlm-schema');
  return {
    getRLMDatabase: () => ({
      getRawDb: () => {
        if (!_testDb || !_testDb.open) {
          _testDb = new BetterSQLite3(':memory:');
          _testDb.pragma('foreign_keys = ON');
          schema.createTables(_testDb);
          schema.createMigrationsTable(_testDb);
          schema.runMigrations(_testDb);
        }
        return _testDb;
      },
    }),
  };
});

vi.mock('../../../main/logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ProjectKnowledgeReadModelService } from '../../../main/memory/project-knowledge-read-model';
import { ProjectRootRegistry } from '../../../main/memory/project-root-registry';
import { WakeContextBuilder } from '../../../main/memory/wake-context-builder';
import { KnowledgeGraphService } from '../../../main/memory/knowledge-graph-service';
import { getRLMDatabase } from '../../../main/persistence/rlm-database';
import {
  linkProjectKnowledgeKgTriple,
  linkProjectKnowledgeWakeHint,
  upsertProjectKnowledgeSource,
} from '../../../main/persistence/rlm/rlm-project-knowledge';
import {
  replaceProjectCodeSymbols,
  upsertProjectCodeIndexStatus,
} from '../../../main/persistence/rlm/rlm-project-code-index';

describe('ProjectKnowledgeReadModelService', () => {
  beforeEach(() => {
    ProjectKnowledgeReadModelService._resetForTesting();
    ProjectRootRegistry._resetForTesting();
    WakeContextBuilder._resetForTesting();
    KnowledgeGraphService._resetForTesting();
    vi.clearAllMocks();
    if (_testDb?.open) {
      _testDb.close();
    }
    _testDb = undefined;
  });

  it('lists registered projects with source inventory', () => {
    const registry = ProjectRootRegistry.getInstance();
    registry.ensureRoot('/fake/project', 'manual-browse');
    const db = getRLMDatabase().getRawDb();
    upsertProjectKnowledgeSource(db, {
      projectKey: '/fake/project',
      sourceKind: 'manifest',
      sourceUri: '/fake/project/package.json',
      sourceTitle: 'package.json',
      contentFingerprint: 'hash-a',
    });

    const service = ProjectKnowledgeReadModelService.getInstance();

    expect(service.listProjects()).toMatchObject([
      {
        projectKey: '/fake/project',
        displayName: 'project',
        inventory: {
          totalSources: 1,
          totalCodeSymbols: 0,
          byKind: { manifest: 1 },
        },
      },
    ]);
  });

  it('returns current KG facts, exact-room wake hints, and target evidence', () => {
    const registry = ProjectRootRegistry.getInstance();
    registry.ensureRoot('/fake/project', 'manual-browse');
    const db = getRLMDatabase().getRawDb();
    const source = upsertProjectKnowledgeSource(db, {
      projectKey: '/fake/project',
      sourceKind: 'manifest',
      sourceUri: '/fake/project/package.json',
      sourceTitle: 'package.json',
      contentFingerprint: 'hash-a',
    }).source;
    const kg = KnowledgeGraphService.getInstance();
    const currentTripleId = kg.addFact('test-project', 'uses_backend', 'express', {
      sourceFile: '/fake/project/package.json',
    });
    const staleTripleId = kg.addFact('test-project', 'uses_frontend', 'react', {
      sourceFile: '/fake/project/package.json',
    });
    kg.invalidateFact('test-project', 'uses_frontend', 'react', '2026-05-03');
    linkProjectKnowledgeKgTriple(db, { projectKey: '/fake/project', sourceId: source.id, tripleId: currentTripleId });
    linkProjectKnowledgeKgTriple(db, { projectKey: '/fake/project', sourceId: source.id, tripleId: staleTripleId });

    const wake = WakeContextBuilder.getInstance();
    const projectHintId = wake.addHint('Project-only instruction', { importance: 8, room: '/fake/project' });
    const generalHintId = wake.addHint('General instruction', { importance: 8, room: 'general' });
    linkProjectKnowledgeWakeHint(db, { projectKey: '/fake/project', sourceId: source.id, hintId: projectHintId });
    linkProjectKnowledgeWakeHint(db, { projectKey: '/fake/project', sourceId: source.id, hintId: generalHintId });

    const service = ProjectKnowledgeReadModelService.getInstance();
    const readModel = service.getReadModel('/fake/project');

    expect(readModel.sources).toMatchObject([{ sourceUri: '/fake/project/package.json' }]);
    expect(readModel.facts).toMatchObject([
      {
        targetKind: 'kg_triple',
        targetId: currentTripleId,
        subject: 'test-project',
        predicate: 'uses_backend',
        object: 'express',
        sourceFile: '/fake/project/package.json',
      },
    ]);
    expect(readModel.facts.some((fact) => fact.targetId === staleTripleId)).toBe(false);
    expect(readModel.wakeHints).toMatchObject([
      {
        targetKind: 'wake_hint',
        targetId: projectHintId,
        content: 'Project-only instruction',
        room: '/fake/project',
      },
    ]);
    expect(readModel.wakeHints.some((hint) => hint.targetId === generalHintId)).toBe(false);

    expect(service.getEvidence('/fake/project', 'kg_triple', currentTripleId)).toMatchObject([
      {
        source: { sourceUri: '/fake/project/package.json' },
        link: { targetKind: 'kg_triple', targetId: currentTripleId },
      },
    ]);
  });

  it('returns bounded code index status, symbols, and definition evidence', () => {
    const registry = ProjectRootRegistry.getInstance();
    registry.ensureRoot('/fake/project', 'manual-browse');
    const db = getRLMDatabase().getRawDb();
    const source = upsertProjectKnowledgeSource(db, {
      projectKey: '/fake/project',
      sourceKind: 'code_file',
      sourceUri: '/fake/project/src/main.ts',
      sourceTitle: 'src/main.ts',
      contentFingerprint: 'file-hash',
      metadata: { relativePath: 'src/main.ts', snapshotVersion: 1 },
    }).source;
    upsertProjectCodeIndexStatus(db, {
      projectKey: '/fake/project',
      workspaceHash: 'workspace-1',
      status: 'ready',
      fileCount: 1,
      symbolCount: 1,
      lastIndexedAt: 10,
      lastSyncedAt: 11,
      updatedAt: 11,
      metadata: { snapshotVersion: 1 },
    });
    replaceProjectCodeSymbols(db, '/fake/project', [
      {
        projectKey: '/fake/project',
        sourceId: source.id,
        workspaceHash: 'workspace-1',
        symbolId: 'sym-1',
        pathFromRoot: 'src/main.ts',
        name: 'bootstrap',
        kind: 'function',
        startLine: 3,
        startCharacter: 2,
        endLine: null,
        endCharacter: null,
        signature: 'function bootstrap()',
        docComment: null,
      },
    ]);

    const service = ProjectKnowledgeReadModelService.getInstance();
    const readModel = service.getReadModel('/fake/project');

    expect(readModel.codeIndex).toMatchObject({
      status: 'ready',
      fileCount: 1,
      symbolCount: 1,
    });
    expect(readModel.codeSymbols).toMatchObject([
      {
        targetKind: 'code_symbol',
        targetId: 'sym-1',
        name: 'bootstrap',
        endLine: 3,
        endCharacter: 2,
      },
    ]);
    expect(readModel.project.inventory).toMatchObject({
      totalCodeSymbols: 1,
      byKind: { code_file: 1 },
    });
    expect(service.getEvidence('/fake/project', 'code_symbol', 'sym-1')).toMatchObject([
      {
        source: { sourceUri: '/fake/project/src/main.ts', sourceKind: 'code_file' },
        link: {
          targetKind: 'code_symbol',
          targetId: 'sym-1',
          sourceSpan: {
            kind: 'file_lines',
            path: '/fake/project/src/main.ts',
            startLine: 3,
            endLine: 3,
            startColumn: 2,
            endColumn: 2,
          },
          metadata: {
            evidenceKind: 'definition_location',
            workspaceHash: 'workspace-1',
          },
        },
      },
    ]);
  });
});
