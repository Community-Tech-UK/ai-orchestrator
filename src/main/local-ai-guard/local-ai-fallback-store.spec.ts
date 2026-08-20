import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import { LocalAiHealthRepository } from './local-ai-health-repository';

const execFileAsync = promisify(execFile);
const electronPath = createRequire(import.meta.url)('electron') as string;
const directories: string[] = [];
const dbs: SqliteDriver[] = [];

const reservationProcessScript = String.raw`
  require('tsx/cjs');
  const path = require('node:path');
  const [mode, filename, id = '', startAtText = '0'] = process.argv.slice(1);
  const { defaultDriverFactory } = require(
    path.join(process.cwd(), 'src/main/db/better-sqlite3-driver.ts'),
  );
  const { RLM_MIGRATIONS_051_055 } = require(
    path.join(process.cwd(), 'src/main/persistence/rlm/rlm-migrations-051-055.ts'),
  );
  const { LocalAiHealthRepository } = require(
    path.join(process.cwd(), 'src/main/local-ai-guard/local-ai-health-repository.ts'),
  );
  const db = defaultDriverFactory(filename);
  db.pragma('busy_timeout = 5000');
  try {
    if (mode === 'setup') {
      const migration = RLM_MIGRATIONS_051_055.find(
        (item) => item.name === '054_local_ai_guard',
      );
      if (!migration) throw new Error('Missing migration 054_local_ai_guard');
      db.exec(migration.up);
      db.exec('ALTER TABLE local_ai_incidents ADD COLUMN unpriced_dispatch_count INTEGER NOT NULL DEFAULT 0;');
      console.log('AIO_RESERVATION_RESULT:' + JSON.stringify({ setup: true }));
    } else {
      const repository = new LocalAiHealthRepository(db, undefined, () => 1000);
      while (Date.now() < Number(startAtText)) {}
      const stored = repository.reserveFallbackRoutingEvent({
      id,
      slot: 'compression',
      intendedRoute: 'local',
      actualRoute: 'frontier',
      policy: 'allow-silently',
      disposition: 'allowed',
      decisionReason: 'policy',
      provider: 'openai',
      model: 'race-model',
      inputTokens: 1000,
      outputTokens: 0,
      estimatedCostUsd: 1,
      createdAt: 1000,
    }, {
      at: 1000,
      dayStart: 0,
      globalDailyBudgetUsd: 1.5,
      });
      console.log('AIO_RESERVATION_RESULT:' + JSON.stringify(stored));
    }
  } finally {
    db.close();
  }
`;

