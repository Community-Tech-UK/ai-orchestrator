import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SqliteDriver } from '../db/sqlite-driver';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import type {
  LocalAiFallbackRequest,
  LocalAiRoutingEvent,
} from '../../shared/types/local-ai-guard.types';
import { LocalAiFallbackApprovalService } from './local-ai-fallback-approval-service';
import { LocalAiHealthRepository } from './local-ai-health-repository';

const dbs: SqliteDriver[] = [];
const tempDirectories: string[] = [];
const execFileAsync = promisify(execFile);
const electronPath = createRequire(import.meta.url)('electron') as string;

const remoteResolutionScript = String.raw`
  require('tsx/cjs');
  const path = require('node:path');
  const [filename, decision] = process.argv.slice(1);
  const { defaultDriverFactory } = require(
    path.join(process.cwd(), 'src/main/db/better-sqlite3-driver.ts'),
  );
  const { RLM_MIGRATIONS_051_055 } = require(
    path.join(process.cwd(), 'src/main/persistence/rlm/rlm-migrations-051-055.ts'),
  );
  const { LocalAiHealthRepository } = require(
    path.join(process.cwd(), 'src/main/local-ai-guard/local-ai-health-repository.ts'),
  );
  const { LocalAiFallbackApprovalService } = require(
    path.join(process.cwd(), 'src/main/local-ai-guard/local-ai-fallback-approval-service.ts'),
  );
  (async () => {
    const firstDb = defaultDriverFactory(filename);
    const migration = RLM_MIGRATIONS_051_055.find(
      (item) => item.name === '054_local_ai_guard',
    );
    firstDb.exec(migration.up);
    const secondDb = defaultDriverFactory(filename);
    firstDb.pragma('busy_timeout = 5000');
    secondDb.pragma('busy_timeout = 5000');
    const firstRepository = new LocalAiHealthRepository(firstDb, undefined, () => 1000);
    const secondRepository = new LocalAiHealthRepository(secondDb, undefined, () => 1000);
    firstRepository.appendRoutingEvent({
      id: 'event-remote',
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
    });
    const timers = [];
    const first = new LocalAiFallbackApprovalService(firstRepository, {
      now: () => 1000,
      createId: () => 'request-remote',
      schedule: (callback) => {
        const handle = { callback, cancelled: false };
        timers.push(handle);
        return handle;
      },
      cancelScheduled: (handle) => { handle.cancelled = true; },
      notifyPending: () => undefined,
      pollIntervalMs: 10,
    });
    const second = new LocalAiFallbackApprovalService(secondRepository, {
      now: () => 1000,
      notifyPending: () => undefined,
    });
    const pending = first.request({
      routingEventId: 'event-remote',
      slot: 'compression',
      estimatedInputTokens: 2000,
      estimatedCostUsd: 0.01,
      expiresAt: 2000,
    });
    second.resolve('request-remote', decision);
    timers[0].callback();
    const winner = await pending;
    const stored = firstRepository.getRoutingEvent('event-remote');
    console.log('AIO_REMOTE_RESOLUTION:' + JSON.stringify({
      winner,
      disposition: stored.disposition,
      allCancelled: timers.every((timer) => timer.cancelled),
    }));
    first.dispose();
    second.dispose();
    firstDb.close();
    secondDb.close();
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
`;

function openDb(filename = ':memory:'): SqliteDriver {
  const db = defaultDriverFactory(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
  if (!migration) throw new Error('Missing migration 054_local_ai_guard');
  db.exec(migration.up);
  dbs.push(db);
  return db;
}

function sharedDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aio-fallback-approval-'));
  tempDirectories.push(directory);
  return join(directory, 'approval.sqlite');
}

function event(id: string, createdAt: number): LocalAiRoutingEvent {
  return {
    id,
    slot: 'compression',
    intendedRoute: 'local',
    actualRoute: 'deferred',
    policy: 'require-confirmation',
    disposition: 'pending-confirmation',
    decisionReason: 'confirmation',
    inputTokens: 2_000,
    outputTokens: 200,
    estimatedCostUsd: 0.01,
    createdAt,
  };
}

