import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import {
  MIGRATIONS,
  computeMigrationChecksum,
  createMigrationsTable,
  runMigrations,
} from '../persistence/rlm/rlm-schema';

const dbs: SqliteDriver[] = [];
const ORIGINAL_LOCAL_AI_GUARD_CHECKSUM = 'a05ef090ef00f86b';

function openDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  dbs.push(db);
  return db;
}

function tableNames(db: SqliteDriver): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>()
    .map(({ name }) => name);
}

function insertActiveTarget(db: SqliteDriver, id: string, baseUrl = 'http://127.0.0.1:11434'): void {
  db.prepare(`
    INSERT INTO local_ai_targets (
      id, label, lifecycle, location_type, worker_node_id, provider,
      endpoint_id, base_url, config_json, created_at, updated_at
    ) VALUES (?, ?, 'enrolled', 'worker', 'node-1', 'ollama', 'ollama', ?, '{}', 1, 1)
  `).run(id, `Target ${id}`, baseUrl);
}

function indexNames(db: SqliteDriver): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all<{ name: string }>()
    .map(({ name }) => name);
}

function columnNames(db: SqliteDriver, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
    .map(({ name }) => name);
}

function insertHealthSample(db: SqliteDriver, id: string, targetId: string): void {
  db.prepare(`
    INSERT INTO local_ai_health_samples (
      id, target_id, layer, check_type, ok, required, affected_roles_json,
      checked_at, duration_ms, evidence_json, origin
    ) VALUES (?, ?, 'endpoint', 'lightweight', 1, 1, '[]', 1, 1, '{}', 'manual')
  `).run(id, targetId);
}

function insertIncident(db: SqliteDriver, id: string, targetId: string): void {
  db.prepare(`
    INSERT INTO local_ai_incidents (
      id, target_id, state, severity, failure_code, affected_layers_json,
      affected_roles_json, opened_at, updated_at
    ) VALUES (?, ?, 'open', 'critical', 'endpoint-timeout', '[]', '[]', 1, 1)
  `).run(id, targetId);
}

function insertRoutingEvent(db: SqliteDriver, id: string, targetId: string, incidentId: string): void {
  db.prepare(`
    INSERT INTO local_ai_routing_events (
      id, target_id, incident_id, slot, intended_route, actual_route, policy,
      disposition, input_tokens, output_tokens, created_at
    ) VALUES (?, ?, ?, 'compression', 'local', 'frontier', 'notify-and-allow', 'allowed', 1, 1, 1)
  `).run(id, targetId, incidentId);
}

function insertFallbackRequest(db: SqliteDriver, id: string, routingEventId: string, incidentId: string): void {
  db.prepare(`
    INSERT INTO local_ai_fallback_requests (
      id, routing_event_id, incident_id, slot, status, estimated_input_tokens, created_at, expires_at
    ) VALUES (?, ?, ?, 'compression', 'pending', 1, 1, 2)
  `).run(id, routingEventId, incidentId);
}

