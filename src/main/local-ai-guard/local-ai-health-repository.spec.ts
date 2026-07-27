import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver, SqliteStatement } from '../db/sqlite-driver';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import type {
  LocalAiFallbackRequest,
  LocalAiHealthSample,
  LocalAiIncident,
  LocalAiRoutingEvent,
  LocalAiTargetConfig,
} from '../../shared/types/local-ai-guard.types';
import { LocalAiHealthRepository } from './local-ai-health-repository';
import { LocalAiTargetRepository } from './local-ai-target-repository';

const dbs: SqliteDriver[] = [];
const tempDirectories: string[] = [];
const dayMs = 24 * 60 * 60 * 1_000;
const execFileAsync = promisify(execFile);
const electronPath = createRequire(import.meta.url)('electron') as string;
const recoveryProcessScript = String.raw`
  require('tsx/cjs');
  const path = require('node:path');
  const [
    mode,
    filename,
    targetId,
    attemptId = '',
    claimedAtText = '0',
    maxAttemptsText = '0',
    cooldownMsText = '0',
    startAtText = '0',
  ] = process.argv.slice(1);
  const { defaultDriverFactory } = require(
    path.join(process.cwd(), 'src/main/db/better-sqlite3-driver.ts'),
  );
  const { RLM_MIGRATIONS_051_055 } = require(
    path.join(process.cwd(), 'src/main/persistence/rlm/rlm-migrations-051-055.ts'),
  );
  const {
    claimLocalAiRecoveryAttempt,
    listLocalAiRecoveryAttempts,
  } = require(
    path.join(process.cwd(), 'src/main/local-ai-guard/local-ai-recovery-attempt-store.ts'),
  );
  const db = defaultDriverFactory(filename);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.pragma('busy_timeout = 5000');
    let result;
    if (mode === 'setup') {
      for (const migrationName of ['054_local_ai_guard', '055_local_ai_recovery_attempts']) {
        const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === migrationName);
        if (!migration) throw new Error('Missing migration ' + migrationName);
        db.exec(migration.up);
      }
      db.prepare(
        "INSERT INTO local_ai_targets (" +
        "id, label, lifecycle, location_type, worker_node_id, provider, endpoint_id, " +
        "base_url, config_json, created_at, updated_at" +
        ") VALUES (?, 'Recovery target', 'enrolled', 'coordinator', '', 'ollama', ?, " +
        "'http://127.0.0.1:11434', '{}', 1, 1)"
      ).run(targetId, targetId);
      result = { setup: true };
    } else if (mode === 'claim') {
      const startAt = Number(startAtText);
      while (Date.now() < startAt) {
        // Synchronize independent writers so both reach the claim boundary together.
      }
      result = claimLocalAiRecoveryAttempt(db, {
        id: attemptId,
        targetId,
        action: 'restart-ollama',
        claimedAt: Number(claimedAtText),
        maxAttempts: Number(maxAttemptsText),
        cooldownMs: Number(cooldownMsText),
      });
    } else if (mode === 'list') {
      result = listLocalAiRecoveryAttempts(db, targetId);
    } else {
      throw new Error('Unknown recovery process mode');
    }
    console.log('AIO_RECOVERY_RESULT:' + JSON.stringify(result));
  } finally {
    db.close();
  }
`;

type RecoveryProcessMode = 'setup' | 'claim' | 'list';

interface RecoveryProcessOptions {
  attemptId?: string;
  claimedAt?: number;
  maxAttempts?: number;
  cooldownMs?: number;
  startAt?: number;
}

async function runRecoveryProcess<T>(
  mode: RecoveryProcessMode,
  filename: string,
  targetId: string,
  options: RecoveryProcessOptions = {},
): Promise<T> {
  const { stdout } = await execFileAsync(electronPath, [
    '-e',
    recoveryProcessScript,
    mode,
    filename,
    targetId,
    options.attemptId ?? '',
    String(options.claimedAt ?? 0),
    String(options.maxAttempts ?? 0),
    String(options.cooldownMs ?? 0),
    String(options.startAt ?? 0),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const prefix = 'AIO_RECOVERY_RESULT:';
  const resultLine = stdout.split('\n').reverse().find((line) => line.startsWith(prefix));
  if (!resultLine) throw new Error('Recovery process returned no result');
  return JSON.parse(resultLine.slice(prefix.length)) as T;
}

const completionOutcomes = ['unsupported', 'failed', 'not-recovered', 'recovered'] as const;
const booleanValues = [false, true] as const;
const validCompletionTupleKeys: Record<(typeof completionOutcomes)[number], readonly string[]> = {
  unsupported: ['false:false:false'],
  failed: ['true:false:false', 'true:true:false'],
  'not-recovered': ['true:true:false'],
  recovered: ['true:true:true'],
};
const invalidRecoveryCompletions = completionOutcomes.flatMap((outcome) =>
  booleanValues.flatMap((supported) =>
    booleanValues.flatMap((attempted) =>
      booleanValues.map((recovered) => ({ outcome, supported, attempted, recovered })))),
).filter(({ outcome, supported, attempted, recovered }) =>
  !validCompletionTupleKeys[outcome].includes(`${supported}:${attempted}:${recovered}`));

function openDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
  if (!migration) throw new Error('Missing migration 054_local_ai_guard');
  db.exec(migration.up);
  const recoveryMigration = RLM_MIGRATIONS_051_055.find(
    (item) => item.name === '055_local_ai_recovery_attempts',
  );
  if (!recoveryMigration) throw new Error('Missing migration 055_local_ai_recovery_attempts');
  db.exec(recoveryMigration.up);
  dbs.push(db);
  return db;
}

function recoveryDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aio-local-ai-recovery-'));
  tempDirectories.push(directory);
  return join(directory, 'recovery.sqlite');
}

function config(): LocalAiTargetConfig {
  return {
    lifecycle: 'enrolled',
    location: { type: 'coordinator' },
    provider: 'ollama',
    endpointId: 'ollama-main',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'qwen3:14b', required: true }],
    canary: { model: 'qwen3:14b', timeoutMs: 30_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 2, cooldownMs: 60_000 },
  };
}

function sample(targetId: string, id = 'sample-1'): LocalAiHealthSample {
  return {
    id,
    targetId,
    layer: 'endpoint',
    checkType: 'lightweight',
    ok: true,
    required: true,
    affectedRoles: ['compression'],
    checkedAt: 1_000,
    durationMs: 10,
    evidence: { endpointReachable: true },
    origin: 'manual',
  };
}