function requestInput(
  routingEventId: string,
  expiresAt: number,
  incidentId?: string,
): Omit<LocalAiFallbackRequest, 'id' | 'status' | 'createdAt' | 'resolvedAt' | 'resolution'> {
  return {
    routingEventId,
    ...(incidentId ? { incidentId } : {}),
    slot: 'compression',
    estimatedInputTokens: 2_000,
    estimatedCostUsd: 0.01,
    expiresAt,
  };
}

interface Scheduled {
  callback: () => void;
  cancelled: boolean;
}

function timerHarness() {
  const scheduled: Scheduled[] = [];
  return {
    scheduled,
    schedule(callback: () => void): Scheduled {
      const handle = { callback, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    cancel(handle: unknown): void {
      (handle as Scheduled).cancelled = true;
    },
    run(index = 0): void {
      const handle = scheduled[index];
      if (!handle?.cancelled) handle?.callback();
    },
  };
}

function persistedRequest(db: SqliteDriver, requestId: string): {
  status: string;
  resolution: string | null;
  resolved_at: number | null;
} | undefined {
  return db.prepare(`
    SELECT status, resolution, resolved_at FROM local_ai_fallback_requests WHERE id = ?
  `).get(requestId);
}

describe('LocalAiFallbackApprovalService', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists a pending request before notifying and waiting', async () => {
    const db = openDb();
    let now = 1_000;
    const repository = new LocalAiHealthRepository(db, undefined, () => now);
    repository.appendRoutingEvent(event('event-persist-first', now));
    let persistedBeforeNotify = false;
    const service = new LocalAiFallbackApprovalService(repository, {
      now: () => now,
      createId: () => 'request-persist-first',
      schedule: () => ({ timer: true }),
      cancelScheduled: () => undefined,
      notifyPending: (request) => {
        persistedBeforeNotify = repository.listPendingFallbackRequests()
          .some((pending) => pending.id === request.id);
      },
    });

    const pending = service.request(requestInput('event-persist-first', 2_000));

    expect(persistedBeforeNotify).toBe(true);
    expect(service.listPending()).toEqual([
      expect.objectContaining({
        id: 'request-persist-first',
        status: 'pending',
        routingEventId: 'event-persist-first',
      }),
    ]);
    now = 1_100;
    expect(service.resolve('request-persist-first', 'allow-once')).toMatchObject({
      status: 'allowed',
      resolution: 'allow-once',
      resolvedAt: 1_100,
    });
    await expect(pending).resolves.toBe('allow-once');
    service.dispose();
  });

  it('persists the confirmation event and request together before notifying', async () => {
    const db = openDb();
    const repository = new LocalAiHealthRepository(db, undefined, () => 1_000);
    let bothPersistedBeforeNotify = false;
    const service = new LocalAiFallbackApprovalService(repository, {
      now: () => 1_000,
      createId: () => 'request-atomic-create',
      notifyPending: (request) => {
        bothPersistedBeforeNotify = repository.getRoutingEvent(request.routingEventId)
          ?.disposition === 'pending-confirmation'
          && repository.getFallbackRequest(request.id)?.status === 'pending';
      },
    });
    const pendingEvent = event('event-atomic-create', 1_000);

    const pending = service.request(
      requestInput(pendingEvent.id, 2_000),
      {
        routingEvent: pendingEvent,
        reservationLimits: { at: 1_000, dayStart: 0 },
      },
    );

    expect(bothPersistedBeforeNotify).toBe(true);
    expect(repository.getRoutingEvent(pendingEvent.id)).toEqual(pendingEvent);
    expect(repository.getFallbackRequest('request-atomic-create')).toEqual({
      id: 'request-atomic-create',
      routingEventId: pendingEvent.id,
      slot: 'compression',
      status: 'pending',
      estimatedInputTokens: 2_000,
      estimatedCostUsd: 0.01,
      createdAt: 1_000,
      expiresAt: 2_000,
    });
    service.resolve('request-atomic-create', 'block');
    await expect(pending).resolves.toBe('block');
    service.dispose();
  });

  it('allows exactly one atomic resolution and settles exactly one waiter', async () => {
    const db = openDb();
    const repository = new LocalAiHealthRepository(db, undefined, () => 1_000);
    repository.appendRoutingEvent(event('event-cas', 1_000));
    const timers = timerHarness();
    const service = new LocalAiFallbackApprovalService(repository, {
      now: () => 1_000,
      createId: () => 'request-cas',
      schedule: (callback) => timers.schedule(callback),
      cancelScheduled: (handle) => timers.cancel(handle),
      notifyPending: () => undefined,
    });
    const pending = service.request(requestInput('event-cas', 2_000));

    expect(service.resolve('request-cas', 'allow-incident')).toMatchObject({
      status: 'allowed',
      resolution: 'allow-incident',
    });
    expect(service.resolve('request-cas', 'block')).toMatchObject({
      status: 'allowed',
      resolution: 'allow-incident',
    });
    timers.run();

    await expect(pending).resolves.toBe('allow-incident');
    expect(timers.scheduled[0]?.cancelled).toBe(true);
    expect(persistedRequest(db, 'request-cas')).toMatchObject({
      status: 'allowed',
      resolution: 'allow-incident',
    });
    expect(repository.getRoutingEvent('event-cas')).toMatchObject({
      actualRoute: 'frontier',
      disposition: 'allowed',
    });
    service.dispose();
  });

  it('revalidates a changed hard ceiling atomically when confirmation becomes dispatchable', async () => {
    const db = openDb();
    const midnight = Date.UTC(2026, 6, 27);
    let now = midnight - 1_000;
    const repository = new LocalAiHealthRepository(db, undefined, () => now);
    repository.appendRoutingEvent({
      ...event('event-spend-before-confirm', midnight - 2_000),
      actualRoute: 'frontier',
      policy: 'allow-silently',
      disposition: 'allowed',
      decisionReason: 'policy',
      estimatedCostUsd: 0.6,
      completedAt: midnight + 500,
    });
    repository.appendRoutingEvent({
      ...event('event-revalidate-confirm', now),
      estimatedCostUsd: 0.6,
    });
    let budget = 2;
    const service = new LocalAiFallbackApprovalService(repository, {
      now: () => now,
      createId: () => 'request-revalidate-confirm',
      notifyPending: () => undefined,
      resolveReservationLimits: () => ({
        at: now,
        dayStart: midnight,
        globalDailyBudgetUsd: budget,
      }),
    });
    const pending = service.request(
      requestInput('event-revalidate-confirm', midnight + 60_000),
    );
    now = midnight + 1_000;
    budget = 1;

    expect(service.resolve('request-revalidate-confirm', 'allow-once')).toMatchObject({
      status: 'blocked',
      resolution: 'block',
    });

    await expect(pending).resolves.toBe('block');
    expect(repository.getRoutingEvent('event-revalidate-confirm')).toMatchObject({
      actualRoute: 'blocked',
      disposition: 'blocked',
      decisionReason: 'daily-budget',
    });
    service.dispose();
  });

  it.each(['allow-once', 'block'] as const)(
    'observes a remote %s winner from another connection without leaking timers',
    async (
    decision,
  ) => {
    const filename = sharedDbPath();
    const { stdout } = await execFileAsync(electronPath, [
      '-e',
      remoteResolutionScript,
      filename,
      decision,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const prefix = 'AIO_REMOTE_RESOLUTION:';
    const line = stdout.split('\n').find((candidate) => candidate.startsWith(prefix));
    if (!line) throw new Error('Remote resolution process returned no result');
    expect(JSON.parse(line.slice(prefix.length))).toEqual({
      winner: decision,
      disposition: decision === 'allow-once' ? 'allowed' : 'blocked',
      allCancelled: true,
    });
    },
  );

  it('expires timed-out requests durably to block and cleans up the awaiter', async () => {
    const db = openDb();
    let now = 1_000;
    const repository = new LocalAiHealthRepository(db, undefined, () => now);
    repository.appendRoutingEvent(event('event-timeout', now));
    const timers = timerHarness();
    const service = new LocalAiFallbackApprovalService(repository, {
      now: () => now,
      createId: () => 'request-timeout',
      schedule: (callback) => timers.schedule(callback),
      cancelScheduled: (handle) => timers.cancel(handle),
      notifyPending: () => undefined,
    });
    const pending = service.request(requestInput('event-timeout', 1_100));

    now = 1_100;
    timers.run();

    await expect(pending).resolves.toBe('block');
    expect(service.listPending()).toEqual([]);
    expect(persistedRequest(db, 'request-timeout')).toEqual({
      status: 'expired',
      resolution: 'block',
      resolved_at: 1_100,
    });
    expect(repository.getRoutingEvent('event-timeout')).toMatchObject({
      actualRoute: 'blocked',
      disposition: 'blocked',
    });
    expect(service.resolve('request-timeout', 'allow-once')).toMatchObject({
      status: 'expired',
      resolution: 'block',
    });
    service.dispose();
  });

  it('reschedules an early timer wake without resolving before durable expiry', async () => {
    const db = openDb();
    let now = 1_000;
    const repository = new LocalAiHealthRepository(db, undefined, () => now);
    repository.appendRoutingEvent(event('event-early-wake', now));
    const timers = timerHarness();
    const service = new LocalAiFallbackApprovalService(repository, {
      now: () => now,
      createId: () => 'request-early-wake',
      schedule: (callback) => timers.schedule(callback),
      cancelScheduled: (handle) => timers.cancel(handle),
      notifyPending: () => undefined,
    });
    let settled = false;
    const pending = service.request(requestInput('event-early-wake', 3_000));
    void pending.then(() => {
      settled = true;
    });

    now = 1_500;
    timers.run();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(service.listPending()).toHaveLength(1);
    expect(timers.scheduled).toHaveLength(2);

    now = 3_000;
    timers.run(1);
    await expect(pending).resolves.toBe('block');
    service.dispose();
  });

  it('sweeps restart-orphaned pending requests to block before accepting new work', () => {
    const db = openDb();
    const repository = new LocalAiHealthRepository(db, undefined, () => 1_000);
    repository.appendRoutingEvent(event('event-orphan', 900));
    repository.createFallbackRequest({
      id: 'request-orphan',
      ...requestInput('event-orphan', 2_000),
      status: 'pending',
      createdAt: 900,
    });

    const service = new LocalAiFallbackApprovalService(repository, {
      now: () => 1_000,
      notifyPending: () => {
        throw new Error('restart sweep must not notify');
      },
    });

    expect(service.listPending()).toEqual([]);
    expect(persistedRequest(db, 'request-orphan')).toEqual({
      status: 'blocked',
      resolution: 'block',
      resolved_at: 1_000,
    });
    expect(repository.getRoutingEvent('event-orphan')).toMatchObject({
      actualRoute: 'blocked',
      disposition: 'blocked',
    });
    service.dispose();
  });

  it('fails closed when a restart orphan cannot be durably blocked', () => {
    const orphan: LocalAiFallbackRequest = {
      id: 'request-sweep-failure',
      ...requestInput('event-sweep-failure', 2_000),
      status: 'pending',
      createdAt: 900,
    };

    expect(() => new LocalAiFallbackApprovalService({
      createFallbackRequest: () => undefined,
      resolveFallbackRequest: () => {
        throw new Error('database unavailable');
      },
      listPendingFallbackRequests: () => [orphan],
    } as never, {
      now: () => 1_000,
      logger: { warn: () => undefined },
    })).toThrow(/database unavailable/);
  });

  it('sweeps every restart orphan across more than one 1,000-row repository page', () => {
    const db = openDb();
    const repository = new LocalAiHealthRepository(db, undefined, () => 2_000);
    for (let index = 0; index < 1_005; index += 1) {
      const suffix = String(index).padStart(4, '0');
      repository.appendRoutingEvent(event(`event-batch-${suffix}`, 1_000));
      repository.createFallbackRequest({
        id: `request-batch-${suffix}`,
        ...requestInput(`event-batch-${suffix}`, 3_000),
        status: 'pending',
        createdAt: 1_000,
      });
    }

    const service = new LocalAiFallbackApprovalService(repository, {
      now: () => 2_000,
      notifyPending: () => undefined,
    });

    expect(repository.listPendingFallbackRequests()).toEqual([]);
    service.dispose();
  });

  it('rejects a timed-out waiter when its durable block transition fails', async () => {
    const timers = timerHarness();
    let now = 1_000;
    const service = new LocalAiFallbackApprovalService({
      createFallbackRequest: () => undefined,
      getFallbackRequest: () => ({
        id: 'request-timeout-failure',
        ...requestInput('event-timeout-failure', 1_100),
        status: 'pending',
        createdAt: 1_000,
      }),
      resolveFallbackRequest: () => {
        throw new Error('database unavailable');
      },
      listPendingFallbackRequests: () => [],
    } as never, {
      now: () => now,
      createId: () => 'request-timeout-failure',
      schedule: (callback) => timers.schedule(callback),
      cancelScheduled: (handle) => timers.cancel(handle),
      notifyPending: () => undefined,
    });
    const pending = service.request(requestInput('event-timeout-failure', 1_100));

    now = 1_100;
    timers.run();

    await expect(pending).rejects.toThrow(/database unavailable/);
    service.dispose();
  });

  it('rejects a disposed waiter when its durable block transition fails', async () => {
    const service = new LocalAiFallbackApprovalService({
      createFallbackRequest: () => undefined,
      getFallbackRequest: () => ({
        id: 'request-dispose-failure',
        ...requestInput('event-dispose-failure', 2_000),
        status: 'pending',
        createdAt: 1_000,
      }),
      resolveFallbackRequest: () => {
        throw new Error('database unavailable');
      },
      listPendingFallbackRequests: () => [],
    } as never, {
      now: () => 1_000,
      createId: () => 'request-dispose-failure',
      notifyPending: () => undefined,
    });
    const pending = service.request(requestInput('event-dispose-failure', 2_000));

    service.dispose();

    await expect(pending).rejects.toThrow(/database unavailable/);
  });

  it('resolves every pending waiter to block and cancels timers on disposal', async () => {
    const db = openDb();
    const repository = new LocalAiHealthRepository(db, undefined, () => 1_000);
    repository.appendRoutingEvent(event('event-dispose-a', 1_000));
    repository.appendRoutingEvent(event('event-dispose-b', 1_000));
    const timers = timerHarness();
    let nextId = 0;
    const service = new LocalAiFallbackApprovalService(repository, {
      now: () => 1_000,
      createId: () => `request-dispose-${nextId += 1}`,
      schedule: (callback) => timers.schedule(callback),
      cancelScheduled: (handle) => timers.cancel(handle),
      notifyPending: () => undefined,
    });
    const first = service.request(requestInput('event-dispose-a', 2_000));
    const second = service.request(requestInput('event-dispose-b', 2_000));

    service.dispose();
    service.dispose();

    await expect(first).resolves.toBe('block');
    await expect(second).resolves.toBe('block');
    expect(timers.scheduled.every((timer) => timer.cancelled)).toBe(true);
    expect(service.listPending()).toEqual([]);
    expect(repository.getRoutingEvent('event-dispose-a')).toMatchObject({
      actualRoute: 'blocked',
      disposition: 'blocked',
    });
    expect(repository.getRoutingEvent('event-dispose-b')).toMatchObject({
      actualRoute: 'blocked',
      disposition: 'blocked',
    });
    expect(() => service.request(requestInput('event-dispose-a', 3_000))).toThrow(/disposed/);
    expect(() => service.resolve('request-dispose-1', 'allow-once')).toThrow(/disposed/);
  });
});
