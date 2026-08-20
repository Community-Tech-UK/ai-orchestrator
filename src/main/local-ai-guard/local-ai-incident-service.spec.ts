import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { NotificationService, type DesktopNotificationPort } from '../notifications/notification-service';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import type {
  LocalAiHealthTransition,
  LocalAiRoutingEvent,
  LocalAiTargetConfig,
} from '../../shared/types/local-ai-guard.types';
import { LocalAiHealthRepository } from './local-ai-health-repository';
import {
  LocalAiIncidentService,
  type LocalAiIncidentServiceOptions,
} from './local-ai-incident-service';
import { LocalAiTargetRepository } from './local-ai-target-repository';

const dbs: SqliteDriver[] = [];
const services: LocalAiIncidentService[] = [];

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
    routingRoles: ['compression', 'titleGeneration'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    incidentFallbackBudgetUsd: 2,
    recovery: { automatic: false, maxAttempts: 2, cooldownMs: 60_000 },
  };
}

function transition(
  targetId: string,
  checkedAt: number,
  overrides: {
    action?: LocalAiHealthTransition['incidentAction'];
    failureCode?: 'endpoint-timeout' | 'connection-refused';
    layer?: 'endpoint' | 'inference';
    roles?: ('compression' | 'titleGeneration')[];
  } = {},
): LocalAiHealthTransition {
  const layer = overrides.layer ?? 'endpoint';
  const roles = overrides.roles ?? ['compression'];
  return {
    current: {
      targetId,
      lifecycle: 'enrolled',
      state: overrides.action === 'resolve' ? 'healthy' : 'unavailable',
      routableRoles: overrides.action === 'resolve' ? ['compression', 'titleGeneration'] : [],
      layers: {
        [layer]: {
          targetId,
          layer,
          checkType: layer === 'inference' ? 'functional' : 'lightweight',
          ok: overrides.action === 'resolve',
          required: true,
          affectedRoles: roles,
          checkedAt,
          durationMs: 25,
          ...(overrides.action === 'resolve'
            ? {}
            : { failureCode: overrides.failureCode ?? 'endpoint-timeout' }),
          message:
            'Bearer TOKEN_PLACEHOLDER Basic BASE64_CREDENTIAL_PLACEHOLDER JWT_HEADER_PLACEHOLDER.JWT_PAYLOAD_PLACEHOLDER.JWT_SIGNATURE_PLACEHOLDER',
          evidence: {
            endpointVersion:
              'ftp://USERNAME_PLACEHOLDER:PASSWORD_PLACEHOLDER@private.example.invalid/path?token=TOKEN_PLACEHOLDER',
          },
        },
      },
      consecutiveFailures: overrides.action === 'resolve' ? 0 : 3,
      consecutiveSuccesses: overrides.action === 'resolve' ? 2 : 0,
      flapping: false,
      checkedAt,
      incidentOpen: overrides.action !== 'resolve',
      stateTransitions: [],
    },
    incidentAction: overrides.action ?? 'open',
  };
}

function routingEvent(
  targetId: string,
  incidentId: string,
  createdAt: number,
  overrides: Partial<LocalAiRoutingEvent> = {},
): LocalAiRoutingEvent {
  return {
    id: `event-${createdAt}`,
    targetId,
    incidentId,
    slot: 'compression',
    intendedRoute: 'local',
    actualRoute: 'frontier',
    policy: 'notify-and-allow',
    disposition: 'allowed',
    decisionReason: 'health',
    provider: 'SENSITIVE_PROVIDER_PLACEHOLDER',
    model: 'SENSITIVE_MODEL_PLACEHOLDER',
    inputTokens: 100,
    outputTokens: 20,
    createdAt,
    completedAt: createdAt + 5,
    ...overrides,
  };
}

function notificationHarness(now: () => number) {
  const desktop: DesktopNotificationPort = {
    isSupported: vi.fn(() => true),
    show: vi.fn(),
  };
  const notifications = new NotificationService({
    desktop,
    now,
    cooldownMs: 60_000,
    dedupeWindowMs: 60_000,
  });
  return { desktop, notifications };
}

function createIncidentService(
  repository: LocalAiHealthRepository,
  notifications: NotificationService,
  options: Omit<LocalAiIncidentServiceOptions, 'resolveTargetIdentity'> & {
    resolveTargetIdentity?: LocalAiIncidentServiceOptions['resolveTargetIdentity'];
    logger?: { warn(message: string, data?: Record<string, unknown>): void };
  },
): LocalAiIncidentService {
  const service = new LocalAiIncidentService(repository, notifications, {
    resolveTargetIdentity: () => undefined,
    ...options,
  });
  services.push(service);
  return service;
}

function seedPendingIncidents(db: SqliteDriver, targetId: string, count: number): void {
  const insert = db.prepare(`
    INSERT INTO local_ai_incidents (
      id, target_id, state, severity, failure_code, affected_layers_json,
      affected_roles_json, opened_at, updated_at
    ) VALUES (?, ?, 'open', 'warning', 'endpoint-timeout', '["endpoint"]', '["compression"]', 1, ?)
  `);
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(`incident-backlog-${String(index).padStart(3, '0')}`, targetId, index + 1);
    }
  })();
}

interface ScheduledTask {
  callback: () => void;
  delayMs: number;
  active: boolean;
}

