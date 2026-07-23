import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import { SkillAttributionService, getSkillAttribution } from './skill-attribution-service';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function makeService(db: SqliteDriver): SkillAttributionService {
  const service = getSkillAttribution();
  service._bindDatabaseForTesting(db);
  return service;
}

describe('skill attribution migration 053', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('creates both tables and is idempotent on re-run', () => {
    const db = openMigratedDb();
    runMigrations(db); // second run must be a no-op
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('skill_activations', 'skill_controls')
      ORDER BY name
    `).all<{ name: string }>().map((row) => row.name);
    expect(tables).toEqual(['skill_activations', 'skill_controls']);
  });

  it('removes both tables on rollback', () => {
    const db = openMigratedDb();
    const migration = RLM_MIGRATIONS_051_055.find(({ name }) => name === '053_skill_attribution');
    if (!migration) throw new Error('Missing migration 053_skill_attribution');
    db.exec(migration.down);
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('skill_activations', 'skill_controls')
    `).all<{ name: string }>();
    expect(tables).toEqual([]);
  });
});

describe('SkillAttributionService', () => {
  beforeEach(() => {
    SkillAttributionService._resetForTesting();
  });

  afterEach(() => {
    SkillAttributionService._resetForTesting();
    for (const db of dbs.splice(0)) db.close();
  });

  it('records activations and lists them newest-first with filters', () => {
    const service = makeService(openMigratedDb());
    service.recordActivation({
      skillName: 'ui-audit',
      skillSource: 'builtin',
      instanceId: 'inst-1',
      matchedBy: 'trigger',
      matchedTrigger: '/ui-audit',
      matchScore: 1,
      tokensInjected: 300,
      autoSelected: true,
    });
    service.recordActivation({
      skillName: 'code-review',
      skillSource: 'builtin',
      instanceId: 'inst-2',
      matchedBy: 'embedding',
      matchScore: 0.71,
      tokensInjected: 420,
      autoSelected: true,
    });

    expect(service.getRecentActivations()).toHaveLength(2);
    const filtered = service.getRecentActivations({ instanceId: 'inst-1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].skillName).toBe('ui-audit');
    expect(filtered[0].matchedTrigger).toBe('/ui-audit');
    expect(filtered[0].autoSelected).toBe(true);
  });

  it('emits an activation event when a record is written', () => {
    const service = makeService(openMigratedDb());
    const seen = vi.fn();
    service.on('activation', seen);
    service.recordActivation({
      skillName: 'ui-audit',
      skillSource: 'builtin',
      matchedBy: 'explicit',
      tokensInjected: 0,
      autoSelected: false,
    });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0]).toMatchObject({ skillName: 'ui-audit', matchedBy: 'explicit' });
  });

  it('aggregates a health summary per skill', () => {
    const service = makeService(openMigratedDb());
    for (let i = 0; i < 3; i++) {
      service.recordActivation({
        skillName: 'ui-audit',
        skillSource: 'builtin',
        matchedBy: i === 0 ? 'trigger' : 'embedding',
        tokensInjected: 100,
        autoSelected: true,
      });
    }
    const summary = service.getHealthSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      skillName: 'ui-audit',
      totalActivations: 3,
      totalTokens: 300,
      byTrigger: 1,
      byEmbedding: 2,
      byExplicit: 0,
    });
  });

  it('flags recent activations for an instance when it errors, feeding precededErrors', () => {
    const service = makeService(openMigratedDb());
    service.recordActivation({
      skillName: 'ui-audit',
      skillSource: 'builtin',
      instanceId: 'inst-err',
      matchedBy: 'trigger',
      tokensInjected: 100,
      autoSelected: true,
    });
    service.recordActivation({
      skillName: 'code-review',
      skillSource: 'builtin',
      instanceId: 'inst-ok',
      matchedBy: 'trigger',
      tokensInjected: 100,
      autoSelected: true,
    });

    service.markErrorForInstance('inst-err');

    const summary = service.getHealthSummary();
    const errored = summary.find((entry) => entry.skillName === 'ui-audit');
    const clean = summary.find((entry) => entry.skillName === 'code-review');
    expect(errored?.precededErrors).toBe(1);
    expect(clean?.precededErrors).toBe(0);
  });

  it('does not flag activations outside the correlation window', () => {
    const service = makeService(openMigratedDb());
    service.recordActivation({
      skillName: 'ui-audit',
      skillSource: 'builtin',
      instanceId: 'inst-old',
      matchedBy: 'trigger',
      tokensInjected: 100,
      autoSelected: true,
    });

    // Error "happens" an hour from now with a 10-minute window: too far ahead.
    service.markErrorForInstance('inst-old', 10 * 60_000, Date.now() + 3_600_000);

    expect(service.getHealthSummary()[0].precededErrors).toBe(0);
  });

  it('persists controls and honours them over source defaults', () => {
    const service = makeService(openMigratedDb());
    expect(service.getEffectiveMode('ui-audit', 'builtin')).toBe('enabled');
    expect(service.getEffectiveMode('ui-ux-pro-max', 'global')).toBe('suggest-only');

    service.setControl('ui-audit', 'disabled', 'over-fires');
    expect(service.getEffectiveMode('ui-audit', 'builtin')).toBe('disabled');
    expect(service._getControlFromDb('ui-audit')?.mode).toBe('disabled');

    service.setControl('ui-ux-pro-max', 'enabled');
    expect(service.getEffectiveMode('ui-ux-pro-max', 'global')).toBe('enabled');
  });

  it('reloads persisted controls after a singleton reset (cold start)', () => {
    const db = openMigratedDb();
    makeService(db).setControl('ui-audit', 'disabled');
    SkillAttributionService._resetForTesting();
    const fresh = makeService(db);
    expect(fresh.getEffectiveMode('ui-audit', 'builtin')).toBe('disabled');
  });

  it('is fail-soft without a database', () => {
    SkillAttributionService._resetForTesting();
    const service = getSkillAttribution();
    service._bindUnavailableForTesting();
    // Database unavailable: recording no-ops, reads return empty.
    expect(service.recordActivation({
      skillName: 'x',
      skillSource: 'builtin',
      matchedBy: 'trigger',
      tokensInjected: 1,
      autoSelected: true,
    })).toBeNull();
    expect(service.getRecentActivations()).toEqual([]);
    expect(service.getHealthSummary()).toEqual([]);
    // Controls still work in-memory so a disable takes effect this session.
    service.setControl('x', 'disabled');
    expect(service.getEffectiveMode('x', 'builtin')).toBe('disabled');
  });
});