const dispatchRestartScript = String.raw`
  require('tsx/cjs');
  const path = require('node:path');
  const [filename] = process.argv.slice(1);
  const { defaultDriverFactory } = require(
    path.join(process.cwd(), 'src/main/db/better-sqlite3-driver.ts'),
  );
  const { RLM_MIGRATIONS_051_055 } = require(
    path.join(process.cwd(), 'src/main/persistence/rlm/rlm-migrations-051-055.ts'),
  );
  const { LocalAiHealthRepository } = require(
    path.join(process.cwd(), 'src/main/local-ai-guard/local-ai-health-repository.ts'),
  );
  const { LocalAiIncidentService } = require(
    path.join(process.cwd(), 'src/main/local-ai-guard/local-ai-incident-service.ts'),
  );
  const openService = (db) => {
    const repository = new LocalAiHealthRepository(db, undefined, () => 2000);
    const incidents = new LocalAiIncidentService(repository, { notify: () => undefined }, {
      now: () => 2000,
      resolveTargetIdentity: () => ({
        provider: 'ollama',
        location: 'coordinator',
        stableTargetId: 'target-restart',
      }),
    });
    return { repository, incidents };
  };
  const firstDb = defaultDriverFactory(filename);
  const migration = RLM_MIGRATIONS_051_055.find(
    (item) => item.name === '054_local_ai_guard',
  );
  firstDb.exec(migration.up);
  firstDb.exec('ALTER TABLE local_ai_incidents ADD COLUMN unpriced_dispatch_count INTEGER NOT NULL DEFAULT 0;');
  firstDb.prepare(
    "INSERT INTO local_ai_targets (" +
    "id, label, lifecycle, location_type, worker_node_id, provider, endpoint_id, " +
    "base_url, config_json, created_at, updated_at" +
    ") VALUES ('target-restart', 'Restart target', 'enrolled', 'coordinator', '', " +
    "'ollama', 'restart', 'http://127.0.0.1:11434', '{}', 1000, 1000)"
  ).run();
  const first = openService(firstDb);
  first.repository.upsertIncident({
    kind: 'open-or-update',
    incident: {
      id: 'incident-restart',
      targetId: 'target-restart',
      state: 'open',
      severity: 'critical',
      failureCode: 'endpoint-timeout',
      affectedLayers: ['endpoint'],
      affectedRoles: ['compression'],
      openedAt: 1000,
      updatedAt: 1000,
      fallbackCount: 0,
      knownCostUsd: 0,
      estimatedCostUsd: 0,
      unpricedDispatchCount: 0,
    },
  });
  first.repository.appendRoutingEvent({
    id: 'event-restart',
    targetId: 'target-restart',
    incidentId: 'incident-restart',
    slot: 'compression',
    intendedRoute: 'local',
    actualRoute: 'frontier',
    policy: 'allow-silently',
    disposition: 'allowed',
    decisionReason: 'policy',
    inputTokens: 1000,
    outputTokens: 0,
    knownCostUsd: 1.25,
    createdAt: 1500,
  });
  const completed = first.repository.markFallbackDispatched('event-restart', 2000);
  first.repository.createFallbackRoutingRequest({
    id: 'event-confirmation-restart',
    slot: 'compression',
    intendedRoute: 'local',
    actualRoute: 'deferred',
    policy: 'require-confirmation',
    disposition: 'pending-confirmation',
    decisionReason: 'confirmation',
    inputTokens: 2000,
    outputTokens: 200,
    estimatedCostUsd: 0.01,
    createdAt: 1000,
  }, {
    id: 'request-confirmation-restart',
    routingEventId: 'event-confirmation-restart',
    slot: 'compression',
    status: 'pending',
    estimatedInputTokens: 2000,
    estimatedCostUsd: 0.01,
    createdAt: 1000,
    expiresAt: 3000,
  }, {
    at: 1000,
    dayStart: 0,
  });
  first.incidents.recordFallback(completed);
  first.incidents.dispose();
  firstDb.close();

  const secondDb = defaultDriverFactory(filename);
  const second = openService(secondDb);
  const stored = second.repository.getRoutingEvent('event-restart');
  const incident = second.repository.listIncidents({
    targetId: 'target-restart',
    limit: 10,
  })[0];
  const accounting = secondDb.prepare(
    'SELECT incident_accounted_at FROM local_ai_routing_events WHERE id = ?',
  ).get('event-restart');
  console.log('AIO_DISPATCH_RESTART:' + JSON.stringify({
    completedAt: stored.completedAt,
    incidentAccountedAt: accounting.incident_accounted_at,
    fallbackCount: incident.fallbackCount,
    knownCostUsd: incident.knownCostUsd,
    confirmationEvent: second.repository.getRoutingEvent('event-confirmation-restart'),
    confirmationRequest: second.repository.getFallbackRequest('request-confirmation-restart'),
  }));
  second.incidents.dispose();
  secondDb.close();
`;

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Local AI fallback reservation store', () => {
  it.each([
    [0.4, 'pending-confirmation'],
    [0.400_001, 'blocked'],
  ] as const)(
    'shadows an incident estimate once known cost exists at boundary %s',
    (nextEstimate, expectedDisposition) => {
      const db = defaultDriverFactory(':memory:');
      dbs.push(db);
      db.exec('PRAGMA foreign_keys = ON;');
      const migration = RLM_MIGRATIONS_051_055.find(
        (item) => item.name === '054_local_ai_guard',
      );
      if (!migration) throw new Error('Missing migration 054_local_ai_guard');
      db.exec(migration.up);
      db.exec('ALTER TABLE local_ai_incidents ADD COLUMN unpriced_dispatch_count INTEGER NOT NULL DEFAULT 0;');
      db.prepare(`
        INSERT INTO local_ai_targets (
          id, label, lifecycle, location_type, worker_node_id, provider, endpoint_id,
          base_url, config_json, created_at, updated_at
        ) VALUES (?, 'Budget target', 'enrolled', 'coordinator', '', 'ollama', ?,
          'http://127.0.0.1:11434', '{}', 1, 1)
      `).run('incident-budget-target', 'incident-budget-target');
      const repository = new LocalAiHealthRepository(db, undefined, () => 2_000);
      const opened = repository.upsertIncident({
        kind: 'open-or-update',
        incident: {
          id: 'incident-budget-shadow',
          targetId: 'incident-budget-target',
          state: 'open',
          severity: 'critical',
          failureCode: 'endpoint-timeout',
          affectedLayers: ['endpoint'],
          affectedRoles: ['compression'],
          openedAt: 1_000,
          updatedAt: 1_000,
          fallbackCount: 0,
          knownCostUsd: 0,
          estimatedCostUsd: 0,
          unpricedDispatchCount: 0,
        },
      });
      repository.accountRoutingEvent({
        id: 'incident-budget-accounted',
        targetId: 'incident-budget-target',
        incidentId: opened.id,
        slot: 'compression',
        intendedRoute: 'local',
        actualRoute: 'frontier',
        policy: 'allow-silently',
        disposition: 'allowed',
        decisionReason: 'policy',
        inputTokens: 1,
        outputTokens: 0,
        knownCostUsd: 0.6,
        estimatedCostUsd: 100,
        createdAt: 1_500,
        completedAt: 1_600,
      });

      const stored = repository.reserveFallbackRoutingEvent({
        id: 'incident-budget-next',
        targetId: 'incident-budget-target',
        incidentId: opened.id,
        slot: 'compression',
        intendedRoute: 'local',
        actualRoute: 'deferred',
        policy: 'require-confirmation',
        disposition: 'pending-confirmation',
        decisionReason: 'confirmation',
        inputTokens: 1,
        outputTokens: 0,
        estimatedCostUsd: nextEstimate,
        createdAt: 2_000,
      }, {
        at: 2_000,
        dayStart: 0,
        incidentBudgetUsd: 1,
      });

      expect(stored.disposition).toBe(expectedDisposition);
      expect(repository.listIncidents({
        targetId: 'incident-budget-target',
        limit: 10,
      })[0]).toMatchObject({
        knownCostUsd: 0.6,
        estimatedCostUsd: 100,
      });
    },
  );

  it('rolls the pending routing event back when linked request insertion fails', () => {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    db.exec('PRAGMA foreign_keys = ON;');
    const migration = RLM_MIGRATIONS_051_055.find(
      (item) => item.name === '054_local_ai_guard',
    );
    if (!migration) throw new Error('Missing migration 054_local_ai_guard');
    db.exec(migration.up);
    db.exec('ALTER TABLE local_ai_incidents ADD COLUMN unpriced_dispatch_count INTEGER NOT NULL DEFAULT 0;');
    const repository = new LocalAiHealthRepository(db, undefined, () => 1_000);
    repository.appendRoutingEvent({
      id: 'existing-request-event',
      slot: 'compression',
      intendedRoute: 'local',
      actualRoute: 'deferred',
      policy: 'require-confirmation',
      disposition: 'pending-confirmation',
      decisionReason: 'confirmation',
      inputTokens: 1,
      outputTokens: 0,
      estimatedCostUsd: 0.1,
      createdAt: 900,
    });
    repository.createFallbackRequest({
      id: 'duplicate-request-id',
      routingEventId: 'existing-request-event',
      slot: 'compression',
      status: 'pending',
      estimatedInputTokens: 1,
      estimatedCostUsd: 0.1,
      createdAt: 900,
      expiresAt: 2_000,
    });
    const pendingEvent = {
      id: 'atomic-pending-event',
      slot: 'compression' as const,
      intendedRoute: 'local' as const,
      actualRoute: 'deferred' as const,
      policy: 'require-confirmation' as const,
      disposition: 'pending-confirmation' as const,
      decisionReason: 'confirmation' as const,
      inputTokens: 1,
      outputTokens: 0,
      estimatedCostUsd: 0.1,
      createdAt: 1_000,
    };

    expect(() => repository.createFallbackRoutingRequest(
      pendingEvent,
      {
        id: 'duplicate-request-id',
        routingEventId: pendingEvent.id,
        slot: 'compression',
        status: 'pending',
        estimatedInputTokens: 1,
        estimatedCostUsd: 0.1,
        createdAt: 1_000,
        expiresAt: 2_000,
      },
      { at: 1_000, dayStart: 0 },
    )).toThrow(/UNIQUE|constraint/i);
    expect(repository.getRoutingEvent(pendingEvent.id)).toBeUndefined();
    expect(db.prepare(`
      SELECT count(*) AS count FROM local_ai_fallback_requests WHERE id = ?
    `).get('duplicate-request-id')).toEqual({ count: 1 });
  });

  it('serializes hard-ceiling evaluation and reservation across separate file connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aio-fallback-reservation-'));
    directories.push(directory);
    const filename = join(directory, 'guard.sqlite');
    const run = async (mode: 'setup' | 'reserve', id = '', startAt = 0) => {
      const { stdout } = await execFileAsync(electronPath, [
        '-e',
        reservationProcessScript,
        mode,
        filename,
        id,
        String(startAt),
      ], {
        cwd: process.cwd(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      const prefix = 'AIO_RESERVATION_RESULT:';
      const line = stdout.split('\n').find((candidate) => candidate.startsWith(prefix));
      if (!line) throw new Error('Reservation process returned no result');
      return JSON.parse(line.slice(prefix.length)) as {
        disposition: string;
        decisionReason: string;
      };
    };
    await run('setup');

    const startAt = Date.now() + 1_000;
    const results = await Promise.all([
      run('reserve', 'race-a', startAt),
      run('reserve', 'race-b', startAt),
    ]);

    expect(results.filter((result) => result.disposition === 'allowed')).toHaveLength(1);
    expect(results.filter((result) => result.disposition === 'blocked')).toEqual([
      expect.objectContaining({ decisionReason: 'daily-budget' }),
    ]);
  });

  it('survives a genuine close/reopen with dispatch and incident accounting committed together', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aio-fallback-dispatch-'));
    directories.push(directory);
    const filename = join(directory, 'guard.sqlite');

    const { stdout } = await execFileAsync(electronPath, [
      '-e',
      dispatchRestartScript,
      filename,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const prefix = 'AIO_DISPATCH_RESTART:';
    const line = stdout.split('\n').find((candidate) => candidate.startsWith(prefix));
    if (!line) throw new Error('Dispatch restart process returned no result');

    expect(JSON.parse(line.slice(prefix.length))).toEqual({
      completedAt: 2_000,
      incidentAccountedAt: 2_000,
      fallbackCount: 1,
      knownCostUsd: 1.25,
      confirmationEvent: expect.objectContaining({
        id: 'event-confirmation-restart',
        disposition: 'pending-confirmation',
        createdAt: 1_000,
      }),
      confirmationRequest: expect.objectContaining({
        id: 'request-confirmation-restart',
        routingEventId: 'event-confirmation-restart',
        status: 'pending',
        createdAt: 1_000,
        expiresAt: 3_000,
      }),
    });
  });
});