function schedulerHarness() {
  const tasks: ScheduledTask[] = [];
  const schedule = vi.fn((callback: () => void, delayMs: number): ScheduledTask => {
    const task = { callback, delayMs, active: true };
    tasks.push(task);
    return task;
  });
  const cancelScheduled = vi.fn((handle: unknown) => {
    (handle as ScheduledTask).active = false;
  });
  const pending = () => tasks.filter((task) => task.active);
  const runNext = (): ScheduledTask => {
    const task = pending()[0];
    if (!task) throw new Error('No scheduled Task 5 outbox drain');
    task.active = false;
    task.callback();
    return task;
  };
  return { schedule, cancelScheduled, pending, runNext };
}

describe('LocalAiIncidentService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const service of services.splice(0)) service.dispose();
    for (const db of dbs.splice(0)) db.close();
  });

  it('opens one incident per target/failure family, updates repeats, and notifies fallback possibility once across restart', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const firstNotifications = notificationHarness(() => now);
    const service = createIncidentService(repository, firstNotifications.notifications, {
      now: () => now,
      createId: () => 'incident-endpoint',
    });

    const opened = service.handleTransition(transition(target.id, 1_000));
    now = 1_500;
    const updated = service.handleTransition(transition(target.id, 1_500, {
      action: 'update',
      failureCode: 'connection-refused',
      roles: ['titleGeneration'],
    }));

    expect(updated).toMatchObject({
      id: opened?.id,
      failureCode: 'endpoint-timeout',
      affectedLayers: ['endpoint'],
      affectedRoles: ['compression', 'titleGeneration'],
      openedAt: 1_000,
      updatedAt: 1_500,
    });
    expect(repository.listIncidents({ targetId: target.id, limit: 10 })).toHaveLength(1);
    expect(firstNotifications.notifications.list()).toHaveLength(1);
    expect(firstNotifications.notifications.list()[0]).toMatchObject({
      kind: 'local-ai-fallback-possible',
      urgency: 'normal',
    });
    expect(firstNotifications.notifications.list()[0]?.fingerprint).toContain('incident-endpoint');
    expect(firstNotifications.notifications.list()[0]?.fingerprint).toContain('fallback-possible');

    const restartedNotifications = notificationHarness(() => now);
    const restarted = createIncidentService(repository, restartedNotifications.notifications, {
      now: () => now,
      createId: () => 'must-not-be-used',
    });
    restarted.handleTransition(transition(target.id, 1_500));

    expect(restartedNotifications.notifications.list()).toEqual([]);
  });

  it('renders a deterministic provider/location endpoint label without stored or resolved secret text', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create({
      ...config(),
      location: { type: 'worker', nodeId: 'Bearer WORKER_NODE_PLACEHOLDER' },
      endpointId: 'Basic ENDPOINT_ID_PLACEHOLDER',
    });
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const { notifications } = notificationHarness(() => now);
    const stableTargetId =
      'JWT_HEADER_PLACEHOLDER.JWT_PAYLOAD_PLACEHOLDER.JWT_SIGNATURE_PLACEHOLDER ftp://private.example.invalid';
    const service = createIncidentService(repository, notifications, {
      now: () => now,
      createId: () => 'incident-safe-endpoint-label',
      resolveTargetIdentity: () => ({
        provider: 'ollama',
        location: 'worker',
        stableTargetId,
      }),
    });

    service.handleTransition(transition(target.id, now));
    now = 3_000;
    service.handleTransition(transition(target.id, now, { action: 'resolve' }));

    const [opened, recovered] = notifications.list();
    expect(opened?.body).toMatch(/^Endpoint: Worker Ollama endpoint #[0-9a-f]{12}\./);
    expect(recovered?.body).toMatch(/^Endpoint: Worker Ollama endpoint #[0-9a-f]{12}\./);
    expect(opened?.body.split('.')[0]).toBe(recovered?.body.split('.')[0]);
    for (const body of [opened?.body, recovered?.body]) {
      expect(body).not.toContain(target.id);
      expect(body).not.toMatch(
        /Bearer|Basic|JWT_HEADER_PLACEHOLDER|JWT_PAYLOAD_PLACEHOLDER|JWT_SIGNATURE_PLACEHOLDER|ftp:|private\.example/,
      );
    }
  });

  it('falls back to a hashed generic endpoint when identity resolution is unavailable without logging secrets', () => {
    const db = openDb();
    const warnings = vi.fn();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db, { warn: warnings });
    const { notifications } = notificationHarness(() => 1_000);
    const service = createIncidentService(repository, notifications, {
      now: () => 1_000,
      createId: () => 'incident-safe-resolver-fallback',
      resolveTargetIdentity: () => {
        throw new Error('Bearer RESOLVER_SECRET ftp://private.example.invalid');
      },
    });

    service.handleTransition(transition(target.id, 1_000));

    expect(notifications.list()[0]?.body).toMatch(/^Endpoint: Local AI endpoint #[0-9a-f]{12}\./);
    expect(notifications.list()[0]?.body).not.toContain(target.id);
    expect(notifications.list()[0]?.body).not.toMatch(/Bearer|RESOLVER_SECRET|ftp:|private\.example/);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('notifies every distinct paid dispatch immediately while replaying the same event idempotently', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create({
      ...config(),
      incidentFallbackBudgetUsd: undefined,
    });
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const { desktop, notifications } = notificationHarness(() => now);
    const service = createIncidentService(repository, notifications, {
      now: () => now,
      createId: () => 'incident-paid',
    });
    const opened = service.handleTransition(transition(target.id, now))!;

    now = 2_000;
    const firstEvent = routingEvent(target.id, opened.id, now, {
      id: 'paid-event-1',
      knownCostUsd: 1.25,
      estimatedCostUsd: 1.5,
    });
    const first = service.recordFallback(firstEvent);
    const replay = service.recordFallback(firstEvent);
    now = 2_100;
    const second = service.recordFallback(routingEvent(target.id, opened.id, now, {
      id: 'paid-event-2',
      knownCostUsd: 0.75,
      estimatedCostUsd: 1,
    }));

    expect(first).toMatchObject({ fallbackCount: 1, knownCostUsd: 1.25, estimatedCostUsd: 1.5 });
    expect(replay).toMatchObject({ fallbackCount: 1, knownCostUsd: 1.25, estimatedCostUsd: 1.5 });
    expect(second).toMatchObject({
      fallbackCount: 2,
      knownCostUsd: 2,
      estimatedCostUsd: 2.5,
      updatedAt: 2_105,
    });
    const paid = notifications.list().filter((record) => record.kind === 'local-ai-paid-dispatch');
    expect(desktop.show).toHaveBeenCalledTimes(3);
    expect(paid).toHaveLength(2);
    expect(paid).toEqual([
      expect.objectContaining({ urgency: 'critical', delivery: 'desktop' }),
      expect.objectContaining({ urgency: 'critical', delivery: 'desktop' }),
    ]);
    expect(paid[0]?.fingerprint).toContain('incident-paid');
    expect(paid[0]?.fingerprint).toContain('paid-dispatch');
    expect(paid[0]?.fingerprint).toContain('paid-event-1');
    expect(paid[1]?.fingerprint).toContain('paid-event-2');
  });

  it('emits a durable budget notice at the exact threshold even when the root incident is already critical', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const { notifications } = notificationHarness(() => now);
    const service = createIncidentService(repository, notifications, {
      now: () => now,
      createId: () => 'incident-budget',
    });
    const criticalTransition = transition(target.id, now);
    criticalTransition.current.layers.endpoint!.failureCode = 'authentication-error';
    const opened = service.handleTransition(criticalTransition)!;
    expect(opened.severity).toBe('critical');

    now = 2_000;
    const budgetEvent = routingEvent(target.id, opened.id, now, {
      id: 'budget-event',
      decisionReason: 'incident-budget',
      knownCostUsd: 2,
      estimatedCostUsd: 9,
    });
    const critical = service.recordFallback(budgetEvent);
    service.recordFallback(budgetEvent);

    expect(critical).toMatchObject({
      severity: 'critical',
      fallbackCount: 1,
      knownCostUsd: 2,
      estimatedCostUsd: 9,
    });
    const budgetNotices = notifications.list().filter((record) => record.kind === 'local-ai-budget-critical');
    expect(budgetNotices).toHaveLength(1);
    expect(budgetNotices[0]).toMatchObject({
      kind: 'local-ai-budget-critical',
      urgency: 'critical',
      delivery: 'desktop',
    });
    const restartedNotifications = notificationHarness(() => now);
    createIncidentService(repository, restartedNotifications.notifications, { now: () => now });
    expect(restartedNotifications.notifications.list()).toEqual([]);
  });

  it('persists failed notification attempts and retries the outbox after service restart', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const failing = notificationHarness(() => now);
    vi.spyOn(failing.notifications, 'notify').mockImplementationOnce(() => {
      throw new Error('notification port unavailable');
    });
    const first = createIncidentService(repository, failing.notifications, {
      now: () => now,
      createId: () => 'incident-retry',
    });

    first.handleTransition(transition(target.id, now));
    expect(failing.notifications.list()).toEqual([]);
    expect(db.prepare(`
      SELECT fallback_notification_state FROM local_ai_incidents WHERE id = ?
    `).get<{ fallback_notification_state: string }>('incident-retry'))
      .toEqual({ fallback_notification_state: 'failed' });

    now = 31_000;
    const restartedNotifications = notificationHarness(() => now);
    createIncidentService(repository, restartedNotifications.notifications, {
      now: () => now,
      createId: () => 'unused',
    });

    expect(restartedNotifications.notifications.list()).toHaveLength(1);
    expect(restartedNotifications.notifications.list()[0]).toMatchObject({
      kind: 'local-ai-fallback-possible',
      delivery: 'desktop',
    });
    expect(db.prepare(`
      SELECT fallback_notification_state FROM local_ai_incidents WHERE id = ?
    `).get<{ fallback_notification_state: string }>('incident-retry'))
      .toEqual({ fallback_notification_state: 'delivered' });
  });

  it('retries failed budget and paid-dispatch outbox items after restart', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const firstNotifications = notificationHarness(() => now);
    const first = createIncidentService(repository, firstNotifications.notifications, {
      now: () => now,
      createId: () => 'incident-multi-retry',
    });
    const opened = first.handleTransition(transition(target.id, now))!;
    vi.spyOn(firstNotifications.notifications, 'notify').mockImplementation(() => {
      throw new Error('notification port unavailable');
    });
    now = 2_000;

    first.recordFallback(routingEvent(target.id, opened.id, now, {
      id: 'paid-budget-retry',
      decisionReason: 'incident-budget',
      knownCostUsd: 2,
    }));

    expect(db.prepare(`
      SELECT budget_notification_state FROM local_ai_incidents WHERE id = ?
    `).get<{ budget_notification_state: string }>(opened.id))
      .toEqual({ budget_notification_state: 'failed' });
    expect(db.prepare(`
      SELECT paid_notification_state FROM local_ai_routing_events WHERE id = ?
    `).get<{ paid_notification_state: string }>('paid-budget-retry'))
      .toEqual({ paid_notification_state: 'failed' });

    now = 32_000;
    const restartedNotifications = notificationHarness(() => now);
    createIncidentService(repository, restartedNotifications.notifications, { now: () => now });
    expect(restartedNotifications.notifications.list().map((record) => record.kind).sort()).toEqual([
      'local-ai-budget-critical',
      'local-ai-paid-dispatch',
    ]);
  });

  it('ignores routing events without ownership and rejects target/incident mismatches without mutation', () => {
    const db = openDb();
    const targets = new LocalAiTargetRepository(db);
    const firstTarget = targets.create(config());
    const secondTarget = targets.create({
      ...config(),
      endpointId: 'ollama-second',
      baseUrl: 'http://127.0.0.1:11435',
    });
    const repository = new LocalAiHealthRepository(db);
    const { notifications } = notificationHarness(() => 2_000);
    const service = createIncidentService(repository, notifications, {
      now: () => 2_000,
      createId: () => 'incident-owner',
    });
    const opened = service.handleTransition(transition(firstTarget.id, 1_000))!;
    const unowned = routingEvent(firstTarget.id, opened.id, 2_000);
    delete unowned.targetId;
    delete unowned.incidentId;

    expect(service.recordFallback(unowned)).toBeUndefined();
    expect(service.recordFallback(routingEvent(secondTarget.id, opened.id, 2_000, {
      id: 'mismatch',
    }))).toBeUndefined();
    expect(service.recordFallback(routingEvent(firstTarget.id, 'foreign-incident', 2_000, {
      id: 'foreign',
    }))).toBeUndefined();
    expect(repository.listIncidents({ targetId: firstTarget.id, limit: 10 })[0]).toMatchObject({
      fallbackCount: 0,
      knownCostUsd: 0,
      estimatedCostUsd: 0,
    });
    expect(db.prepare('SELECT count(*) AS count FROM local_ai_routing_events').get<{ count: number }>())
      .toEqual({ count: 0 });
  });

  it('rejects incoherent action/state and probe layer/target transitions before authoritative mutation', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    const { notifications } = notificationHarness(() => 2_000);
    const service = createIncidentService(repository, notifications, {
      now: () => 2_000,
      createId: () => 'must-not-open',
    });
    const wrongState = transition(target.id, 1_000);
    wrongState.current.state = 'healthy';
    const wrongLayer = transition(target.id, 1_000);
    wrongLayer.current.layers = { model: wrongLayer.current.layers.endpoint };
    const wrongTarget = transition(target.id, 1_000);
    wrongTarget.current.layers.endpoint!.targetId = 'foreign-target';
    const wrongPreviousProbe = transition(target.id, 1_000);
    wrongPreviousProbe.previous = {
      ...wrongPreviousProbe.current,
      layers: {
        endpoint: {
          ...wrongPreviousProbe.current.layers.endpoint!,
          targetId: 'foreign-target',
        },
      },
    };

    expect(service.handleTransition(wrongState)).toBeUndefined();
    expect(service.handleTransition(wrongLayer)).toBeUndefined();
    expect(service.handleTransition(wrongTarget)).toBeUndefined();
    expect(service.handleTransition(wrongPreviousProbe)).toBeUndefined();
    expect(repository.listIncidents({ targetId: target.id, limit: 10 })).toEqual([]);

    const opened = service.handleTransition(transition(target.id, 2_000))!;
    const invalidResolve = transition(target.id, 3_000, { action: 'resolve' });
    invalidResolve.current.incidentOpen = true;
    expect(service.handleTransition(invalidResolve)).toBeUndefined();
    expect(repository.listIncidents({ targetId: target.id, limit: 10 })[0])
      .toMatchObject({ id: opened.id, state: 'open' });
  });

  it('requires a non-empty coherent required successful probe before resolving', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    const { notifications } = notificationHarness(() => 3_000);
    const service = createIncidentService(repository, notifications, {
      now: () => 3_000,
      createId: () => 'incident-required-recovery',
    });
    service.handleTransition(transition(target.id, 1_000));
    const empty = transition(target.id, 3_000, { action: 'resolve' });
    empty.current.layers = {};
    const optionalOnly = transition(target.id, 3_000, { action: 'resolve' });
    optionalOnly.current.layers.endpoint!.required = false;

    expect(service.handleTransition(empty)).toBeUndefined();
    expect(service.handleTransition(optionalOnly)).toBeUndefined();
    expect(repository.listIncidents({ targetId: target.id, limit: 10 })[0])
      .toMatchObject({ state: 'open' });
    expect(service.handleTransition(transition(target.id, 3_000, { action: 'resolve' })))
      .toMatchObject({ state: 'resolved', resolvedAt: 3_000 });
  });

  it('retries a failed recovery notification from the durable outbox after restart', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const firstNotifications = notificationHarness(() => now);
    const first = createIncidentService(repository, firstNotifications.notifications, {
      now: () => now,
      createId: () => 'incident-recovery-retry',
    });
    first.handleTransition(transition(target.id, now));
    vi.spyOn(firstNotifications.notifications, 'notify').mockImplementationOnce(() => {
      throw new Error('notification enqueue unavailable');
    });
    now = 3_000;

    first.handleTransition(transition(target.id, now, { action: 'resolve' }));

    expect(db.prepare(`
      SELECT recovery_notification_state FROM local_ai_incidents WHERE id = ?
    `).get<{ recovery_notification_state: string }>('incident-recovery-retry'))
      .toEqual({ recovery_notification_state: 'failed' });
    now = 33_000;
    const restartedNotifications = notificationHarness(() => now);
    createIncidentService(repository, restartedNotifications.notifications, { now: () => now });
    expect(restartedNotifications.notifications.list()).toEqual([
      expect.objectContaining({ kind: 'local-ai-recovered', urgency: 'normal' }),
    ]);
    expect(db.prepare(`
      SELECT recovery_notification_state FROM local_ai_incidents WHERE id = ?
    `).get<{ recovery_notification_state: string }>('incident-recovery-retry'))
      .toEqual({ recovery_notification_state: 'delivered' });
  });

  it.each([101, 205])('drains all %i pending notifications through bounded successive batches', (count) => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    seedPendingIncidents(db, target.id, count);
    const repository = new LocalAiHealthRepository(db);
    const { notifications } = notificationHarness(() => 1_000);

    createIncidentService(repository, notifications, { now: () => 1_000 });

    expect(notifications.list()).toHaveLength(count);
    expect(db.prepare(`
      SELECT count(*) AS count FROM local_ai_incidents WHERE fallback_notification_state = 'delivered'
    `).get<{ count: number }>()).toEqual({ count });
    expect(repository.listRetryableNotifications(1_000, 30_000, 100)).toEqual([]);
  });

  it('continues a backlog beyond the 10,000-attempt turn cap on the same service', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    seedPendingIncidents(db, target.id, 10_001);
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const { notifications } = notificationHarness(() => now);
    const timers = schedulerHarness();

    const service = createIncidentService(repository, notifications, {
      now: () => now,
      schedule: timers.schedule,
      cancelScheduled: timers.cancelScheduled,
    });

    expect(db.prepare(`
      SELECT count(*) AS count FROM local_ai_incidents WHERE fallback_notification_state = 'delivered'
    `).get<{ count: number }>()).toEqual({ count: 10_000 });
    expect(timers.pending()).toEqual([
      expect.objectContaining({ delayMs: 1 }),
    ]);

    now = 1_001;
    timers.runNext();

    expect(db.prepare(`
      SELECT count(*) AS count FROM local_ai_incidents WHERE fallback_notification_state = 'delivered'
    `).get<{ count: number }>()).toEqual({ count: 10_001 });
    expect(timers.pending()).toEqual([]);
    service.dispose();
  });

  it('retries a thrown notification on the same service at its exact durable deadline', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const { notifications } = notificationHarness(() => now);
    const realNotify = notifications.notify.bind(notifications);
    let attempts = 0;
    vi.spyOn(notifications, 'notify').mockImplementation((input) => {
      attempts += 1;
      if (attempts === 1) throw new Error('notification port unavailable');
      return realNotify(input);
    });
    const timers = schedulerHarness();
    const service = createIncidentService(repository, notifications, {
      now: () => now,
      createId: () => 'incident-same-service-retry',
      schedule: timers.schedule,
      cancelScheduled: timers.cancelScheduled,
    });

    service.handleTransition(transition(target.id, now));

    expect(attempts).toBe(1);
    expect(timers.pending()).toEqual([
      expect.objectContaining({ delayMs: 30_000 }),
    ]);
    now = 30_999;
    expect(attempts).toBe(1);
    now = 31_000;
    timers.runNext();
    expect(attempts).toBe(2);
    expect(db.prepare(`
      SELECT fallback_notification_state AS state FROM local_ai_incidents WHERE id = ?
    `).get<{ state: string }>('incident-same-service-retry')).toEqual({ state: 'delivered' });
    expect(timers.pending()).toEqual([]);
    service.dispose();
  });

  it.each([
    { direction: 'forward', samples: [5_000, 35_000], retryAt: 65_000 },
    { direction: 'backward', samples: [5_000, 1_000], retryAt: 31_000 },
  ])(
    'persists and schedules a notify failure from one fresh $direction clock sample',
    ({ samples, retryAt }) => {
      const db = openDb();
      const target = new LocalAiTargetRepository(db).create(config());
      const repository = new LocalAiHealthRepository(db);
      repository.upsertIncident({
        kind: 'open-or-update',
        incident: {
          id: `incident-notify-clock-${samples[1]}`,
          targetId: target.id,
          state: 'open',
          severity: 'warning',
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
      const clockSamples = [...samples];
      const now = vi.fn(() => clockSamples.shift() ?? samples.at(-1)!);
      const { notifications } = notificationHarness(() => samples.at(-1)!);
      vi.spyOn(notifications, 'notify').mockImplementation(() => {
        throw new Error('notification port unavailable');
      });
      const timers = schedulerHarness();

      const service = createIncidentService(repository, notifications, {
        now,
        schedule: timers.schedule,
        cancelScheduled: timers.cancelScheduled,
      });

      expect(db.prepare(`
        SELECT fallback_notification_state AS state,
          fallback_notification_claimed_at AS retry_at
        FROM local_ai_incidents WHERE id = ?
      `).get<{ state: string; retry_at: number }>(`incident-notify-clock-${samples[1]}`))
        .toEqual({ state: 'failed', retry_at: retryAt });
      expect(timers.pending()).toEqual([
        expect.objectContaining({ delayMs: 30_000 }),
      ]);
      expect(timers.pending()).not.toEqual([
        expect.objectContaining({ delayMs: 1 }),
      ]);
      service.dispose();
    },
  );

  it.each([
    [
      'fallback-possible',
      'local-ai-fallback-possible',
      'fallback_notification_state',
      'fallback_notification_claim_token',
      'fallback_notification_claimed_at',
      'incident',
    ],
    [
      'budget-critical',
      'local-ai-budget-critical',
      'budget_notification_state',
      'budget_notification_claim_token',
      'budget_notification_claimed_at',
      'incident',
    ],
    [
      'recovered',
      'local-ai-recovered',
      'recovery_notification_state',
      'recovery_notification_claim_token',
      'recovery_notification_claimed_at',
      'incident',
    ],
    [
      'paid-dispatch',
      'local-ai-paid-dispatch',
      'paid_notification_state',
      'paid_notification_claim_token',
      'paid_notification_claimed_at',
      'routing-event',
    ],
  ] as const)(
    'delivers a legacy claimed %s row with no lease exactly once without a 1ms timer loop',
    (transitionKind, expectedKind, stateColumn, tokenColumn, claimedAtColumn, entity) => {
      const db = openDb();
      const target = new LocalAiTargetRepository(db).create(config());
      const repository = new LocalAiHealthRepository(db);
      const incidentId = `incident-legacy-${transitionKind}`;
      const opened = repository.upsertIncident({
        kind: 'open-or-update',
        incident: {
          id: incidentId,
          targetId: target.id,
          state: 'open',
          severity: 'warning',
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
      db.prepare(`
        UPDATE local_ai_incidents SET
          fallback_notification_state = 'delivered',
          budget_notification_state = 'delivered',
          recovery_notification_state = 'delivered'
        WHERE id = ?
      `).run(opened.id);
      const entityId = entity === 'incident' ? opened.id : `event-legacy-${transitionKind}`;
      if (transitionKind === 'recovered') {
        db.prepare(`
          UPDATE local_ai_incidents SET state = 'resolved', resolved_at = 2_000 WHERE id = ?
        `).run(opened.id);
      }
      if (entity === 'routing-event') {
        repository.appendRoutingEvent(routingEvent(target.id, opened.id, 2_000, { id: entityId }));
      }
      const table = entity === 'incident' ? 'local_ai_incidents' : 'local_ai_routing_events';
      db.prepare(`
        UPDATE ${table} SET
          ${stateColumn} = 'claimed',
          ${tokenColumn} = 'legacy-claim',
          ${claimedAtColumn} = NULL
        WHERE id = ?
      `).run(entityId);
      const { notifications } = notificationHarness(() => 5_000);
      const timers = schedulerHarness();

      const service = createIncidentService(repository, notifications, {
        now: () => 5_000,
        schedule: timers.schedule,
        cancelScheduled: timers.cancelScheduled,
      });

      expect(notifications.list()).toEqual([
        expect.objectContaining({ kind: expectedKind }),
      ]);
      expect(db.prepare(`
        SELECT ${stateColumn} AS state FROM ${table} WHERE id = ?
      `).get<{ state: string }>(entityId)).toEqual({ state: 'delivered' });
      expect(timers.schedule).not.toHaveBeenCalled();
      expect(timers.pending()).toEqual([]);
      service.dispose();
    },
  );

  it('discards a malformed pending incident during startup without notifying or scheduling a retry', () => {
    const db = openDb();
    const warnings = vi.fn();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db, { warn: warnings });
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: {
        id: 'incident-startup-malformed-SECRET_ID',
        targetId: target.id,
        state: 'open',
        severity: 'warning',
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
    db.prepare(`
      UPDATE local_ai_incidents
      SET affected_layers_json = '{"credential":"Bearer STARTUP_SECRET"'
      WHERE id = ?
    `).run(opened.id);
    const { notifications } = notificationHarness(() => 5_000);
    const timers = schedulerHarness();

    expect(() => createIncidentService(repository, notifications, {
      now: () => 5_000,
      schedule: timers.schedule,
      cancelScheduled: timers.cancelScheduled,
    })).not.toThrow();

    expect(notifications.list()).toEqual([]);
    expect(db.prepare(`
      SELECT fallback_notification_state AS state, fallback_notification_attempts AS attempts
      FROM local_ai_incidents WHERE id = ?
    `).get<{ state: string; attempts: number }>(opened.id))
      .toEqual({ state: 'discarded', attempts: 0 });
    expect(timers.schedule).not.toHaveBeenCalled();
    expect(timers.pending()).toEqual([]);
    expect(JSON.stringify(warnings.mock.calls)).not.toMatch(
      /incident-startup-malformed-SECRET_ID|STARTUP_SECRET|Bearer/,
    );
  });

  it('discards a paid notification whose incident foreign key became null without a startup retry loop', () => {
    const db = openDb();
    const warnings = vi.fn();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db, { warn: warnings });
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: {
        id: 'incident-deleted-before-startup',
        targetId: target.id,
        state: 'open',
        severity: 'warning',
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
    repository.appendRoutingEvent(routingEvent(target.id, opened.id, 2_000, {
      id: 'event-orphaned-before-startup-SECRET_ID',
    }));
    db.prepare(`
      UPDATE local_ai_routing_events SET paid_notification_state = 'pending' WHERE id = ?
    `).run('event-orphaned-before-startup-SECRET_ID');
    db.prepare('DELETE FROM local_ai_incidents WHERE id = ?').run(opened.id);
    expect(db.prepare(`
      SELECT incident_id FROM local_ai_routing_events WHERE id = ?
    `).get<{ incident_id: string | null }>('event-orphaned-before-startup-SECRET_ID'))
      .toEqual({ incident_id: null });
    const { notifications } = notificationHarness(() => 5_000);
    const timers = schedulerHarness();

    expect(() => createIncidentService(repository, notifications, {
      now: () => 5_000,
      schedule: timers.schedule,
      cancelScheduled: timers.cancelScheduled,
    })).not.toThrow();

    expect(notifications.list()).toEqual([]);
    expect(db.prepare(`
      SELECT paid_notification_state AS state, paid_notification_attempts AS attempts
      FROM local_ai_routing_events WHERE id = ?
    `).get<{ state: string; attempts: number }>('event-orphaned-before-startup-SECRET_ID'))
      .toEqual({ state: 'discarded', attempts: 0 });
    expect(timers.schedule).not.toHaveBeenCalled();
    expect(timers.pending()).toEqual([]);
    expect(JSON.stringify(warnings.mock.calls)).not.toMatch(/event-orphaned-before-startup-SECRET_ID/);
  });

  it.each([
    { direction: 'forward', samples: [5_000, 35_000] },
    { direction: 'backward', samples: [5_000, 1_000] },
  ])(
    'backs off an unexpected repository claim error from a fresh $direction clock sample',
    ({ samples }) => {
      const db = openDb();
      const target = new LocalAiTargetRepository(db).create(config());
      const repository = new LocalAiHealthRepository(db);
      repository.upsertIncident({
        kind: 'open-or-update',
        incident: {
          id: 'incident-claim-error-SECRET_ID',
          targetId: target.id,
          state: 'open',
          severity: 'warning',
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
      vi.spyOn(repository, 'claimNotification').mockImplementation(() => {
        throw new Error('Bearer CLAIM_REPOSITORY_SECRET');
      });
      const warnings = vi.fn();
      const clockSamples = [...samples];
      const now = vi.fn(() => clockSamples.shift() ?? samples.at(-1)!);
      const { notifications } = notificationHarness(() => samples.at(-1)!);
      const timers = schedulerHarness();

      expect(() => createIncidentService(repository, notifications, {
        now,
        schedule: timers.schedule,
        cancelScheduled: timers.cancelScheduled,
        logger: { warn: warnings },
      })).not.toThrow();

      expect(notifications.list()).toEqual([]);
      expect(now.mock.results.map((result) => result.value)).toEqual(samples);
      expect(timers.pending()).toEqual([
        expect.objectContaining({ delayMs: 30_000 }),
      ]);
      expect(timers.pending()).not.toEqual([
        expect.objectContaining({ delayMs: 1 }),
      ]);
      const warningText = JSON.stringify(warnings.mock.calls);
      expect(warningText).toMatch(/repository-claim-error/);
      expect(warningText).not.toMatch(
        /incident-claim-error-SECRET_ID|CLAIM_REPOSITORY_SECRET|Bearer/,
      );
    },
  );

  it('backs off permanent failures without a continuation loop and cancels owned work on dispose', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const { notifications } = notificationHarness(() => now);
    let attempts = 0;
    vi.spyOn(notifications, 'notify').mockImplementation(() => {
      attempts += 1;
      throw new Error('permanent notification failure');
    });
    const timers = schedulerHarness();
    const service = createIncidentService(repository, notifications, {
      now: () => now,
      createId: () => 'incident-permanent-scheduled-failure',
      schedule: timers.schedule,
      cancelScheduled: timers.cancelScheduled,
    });

    service.handleTransition(transition(target.id, now));
    expect(attempts).toBe(1);
    expect(timers.pending()).toEqual([
      expect.objectContaining({ delayMs: 30_000 }),
    ]);

    now = 31_000;
    timers.runNext();
    expect(attempts).toBe(2);
    expect(timers.pending()).toEqual([
      expect.objectContaining({ delayMs: 30_000 }),
    ]);
    const cancelledCallback = timers.pending()[0]!.callback;
    service.dispose();
    expect(timers.pending()).toEqual([]);
    cancelledCallback();
    service.handleTransition(transition(target.id, 61_000, { action: 'update' }));
    expect(attempts).toBe(2);
  });

  it('clamps a far-future durable retry to the signed timer ceiling', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    const opened = repository.upsertIncident({
      kind: 'open-or-update',
      incident: {
        id: 'incident-far-future-retry',
        targetId: target.id,
        state: 'open',
        severity: 'warning',
        failureCode: 'endpoint-timeout',
        affectedLayers: ['endpoint'],
        affectedRoles: ['compression'],
        openedAt: 1,
        updatedAt: 1,
        fallbackCount: 0,
        knownCostUsd: 0,
        estimatedCostUsd: 0,
        unpricedDispatchCount: 0,
      },
    });
    db.prepare(`
      UPDATE local_ai_incidents SET fallback_notification_state = 'failed',
        fallback_notification_claimed_at = ? WHERE id = ?
    `).run(Number.MAX_SAFE_INTEGER, opened.id);
    const { notifications } = notificationHarness(() => 1);
    const timers = schedulerHarness();

    const service = createIncidentService(repository, notifications, {
      now: () => 1,
      schedule: timers.schedule,
      cancelScheduled: timers.cancelScheduled,
    });

    expect(timers.pending()).toEqual([
      expect.objectContaining({ delayMs: 2_147_483_647 }),
    ]);
    service.dispose();
  });

  it('backs off permanent failures while draining later work and retries only after the deadline', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    seedPendingIncidents(db, target.id, 101);
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const { notifications } = notificationHarness(() => now);
    const realNotify = notifications.notify.bind(notifications);
    let attempts = 0;
    vi.spyOn(notifications, 'notify').mockImplementation((input) => {
      attempts += 1;
      const incidentId = (input.fingerprintFields as { incidentId?: string }).incidentId;
      if (incidentId !== 'incident-backlog-100') throw new Error('permanent notification failure');
      return realNotify(input);
    });

    createIncidentService(repository, notifications, { now: () => now });

    expect(attempts).toBe(101);
    expect(notifications.list()).toEqual([
      expect.objectContaining({ fingerprint: expect.stringContaining('incident-backlog-100') }),
    ]);
    expect(db.prepare(`
      SELECT fallback_notification_state AS state, min(fallback_notification_claimed_at) AS earliest,
        max(fallback_notification_claimed_at) AS latest
      FROM local_ai_incidents WHERE fallback_notification_state = 'failed'
    `).get<{ state: string; earliest: number; latest: number }>()).toEqual({
      state: 'failed',
      earliest: 31_000,
      latest: 31_000,
    });

    now = 30_999;
    createIncidentService(repository, notifications, { now: () => now });
    expect(attempts).toBe(101);

    now = 31_000;
    createIncidentService(repository, notifications, { now: () => now });
    expect(attempts).toBe(201);
    expect(db.prepare(`
      SELECT count(*) AS count FROM local_ai_incidents
      WHERE fallback_notification_state = 'failed' AND fallback_notification_claimed_at = 61000
    `).get<{ count: number }>()).toEqual({ count: 100 });
  });

  it('accounts and notifies a late pre-resolution paid event without reopening the incident', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create({
      ...config(),
      incidentFallbackBudgetUsd: undefined,
    });
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const { notifications } = notificationHarness(() => now);
    const service = createIncidentService(repository, notifications, {
      now: () => now,
      createId: () => 'incident-late-paid',
    });
    const opened = service.handleTransition(transition(target.id, now))!;
    now = 4_000;
    service.handleTransition(transition(target.id, now, { action: 'resolve' }));
    now = 5_000;
    const late = routingEvent(target.id, opened.id, 4_000, {
      id: 'late-paid-event',
      targetId: undefined,
      knownCostUsd: 1.25,
    });

    const accounted = service.recordFallback(late);
    const rejected = service.recordFallback(routingEvent(target.id, opened.id, 4_001, {
      id: 'post-resolution-event',
      targetId: undefined,
      knownCostUsd: 9,
    }));

    expect(accounted).toMatchObject({
      state: 'resolved',
      resolvedAt: 4_000,
      updatedAt: 5_000,
      fallbackCount: 1,
      knownCostUsd: 1.25,
    });
    expect(rejected).toBeUndefined();
    expect(notifications.list().filter((record) => record.kind === 'local-ai-paid-dispatch'))
      .toEqual([expect.objectContaining({ urgency: 'critical', delivery: 'desktop' })]);
    expect(repository.listIncidents({ targetId: target.id, limit: 10 })).toEqual([
      expect.objectContaining({ id: opened.id, state: 'resolved', resolvedAt: 4_000 }),
    ]);
  });

  it('resolves with monotonic duration and impact while excluding secret-bearing evidence and routing fields', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    let now = 1_000;
    const { notifications } = notificationHarness(() => now);
    const service = createIncidentService(repository, notifications, {
      now: () => now,
      createId: () => 'incident-recovery',
    });
    const opened = service.handleTransition(transition(target.id, now))!;
    now = 2_000;
    service.recordFallback(routingEvent(target.id, opened.id, now, {
      knownCostUsd: 0.75,
      estimatedCostUsd: 1,
    }));
    now = 4_000;

    const resolved = service.handleTransition(transition(target.id, now, { action: 'resolve' }));
    const recovery = notifications.list().at(-1)!;

    expect(resolved).toMatchObject({
      state: 'resolved',
      resolvedAt: 4_000,
      updatedAt: 4_000,
      fallbackCount: 1,
      knownCostUsd: 0.75,
      estimatedCostUsd: 1,
    });
    expect(recovery).toMatchObject({ kind: 'local-ai-recovered', urgency: 'normal' });
    expect(recovery.body).toMatch(/^Endpoint: Local AI endpoint #[0-9a-f]{12}\./);
    expect(recovery.body).not.toContain(target.id);
    expect(recovery.body).toContain('endpoint');
    expect(recovery.body).toContain('compression');
    expect(recovery.body).toContain('3s');
    expect(recovery.body).toContain('1 paid dispatch');
    expect(recovery.body).toContain('$0.75 known');
    expect(recovery.body).toContain('$1.00 estimated');
    expect(recovery.body).not.toMatch(
      /Bearer|Basic|JWT_HEADER_PLACEHOLDER|USERNAME_PLACEHOLDER|PASSWORD_PLACEHOLDER|TOKEN_PLACEHOLDER|ftp:|private\.example|SENSITIVE_/,
    );
  });

  it('acknowledges once and clamps acknowledgement and later updates against a backward clock', () => {
    const db = openDb();
    const target = new LocalAiTargetRepository(db).create(config());
    const repository = new LocalAiHealthRepository(db);
    let now = 2_000;
    const { notifications } = notificationHarness(() => now);
    const service = createIncidentService(repository, notifications, {
      now: () => now,
      createId: () => 'incident-ack',
    });
    const opened = service.handleTransition(transition(target.id, now))!;
    now = 1_000;

    const acknowledged = service.acknowledge(opened.id);
    const updated = service.handleTransition(transition(target.id, 1_500, { action: 'update' }));

    expect(acknowledged).toMatchObject({
      state: 'acknowledged',
      acknowledgedAt: 2_000,
      updatedAt: 2_000,
    });
    expect(service.acknowledge(opened.id)).toBeUndefined();
    expect(updated).toMatchObject({
      state: 'acknowledged',
      acknowledgedAt: 2_000,
      updatedAt: 2_000,
    });
  });
});
