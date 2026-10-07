import { afterEach, describe, expect, it } from 'vitest';
import type { LocalAiIncident, LocalAiTargetConfig } from '../../shared/types/local-ai-guard.types';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import { LocalAiHealthEngine } from './local-ai-health-engine';
import { LocalAiHealthRepository } from './local-ai-health-repository';
import { closeIncidentsForRetiredTargets } from './local-ai-incident-retirement';
import { createLocalAiManagementOperations } from './local-ai-management-operations';
import { createLocalAiPublicOperations } from './local-ai-public-operations';
import { LocalAiTargetRepository } from './local-ai-target-repository';

const NOW = 5_000;
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
    location: { type: 'coordinator' },
    provider: 'ollama',
    endpointId: 'ollama-main',
    baseUrl: 'http://127.0.0.1:11434/',
    expectedModels: [{ modelId: 'qwen3:14b', required: true }],
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

function incident(targetId: string, id: string, state: LocalAiIncident['state'] = 'open'): LocalAiIncident {
  return {
    id,
    targetId,
    state,
    severity: 'warning',
    failureCode: 'connection-refused',
    affectedLayers: ['endpoint'],
    affectedRoles: ['compression'],
    openedAt: 1_000,
    updatedAt: 1_000,
    fallbackCount: 0,
    knownCostUsd: 0,
    estimatedCostUsd: 0,
    unpricedDispatchCount: 0,
  };
}

describe('retiring a Local AI target closes its incidents (LT-664)', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('drops open and acknowledged incidents from status when the target is retired, including ones already retired', async () => {
    const db = openDb();
    const targets = new LocalAiTargetRepository(db, undefined, () => NOW);
    const health = new LocalAiHealthRepository(db, undefined, () => NOW);
    const active = targets.create(config());
    const alreadyRetired = targets.create(config({
      endpointId: 'ollama-old',
      baseUrl: 'http://127.0.0.1:11435/',
    }));
    const open = health.upsertIncident({ kind: 'open-or-update', incident: incident(active.id, 'open-1') });
    health.upsertIncident({ kind: 'acknowledge', incidentId: open.id, at: 2_000 });
    health.upsertIncident({
      kind: 'open-or-update',
      incident: incident(alreadyRetired.id, 'stale-retired'),
    });
    targets.setLifecycle(alreadyRetired.id, 'retired');

    const operations = createLocalAiPublicOperations({
      getRuntime: () => ({
        targets,
        health,
        probes: { check: async () => [] },
        notifyChanged: () => undefined,
      }) as never,
      discoverCandidates: async () => [],
      now: () => NOW,
    });
    await operations.setLifecycle(active.id, 'retired');
    closeIncidentsForRetiredTargets(targets, health, NOW);

    expect(health.listIncidents({ targetId: active.id, state: 'open', limit: 10 })).toEqual([]);
    expect(health.listIncidents({ targetId: active.id, state: 'acknowledged', limit: 10 })).toEqual([]);
    expect(health.listIncidents({ targetId: alreadyRetired.id, state: 'open', limit: 10 })).toEqual([]);
    expect(health.listIncidents({ targetId: active.id, limit: 10 })[0]).toMatchObject({ state: 'resolved' });

    const management = createLocalAiManagementOperations({
      getRuntime: () => ({
        targets,
        health,
        engine: new LocalAiHealthEngine(),
        scheduler: { getStatus: () => undefined },
        incidents: { acknowledge: () => undefined },
      }) as never,
      now: () => NOW,
    });
    expect((await management.status()).incidents).toEqual([]);
  });
});
