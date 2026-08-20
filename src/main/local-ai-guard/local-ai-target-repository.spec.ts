import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import type { LocalAiTargetConfig } from '../../shared/types/local-ai-guard.types';
import { LocalAiTargetRepository } from './local-ai-target-repository';

const dbs: SqliteDriver[] = [];

function openDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
  if (!migration) throw new Error('Missing migration 054_local_ai_guard');
  db.exec(migration.up);
  db.exec('ALTER TABLE local_ai_incidents ADD COLUMN unpriced_dispatch_count INTEGER NOT NULL DEFAULT 0;');
  dbs.push(db);
  return db;
}

function config(overrides: Partial<LocalAiTargetConfig> = {}): LocalAiTargetConfig {
  return {
    lifecycle: 'enrolled',
    location: { type: 'worker', nodeId: 'worker-1' },
    provider: 'ollama',
    endpointId: 'ollama-main',
    baseUrl: 'http://127.0.0.1:11434/',
    expectedModels: [{ modelId: 'qwen3:14b', required: true, minContextLength: 16_384 }],
    canary: { model: 'qwen3:14b', timeoutMs: 30_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 2, cooldownMs: 60_000 },
    ...overrides,
  };
}

describe('LocalAiTargetRepository', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const db of dbs.splice(0)) db.close();
  });

  it('creates, canonicalizes, and updates a target configuration without changing its endpoint identity', () => {
    const repository = new LocalAiTargetRepository(openDb());

    const created = repository.create(config());
    const updated = repository.update(created.id, {
      warningLatencyMs: 3_000,
      routingRoles: ['compression', 'titleGeneration'],
    });

    expect(created.baseUrl).toBe('http://127.0.0.1:11434');
    expect(updated).toMatchObject({
      id: created.id,
      provider: 'ollama',
      endpointId: 'ollama-main',
      warningLatencyMs: 3_000,
      routingRoles: ['compression', 'titleGeneration'],
      createdAt: created.createdAt,
    });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    expect(repository.findByEndpoint({
      location: { type: 'worker', nodeId: 'worker-1' },
      provider: 'ollama',
      endpointId: 'ollama-main',
      baseUrl: 'http://127.0.0.1:11434/',
    })?.id).toBe(created.id);
  });

  it('rejects another active target with the same canonical endpoint identity', () => {
    const repository = new LocalAiTargetRepository(openDb());
    repository.create(config());

    expect(() => repository.create(config({ baseUrl: 'http://127.0.0.1:11434' }))).toThrow();
  });

  it('round-trips a valid maximum-length endpoint identity with a schema-valid generated label', () => {
    const repository = new LocalAiTargetRepository(openDb());
    const target = repository.create(config({
      location: { type: 'worker', nodeId: 'w'.repeat(256) },
      endpointId: 'e'.repeat(256),
    }));

    expect(target.label).toHaveLength(256);
    expect(repository.get(target.id)).toEqual(target);
  });

  it('records pause, resume, and retirement lifecycle timestamps', () => {
    let now = 1_000;
    const repository = new LocalAiTargetRepository(openDb(), undefined, () => now);
    const target = repository.create(config());

    now = 2_000;
    const paused = repository.setLifecycle(target.id, 'paused', { pausedUntil: 5_000 });
    now = 3_000;
    const resumed = repository.setLifecycle(target.id, 'enrolled');
    now = 4_000;
    const retired = repository.setLifecycle(target.id, 'retired');

    expect(paused).toMatchObject({ lifecycle: 'paused', pausedUntil: 5_000, updatedAt: 2_000 });
    expect(paused).not.toHaveProperty('retiredAt');
    expect(resumed).toMatchObject({ lifecycle: 'enrolled', updatedAt: 3_000 });
    expect(resumed).not.toHaveProperty('pausedUntil');
    expect(resumed).not.toHaveProperty('retiredAt');
    expect(retired).toMatchObject({ lifecycle: 'retired', retiredAt: 4_000, updatedAt: 4_000 });
    expect(retired).not.toHaveProperty('pausedUntil');
  });

  it('persists an indefinite pause without inventing a deadline', () => {
    let now = 1_000;
    const repository = new LocalAiTargetRepository(openDb(), undefined, () => now);
    const target = repository.create(config());
    now = 2_000;

    const paused = repository.setLifecycle(target.id, 'paused');

    expect(paused).toMatchObject({ lifecycle: 'paused', updatedAt: 2_000 });
    expect(paused).not.toHaveProperty('pausedUntil');
    expect(repository.get(target.id)).toEqual(paused);
  });

  it('replaces a timed pause with an indefinite pause by clearing the old deadline', () => {
    let now = 1_000;
    const repository = new LocalAiTargetRepository(openDb(), undefined, () => now);
    const target = repository.create(config());
    now = 2_000;
    repository.setLifecycle(target.id, 'paused', { pausedUntil: 5_000 });
    now = 3_000;

    const indefinitelyPaused = repository.setLifecycle(target.id, 'paused');

    expect(indefinitelyPaused).toMatchObject({ lifecycle: 'paused', updatedAt: 3_000 });
    expect(indefinitelyPaused).not.toHaveProperty('pausedUntil');
    expect(repository.get(target.id)).toEqual(indefinitelyPaused);
  });

  it('notifies lifecycle subscribers after durable changes and supports disposal', () => {
    const repository = new LocalAiTargetRepository(openDb());
    const observed: string[] = [];
    const unsubscribe = repository.subscribe((value) => {
      observed.push(`${value.id}:${value.lifecycle}`);
    });

    const created = repository.create(config());
    repository.setLifecycle(created.id, 'paused');
    unsubscribe();
    repository.setLifecycle(created.id, 'enrolled');

    expect(observed).toEqual([
      `${created.id}:enrolled`,
      `${created.id}:paused`,
    ]);
  });

  it('rejects invalid or non-future pause deadlines without corrupting the existing target', () => {
    const repository = new LocalAiTargetRepository(openDb(), undefined, () => 1_000);
    const target = repository.create(config());
    const invalidTimes = [Number.NaN, -1, 999, 1_000, Number.MAX_SAFE_INTEGER + 1];

    for (const pausedUntil of invalidTimes) {
      expect(() => repository.setLifecycle(target.id, 'paused', { pausedUntil })).toThrow();
    }
    expect(repository.get(target.id)).toEqual(target);
  });

  it('keeps configuration mutation time truthful while a future pause deadline is active', () => {
    const db = openDb();
    let now = 1_000;
    const repository = new LocalAiTargetRepository(db, undefined, () => now);
    const created = repository.create(config());
    now = 2_000;
    repository.setLifecycle(created.id, 'paused', { pausedUntil: 5_000 });
    now = 3_000;
    const updated = repository.update(created.id, { warningLatencyMs: 3_000 });

    expect(updated).toMatchObject({
      lifecycle: 'paused',
      pausedUntil: 5_000,
      updatedAt: 3_000,
      warningLatencyMs: 3_000,
    });
    expect(() => repository.update(created.id, { warningLatencyMs: 0 })).toThrow();
    expect(repository.get(created.id)).toEqual(updated);
  });

  it('rejects direct create and update calls outside trusted numeric bounds without writing', () => {
    const repository = new LocalAiTargetRepository(openDb());
    for (const invalid of [
      config({ endpointCheckIntervalMs: 1 }),
      config({ canary: { ...config().canary, intervalMs: Number.NaN } }),
      config({ warningLatencyMs: 1.5 }),
      config({ recovery: { automatic: true, maxAttempts: 0, cooldownMs: 1_000_000_000 } }),
    ]) {
      expect(() => repository.create(invalid)).toThrow();
    }
    expect(repository.list()).toEqual([]);

    const target = repository.create(config());
    for (const patch of [
      { endpointCheckIntervalMs: 1 },
      { canary: { ...target.canary, timeoutMs: 1_000_000_000 } },
      { freshnessLimitMs: Number.NaN },
      { recovery: { ...target.recovery, maxAttempts: 1.5 } },
    ]) {
      expect(() => repository.update(target.id, patch)).toThrow();
    }
    expect(repository.get(target.id)).toEqual(target);
  });

  it('rejects invalid expected-model relationships before create or update persistence', () => {
    const repository = new LocalAiTargetRepository(openDb());
    const duplicateModels = [
      config().expectedModels[0],
      { ...config().expectedModels[0], required: false },
    ];

    expect(() => repository.create(config({
      expectedModels: duplicateModels,
    }))).toThrow();
    expect(() => repository.create(config({
      canary: { ...config().canary, model: 'not-expected' },
    }))).toThrow();
    expect(repository.list()).toEqual([]);

    const target = repository.create(config());
    expect(() => repository.update(target.id, {
      expectedModels: duplicateModels,
    })).toThrow();
    expect(() => repository.update(target.id, {
      canary: { ...target.canary, model: 'not-expected' },
    })).toThrow();
    expect(repository.get(target.id)).toEqual(target);
  });

  it('accepts exact trusted numeric boundaries for direct repository calls', () => {
    const repository = new LocalAiTargetRepository(openDb());
    const created = repository.create(config({
      canary: { model: 'qwen3:14b', timeoutMs: 5_000, intervalMs: 120_000 },
      endpointCheckIntervalMs: 30_000,
      freshnessLimitMs: 30_000,
      warningLatencyMs: 100,
      recovery: { automatic: true, maxAttempts: 1, cooldownMs: 60_000 },
    }));

    const updated = repository.update(created.id, {
      canary: { model: 'qwen3:14b', timeoutMs: 120_000, intervalMs: 3_600_000 },
      endpointCheckIntervalMs: 900_000,
      freshnessLimitMs: 900_000,
      warningLatencyMs: 60_000,
      recovery: { automatic: true, maxAttempts: 5, cooldownMs: 3_600_000 },
    });
    expect(updated.endpointCheckIntervalMs).toBe(900_000);
  });

  it('logs and omits a target whose persisted JSON no longer matches the strict configuration schema', () => {
    const db = openDb();
    const warnings: Record<string, unknown>[] = [];
    const repository = new LocalAiTargetRepository(db, { warn: (_message, data) => warnings.push(data ?? {}) });
    const target = repository.create(config());
    db.prepare('UPDATE local_ai_targets SET config_json = ? WHERE id = ?').run('{"unexpected":true}', target.id);

    expect(repository.list()).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ targetId: target.id })]);
  });

  it('fails safe when a legacy persisted target contains newly out-of-policy numeric values', () => {
    const db = openDb();
    const warnings: Record<string, unknown>[] = [];
    const repository = new LocalAiTargetRepository(
      db,
      { warn: (_message, data) => warnings.push(data ?? {}) },
    );
    const target = repository.create(config());
    db.prepare('UPDATE local_ai_targets SET config_json = ? WHERE id = ?').run(
      JSON.stringify(config({ endpointCheckIntervalMs: 1 })),
      target.id,
    );

    expect(repository.get(target.id)).toBeUndefined();
    expect(repository.list()).toEqual([]);
    expect(warnings).toEqual([
      expect.objectContaining({ targetId: target.id }),
      expect.objectContaining({ targetId: target.id }),
    ]);
  });

  it('fails safe when persisted target model relationships violate the worker contract', () => {
    const db = openDb();
    const warnings: Record<string, unknown>[] = [];
    const repository = new LocalAiTargetRepository(
      db,
      { warn: (_message, data) => warnings.push(data ?? {}) },
    );
    const target = repository.create(config());
    db.prepare('UPDATE local_ai_targets SET config_json = ? WHERE id = ?').run(
      JSON.stringify(config({
        canary: { ...target.canary, model: 'not-expected' },
      })),
      target.id,
    );

    expect(repository.get(target.id)).toBeUndefined();
    expect(repository.list()).toEqual([]);
    expect(warnings).toEqual([
      expect.objectContaining({ targetId: target.id }),
      expect.objectContaining({ targetId: target.id }),
    ]);
  });
});
