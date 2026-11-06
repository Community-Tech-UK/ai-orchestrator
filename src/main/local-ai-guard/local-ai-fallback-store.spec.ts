import { execFile, type ChildProcess } from 'node:child_process';
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
const reservationProcesses: { child: ChildProcess; closed: Promise<void> }[] = [];
const reservationLifetimes: { disposed: boolean }[] = [];

const reservationProcessScript = String.raw`
  require('tsx/cjs');
  const path = require('node:path');
  const [mode, filename, id] = process.argv.slice(1);
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
    }
  } catch (error) {
    db.close();
    throw error;
  }
  // Both real file connections must be ready before either reservation starts.
  // Waiting on stdin consumes no CPU and does not guess how long imports take.
  process.stdin.once('data', () => {
    try {
      const repository = new LocalAiHealthRepository(db, undefined, () => 1000);
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
    } finally {
      db.close();
      process.stdin.destroy();
    }
  });
  console.log('AIO_RESERVATION_READY:' + id);
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

afterEach(async () => {
  // Fence suspended test continuations before any buffered READY message can resume them.
  for (const lifetime of reservationLifetimes.splice(0)) lifetime.disposed = true;
  await Promise.all(reservationProcesses.splice(0).map(async ({ child, closed }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }));
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
    const lifetime = { disposed: false };
    reservationLifetimes.push(lifetime);
    const assertCurrent = (): void => {
      if (lifetime.disposed) throw new Error('Reservation fixture has been disposed');
    };
    const start = (mode: 'setup' | 'reserve', id: string) => {
      assertCurrent();
      const execution = execFileAsync(electronPath, [
        '-e', reservationProcessScript, mode, filename, id,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      const child = execution.child;
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      reservationProcesses.push({ child, closed });
      const ready = new Promise<void>((resolve, reject) => {
        let output = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          if (lifetime.disposed) { reject(new Error('Reservation fixture has been disposed')); return; }
          output += chunk.toString();
          if (output.includes('AIO_RESERVATION_READY:' + id)) resolve();
        });
        void execution.then(() => reject(new Error('Reservation process exited before release')), reject);
      });
      return {
        ready,
        release: () => { assertCurrent(); child.stdin?.end('reserve\n'); },
        result: async () => {
          const { stdout } = await execution;
          const prefix = 'AIO_RESERVATION_RESULT:';
          const line = stdout.split('\n').find((candidate) => candidate.startsWith(prefix));
          if (!line) throw new Error('Reservation process returned no result');
          return JSON.parse(line.slice(prefix.length)) as {
            disposition: string;
            decisionReason: string;
          };
        },
      };
    };
    // The first reservation process also initializes the disposable database;
    // no third cold process or wall-clock rendezvous is needed.
    const first = start('setup', 'race-a');
    await first.ready;
    const second = start('reserve', 'race-b');
    await second.ready;
    first.release();
    second.release();
    const results = await Promise.all([first.result(), second.result()]);

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

describe('daily helper limit arithmetic (Step 7, A0-H)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function setup(): { db: SqliteDriver; repository: LocalAiHealthRepository } {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    db.exec('PRAGMA foreign_keys = ON;');
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    if (!migration) throw new Error('Missing migration 054_local_ai_guard');
    db.exec(migration.up);
    db.exec('ALTER TABLE local_ai_incidents ADD COLUMN unpriced_dispatch_count INTEGER NOT NULL DEFAULT 0;');
    return { db, repository: new LocalAiHealthRepository(db, undefined, () => 2_000) };
  }

  function insertEvent(
    db: SqliteDriver,
    id: string,
    row: {
      estimatedCostUsd?: number | null;
      knownCostUsd?: number | null;
      createdAt: number;
      completedAt?: number | null;
    },
  ): void {
    db.prepare(`
      INSERT INTO local_ai_routing_events (
        id, slot, intended_route, actual_route, policy, disposition, decision_reason,
        input_tokens, output_tokens, known_cost_usd, estimated_cost_usd, created_at, completed_at
      ) VALUES (?, 'compression', 'local', 'frontier', 'allow-silently', 'allowed', 'policy', 1, 0, ?, ?, ?, ?)
    `).run(
      id,
      row.knownCostUsd ?? null,
      row.estimatedCostUsd ?? null,
      row.createdAt,
      row.completedAt ?? null,
    );
  }

  function reserveEvent(
    repository: LocalAiHealthRepository,
    estimatedCostUsd: number | undefined,
    globalDailyBudgetUsd: number,
    id = 'next',
  ): { disposition?: string; decisionReason?: string } {
    return repository.reserveFallbackRoutingEvent({
      id,
      slot: 'compression',
      intendedRoute: 'local',
      actualRoute: 'frontier',
      policy: 'allow-silently',
      disposition: 'allowed',
      decisionReason: 'policy',
      inputTokens: 1,
      outputTokens: 0,
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      createdAt: 2_000,
    }, {
      at: 2_000,
      dayStart: 1_000,
      globalDailyBudgetUsd,
    });
  }

  it('a configured budget does not block when the estimate is missing', () => {
    const { db, repository } = setup();
    insertEvent(db, 'unknown-1', { createdAt: 1_500 });

    const stored = reserveEvent(repository, undefined, 1);

    expect(stored.decisionReason).not.toBe('daily-budget');
    expect(stored.disposition).not.toBe('blocked');
  });

  it('unknown-cost rows count five cents each, not the whole day', () => {
    const { db, repository } = setup();
    insertEvent(db, 'unknown-1', { createdAt: 1_500 });
    insertEvent(db, 'unknown-2', { createdAt: 1_600 });
    insertEvent(db, 'unknown-3', { createdAt: 1_700 });

    // Three unknown rows (0.15) plus this 0.05 estimate is 0.20: not over a 0.20 limit.
    expect(reserveEvent(repository, 0.05, 0.2, 'next-a').disposition).not.toBe('blocked');

    // A fourth unknown row tips it: 0.20 + 0.05 > 0.20.
    insertEvent(db, 'unknown-4', { createdAt: 1_800 });
    const blocked = reserveEvent(repository, 0.05, 0.2, 'next-b');
    expect(blocked.disposition).toBe('blocked');
    expect(blocked.decisionReason).toBe('daily-budget');
  });

  it('the ceiling is reached by known plus estimated plus unknown', () => {
    const { db, repository } = setup();
    insertEvent(db, 'known-1', { knownCostUsd: 0.6, createdAt: 1_500, completedAt: 1_550 });
    insertEvent(db, 'estimated-1', { estimatedCostUsd: 0.3, createdAt: 1_600 });
    insertEvent(db, 'unknown-1', { createdAt: 1_700 });

    // 0.6 + 0.3 + 0.05 = 0.95; a 0.06 estimate reaches 1.01 > 1.
    const blocked = reserveEvent(repository, 0.06, 1);
    expect(blocked.disposition).toBe('blocked');
    expect(blocked.decisionReason).toBe('daily-budget');
  });

  it('stale unpriced reservations do not accumulate against the limit', () => {
    const { db, repository } = setup();
    // Open, unpriced rows more than a day old are dispatch bookkeeping that
    // never completed. 100 of them at five cents would be $5 against a $2 limit
    // and would block every paid helper call for good.
    for (let n = 0; n < 100; n += 1) {
      insertEvent(db, `stale-${n}`, { createdAt: 2_000 - DAY_MS - 1_000 - n });
    }

    const allowed = reserveEvent(repository, 0.01, 2);
    expect(allowed.decisionReason).not.toBe('daily-budget');
    expect(allowed.disposition).not.toBe('blocked');

    // A fresh unpriced reservation still counts five cents and tips a tight limit.
    insertEvent(db, 'fresh-unknown', { createdAt: 1_500 });
    const blocked = reserveEvent(repository, 0.01, 0.05, 'next-b');
    expect(blocked.disposition).toBe('blocked');
    expect(blocked.decisionReason).toBe('daily-budget');
  });
});
