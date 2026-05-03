import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../../main/db/sqlite-driver';
import * as schema from '../../../main/persistence/rlm/rlm-schema';
import * as kgStore from '../../../main/persistence/rlm/rlm-knowledge-graph';
import {
  clearProjectKnowledgeLinksForSource,
  deleteProjectKnowledgeSourcesNotSeen,
  getProjectKnowledgeSourceInventory,
  hasCurrentProjectKnowledgeSources,
  linkProjectKnowledgeKgTriple,
  linkProjectKnowledgeWakeHint,
  listProjectKnowledgeLinks,
  listProjectKnowledgeSources,
  upsertProjectKnowledgeSource,
} from '../../../main/persistence/rlm/rlm-project-knowledge';
import type { ProjectKnowledgeSourceKind } from '../../../shared/types/knowledge-graph.types';

describe('project knowledge persistence', () => {
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

  it('upserts canonical source rows and detects changed fingerprints', () => {
    const first = upsertSource({ contentFingerprint: 'hash-a' });
    const second = upsertSource({ contentFingerprint: 'hash-a' });
    const changed = upsertSource({ contentFingerprint: 'hash-b' });
    const recategorized = upsertSource({ sourceKind: 'config', contentFingerprint: 'hash-b' });

    expect(first).toMatchObject({ created: true, changed: false });
    expect(second).toMatchObject({ created: false, changed: false });
    expect(changed).toMatchObject({ created: false, changed: true });
    expect(second.source.id).toBe(first.source.id);
    expect(changed.source.id).toBe(first.source.id);
    expect(changed.source.contentFingerprint).toBe('hash-b');
    expect(recategorized.source.id).toBe(first.source.id);
    expect(recategorized.source.sourceKind).toBe('config');
    expect(listProjectKnowledgeSources(db, '/fake/project')).toHaveLength(1);
  });

  it('inserts concrete KG and wake links idempotently and clears by target kind', () => {
    const source = upsertSource().source;
    const tripleId = addTriple();
    const hintId = addHint();

    const firstKgLink = linkProjectKnowledgeKgTriple(db, {
      projectKey: '/fake/project',
      sourceId: source.id,
      tripleId,
    });
    const secondKgLink = linkProjectKnowledgeKgTriple(db, {
      projectKey: '/fake/project',
      sourceId: source.id,
      tripleId,
    });
    const wakeLink = linkProjectKnowledgeWakeHint(db, {
      projectKey: '/fake/project',
      sourceId: source.id,
      hintId,
    });

    expect(firstKgLink).toMatchObject({ created: true });
    expect(secondKgLink).toMatchObject({ created: false });
    expect(secondKgLink.link.id).toBe(firstKgLink.link.id);
    expect(wakeLink).toMatchObject({ created: true });
    expect(listProjectKnowledgeLinks(db, '/fake/project')).toHaveLength(2);

    expect(clearProjectKnowledgeLinksForSource(db, '/fake/project', source.id, ['kg_triple'])).toBe(1);
    expect(listProjectKnowledgeLinks(db, '/fake/project')).toMatchObject([
      { targetKind: 'wake_hint', targetId: hintId },
    ]);
  });

  it('rejects links when the source belongs to a different project', () => {
    const source = upsertSource({ projectKey: '/fake/project-a' }).source;
    const tripleId = addTriple();

    expect(() => linkProjectKnowledgeKgTriple(db, {
      projectKey: '/fake/project-b',
      sourceId: source.id,
      tripleId,
    })).toThrow(/does not belong to project/);
  });

  it('cascades concrete links when sources or targets are deleted', () => {
    const source = upsertSource().source;
    const tripleId = addTriple();
    const hintId = addHint();

    linkProjectKnowledgeKgTriple(db, { projectKey: '/fake/project', sourceId: source.id, tripleId });
    linkProjectKnowledgeWakeHint(db, { projectKey: '/fake/project', sourceId: source.id, hintId });
    expect(listProjectKnowledgeLinks(db, '/fake/project')).toHaveLength(2);

    db.prepare('DELETE FROM kg_triples WHERE id = ?').run(tripleId);
    expect(listProjectKnowledgeLinks(db, '/fake/project')).toMatchObject([
      { targetKind: 'wake_hint', targetId: hintId },
    ]);

    db.prepare('DELETE FROM wake_hints WHERE id = ?').run(hintId);
    expect(listProjectKnowledgeLinks(db, '/fake/project')).toHaveLength(0);

    const secondTripleId = addTriple('uses_backend', 'fastify');
    const secondHintId = addHint('hint_2', 'Use strict TypeScript');
    linkProjectKnowledgeKgTriple(db, { projectKey: '/fake/project', sourceId: source.id, tripleId: secondTripleId });
    linkProjectKnowledgeWakeHint(db, { projectKey: '/fake/project', sourceId: source.id, hintId: secondHintId });

    db.prepare('DELETE FROM project_knowledge_sources WHERE id = ?').run(source.id);
    expect(listProjectKnowledgeLinks(db, '/fake/project')).toHaveLength(0);
  });

  it('deletes project sources not seen in the current run without touching other projects', () => {
    const readme = upsertSource({
      sourceKind: 'readme',
      sourceUri: '/fake/project/README.md',
      sourceTitle: 'README.md',
    }).source;
    const agents = upsertSource({
      sourceKind: 'instruction_doc',
      sourceUri: '/fake/project/AGENTS.md',
      sourceTitle: 'AGENTS.md',
    }).source;
    upsertSource({
      projectKey: '/fake/other',
      sourceKind: 'readme',
      sourceUri: '/fake/other/README.md',
      sourceTitle: 'README.md',
    });

    const deleted = deleteProjectKnowledgeSourcesNotSeen(db, '/fake/project', [agents.sourceUri]);

    expect(deleted).toBe(1);
    expect(listProjectKnowledgeSources(db, '/fake/project')).toMatchObject([
      { id: agents.id },
    ]);
    expect(listProjectKnowledgeSources(db, '/fake/other')).toHaveLength(1);
    expect(listProjectKnowledgeSources(db, '/fake/project').some((source) => source.id === readme.id)).toBe(false);
  });

  it('reports inventory and current-source coverage by kind, URI, and fingerprint', () => {
    upsertSource({
      sourceKind: 'manifest',
      sourceUri: '/fake/project/package.json',
      contentFingerprint: 'pkg-hash',
    });
    upsertSource({
      sourceKind: 'readme',
      sourceUri: '/fake/project/README.md',
      sourceTitle: 'README.md',
      contentFingerprint: 'readme-hash',
    });

    expect(getProjectKnowledgeSourceInventory(db, '/fake/project')).toMatchObject({
      totalSources: 2,
      byKind: {
        manifest: 1,
        readme: 1,
      },
    });

    expect(hasCurrentProjectKnowledgeSources(db, '/fake/project', [
      { sourceKind: 'manifest', sourceUri: '/fake/project/package.json', contentFingerprint: 'pkg-hash' },
      { sourceKind: 'readme', sourceUri: '/fake/project/README.md', contentFingerprint: 'readme-hash' },
    ])).toBe(true);
    expect(hasCurrentProjectKnowledgeSources(db, '/fake/project', [
      { sourceKind: 'manifest', sourceUri: '/fake/project/package.json', contentFingerprint: 'stale-hash' },
    ])).toBe(false);
    expect(hasCurrentProjectKnowledgeSources(db, '/fake/project', [
      { sourceKind: 'config', sourceUri: '/fake/project/tsconfig.json', contentFingerprint: 'missing' },
    ])).toBe(false);
  });

  function upsertSource(overrides: {
    projectKey?: string;
    sourceKind?: ProjectKnowledgeSourceKind;
    sourceUri?: string;
    sourceTitle?: string;
    contentFingerprint?: string;
  } = {}) {
    return upsertProjectKnowledgeSource(db, {
      projectKey: overrides.projectKey ?? '/fake/project',
      sourceKind: overrides.sourceKind ?? 'manifest',
      sourceUri: overrides.sourceUri ?? '/fake/project/package.json',
      sourceTitle: overrides.sourceTitle ?? 'package.json',
      contentFingerprint: overrides.contentFingerprint ?? 'hash-a',
      metadata: { relativePath: 'package.json' },
    });
  }

  function addTriple(predicate = 'uses_backend', object = 'express'): string {
    return kgStore.addTriple(db, {
      subject: 'test-project',
      predicate,
      object,
      confidence: 1,
      sourceFile: '/fake/project/package.json',
    });
  }

  function addHint(id = 'hint_1', content = 'Use TypeScript'): string {
    db.prepare(`
      INSERT INTO wake_hints (id, content, importance, room, source_reflection_id, source_session_id, created_at, last_used, usage_count)
      VALUES (?, ?, 7, '/fake/project', NULL, NULL, ?, ?, 0)
    `).run(id, content, Date.now(), Date.now());
    return id;
  }
});