function incident(targetId: string, id = 'incident-1'): LocalAiIncident {
  return {
    id,
    targetId,
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
  };
}

function event(id: string, createdAt: number, overrides: Partial<LocalAiRoutingEvent> = {}): LocalAiRoutingEvent {
  return {
    id,
    slot: 'compression',
    intendedRoute: 'local',
    actualRoute: 'frontier',
    policy: 'notify-and-allow',
    disposition: 'allowed',
    decisionReason: 'health',
    inputTokens: 100,
    outputTokens: 20,
    createdAt,
    ...overrides,
  };
}

describe('LocalAiHealthRepository', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const db of dbs.splice(0)) db.close();
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('round-trips samples through strict JSON and bounds latest-sample reads to 100 rows', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    for (let index = 0; index < 101; index += 1) {
      repository.appendSample({ ...sample(target.id, `sample-${index}`), checkedAt: index });
    }

    const latest = repository.latestSamples(target.id);

    expect(latest).toHaveLength(100);
    expect(latest[0]).toMatchObject({ id: 'sample-100', evidence: { endpointReachable: true } });
    expect(latest.at(-1)?.id).toBe('sample-1');
  });

  it('atomically claims bounded recovery attempts and persists cooldown across repository restart', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const firstRepository = new LocalAiHealthRepository(db);

    expect(firstRepository.claimRecoveryAttempt({
      id: 'attempt-1',
      targetId: target.id,
      action: 'restart-ollama',
      claimedAt: 1_000,
      maxAttempts: 2,
      cooldownMs: 60_000,
    })).toEqual({
      claimed: true,
      attempt: expect.objectContaining({
        id: 'attempt-1',
        attemptNumber: 1,
        outcome: 'claimed',
      }),
    });

    const restartedRepository = new LocalAiHealthRepository(db);
    expect(restartedRepository.claimRecoveryAttempt({
      id: 'attempt-in-cooldown',
      targetId: target.id,
      action: 'restart-ollama',
      claimedAt: 60_999,
      maxAttempts: 2,
      cooldownMs: 60_000,
    })).toEqual({
      claimed: false,
      reason: 'cooldown',
      attemptCount: 1,
      nextEligibleAt: 61_000,
    });
    expect(restartedRepository.claimRecoveryAttempt({
      id: 'attempt-2',
      targetId: target.id,
      action: 'restart-ollama',
      claimedAt: 61_000,
      maxAttempts: 2,
      cooldownMs: 60_000,
    })).toEqual({
      claimed: true,
      attempt: expect.objectContaining({
        id: 'attempt-2',
        attemptNumber: 2,
      }),
    });
    expect(firstRepository.claimRecoveryAttempt({
      id: 'attempt-exhausted',
      targetId: target.id,
      action: 'deep-check',
      claimedAt: 200_000,
      maxAttempts: 2,
      cooldownMs: 0,
    })).toEqual({
      claimed: false,
      reason: 'max-attempts',
      attemptCount: 2,
    });
  });

  it('persists recovery cooldown after closing and reopening a file-backed database', async () => {
    const filename = recoveryDbPath();
    await runRecoveryProcess('setup', filename, 'file-target');
    const first = await runRecoveryProcess<{ claimed: boolean }>('claim', filename, 'file-target', {
      attemptId: 'file-attempt-1',
      claimedAt: 1_000,
      maxAttempts: 2,
      cooldownMs: 60_000,
    });
    expect(first.claimed).toBe(true);

    const reopened = await runRecoveryProcess('claim', filename, 'file-target', {
      attemptId: 'file-attempt-blocked',
      claimedAt: 60_999,
      maxAttempts: 2,
      cooldownMs: 60_000,
    });
    expect(reopened).toEqual({
      claimed: false,
      reason: 'cooldown',
      attemptCount: 1,
      nextEligibleAt: 61_000,
    });
  });

  it('serializes contending recovery claims across independent SQLite connections', async () => {
    const filename = recoveryDbPath();
    await runRecoveryProcess('setup', filename, 'contended-target');
    const startAt = Date.now() + 1_000;
    const results = await Promise.all([
      runRecoveryProcess<{ claimed: boolean; reason?: string }>(
        'claim',
        filename,
        'contended-target',
        {
          attemptId: 'contender-1',
          claimedAt: 1_000,
          maxAttempts: 1,
          cooldownMs: 60_000,
          startAt,
        },
      ),
      runRecoveryProcess<{ claimed: boolean; reason?: string }>(
        'claim',
        filename,
        'contended-target',
        {
          attemptId: 'contender-2',
          claimedAt: 1_000,
          maxAttempts: 1,
          cooldownMs: 60_000,
          startAt,
        },
      ),
    ]);

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => !result.claimed)).toEqual([
      expect.objectContaining({ reason: 'max-attempts' }),
    ]);
    const attempts = await runRecoveryProcess<unknown[]>('list', filename, 'contended-target');
    expect(attempts).toHaveLength(1);
    const afterReopen = await runRecoveryProcess('claim', filename, 'contended-target', {
      attemptId: 'after-reopen',
      claimedAt: 100_000,
      maxAttempts: 1,
      cooldownMs: 0,
    });
    expect(afterReopen).toEqual({
      claimed: false,
      reason: 'max-attempts',
      attemptCount: 1,
    });
  });

  it('allows only one same-time automatic recovery claimant and stores metadata-only completion', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const first = new LocalAiHealthRepository(db);
    const second = new LocalAiHealthRepository(db);

    const winner = first.claimRecoveryAttempt({
      id: 'attempt-winner',
      targetId: target.id,
      action: 'restart-ollama',
      claimedAt: 5_000,
      maxAttempts: 3,
      cooldownMs: 60_000,
    });
    const loser = second.claimRecoveryAttempt({
      id: 'attempt-loser',
      targetId: target.id,
      action: 'restart-ollama',
      claimedAt: 5_000,
      maxAttempts: 3,
      cooldownMs: 60_000,
    });

    expect(winner.claimed).toBe(true);
    expect(loser).toEqual({
      claimed: false,
      reason: 'cooldown',
      attemptCount: 1,
      nextEligibleAt: 65_000,
    });
    expect(first.completeRecoveryAttempt('attempt-winner', {
      completedAt: 5_100,
      outcome: 'recovered',
      supported: true,
      attempted: true,
      recovered: true,
    })).toBe(true);
    expect(first.listRecoveryAttempts(target.id)).toEqual([
      {
        id: 'attempt-winner',
        targetId: target.id,
        action: 'restart-ollama',
        attemptNumber: 1,
        claimedAt: 5_000,
        completedAt: 5_100,
        outcome: 'recovered',
        supported: true,
        attempted: true,
        recovered: true,
      },
    ]);
    expect(JSON.stringify(first.listRecoveryAttempts(target.id))).not.toMatch(
      /command|Bearer|secret|evidence|message|prompt|modelOutput|baseUrl/i,
    );
  });

  it('enforces cooldown for an attempt claimed at the Unix epoch', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    expect(repository.claimRecoveryAttempt({
      id: 'attempt-at-epoch',
      targetId: target.id,
      action: 'deep-check',
      claimedAt: 0,
      maxAttempts: 2,
      cooldownMs: 1_000,
    }).claimed).toBe(true);

    expect(repository.claimRecoveryAttempt({
      id: 'attempt-before-epoch-cooldown',
      targetId: target.id,
      action: 'deep-check',
      claimedAt: 999,
      maxAttempts: 2,
      cooldownMs: 1_000,
    })).toEqual({
      claimed: false,
      reason: 'cooldown',
      attemptCount: 1,
      nextEligibleAt: 1_000,
    });
  });

  it.each(invalidRecoveryCompletions)(
    'rejects contradictory $outcome/$supported/$attempted/$recovered completion without mutating the claim',
    (completion) => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    repository.claimRecoveryAttempt({
      id: 'attempt-contradictory',
      targetId: target.id,
      action: 'restart-ollama',
      claimedAt: 1_000,
      maxAttempts: 1,
      cooldownMs: 0,
    });

    expect(() => repository.completeRecoveryAttempt('attempt-contradictory', {
      completedAt: 1_001,
      ...completion,
    })).toThrow('Invalid Local AI recovery attempt outcome');
    const [attempt] = repository.listRecoveryAttempts(target.id);
    expect(attempt).toMatchObject({
      id: 'attempt-contradictory',
      outcome: 'claimed',
    });
    expect(attempt).not.toHaveProperty('completedAt');
    },
  );

  it('updates the existing unresolved incident for a target and failure instead of creating a duplicate', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    const opened = repository.upsertIncident({ kind: 'open-or-update', incident: incident(target.id) });
    const updated = repository.upsertIncident({
      kind: 'open-or-update',
      incident: { ...incident(target.id, 'incident-2'), updatedAt: 2_000, fallbackCount: 3 },
    });

    expect(updated).toMatchObject({ id: opened.id, openedAt: 1_000, updatedAt: 2_000, fallbackCount: 3 });
    expect(repository.listIncidents({ targetId: target.id, limit: 10 })).toHaveLength(1);
  });

  it('keeps acknowledgement on an open update, resolves it, and opens a fresh incident after resolution', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    const opened = repository.upsertIncident({ kind: 'open-or-update', incident: incident(target.id) });
    const acknowledged = repository.upsertIncident({ kind: 'acknowledge', incidentId: opened.id, at: 2_000 });
    const updated = repository.upsertIncident({
      kind: 'open-or-update',
      incident: { ...incident(target.id, 'ignored'), updatedAt: 3_000, fallbackCount: 2 },
    });
    const resolved = repository.upsertIncident({ kind: 'resolve', incidentId: opened.id, at: 4_000 });
    const reopened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: { ...incident(target.id, 'reopened'), openedAt: 5_000, updatedAt: 5_000 },
    });

    expect(acknowledged).toMatchObject({ state: 'acknowledged', acknowledgedAt: 2_000 });
    expect(updated).toMatchObject({ id: opened.id, state: 'acknowledged', acknowledgedAt: 2_000, fallbackCount: 2 });
    expect(resolved).toMatchObject({ state: 'resolved', acknowledgedAt: 2_000, resolvedAt: 4_000 });
    expect(reopened).toMatchObject({ id: 'reopened', state: 'open', openedAt: 5_000 });
    expect(repository.listIncidents({ targetId: target.id, limit: 10 })).toHaveLength(2);
  });

  it('enforces monotonic incident audit times while allowing equal boundaries', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: { ...incident(target.id), openedAt: 1_000, updatedAt: 1_000 },
    });

    expect(() => repository.upsertIncident({ kind: 'acknowledge', incidentId: opened.id, at: 999 })).toThrow('cannot');
    expect(repository.upsertIncident({ kind: 'acknowledge', incidentId: opened.id, at: 1_000 }))
      .toMatchObject({ acknowledgedAt: 1_000 });
    expect(() => repository.upsertIncident({
      kind: 'open-or-update',
      incident: { ...incident(target.id), updatedAt: 999 },
    })).toThrow('updatedAt');
    expect(repository.upsertIncident({
      kind: 'open-or-update',
      incident: { ...incident(target.id), updatedAt: 1_000 },
    })).toMatchObject({ id: opened.id, state: 'acknowledged' });
    expect(() => repository.upsertIncident({ kind: 'resolve', incidentId: opened.id, at: 999 })).toThrow('cannot');
    expect(repository.upsertIncident({ kind: 'resolve', incidentId: opened.id, at: 1_000 }))
      .toMatchObject({ resolvedAt: 1_000 });
    expect(() => repository.upsertIncident({
      kind: 'open-or-update',
      incident: { ...incident(target.id, 'bad-coherence'), openedAt: 2_000, updatedAt: 1_999 },
    })).toThrow('openedAt');
  });

  it('atomically accounts each paid routing event once while keeping distinct events independently notifyable', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db, undefined, () => 3_000);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: incident(target.id),
    });
    const firstEvent = event('paid-1', 2_000, {
      targetId: target.id,
      incidentId: opened.id,
      knownCostUsd: 1.25,
      estimatedCostUsd: 1.5,
    });
    const secondEvent = event('paid-2', 2_100, {
      targetId: target.id,
      incidentId: opened.id,
      knownCostUsd: 0.75,
      estimatedCostUsd: 1,
    });

    const first = repository.accountRoutingEvent(firstEvent);
    const replay = repository.accountRoutingEvent(firstEvent);
    const second = repository.accountRoutingEvent(secondEvent);

    expect(first).toMatchObject({ accounted: true, paidDispatch: true, budgetCrossed: false });
    expect(replay).toMatchObject({ accounted: false, paidDispatch: true, budgetCrossed: false });
    expect(second).toMatchObject({ accounted: true, paidDispatch: true, budgetCrossed: false });
    expect(second?.incident).toMatchObject({
      fallbackCount: 2,
      knownCostUsd: 2,
      estimatedCostUsd: 2.5,
      updatedAt: 3_000,
    });
    expect(repository.listRetryableNotifications(3_000, 30_000, 100))
      .toEqual(expect.arrayContaining([
        { entity: 'routing-event', entityId: 'paid-1', transitionKind: 'paid-dispatch' },
        { entity: 'routing-event', entityId: 'paid-2', transitionKind: 'paid-dispatch' },
      ]));
  });

  it('rejects unowned and mismatched routing events without inserting or mutating anything', () => {
    const db = openDb();
    const targets = new LocalAiTargetRepository(db);
    const firstTarget = targets.create(config());
    const secondTarget = targets.create({
      ...config(),
      endpointId: 'ollama-second',
      baseUrl: 'http://127.0.0.1:11435',
    });
    const repository = new LocalAiHealthRepository(db, undefined, () => 2_000);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: incident(firstTarget.id),
    });

    expect(repository.accountRoutingEvent(event('unowned', 1_500))).toBeUndefined();
    expect(repository.accountRoutingEvent(event('mismatch', 1_500, {
      targetId: secondTarget.id,
      incidentId: opened.id,
    }))).toBeUndefined();
    expect(repository.accountRoutingEvent(event('foreign', 1_500, {
      incidentId: 'missing-incident',
    }))).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS count FROM local_ai_routing_events').get<{ count: number }>())
      .toEqual({ count: 0 });
    expect(repository.listIncidents({ targetId: firstTarget.id, limit: 10 })[0]).toMatchObject({
      fallbackCount: 0,
      knownCostUsd: 0,
      estimatedCostUsd: 0,
      updatedAt: 1_000,
    });
  });

  it('requires an exact incident id instead of guessing between simultaneous target failure families', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db, undefined, () => 2_000);
    const endpointIncident = repository.upsertIncident({
      kind: 'open-or-update',
      incident: incident(target.id, 'incident-endpoint'),
    });
    const inferenceIncident = repository.upsertIncident({
      kind: 'open-or-update',
      incident: {
        ...incident(target.id, 'incident-inference'),
        failureCode: 'inference-timeout',
        affectedLayers: ['inference'],
      },
    });

    expect(repository.accountRoutingEvent(event('target-only', 1_500, {
      targetId: target.id,
      knownCostUsd: 1,
    }))).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS count FROM local_ai_routing_events').get<{ count: number }>())
      .toEqual({ count: 0 });
    expect(repository.listIncidents({ targetId: target.id, limit: 10 }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: endpointIncident.id, fallbackCount: 0, knownCostUsd: 0 }),
        expect.objectContaining({ id: inferenceIncident.id, fallbackCount: 0, knownCostUsd: 0 }),
      ]));
  });

  it('accounts a pre-resolution event against its exact resolved incident without reopening it', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db, undefined, () => 5_000);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: incident(target.id),
    });
    repository.upsertIncident({ kind: 'resolve', incidentId: opened.id, at: 4_000 });
    const late = event('late-paid', 4_000, {
      incidentId: opened.id,
      knownCostUsd: 1.25,
      estimatedCostUsd: 1.5,
      completedAt: 4_000,
    });

    const accounted = repository.accountRoutingEvent(late);
    const rejected = repository.accountRoutingEvent(event('post-resolution', 4_001, {
      incidentId: opened.id,
      knownCostUsd: 9,
    }));

    expect(accounted).toMatchObject({
      accounted: true,
      paidDispatch: true,
      incident: {
        id: opened.id,
        state: 'resolved',
        resolvedAt: 4_000,
        updatedAt: 5_000,
        fallbackCount: 1,
        knownCostUsd: 1.25,
        estimatedCostUsd: 1.5,
      },
    });
    expect(rejected).toBeUndefined();
    expect(db.prepare(`
      SELECT count(*) AS count FROM local_ai_routing_events
    `).get<{ count: number }>()).toEqual({ count: 1 });
    expect(repository.listRetryableNotifications(5_000, 30_000, 100)).toContainEqual({
      entity: 'routing-event',
      entityId: 'late-paid',
      transitionKind: 'paid-dispatch',
    });
  });

  it('marks dispatch completion and incident accounting in one repository transaction', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db, undefined, () => 2_000);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: incident(target.id),
    });
    repository.appendRoutingEvent(event('atomic-dispatch', 1_500, {
      targetId: target.id,
      incidentId: opened.id,
      knownCostUsd: 1.25,
    }));

    expect(repository.markFallbackDispatched('atomic-dispatch', 2_000)).toMatchObject({
      id: 'atomic-dispatch',
      completedAt: 2_000,
    });
    expect(repository.listIncidents({ targetId: target.id, limit: 10 })).toContainEqual(
      expect.objectContaining({
        id: opened.id,
        fallbackCount: 1,
        knownCostUsd: 1.25,
      }),
    );
    expect(db.prepare(`
      SELECT completed_at, incident_accounted_at
      FROM local_ai_routing_events WHERE id = ?
    `).get('atomic-dispatch')).toEqual({
      completed_at: 2_000,
      incident_accounted_at: 2_000,
    });
  });

  it('rolls dispatch completion back when linked incident accounting is incoherent', () => {
    const db = openDb();
    const targets = new LocalAiTargetRepository(db);
    const incidentTarget = targets.create(config());
    const eventTarget = targets.create({ ...config(), endpointId: 'other-endpoint' });
    const repository = new LocalAiHealthRepository(db, undefined, () => 2_000);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: incident(incidentTarget.id),
    });
    repository.appendRoutingEvent(event('atomic-dispatch-rollback', 1_500, {
      targetId: eventTarget.id,
      incidentId: opened.id,
      knownCostUsd: 1.25,
    }));

    expect(() => repository.markFallbackDispatched('atomic-dispatch-rollback', 2_000))
      .toThrow(/incident accounting failed/);
    expect(db.prepare(`
      SELECT completed_at, incident_accounted_at
      FROM local_ai_routing_events WHERE id = ?
    `).get('atomic-dispatch-rollback')).toEqual({
      completed_at: null,
      incident_accounted_at: null,
    });
    expect(repository.listIncidents({ targetId: incidentTarget.id, limit: 10 }))
      .toContainEqual(expect.objectContaining({ id: opened.id, fallbackCount: 0 }));
  });

  it('creates and claims a durable recovery outbox item in the resolution transaction', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: incident(target.id),
    });

    repository.upsertIncident({ kind: 'resolve', incidentId: opened.id, at: 2_000 });
    const reference = {
      entity: 'incident' as const,
      entityId: opened.id,
      transitionKind: 'recovered' as const,
    };

    expect(repository.listRetryableNotifications(2_000, 30_000, 100)).toContainEqual(reference);
    expect(repository.claimNotification(reference, 'recovery-1', 2_000, 30_000))
      .toMatchObject({ reference, incident: { state: 'resolved', resolvedAt: 2_000 } });
    expect(repository.claimNotification(reference, 'recovery-2', 2_000, 30_000)).toBeUndefined();
    expect(repository.markNotificationFailed(reference, 'recovery-1', 32_000)).toBe(true);
    expect(repository.listRetryableNotifications(31_999, 30_000, 100)).not.toContainEqual(reference);
    expect(repository.claimNotification(reference, 'recovery-2', 31_999, 30_000)).toBeUndefined();
    expect(repository.claimNotification(reference, 'recovery-2', 32_000, 30_000))
      .toMatchObject({ reference });
    expect(repository.markNotificationDelivered(reference, 'recovery-2', 32_000)).toBe(true);
  });

  it('marks an exact incident budget crossing independently of root-cause severity and only once', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create({
      ...config(),
      incidentFallbackBudgetUsd: 2,
    });
    const repository = new LocalAiHealthRepository(db, undefined, () => 2_000);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: {
        ...incident(target.id),
        severity: 'critical',
        failureCode: 'authentication-error',
      },
    });
    const crossing = event('budget-exact', 1_500, {
      targetId: target.id,
      incidentId: opened.id,
      decisionReason: 'incident-budget',
      knownCostUsd: 2,
      estimatedCostUsd: 9,
    });

    const first = repository.accountRoutingEvent(crossing);
    const replay = repository.accountRoutingEvent(crossing);

    expect(first).toMatchObject({ accounted: true, budgetCrossed: true });
    expect(replay).toMatchObject({ accounted: false, budgetCrossed: false });
    expect(db.prepare(`
      SELECT budget_crossed_at FROM local_ai_incidents WHERE id = ?
    `).get<{ budget_crossed_at: number | null }>(opened.id)).toEqual({ budget_crossed_at: 2_000 });
    expect(repository.listRetryableNotifications(2_000, 30_000, 100))
      .toContainEqual({
        entity: 'incident',
        entityId: opened.id,
        transitionKind: 'budget-critical',
      });
  });

  it('treats only explicit daily or incident reasons as budget decisions', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create({
      ...config(),
      incidentFallbackBudgetUsd: 2,
    });
    const repository = new LocalAiHealthRepository(db, undefined, () => 2_000);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: { ...incident(target.id), severity: 'warning' },
    });
    const policyBlock = event('policy-block', 1_100, {
      targetId: target.id,
      incidentId: opened.id,
      actualRoute: 'blocked',
      policy: 'block-paid-fallback',
      disposition: 'blocked',
      decisionReason: 'policy',
      estimatedCostUsd: 20,
    });
    const thresholdOnly = event('threshold-only', 1_200, {
      targetId: target.id,
      incidentId: opened.id,
      decisionReason: 'health',
      knownCostUsd: 2,
    });
    const explicitDailyBudget = event('daily-budget', 1_300, {
      targetId: target.id,
      incidentId: opened.id,
      actualRoute: 'blocked',
      disposition: 'blocked',
      decisionReason: 'daily-budget',
    });

    expect(repository.accountRoutingEvent(policyBlock)).toMatchObject({ budgetCrossed: false });
    expect(repository.accountRoutingEvent(thresholdOnly)).toMatchObject({ budgetCrossed: false });
    expect(repository.listRetryableNotifications(2_000, 30_000, 100))
      .not.toContainEqual(expect.objectContaining({ transitionKind: 'budget-critical' }));
    expect(repository.accountRoutingEvent(explicitDailyBudget)).toMatchObject({ budgetCrossed: true });
    expect(repository.listRetryableNotifications(2_000, 30_000, 100))
      .toContainEqual({
        entity: 'incident',
        entityId: opened.id,
        transitionKind: 'budget-critical',
      });
  });

  it('round-trips the persisted routing decision reason through the repository row mapper', () => {
    const repository = new LocalAiHealthRepository(openDb());
    const routed = {
      ...event('reason-roundtrip', 1_000),
      decisionReason: 'confirmation' as const,
    };

    repository.appendRoutingEvent(routed);

    expect(repository.getRoutingEvent(routed.id)).toEqual(routed);
  });

  it('claims notification outbox items once, persists failures for retry, and reclaims expired leases', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: incident(target.id),
    });
    const reference = {
      entity: 'incident' as const,
      entityId: opened.id,
      transitionKind: 'fallback-possible' as const,
    };

    expect(repository.claimNotification(reference, 'claim-1', 1_000, 30_000))
      .toMatchObject({ reference, incident: { id: opened.id } });
    expect(repository.claimNotification(reference, 'claim-2', 1_000, 30_000)).toBeUndefined();
    expect(repository.markNotificationFailed(reference, 'claim-1', 31_000)).toBe(true);
    expect(repository.listRetryableNotifications(30_999, 30_000, 100)).not.toContainEqual(reference);
    expect(repository.claimNotification(reference, 'claim-2', 30_999, 30_000)).toBeUndefined();
    expect(repository.claimNotification(reference, 'claim-2', 31_000, 30_000))
      .toMatchObject({ reference });
    expect(repository.claimNotification(reference, 'claim-3', 61_000, 30_000))
      .toMatchObject({ reference });
    expect(repository.markNotificationDelivered(reference, 'claim-2', 61_000)).toBe(false);
    expect(repository.markNotificationDelivered(reference, 'claim-3', 61_000)).toBe(true);
    expect(repository.listRetryableNotifications(100_000, 30_000, 100)).not.toContainEqual(reference);
  });

  it('atomically discards malformed and orphaned notification ownership without claiming or retrying it', () => {
    const db = openDb();
    const warnings = vi.fn();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db, { warn: warnings });
    const malformed = repository.upsertIncident({
      kind: 'open-or-update',
      incident: incident(target.id, 'incident-malformed-SECRET_ID'),
    });
    const eventOwner = repository.upsertIncident({
      kind: 'open-or-update',
      incident: {
        ...incident(target.id, 'incident-event-owner'),
        failureCode: 'inference-timeout',
        affectedLayers: ['inference'],
      },
    });
    repository.appendRoutingEvent(event('event-orphaned-SECRET_ID', 2_000, {
      targetId: target.id,
      incidentId: eventOwner.id,
    }));
    db.prepare(`
      UPDATE local_ai_incidents SET
        affected_layers_json = '{"credential":"Bearer MALFORMED_SECRET"',
        budget_notification_state = 'not-applicable',
        recovery_notification_state = 'not-applicable'
      WHERE id = ?
    `).run(malformed.id);
    db.prepare(`
      UPDATE local_ai_incidents SET fallback_notification_state = 'delivered' WHERE id = ?
    `).run(eventOwner.id);
    db.prepare(`
      UPDATE local_ai_routing_events SET
        incident_id = NULL,
        paid_notification_state = 'pending'
      WHERE id = ?
    `).run('event-orphaned-SECRET_ID');
    const malformedReference = {
      entity: 'incident' as const,
      entityId: malformed.id,
      transitionKind: 'fallback-possible' as const,
    };
    const orphanedReference = {
      entity: 'routing-event' as const,
      entityId: 'event-orphaned-SECRET_ID',
      transitionKind: 'paid-dispatch' as const,
    };

    expect(() => repository.claimNotification(
      malformedReference,
      'malformed-claim',
      5_000,
      30_000,
    )).not.toThrow();
    expect(repository.claimNotification(
      malformedReference,
      'malformed-claim',
      5_000,
      30_000,
    )).toBeUndefined();
    expect(repository.claimNotification(
      orphanedReference,
      'orphaned-claim',
      5_000,
      30_000,
    )).toBeUndefined();
    expect(db.prepare(`
      SELECT fallback_notification_state AS state, fallback_notification_attempts AS attempts,
        fallback_notification_claim_token AS token
      FROM local_ai_incidents WHERE id = ?
    `).get<{ state: string; attempts: number; token: string | null }>(malformed.id))
      .toEqual({ state: 'discarded', attempts: 0, token: null });
    expect(db.prepare(`
      SELECT paid_notification_state AS state, paid_notification_attempts AS attempts,
        paid_notification_claim_token AS token
      FROM local_ai_routing_events WHERE id = ?
    `).get<{ state: string; attempts: number; token: string | null }>('event-orphaned-SECRET_ID'))
      .toEqual({ state: 'discarded', attempts: 0, token: null });
    expect(repository.listRetryableNotifications(100_000, 30_000, 100)).toEqual([]);
    expect(repository.nextOutboxDueAt(100_000, 30_000)).toBeUndefined();
    const warningText = JSON.stringify(warnings.mock.calls);
    expect(warningText).not.toMatch(
      /incident-malformed-SECRET_ID|event-orphaned-SECRET_ID|MALFORMED_SECRET|Bearer/,
    );
    expect(warningText).toMatch(/rowIdHash|notificationIdHash/);
    expect(warningText).toMatch(/invalid-json|invalid-row|malformed-incident|missing-incident-ownership/);
  });

  it('reports the earliest durable notification retry or lease-expiry deadline', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    const first = repository.upsertIncident({
      kind: 'open-or-update',
      incident: incident(target.id, 'incident-next-due-first'),
    });
    const second = repository.upsertIncident({
      kind: 'open-or-update',
      incident: {
        ...incident(target.id, 'incident-next-due-second'),
        failureCode: 'inference-timeout',
        affectedLayers: ['inference'],
      },
    });
    const firstReference = {
      entity: 'incident' as const,
      entityId: first.id,
      transitionKind: 'fallback-possible' as const,
    };
    const secondReference = {
      entity: 'incident' as const,
      entityId: second.id,
      transitionKind: 'fallback-possible' as const,
    };

    expect(repository.nextOutboxDueAt(1_000, 30_000)).toBe(1_000);
    repository.claimNotification(firstReference, 'first-claim', 1_000, 30_000);
    repository.markNotificationFailed(firstReference, 'first-claim', 51_000);
    repository.claimNotification(secondReference, 'second-claim', 2_000, 30_000);
    expect(repository.nextOutboxDueAt(2_000, 30_000)).toBe(32_000);
    repository.markNotificationFailed(secondReference, 'second-claim', 41_000);
    expect(repository.nextOutboxDueAt(2_000, 30_000)).toBe(41_000);
    repository.claimNotification(secondReference, 'second-retry', 41_000, 30_000);
    repository.markNotificationDelivered(secondReference, 'second-retry', 41_000);
    expect(repository.nextOutboxDueAt(41_000, 30_000)).toBe(51_000);
  });

  it('reclaims a legacy claimed notification with no lease timestamp immediately', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: incident(target.id, 'incident-null-lease'),
    });
    const activelyLeased = repository.upsertIncident({
      kind: 'open-or-update',
      incident: {
        ...incident(target.id, 'incident-active-lease'),
        failureCode: 'inference-timeout',
        affectedLayers: ['inference'],
      },
    });
    repository.appendRoutingEvent(event('paid-null-lease', 2_000, {
      targetId: target.id,
      incidentId: opened.id,
    }));
    db.prepare(`
      UPDATE local_ai_incidents SET
        fallback_notification_state = 'claimed',
        fallback_notification_claim_token = 'legacy-fallback-claim',
        fallback_notification_claimed_at = NULL,
        budget_notification_state = 'claimed',
        budget_notification_claim_token = 'legacy-budget-claim',
        budget_notification_claimed_at = NULL,
        recovery_notification_state = 'claimed',
        recovery_notification_claim_token = 'legacy-recovery-claim',
        recovery_notification_claimed_at = NULL
      WHERE id = ?
    `).run(opened.id);
    db.prepare(`
      UPDATE local_ai_routing_events SET
        paid_notification_state = 'claimed',
        paid_notification_claim_token = 'legacy-paid-claim',
        paid_notification_claimed_at = NULL
      WHERE id = ?
    `).run('paid-null-lease');
    db.prepare(`
      UPDATE local_ai_incidents SET
        fallback_notification_state = 'claimed',
        fallback_notification_claim_token = 'active-claim',
        fallback_notification_claimed_at = 5_000
      WHERE id = ?
    `).run(activelyLeased.id);
    const references = [
      {
        entity: 'incident' as const,
        entityId: opened.id,
        transitionKind: 'fallback-possible' as const,
      },
      {
        entity: 'incident' as const,
        entityId: opened.id,
        transitionKind: 'budget-critical' as const,
      },
      {
        entity: 'incident' as const,
        entityId: opened.id,
        transitionKind: 'recovered' as const,
      },
      {
        entity: 'routing-event' as const,
        entityId: 'paid-null-lease',
        transitionKind: 'paid-dispatch' as const,
      },
    ];

    expect(repository.nextOutboxDueAt(5_000, 30_000)).toBe(5_000);
    expect(repository.listRetryableNotifications(5_000, 30_000, 100)).toEqual(references);
    for (const [index, reference] of references.entries()) {
      expect(repository.claimNotification(reference, `replacement-claim-${index}`, 5_000, 30_000))
        .toMatchObject({ reference });
    }
    expect(repository.listRetryableNotifications(5_000, 30_000, 100)).not.toContainEqual({
      entity: 'incident',
      entityId: activelyLeased.id,
      transitionKind: 'fallback-possible',
    });
  });

  it('rejects contradictory open-or-update incident states and lifecycle timestamps', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);

    expect(() => repository.upsertIncident({
      kind: 'open-or-update',
      incident: { ...incident(target.id), state: 'resolved', resolvedAt: 2_000 },
    })).toThrow('open-or-update');
    expect(() => repository.upsertIncident({
      kind: 'open-or-update',
      incident: { ...incident(target.id), acknowledgedAt: 2_000 },
    })).toThrow('open-or-update');
  });

  it('resolves a pending fallback request exactly once with compare-and-set semantics', () => {
    const db = openDb();
    const repository = new LocalAiHealthRepository(db, undefined, () => 1_500);
    repository.appendRoutingEvent(event('event-1', 1_000));
    const request: LocalAiFallbackRequest = {
      id: 'request-1',
      routingEventId: 'event-1',
      slot: 'compression',
      status: 'pending',
      estimatedInputTokens: 100,
      createdAt: 1_000,
      expiresAt: 2_000,
    };
    repository.createFallbackRequest(request);

    expect(repository.resolveFallbackRequest(request.id, 'allow-once')).toMatchObject({
      status: 'allowed',
      resolution: 'allow-once',
    });
    expect(repository.resolveFallbackRequest(request.id, 'block')).toMatchObject({
      status: 'allowed',
      resolution: 'allow-once',
    });
    expect(repository.listPendingFallbackRequests()).toEqual([]);
  });

  it('expires pending requests at their exact deadline and only resolves requests before it', () => {
    const db = openDb();
    let now = 999;
    const repository = new LocalAiHealthRepository(db, undefined, () => now);
    for (const id of ['before', 'exact', 'after']) repository.appendRoutingEvent(event(`event-${id}`, 1));
    for (const id of ['before', 'exact', 'after']) {
      repository.createFallbackRequest({
        id: `request-${id}`,
        routingEventId: `event-${id}`,
        slot: 'compression',
        status: 'pending',
        estimatedInputTokens: 1,
        createdAt: 1,
        expiresAt: 1_000,
      });
    }

    expect(repository.listPendingFallbackRequests().map((request) => request.id)).toEqual([
      'request-after', 'request-before', 'request-exact',
    ]);
    expect(repository.resolveFallbackRequest('request-before', 'allow-once')).toMatchObject({ status: 'allowed' });
    now = 1_000;
    expect(repository.listPendingFallbackRequests()).toEqual([]);
    expect(repository.resolveFallbackRequest('request-exact', 'block')).toMatchObject({
      status: 'expired',
      resolution: 'block',
    });
    now = 1_001;
    expect(repository.resolveFallbackRequest('request-after', 'defer')).toMatchObject({
      status: 'expired',
      resolution: 'block',
    });
    expect(db.prepare('SELECT status FROM local_ai_fallback_requests WHERE id = ?').get<{ status: string }>('request-exact'))
      .toEqual({ status: 'expired' });
    expect(db.prepare('SELECT status FROM local_ai_fallback_requests WHERE id = ?').get<{ status: string }>('request-after'))
      .toEqual({ status: 'expired' });
  });

  it('keeps known and estimated costs separate in effectiveness summaries', () => {
    const db = openDb();
    const repository = new LocalAiHealthRepository(db);
    const now = 100 * dayMs;
    repository.appendRoutingEvent(event('frontier-known', now - 1_000, { knownCostUsd: 1.25 }));
    repository.appendRoutingEvent(event('frontier-estimated', now - 2_000, { estimatedCostUsd: 2.5 }));
    repository.appendRoutingEvent(event('local-avoided', now - 3_000, {
      actualRoute: 'local',
      disposition: 'not-needed',
      inputTokens: 40,
      outputTokens: 10,
      estimatedCostUsd: 0.4,
    }));

    expect(repository.summarize('24h', now)).toMatchObject({
      localTasks: 1,
      localTokens: 50,
      proposedFallbacks: 2,
      allowedFallbacks: 2,
      knownCostUsd: 1.25,
      estimatedCostUsd: 2.5,
      avoidedEstimatedTokens: 50,
      avoidedEstimatedCostUsd: 0.4,
    });
  });

  it('summarizes every event beyond the former 10,000-row limit', () => {
    const db = openDb();
    const repository = new LocalAiHealthRepository(db);
    const now = 100 * dayMs;
    for (let index = 0; index < 10_001; index += 1) {
      repository.appendRoutingEvent(event(`bulk-${String(index).padStart(5, '0')}`, now - 1, {
        knownCostUsd: 1,
        estimatedCostUsd: 0.5,
      }));
    }

    expect(repository.summarize('24h', now)).toMatchObject({
      proposedFallbacks: 10_001,
      allowedFallbacks: 10_001,
      knownCostUsd: 10_001,
      estimatedCostUsd: 5_000.5,
    });
  });

  it('returns exact safe-integer token totals and names the overflowing field', () => {
    const db = openDb();
    const repository = new LocalAiHealthRepository(db);
    const now = 100 * dayMs;
    repository.appendRoutingEvent(event('max-safe', now - 1, {
      actualRoute: 'local',
      disposition: 'not-needed',
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
    }));
    expect(repository.summarize('24h', now).localTokens).toBe(Number.MAX_SAFE_INTEGER);
    repository.appendRoutingEvent(event('one-too-many', now - 1, {
      actualRoute: 'local',
      disposition: 'not-needed',
      inputTokens: 1,
      outputTokens: 0,
    }));

    expect(() => repository.summarize('24h', now)).toThrow('Local AI summary range error for localTokens');
  });

  it('prunes raw history older than 90 days only after preserving daily aggregates', () => {
    const db = openDb();
    const repository = new LocalAiHealthRepository(db);
    const now = 100 * dayMs;
    const oldCreatedAt = now - (91 * dayMs);
    repository.appendSample(sample(new LocalAiTargetRepository(db).create(config()).id, 'old-sample'));
    db.prepare('UPDATE local_ai_health_samples SET checked_at = ? WHERE id = ?').run(oldCreatedAt, 'old-sample');
    repository.appendRoutingEvent(event('old-event', oldCreatedAt, { knownCostUsd: 3, estimatedCostUsd: 4 }));

    expect(repository.runRetention(now)).toEqual({ samplesDeleted: 1, routingEventsDeleted: 1, daysAggregated: 1 });
    expect(db.prepare('SELECT count(*) AS count FROM local_ai_routing_events').get<{ count: number }>()?.count).toBe(0);
    expect(db.prepare('SELECT aggregate_json FROM local_ai_daily_aggregates').get<{ aggregate_json: string }>())
      .toEqual(expect.objectContaining({ aggregate_json: expect.stringContaining('"knownCostUsd":3') }));
    expect(repository.runRetention(now)).toEqual({ samplesDeleted: 0, routingEventsDeleted: 0, daysAggregated: 0 });
  });

  it('keeps one target/day aggregate across a page split with tied timestamps and ID keysets', () => {
    const db = openDb();
    const repository = new LocalAiHealthRepository(db);
    const now = Date.UTC(2026, 3, 1);
    const cutoff = now - (90 * dayMs);
    const retainedDay = cutoff - 1;
    for (let index = 0; index < 1_001; index += 1) {
      repository.appendRoutingEvent(event(`retention-${String(index).padStart(4, '0')}`, retainedDay, {
        knownCostUsd: 1,
        estimatedCostUsd: 2,
      }));
    }
    repository.appendRoutingEvent(event('at-cutoff', cutoff));

    expect(repository.runRetention(now)).toEqual({ samplesDeleted: 0, routingEventsDeleted: 1_001, daysAggregated: 1 });
    expect(db.prepare('SELECT count(*) AS count FROM local_ai_routing_events').get<{ count: number }>()).toEqual({ count: 1 });
    const aggregate = db.prepare('SELECT day, aggregate_json FROM local_ai_daily_aggregates')
      .get<{ day: string; aggregate_json: string }>();
    expect(aggregate?.day).toBe('2025-12-31');
    expect(JSON.parse(aggregate!.aggregate_json)).toMatchObject({ knownCostUsd: 1_001, estimatedCostUsd: 2_002 });
    expect(repository.runRetention(now)).toEqual({ samplesDeleted: 0, routingEventsDeleted: 0, daysAggregated: 0 });
  });

  it('streams more than one page of distinct retention groups with a seekable continuation query', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    const now = Date.UTC(2026, 6, 1);
    const originalPrepareCached = db.prepareCached.bind(db);
    let rawEventPageQueries = 0;
    let continuationPlan = '';
    vi.spyOn(db, 'prepareCached').mockImplementation((sql) => {
      const statement = originalPrepareCached(sql);
      if (sql.includes('SELECT * FROM local_ai_routing_events') && sql.includes('created_at < ?')) {
        rawEventPageQueries += 1;
        if (rawEventPageQueries === 2) {
          const explainedStatement: SqliteStatement = {
            run(...params) {
              return statement.run(...params);
            },
            get<T = unknown>(...params: unknown[]) {
              return statement.get<T>(...params);
            },
            all<T = unknown>(...params: unknown[]) {
              continuationPlan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
                .all<{ detail: string }>(...params)
                .map((row) => row.detail)
                .join('\n');
              return statement.all<T>(...params);
            },
          };
          return explainedStatement;
        }
      }
      return statement;
    });
    for (let index = 0; index < 1_001; index += 1) {
      repository.appendRoutingEvent(event(
        `group-${String(index).padStart(4, '0')}`,
        now - ((91 + index) * dayMs),
        index === 1_000 ? { targetId: target.id } : {},
      ));
    }

    expect(repository.runRetention(now)).toEqual({
      samplesDeleted: 0,
      routingEventsDeleted: 1_001,
      daysAggregated: 1_001,
    });
    expect(rawEventPageQueries).toBe(2);
    expect(continuationPlan).toContain(
      'SEARCH local_ai_routing_events USING INDEX idx_local_ai_routing_events_retention_stream',
    );
    expect(continuationPlan).not.toContain('SCAN');
    expect(continuationPlan).not.toContain('USE TEMP B-TREE');
    expect(db.prepare(`
      SELECT count(*) AS count FROM local_ai_daily_aggregates WHERE target_id IS NULL
    `).get<{ count: number }>()).toEqual({ count: 1_000 });
    const targetAggregate = db.prepare(`
      SELECT aggregate_json FROM local_ai_daily_aggregates WHERE target_id = ?
    `).get<{ aggregate_json: string }>(target.id);
    expect(JSON.parse(targetAggregate!.aggregate_json)).toMatchObject({ proposedFallbacks: 1 });
  });

  it('reports unique UTC retention days even when multiple targets have rows on the same day', () => {
    const db = openDb();
    const targets = new LocalAiTargetRepository(db);
    const first = targets.create(config());
    const second = targets.create({ ...config(), endpointId: 'ollama-second', baseUrl: 'http://127.0.0.1:11435' });
    const repository = new LocalAiHealthRepository(db);
    const now = Date.UTC(2026, 6, 1);
    const sameDay = now - (91 * dayMs);
    const anotherDay = now - (92 * dayMs);
    repository.appendRoutingEvent(event('first-same-day', sameDay, { targetId: first.id }));
    repository.appendRoutingEvent(event('second-same-day', sameDay, { targetId: second.id }));
    repository.appendRoutingEvent(event('first-another-day', anotherDay, { targetId: first.id }));

    expect(repository.runRetention(now)).toEqual({ samplesDeleted: 0, routingEventsDeleted: 3, daysAggregated: 2 });
    expect(repository.runRetention(now)).toEqual({ samplesDeleted: 0, routingEventsDeleted: 0, daysAggregated: 0 });
  });
});
