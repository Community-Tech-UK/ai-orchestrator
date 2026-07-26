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
    const repository = new LocalAiTargetRepository(openDb());
    const target = repository.create(config());

    const pausedAt = target.updatedAt + 1_000;
    const resumedAt = pausedAt + 1_000;
    const retiredAt = resumedAt + 1_000;
    const paused = repository.setLifecycle(target.id, 'paused', pausedAt);
    const resumed = repository.setLifecycle(target.id, 'enrolled', resumedAt);
    const retired = repository.setLifecycle(target.id, 'retired', retiredAt);

    expect(paused).toMatchObject({ lifecycle: 'paused', pausedUntil: pausedAt, updatedAt: pausedAt });
    expect(paused).not.toHaveProperty('retiredAt');
    expect(resumed).toMatchObject({ lifecycle: 'enrolled', updatedAt: resumedAt });
    expect(resumed).not.toHaveProperty('pausedUntil');
    expect(resumed).not.toHaveProperty('retiredAt');
    expect(retired).toMatchObject({ lifecycle: 'retired', retiredAt, updatedAt: retiredAt });
    expect(retired).not.toHaveProperty('pausedUntil');
  });

  it('rejects invalid or regressive lifecycle timestamps without corrupting the existing target', () => {
    const repository = new LocalAiTargetRepository(openDb());
    const target = repository.create(config());
    const invalidTimes = [Number.NaN, -1, Number.MAX_SAFE_INTEGER + 1, target.createdAt - 1];

    for (const at of invalidTimes) expect(() => repository.setLifecycle(target.id, 'paused', at)).toThrow();
    expect(repository.get(target.id)).toEqual(target);

    const paused = repository.setLifecycle(target.id, 'paused', target.updatedAt + 1);
    expect(() => repository.setLifecycle(target.id, 'enrolled', paused.updatedAt - 1)).toThrow();
    expect(repository.get(target.id)).toEqual(paused);
  });

  it('keeps configuration updates and later lifecycle changes monotonic after a future explicit lifecycle timestamp', () => {
    const db = openDb();
    let now = 1_000;
    const repository = new LocalAiTargetRepository(db, undefined, () => now);
    const created = repository.create(config());
    const paused = repository.setLifecycle(created.id, 'paused', 5_000);
    const updated = repository.update(created.id, { warningLatencyMs: 3_000 });

    expect(updated).toMatchObject({ updatedAt: 5_000, warningLatencyMs: 3_000 });
    expect(() => repository.setLifecycle(created.id, 'enrolled', 2_000)).toThrow();
    expect(() => repository.update(created.id, { warningLatencyMs: 0 })).toThrow();
    expect(repository.get(created.id)).toEqual(updated);
    expect(repository.setLifecycle(created.id, 'enrolled', 5_001)).toMatchObject({
      lifecycle: 'enrolled', updatedAt: 5_001,
    });
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
});