describe('Local AI Guard migrations 054-055', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('creates indexed Local AI Guard tables and completely rolls them back', () => {
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    const recoveryMigration = RLM_MIGRATIONS_051_055.find(
      (item) => item.name === '055_local_ai_recovery_attempts',
    );
    expect(migration).toBeDefined();
    expect(recoveryMigration).toBeDefined();

    const db = openDb();
    db.exec(migration!.up);
    db.exec(recoveryMigration!.up);
    expect(tableNames(db)).toEqual(expect.arrayContaining([
      'local_ai_targets',
      'local_ai_health_samples',
      'local_ai_recovery_attempts',
      'local_ai_incidents',
      'local_ai_routing_events',
      'local_ai_fallback_requests',
      'local_ai_daily_aggregates',
    ]));
    expect(indexNames(db)).toEqual(expect.arrayContaining([
      'idx_local_ai_targets_active_endpoint_identity',
      'idx_local_ai_health_samples_target_time',
      'idx_local_ai_health_samples_time',
      'idx_local_ai_recovery_attempts_target_time',
      'idx_local_ai_incidents_target_time',
      'idx_local_ai_incidents_state',
      'idx_local_ai_incidents_notification_outbox',
      'idx_local_ai_incidents_fallback_notification_due',
      'idx_local_ai_incidents_budget_notification_due',
      'idx_local_ai_incidents_recovery_notification_due',
      'idx_local_ai_routing_events_target_time',
      'idx_local_ai_routing_events_incident_time',
      'idx_local_ai_routing_events_time',
      'idx_local_ai_routing_events_retention_stream',
      'idx_local_ai_routing_events_notification_outbox',
      'idx_local_ai_routing_events_paid_notification_due',
      'idx_local_ai_fallback_requests_pending',
      'idx_local_ai_fallback_requests_pending_order',
      'idx_local_ai_daily_aggregates_target_day',
      'idx_local_ai_daily_aggregates_day',
    ]));
    expect(columnNames(db, 'local_ai_incidents')).toEqual(expect.arrayContaining([
      'budget_crossed_at',
      'fallback_notification_state',
      'fallback_notification_claim_token',
      'fallback_notification_claimed_at',
      'fallback_notification_delivered_at',
      'fallback_notification_attempts',
      'budget_notification_state',
      'budget_notification_claim_token',
      'budget_notification_claimed_at',
      'budget_notification_delivered_at',
      'budget_notification_attempts',
      'recovery_notification_state',
      'recovery_notification_claim_token',
      'recovery_notification_claimed_at',
      'recovery_notification_delivered_at',
      'recovery_notification_attempts',
    ]));
    expect(columnNames(db, 'local_ai_routing_events')).toEqual(expect.arrayContaining([
      'decision_reason',
      'incident_accounted_at',
      'paid_notification_state',
      'paid_notification_claim_token',
      'paid_notification_claimed_at',
      'paid_notification_delivered_at',
      'paid_notification_attempts',
    ]));
    expect(columnNames(db, 'local_ai_recovery_attempts')).toEqual([
      'id',
      'target_id',
      'action',
      'attempt_number',
      'claimed_at',
      'completed_at',
      'outcome',
      'supported',
      'attempted',
      'recovered',
    ]);
    insertActiveTarget(db, 'default-target');
    expect(() => db.prepare(`
      INSERT INTO local_ai_recovery_attempts (
        id, target_id, action, attempt_number, claimed_at, completed_at,
        outcome, supported, attempted, recovered
      ) VALUES (
        'invalid-recovery-audit', 'default-target', 'restart-ollama', 1, 1, 2,
        'recovered', 1, 1, 0
      )
    `).run()).toThrow();
    expect(() => db.prepare(`
      INSERT INTO local_ai_recovery_attempts (
        id, target_id, action, attempt_number, claimed_at, completed_at,
        outcome, supported, attempted, recovered
      ) VALUES (
        'invalid-recovery-boolean', 'default-target', 'restart-ollama', 1, 1, 2,
        'not-recovered', 2, 1, 0
      )
    `).run()).toThrow();
    insertIncident(db, 'default-incident', 'default-target');
    expect(db.prepare(`
      SELECT fallback_notification_state, budget_notification_state, recovery_notification_state
      FROM local_ai_incidents WHERE id = ?
    `).get<{
      fallback_notification_state: string;
      budget_notification_state: string;
      recovery_notification_state: string;
    }>('default-incident')).toEqual({
      fallback_notification_state: 'pending',
      budget_notification_state: 'not-applicable',
      recovery_notification_state: 'not-applicable',
    });
    expect(() => db.prepare(`
      UPDATE local_ai_incidents SET
        fallback_notification_state = 'discarded',
        budget_notification_state = 'discarded',
        recovery_notification_state = 'discarded'
      WHERE id = ?
    `).run('default-incident')).not.toThrow();
    expect(() => db.prepare(`
      UPDATE local_ai_incidents SET fallback_notification_state = 'invalid' WHERE id = ?
    `).run('default-incident')).toThrow();
    insertRoutingEvent(db, 'default-routing-reason', 'default-target', 'default-incident');
    expect(db.prepare(`
      SELECT decision_reason, paid_notification_state FROM local_ai_routing_events WHERE id = ?
    `).get<{
      decision_reason: string;
      paid_notification_state: string;
    }>('default-routing-reason')).toEqual({
      decision_reason: 'health',
      paid_notification_state: 'not-applicable',
    });
    expect(() => db.prepare(`
      UPDATE local_ai_routing_events SET paid_notification_state = 'discarded' WHERE id = ?
    `).run('default-routing-reason')).not.toThrow();
    expect(() => db.prepare(`
      UPDATE local_ai_routing_events SET paid_notification_state = 'invalid' WHERE id = ?
    `).run('default-routing-reason')).toThrow();
    expect(() => db.prepare(`
      UPDATE local_ai_routing_events SET decision_reason = 'block-paid-fallback' WHERE id = ?
    `).run('default-routing-reason')).toThrow();
    expect(db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_local_ai_incidents_notification_outbox'
    `).get<{ sql: string }>()?.sql).toContain('recovery_notification_state');

    db.exec(recoveryMigration!.down);
    db.exec(migration!.down);
    expect(tableNames(db).filter((name) => name.startsWith('local_ai_'))).toEqual([]);
    expect(indexNames(db).filter((name) => name.startsWith('idx_local_ai_'))).toEqual([]);
  });

  it('upgrades an applied original 054 through the real checksum-enforcing migration runner', () => {
    const migration054 = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    const migration055 = RLM_MIGRATIONS_051_055.find(
      (item) => item.name === '055_local_ai_recovery_attempts',
    );
    expect(migration054).toBeDefined();
    expect(migration055).toBeDefined();
    if (!migration054 || !migration055) throw new Error('Missing Local AI Guard recovery migrations');
    expect(computeMigrationChecksum(migration054)).toBe(ORIGINAL_LOCAL_AI_GUARD_CHECKSUM);

    const db = openDb();
    createMigrationsTable(db);
    db.exec(migration054.up);
    const insertApplied = db.prepare(`
      INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, 1, ?)
    `);
    for (const migration of MIGRATIONS.filter((item) => item.name !== migration055.name)) {
      insertApplied.run(
        migration.name,
        migration.name === migration054.name
          ? ORIGINAL_LOCAL_AI_GUARD_CHECKSUM
          : computeMigrationChecksum(migration),
      );
    }
    expect(tableNames(db)).not.toContain('local_ai_recovery_attempts');

    expect(() => runMigrations(db)).not.toThrow();

    expect(db.prepare('SELECT name FROM _migrations WHERE name = ?')
      .get<{ name: string }>(migration055.name)).toEqual({ name: migration055.name });
    expect(tableNames(db)).toContain('local_ai_recovery_attempts');
  });

  it('accepts only coherent completed recovery audit tuples', () => {
    const migration054 = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    const migration055 = RLM_MIGRATIONS_051_055.find(
      (item) => item.name === '055_local_ai_recovery_attempts',
    );
    if (!migration054 || !migration055) throw new Error('Missing Local AI Guard recovery migrations');
    const db = openDb();
    db.exec(migration054.up);
    db.exec(migration055.up);
    insertActiveTarget(db, 'audit-target');
    const insert = db.prepare(`
      INSERT INTO local_ai_recovery_attempts (
        id, target_id, action, attempt_number, claimed_at, completed_at,
        outcome, supported, attempted, recovered
      ) VALUES (?, 'audit-target', 'restart-ollama', ?, 10, ?, ?, ?, ?, ?)
    `);
    const valid = [
      ['unsupported', 0, 0, 0],
      ['failed', 1, 0, 0],
      ['failed', 1, 1, 0],
      ['not-recovered', 1, 1, 0],
      ['recovered', 1, 1, 1],
    ] as const;
    valid.forEach(([outcome, supported, attempted, recovered], index) => {
      expect(() => insert.run(
        `valid-${outcome}-${index}`,
        index + 1,
        11,
        outcome,
        supported,
        attempted,
        recovered,
      )).not.toThrow();
    });
    const invalid = [
      ['completed-null', null, 'not-recovered', 1, 1, 0],
      ['unsupported-supported', 11, 'unsupported', 1, 0, 0],
      ['unsupported-attempted', 11, 'unsupported', 0, 1, 0],
      ['failed-unsupported', 11, 'failed', 0, 1, 0],
      ['not-recovered-not-attempted', 11, 'not-recovered', 1, 0, 0],
      ['not-recovered-unsupported', 11, 'not-recovered', 0, 1, 0],
      ['recovered-false', 11, 'recovered', 1, 1, 0],
      ['non-recovered-true', 11, 'failed', 1, 1, 1],
    ] as const;
    invalid.forEach(([id, completedAt, outcome, supported, attempted, recovered], index) => {
      expect(() => insert.run(
        id,
        valid.length + index + 1,
        completedAt,
        outcome,
        supported,
        attempted,
        recovered,
      )).toThrow();
    });
  });

  it.each([
    ['supported', null, 1, 1],
    ['attempted', 1, null, 1],
    ['recovered', 1, 1, null],
  ] as const)('rejects a completed recovery audit with NULL %s', (_field, supported, attempted, recovered) => {
    const migration054 = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    const migration055 = RLM_MIGRATIONS_051_055.find(
      (item) => item.name === '055_local_ai_recovery_attempts',
    );
    if (!migration054 || !migration055) throw new Error('Missing Local AI Guard recovery migrations');
    const db = openDb();
    db.exec(migration054.up);
    db.exec(migration055.up);
    insertActiveTarget(db, 'null-audit-target');

    expect(() => db.prepare(`
      INSERT INTO local_ai_recovery_attempts (
        id, target_id, action, attempt_number, claimed_at, completed_at,
        outcome, supported, attempted, recovered
      ) VALUES ('null-audit', 'null-audit-target', 'restart-ollama', 1, 10, 11, 'recovered', ?, ?, ?)
    `).run(supported, attempted, recovered)).toThrow();
  });

  it('uses the pending-request order index without a temporary sort', () => {
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    if (!migration) throw new Error('Missing migration 054_local_ai_guard');
    const db = openDb();
    db.exec(migration.up);
    const recoveryMigration = RLM_MIGRATIONS_051_055.find(
      (item) => item.name === '055_local_ai_recovery_attempts',
    );
    if (!recoveryMigration) throw new Error('Missing migration 055_local_ai_recovery_attempts');
    db.exec(recoveryMigration.up);

    const details = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM local_ai_fallback_requests INDEXED BY idx_local_ai_fallback_requests_pending_order
      WHERE status = 'pending' AND expires_at > ? ORDER BY created_at ASC, id ASC LIMIT ?
    `).all<{ detail: string }>(1, 10).map((row) => row.detail);

    expect(details.join('\n')).toContain('idx_local_ai_fallback_requests_pending_order');
    expect(details.join('\n')).not.toContain('USE TEMP B-TREE');
  });

  it('seeks the earliest durable notification deadline through state/time indexes', () => {
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    if (!migration) throw new Error('Missing migration 054_local_ai_guard');
    const db = openDb();
    db.exec(migration.up);

    const incidentPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT fallback_notification_claimed_at AS claimed_at
      FROM local_ai_incidents INDEXED BY idx_local_ai_incidents_fallback_notification_due
      WHERE fallback_notification_state = 'failed'
      ORDER BY fallback_notification_claimed_at ASC, id ASC LIMIT 1
    `).all<{ detail: string }>().map((row) => row.detail).join('\n');
    const eventPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT paid_notification_claimed_at AS claimed_at
      FROM local_ai_routing_events INDEXED BY idx_local_ai_routing_events_paid_notification_due
      WHERE paid_notification_state = 'claimed'
      ORDER BY paid_notification_claimed_at ASC, id ASC LIMIT 1
    `).all<{ detail: string }>().map((row) => row.detail).join('\n');

    expect(incidentPlan).toContain('idx_local_ai_incidents_fallback_notification_due');
    expect(incidentPlan).not.toContain('SCAN');
    expect(incidentPlan).not.toContain('USE TEMP B-TREE');
    expect(eventPlan).toContain('idx_local_ai_routing_events_paid_notification_due');
    expect(eventPlan).not.toContain('SCAN');
    expect(eventPlan).not.toContain('USE TEMP B-TREE');
  });

  it('seeks retained routing-event continuation pages without scanning or a temporary sort', () => {
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    if (!migration) throw new Error('Missing migration 054_local_ai_guard');
    const db = openDb();
    db.exec(migration.up);

    const details = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM local_ai_routing_events INDEXED BY idx_local_ai_routing_events_retention_stream
      WHERE created_at < ?
        AND (retention_target_key, created_at, id) > (?, ?, ?)
      ORDER BY retention_target_key ASC, created_at ASC, id ASC LIMIT ?
    `).all<{ detail: string }>(1_000, 'target-1', 500, 'event-1', 1_000)
      .map((row) => row.detail);

    const plan = details.join('\n');
    expect(plan).toContain('SEARCH local_ai_routing_events USING INDEX idx_local_ai_routing_events_retention_stream');
    expect(plan).not.toContain('SCAN');
    expect(plan).not.toContain('USE TEMP B-TREE');
  });

  it('prevents duplicate active endpoint identities while retaining retired history', () => {
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    if (!migration) throw new Error('Missing migration 054_local_ai_guard');

    const db = openDb();
    db.exec(migration.up);
    insertActiveTarget(db, 'target-1');

    expect(() => insertActiveTarget(db, 'target-2')).toThrow();

    db.prepare("UPDATE local_ai_targets SET lifecycle = 'retired' WHERE id = 'target-1'").run();
    expect(() => insertActiveTarget(db, 'target-2')).not.toThrow();
  });

  it('treats trailing-slash endpoint URLs as the same active identity', () => {
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    if (!migration) throw new Error('Missing migration 054_local_ai_guard');

    const db = openDb();
    db.exec(migration.up);
    insertActiveTarget(db, 'target-1', 'http://127.0.0.1:11434');

    expect(() => insertActiveTarget(db, 'target-2', 'http://127.0.0.1:11434/')).toThrow();
  });

  it.each([
    'http://@127.0.0.1:11434',
    'http://127.0.0.1:11434/?',
    'http://127.0.0.1:11434/#',
  ])('rejects a syntactic credential, query, or fragment delimiter in a stored endpoint URL: %s', (baseUrl) => {
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    if (!migration) throw new Error('Missing migration 054_local_ai_guard');

    const db = openDb();
    db.exec(migration.up);

    expect(() => insertActiveTarget(db, 'target-1', baseUrl)).toThrow();
  });

  it('applies cascade and nulling foreign-key actions to Local AI Guard history', () => {
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    const recoveryMigration = RLM_MIGRATIONS_051_055.find(
      (item) => item.name === '055_local_ai_recovery_attempts',
    );
    if (!migration || !recoveryMigration) {
      throw new Error('Missing Local AI Guard recovery migrations');
    }

    const db = openDb();
    db.exec(migration.up);
    db.exec(recoveryMigration.up);
    insertActiveTarget(db, 'target-1');
    insertHealthSample(db, 'sample-1', 'target-1');
    db.prepare(`
      INSERT INTO local_ai_recovery_attempts (
        id, target_id, action, attempt_number, claimed_at, outcome
      ) VALUES ('attempt-1', 'target-1', 'restart-ollama', 1, 1, 'claimed')
    `).run();
    insertIncident(db, 'incident-1', 'target-1');
    insertRoutingEvent(db, 'event-1', 'target-1', 'incident-1');
    insertFallbackRequest(db, 'request-1', 'event-1', 'incident-1');
    db.prepare(`
      INSERT INTO local_ai_daily_aggregates (id, target_id, day, aggregate_json, created_at, updated_at)
      VALUES ('aggregate-1', 'target-1', '2026-07-26', '{}', 1, 1)
    `).run();

    db.prepare("DELETE FROM local_ai_targets WHERE id = 'target-1'").run();

    expect(db.prepare('SELECT count(*) AS count FROM local_ai_health_samples').get<{ count: number }>()?.count).toBe(0);
    expect(db.prepare('SELECT count(*) AS count FROM local_ai_recovery_attempts').get<{ count: number }>()?.count).toBe(0);
    expect(db.prepare('SELECT count(*) AS count FROM local_ai_incidents').get<{ count: number }>()?.count).toBe(0);
    expect(db.prepare('SELECT target_id, incident_id FROM local_ai_routing_events WHERE id = ?')
      .get<{ target_id: string | null; incident_id: string | null }>('event-1'))
      .toEqual({ target_id: null, incident_id: null });
    expect(db.prepare('SELECT target_id FROM local_ai_daily_aggregates WHERE id = ?')
      .get<{ target_id: string | null }>('aggregate-1'))
      .toEqual({ target_id: null });
    expect(db.prepare('SELECT incident_id FROM local_ai_fallback_requests WHERE id = ?')
      .get<{ incident_id: string | null }>('request-1'))
      .toEqual({ incident_id: null });

    db.prepare("DELETE FROM local_ai_routing_events WHERE id = 'event-1'").run();
    expect(db.prepare('SELECT count(*) AS count FROM local_ai_fallback_requests').get<{ count: number }>()?.count).toBe(0);
  });
});
