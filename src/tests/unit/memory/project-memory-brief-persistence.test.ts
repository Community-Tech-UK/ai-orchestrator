import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../../main/db/sqlite-driver';
import * as schema from '../../../main/persistence/rlm/rlm-schema';
import {
  getProjectMemoryStartupBriefByInstance,
  recordProjectMemoryStartupBrief,
} from '../../../main/persistence/rlm/rlm-project-memory-briefs';

describe('project memory startup brief persistence', () => {
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

  it('records and reads startup brief rows with sections, sources, and metadata', () => {
    const record = recordProjectMemoryStartupBrief(db, {
      instanceId: 'instance-1',
      projectKey: '/fake/project',
      renderedText: '## Project Memory Brief\n\nCurrent source-backed facts:\n- [fact src:1] Uses Angular',
      sections: [
        {
          title: 'Current source-backed facts',
          items: [{ sourceId: 'fact:1', label: 'fact src:1', text: 'Uses Angular' }],
        },
      ],
      sources: [
        {
          id: 'fact:1',
          type: 'project-fact',
          projectPath: '/fake/project',
          metadata: { targetKind: 'kg_triple', targetId: 'triple-1' },
        },
      ],
      maxChars: 1600,
      truncated: false,
      provider: 'claude',
      model: 'haiku',
      metadata: { candidatesScanned: 1, candidatesIncluded: 1 },
    });

    expect(record).toMatchObject({
      instance_id: 'instance-1',
      project_key: '/fake/project',
      rendered_text: expect.stringContaining('Uses Angular'),
      rendered_chars: record.rendered_text.length,
      source_count: 1,
      truncated: 0,
      provider: 'claude',
      model: 'haiku',
      sections: [{ title: 'Current source-backed facts' }],
      sources: [{ id: 'fact:1', type: 'project-fact' }],
      metadata: { candidatesScanned: 1, candidatesIncluded: 1 },
    });

    expect(getProjectMemoryStartupBriefByInstance(db, 'instance-1')).toMatchObject({
      id: record.id,
      sources: [{ id: 'fact:1' }],
    });
  });

  it('updates the existing row for the same instance id', () => {
    recordProjectMemoryStartupBrief(db, {
      instanceId: 'instance-1',
      projectKey: '/fake/project',
      renderedText: 'first brief',
      sections: [],
      sources: [],
      maxChars: 1600,
      truncated: false,
    });
    const updated = recordProjectMemoryStartupBrief(db, {
      instanceId: 'instance-1',
      projectKey: '/fake/project',
      renderedText: 'second brief',
      sections: [{ title: 'Project wake hints', items: [] }],
      sources: [],
      maxChars: 500,
      truncated: true,
      metadata: { candidatesScanned: 2 },
    });

    const rows = rawDb.prepare('SELECT * FROM project_memory_startup_briefs').all();
    expect(rows).toHaveLength(1);
    expect(updated.rendered_text).toBe('second brief');
    expect(updated.max_chars).toBe(500);
    expect(updated.truncated).toBe(1);
    expect(updated.metadata).toEqual({ candidatesScanned: 2 });
  });

  it('does not throw when stored JSON is corrupt', () => {
    recordProjectMemoryStartupBrief(db, {
      instanceId: 'instance-1',
      projectKey: '/fake/project',
      renderedText: 'brief',
      sections: [],
      sources: [],
      maxChars: 1600,
      truncated: false,
    });
    rawDb.prepare(`
      UPDATE project_memory_startup_briefs
      SET sections_json = '{bad', sources_json = 'null', metadata_json = '[]'
      WHERE instance_id = 'instance-1'
    `).run();

    expect(getProjectMemoryStartupBriefByInstance(db, 'instance-1')).toMatchObject({
      sections: [],
      sources: [],
      metadata: {},
    });
  });
});
