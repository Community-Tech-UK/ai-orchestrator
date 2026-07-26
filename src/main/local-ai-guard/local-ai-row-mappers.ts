import {
  LocalAiFallbackRequestSchema,
  LocalAiHealthSampleSchema,
  LocalAiIncidentSchema,
  LocalAiRoutingEventSchema,
  LocalAiTargetConfigSchema,
  LocalAiTargetSchema,
} from '../../shared/validation/local-ai-guard.schemas';
import type {
  LocalAiFallbackRequest,
  LocalAiHealthSample,
  LocalAiIncident,
  LocalAiRoutingEvent,
  LocalAiTarget,
} from '../../shared/types/local-ai-guard.types';
import type { SqliteDriver } from '../db/sqlite-driver';

export interface LocalAiRepositoryLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

export type LocalAiNotificationState =
  | 'not-applicable'
  | 'pending'
  | 'claimed'
  | 'failed'
  | 'delivered'
  | 'discarded';

export interface LocalAiTargetRow {
  id: string;
  label: string;
  lifecycle: string;
  location_type: string;
  worker_node_id: string;
  provider: string;
  endpoint_id: string;
  base_url: string;
  config_json: string;
  paused_until: number | null;
  retired_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface LocalAiHealthSampleRow {
  id: string;
  target_id: string;
  layer: string;
  check_type: string;
  ok: number;
  required: number;
  affected_roles_json: string;
  checked_at: number;
  duration_ms: number;
  failure_code: string | null;
  message: string | null;
  evidence_json: string;
  origin: string;
}

export interface LocalAiIncidentRow {
  id: string;
  target_id: string;
  state: string;
  severity: string;
  failure_code: string;
  affected_layers_json: string;
  affected_roles_json: string;
  opened_at: number;
  updated_at: number;
  acknowledged_at: number | null;
  resolved_at: number | null;
  fallback_count: number;
  known_cost_usd: number;
  estimated_cost_usd: number;
  budget_crossed_at: number | null;
  fallback_notification_state: LocalAiNotificationState;
  fallback_notification_claim_token: string | null;
  fallback_notification_claimed_at: number | null;
  fallback_notification_delivered_at: number | null;
  fallback_notification_attempts: number;
  budget_notification_state: LocalAiNotificationState;
  budget_notification_claim_token: string | null;
  budget_notification_claimed_at: number | null;
  budget_notification_delivered_at: number | null;
  budget_notification_attempts: number;
  recovery_notification_state: LocalAiNotificationState;
  recovery_notification_claim_token: string | null;
  recovery_notification_claimed_at: number | null;
  recovery_notification_delivered_at: number | null;
  recovery_notification_attempts: number;
}

export interface LocalAiRoutingEventRow {
  id: string;
  target_id: string | null;
  incident_id: string | null;
  slot: string;
  intended_route: string;
  actual_route: string;
  policy: string;
  disposition: string;
  decision_reason: string;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  known_cost_usd: number | null;
  estimated_cost_usd: number | null;
  created_at: number;
  completed_at: number | null;
  incident_accounted_at: number | null;
  paid_notification_state: LocalAiNotificationState;
  paid_notification_claim_token: string | null;
  paid_notification_claimed_at: number | null;
  paid_notification_delivered_at: number | null;
  paid_notification_attempts: number;
}

export interface LocalAiFallbackRequestRow {
  id: string;
  routing_event_id: string;
  incident_id: string | null;
  slot: string;
  status: string;
  estimated_input_tokens: number;
  estimated_cost_usd: number | null;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

export type LocalAiNotificationReference =
  | {
    entity: 'incident';
    entityId: string;
    transitionKind: 'fallback-possible' | 'budget-critical' | 'recovered';
  }
  | { entity: 'routing-event'; entityId: string; transitionKind: 'paid-dispatch' };

export interface LocalAiNotificationClaim {
  reference: LocalAiNotificationReference;
  incident: LocalAiIncident;
}

export interface LocalAiNotificationColumns {
  table: 'local_ai_incidents' | 'local_ai_routing_events';
  state: string;
  token: string;
  claimedAt: string;
  deliveredAt: string;
  attempts: string;
}

export interface LocalAiRoutingAccountingResult {
  incident: LocalAiIncident;
  event: LocalAiRoutingEvent;
  accounted: boolean;
  paidDispatch: boolean;
  budgetCrossed: boolean;
}

interface LocalAiNotificationDueSource {
  table: 'local_ai_incidents' | 'local_ai_routing_events';
  state: string;
  claimedAt: string;
  index: string;
}

const LOCAL_AI_NOTIFICATION_DUE_SOURCES: LocalAiNotificationDueSource[] = [
  {
    table: 'local_ai_incidents',
    state: 'fallback_notification_state',
    claimedAt: 'fallback_notification_claimed_at',
    index: 'idx_local_ai_incidents_fallback_notification_due',
  },
  {
    table: 'local_ai_incidents',
    state: 'budget_notification_state',
    claimedAt: 'budget_notification_claimed_at',
    index: 'idx_local_ai_incidents_budget_notification_due',
  },
  {
    table: 'local_ai_incidents',
    state: 'recovery_notification_state',
    claimedAt: 'recovery_notification_claimed_at',
    index: 'idx_local_ai_incidents_recovery_notification_due',
  },
  {
    table: 'local_ai_routing_events',
    state: 'paid_notification_state',
    claimedAt: 'paid_notification_claimed_at',
    index: 'idx_local_ai_routing_events_paid_notification_due',
  },
];

export function accountLocalAiRoutingEvent(
  db: SqliteDriver,
  logger: LocalAiRepositoryLogger,
  input: LocalAiRoutingEvent,
  accountedAt: number,
): LocalAiRoutingAccountingResult | undefined {
  const parsed = LocalAiRoutingEventSchema.parse(input);
  if (!parsed.incidentId) return undefined;
  return db.transaction(() => {
    const storedRow = db.prepareCached('SELECT * FROM local_ai_routing_events WHERE id = ?')
      .get<LocalAiRoutingEventRow>(parsed.id);
    const stored = storedRow ? mapLocalAiRoutingEventRow(storedRow, logger) : undefined;
    if (storedRow && (!stored || !sameRoutingEventPayload(stored, parsed))) return undefined;
    const incident = resolveRoutingIncident(db, logger, parsed, storedRow);
    if (!incident || (parsed.targetId && parsed.targetId !== incident.targetId)
      || (parsed.incidentId && parsed.incidentId !== incident.id)
      || (storedRow?.target_id && storedRow.target_id !== incident.targetId)
      || (storedRow?.incident_id && storedRow.incident_id !== incident.id)
      || (incident.state === 'resolved'
        && (incident.resolvedAt === undefined || parsed.createdAt > incident.resolvedAt))) return undefined;
    const event: LocalAiRoutingEvent = { ...parsed, targetId: incident.targetId, incidentId: incident.id };
    if (!storedRow) insertRoutingEventRow(db, event);
    const row = db.prepareCached('SELECT * FROM local_ai_routing_events WHERE id = ?')
      .get<LocalAiRoutingEventRow>(event.id)!;
    const paidDispatch = event.actualRoute === 'frontier' && event.disposition === 'allowed';
    if (row.incident_accounted_at !== null) {
      return {
        incident: requireIncidentRow(db, logger, incident.id),
        event,
        accounted: false,
        paidDispatch,
        budgetCrossed: false,
      };
    }
    const at = Math.max(accountedAt, event.createdAt, event.completedAt ?? 0, incident.updatedAt);
    const budgetReached = event.decisionReason === 'daily-budget'
      || event.decisionReason === 'incident-budget';
    const incidentRow = db.prepareCached('SELECT * FROM local_ai_incidents WHERE id = ?')
      .get<LocalAiIncidentRow>(incident.id)!;
    const budgetCrossed = budgetReached && incidentRow.budget_crossed_at === null;
    const claimed = db.prepareCached(`
      UPDATE local_ai_routing_events SET
        target_id = ?, incident_id = ?, incident_accounted_at = ?,
        paid_notification_state = CASE WHEN ? = 1 THEN 'pending' ELSE paid_notification_state END
      WHERE id = ? AND incident_accounted_at IS NULL
    `).run(incident.targetId, incident.id, at, paidDispatch ? 1 : 0, event.id);
    if (claimed.changes !== 1) {
      return {
        incident: requireIncidentRow(db, logger, incident.id),
        event,
        accounted: false,
        paidDispatch,
        budgetCrossed: false,
      };
    }
    updateAccountedIncident(db, {
      ...incident,
      severity: budgetReached ? 'critical' : incident.severity,
      updatedAt: at,
      affectedRoles: [...new Set([...incident.affectedRoles, event.slot])].sort(),
      fallbackCount: incident.fallbackCount + (paidDispatch ? 1 : 0),
      knownCostUsd: addAccountingCost(incident.knownCostUsd, event.knownCostUsd),
      estimatedCostUsd: addAccountingCost(incident.estimatedCostUsd, event.estimatedCostUsd),
    });
    if (budgetCrossed) {
      db.prepareCached(`
        UPDATE local_ai_incidents SET budget_crossed_at = ?, budget_notification_state = 'pending'
        WHERE id = ? AND budget_crossed_at IS NULL
      `).run(at, incident.id);
    }
    return {
      incident: requireIncidentRow(db, logger, incident.id),
      event,
      accounted: true,
      paidDispatch,
      budgetCrossed,
    };
  })();
}

export function listRetryableLocalAiNotifications(
  db: SqliteDriver,
  now: number,
  leaseMs: number,
  limit: number,
): LocalAiNotificationReference[] {
  const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
  const cutoff = Math.max(0, now - Math.max(0, leaseMs));
  const references: LocalAiNotificationReference[] = [];
  const incidents = db.prepareCached(`
    SELECT * FROM local_ai_incidents
    WHERE fallback_notification_state = 'pending'
      OR (fallback_notification_state = 'failed'
        AND (fallback_notification_claimed_at IS NULL OR fallback_notification_claimed_at <= ?))
      OR (fallback_notification_state = 'claimed'
        AND (fallback_notification_claimed_at IS NULL OR fallback_notification_claimed_at <= ?))
      OR budget_notification_state = 'pending'
      OR (budget_notification_state = 'failed'
        AND (budget_notification_claimed_at IS NULL OR budget_notification_claimed_at <= ?))
      OR (budget_notification_state = 'claimed'
        AND (budget_notification_claimed_at IS NULL OR budget_notification_claimed_at <= ?))
      OR recovery_notification_state = 'pending'
      OR (recovery_notification_state = 'failed'
        AND (recovery_notification_claimed_at IS NULL OR recovery_notification_claimed_at <= ?))
      OR (recovery_notification_state = 'claimed'
        AND (recovery_notification_claimed_at IS NULL OR recovery_notification_claimed_at <= ?))
    ORDER BY updated_at ASC, id ASC LIMIT ?
  `).all<LocalAiIncidentRow>(now, cutoff, now, cutoff, now, cutoff, safeLimit);
  for (const row of incidents) {
    if (retryableNotificationState(
      row.fallback_notification_state, row.fallback_notification_claimed_at, now, cutoff,
    )) {
      references.push({ entity: 'incident', entityId: row.id, transitionKind: 'fallback-possible' });
    }
    if (retryableNotificationState(
      row.budget_notification_state, row.budget_notification_claimed_at, now, cutoff,
    )) {
      references.push({ entity: 'incident', entityId: row.id, transitionKind: 'budget-critical' });
    }
    if (retryableNotificationState(
      row.recovery_notification_state, row.recovery_notification_claimed_at, now, cutoff,
    )) {
      references.push({ entity: 'incident', entityId: row.id, transitionKind: 'recovered' });
    }
    if (references.length >= safeLimit) return references.slice(0, safeLimit);
  }
  const events = db.prepareCached(`
    SELECT * FROM local_ai_routing_events
    WHERE paid_notification_state = 'pending'
      OR (paid_notification_state = 'failed'
        AND (paid_notification_claimed_at IS NULL OR paid_notification_claimed_at <= ?))
      OR (paid_notification_state = 'claimed'
        AND (paid_notification_claimed_at IS NULL OR paid_notification_claimed_at <= ?))
    ORDER BY created_at ASC, id ASC LIMIT ?
  `).all<LocalAiRoutingEventRow>(now, cutoff, safeLimit - references.length);
  for (const row of events) {
    if (retryableNotificationState(
      row.paid_notification_state, row.paid_notification_claimed_at, now, cutoff,
    )) {
      references.push({ entity: 'routing-event', entityId: row.id, transitionKind: 'paid-dispatch' });
    }
  }
  return references;
}

export function nextLocalAiNotificationDueAt(
  db: SqliteDriver,
  now: number,
  leaseMs: number,
): number | undefined {
  const safeNow = safeNotificationTimestamp(now, 0);
  const safeLeaseMs = safeNotificationTimestamp(leaseMs, 0);
  let earliest: number | undefined;
  for (const source of LOCAL_AI_NOTIFICATION_DUE_SOURCES) {
    const pending = db.prepareCached(`
      SELECT 1 AS found FROM ${source.table} INDEXED BY ${source.index}
      WHERE ${source.state} = 'pending' LIMIT 1
    `).get<{ found: number }>();
    if (pending) return safeNow;
    const failed = earliestNotificationStateTimestamp(db, source, 'failed');
    const claimed = earliestNotificationStateTimestamp(db, source, 'claimed');
    const failedDueAt = failed === undefined ? undefined : safeNotificationTimestamp(failed, safeNow);
    const claimedDueAt = claimed === undefined
      ? undefined
      : claimed === null
        ? safeNow
        : addNotificationDeadline(safeNotificationTimestamp(claimed, safeNow), safeLeaseMs);
    for (const dueAt of [failedDueAt, claimedDueAt]) {
      if (dueAt !== undefined && (earliest === undefined || dueAt < earliest)) earliest = dueAt;
    }
  }
  return earliest;
}

export function localAiNotificationColumns(
  reference: LocalAiNotificationReference,
): LocalAiNotificationColumns {
  const prefix = reference.transitionKind === 'fallback-possible'
    ? 'fallback_notification'
    : reference.transitionKind === 'budget-critical'
      ? 'budget_notification'
      : reference.transitionKind === 'recovered'
        ? 'recovery_notification'
        : 'paid_notification';
  return {
    table: reference.entity === 'incident' ? 'local_ai_incidents' : 'local_ai_routing_events',
    state: `${prefix}_state`,
    token: `${prefix}_claim_token`,
    claimedAt: `${prefix}_claimed_at`,
    deliveredAt: `${prefix}_delivered_at`,
    attempts: `${prefix}_attempts`,
  };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function warnMalformed(logger: LocalAiRepositoryLogger, rowType: string, id: string, error: unknown): void {
  logger.warn(`Omitting malformed persisted Local AI Guard ${rowType}`, {
    [`${rowType}Id`]: id,
    error: error instanceof Error ? error.message : String(error),
  });
}

export function mapLocalAiTargetRow(row: LocalAiTargetRow, logger: LocalAiRepositoryLogger): LocalAiTarget | undefined {
  try {
    const config = LocalAiTargetConfigSchema.parse(parseJson(row.config_json));
    const locationMatches = config.location.type === row.location_type
      && (config.location.type === 'coordinator' ? row.worker_node_id === '' : config.location.nodeId === row.worker_node_id);
    if (!locationMatches || config.provider !== row.provider || config.endpointId !== row.endpoint_id || config.baseUrl !== row.base_url) {
      throw new Error('Target identity columns do not match persisted configuration');
    }
    const parsed = LocalAiTargetSchema.safeParse({
      ...config,
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.paused_until === null ? {} : { pausedUntil: row.paused_until }),
      ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
    });
    if (!parsed.success || parsed.data.lifecycle !== row.lifecycle) {
      throw new Error(parsed.success ? 'Target lifecycle column does not match persisted configuration' : parsed.error.message);
    }
    return parsed.data;
  } catch (error) {
    warnMalformed(logger, 'target', row.id, error);
    return undefined;
  }
}

export function mapLocalAiHealthSampleRow(row: LocalAiHealthSampleRow, logger: LocalAiRepositoryLogger): LocalAiHealthSample | undefined {
  try {
    const parsed = LocalAiHealthSampleSchema.safeParse({
      id: row.id,
      targetId: row.target_id,
      layer: row.layer,
      checkType: row.check_type,
      ok: sqliteBoolean(row.ok),
      required: sqliteBoolean(row.required),
      affectedRoles: parseJson(row.affected_roles_json),
      checkedAt: row.checked_at,
      durationMs: row.duration_ms,
      ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
      ...(row.message === null ? {} : { message: row.message }),
      evidence: parseJson(row.evidence_json),
      origin: row.origin,
    });
    if (!parsed.success) throw new Error(parsed.error.message);
    return parsed.data;
  } catch (error) {
    warnMalformed(logger, 'healthSample', row.id, error);
    return undefined;
  }
}

export function mapLocalAiIncidentRow(row: LocalAiIncidentRow, logger: LocalAiRepositoryLogger): LocalAiIncident | undefined {
  try {
    const parsed = LocalAiIncidentSchema.safeParse({
      id: row.id,
      targetId: row.target_id,
      state: row.state,
      severity: row.severity,
      failureCode: row.failure_code,
      affectedLayers: parseJson(row.affected_layers_json),
      affectedRoles: parseJson(row.affected_roles_json),
      openedAt: row.opened_at,
      updatedAt: row.updated_at,
      ...(row.acknowledged_at === null ? {} : { acknowledgedAt: row.acknowledged_at }),
      ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
      fallbackCount: row.fallback_count,
      knownCostUsd: row.known_cost_usd,
      estimatedCostUsd: row.estimated_cost_usd,
    });
    if (!parsed.success) throw new Error(parsed.error.message);
    return parsed.data;
  } catch (error) {
    warnMalformed(logger, 'incident', row.id, error);
    return undefined;
  }
}

export function mapLocalAiRoutingEventRow(row: LocalAiRoutingEventRow, logger: LocalAiRepositoryLogger): LocalAiRoutingEvent | undefined {
  try {
    const parsed = LocalAiRoutingEventSchema.safeParse({
      id: row.id,
      ...(row.target_id === null ? {} : { targetId: row.target_id }),
      ...(row.incident_id === null ? {} : { incidentId: row.incident_id }),
      slot: row.slot,
      intendedRoute: row.intended_route,
      actualRoute: row.actual_route,
      policy: row.policy,
      disposition: row.disposition,
      decisionReason: row.decision_reason,
      ...(row.provider === null ? {} : { provider: row.provider }),
      ...(row.model === null ? {} : { model: row.model }),
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      ...(row.known_cost_usd === null ? {} : { knownCostUsd: row.known_cost_usd }),
      ...(row.estimated_cost_usd === null ? {} : { estimatedCostUsd: row.estimated_cost_usd }),
      createdAt: row.created_at,
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    });
    if (!parsed.success) throw new Error(parsed.error.message);
    return parsed.data;
  } catch (error) {
    warnMalformed(logger, 'routingEvent', row.id, error);
    return undefined;
  }
}

export function mapLocalAiFallbackRequestRow(
  row: LocalAiFallbackRequestRow,
  logger: LocalAiRepositoryLogger,
): LocalAiFallbackRequest | undefined {
  try {
    const parsed = LocalAiFallbackRequestSchema.safeParse({
      id: row.id,
      routingEventId: row.routing_event_id,
      ...(row.incident_id === null ? {} : { incidentId: row.incident_id }),
      slot: row.slot,
      status: row.status,
      estimatedInputTokens: row.estimated_input_tokens,
      ...(row.estimated_cost_usd === null ? {} : { estimatedCostUsd: row.estimated_cost_usd }),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
      ...(row.resolution === null ? {} : { resolution: row.resolution }),
    });
    if (!parsed.success) throw new Error(parsed.error.message);
    return parsed.data;
  } catch (error) {
    warnMalformed(logger, 'fallbackRequest', row.id, error);
    return undefined;
  }
}

function resolveRoutingIncident(
  db: SqliteDriver,
  logger: LocalAiRepositoryLogger,
  event: LocalAiRoutingEvent,
  stored: LocalAiRoutingEventRow | undefined,
): LocalAiIncident | undefined {
  const incidentId = event.incidentId;
  if (!incidentId || (stored?.incident_id && stored.incident_id !== incidentId)) return undefined;
  const row = db.prepareCached('SELECT * FROM local_ai_incidents WHERE id = ?')
    .get<LocalAiIncidentRow>(incidentId);
  return row ? mapLocalAiIncidentRow(row, logger) : undefined;
}

function insertRoutingEventRow(db: SqliteDriver, event: LocalAiRoutingEvent): void {
  db.prepareCached(`
    INSERT INTO local_ai_routing_events (
      id, target_id, incident_id, slot, intended_route, actual_route, policy, disposition, decision_reason, provider, model,
      input_tokens, output_tokens, known_cost_usd, estimated_cost_usd, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.targetId ?? null,
    event.incidentId ?? null,
    event.slot,
    event.intendedRoute,
    event.actualRoute,
    event.policy,
    event.disposition,
    event.decisionReason,
    event.provider ?? null,
    event.model ?? null,
    event.inputTokens,
    event.outputTokens,
    event.knownCostUsd ?? null,
    event.estimatedCostUsd ?? null,
    event.createdAt,
    event.completedAt ?? null,
  );
}

function updateAccountedIncident(db: SqliteDriver, incident: LocalAiIncident): void {
  db.prepareCached(`
    UPDATE local_ai_incidents SET
      state = ?, severity = ?, failure_code = ?, affected_layers_json = ?, affected_roles_json = ?, updated_at = ?,
      acknowledged_at = ?, resolved_at = ?, fallback_count = ?, known_cost_usd = ?, estimated_cost_usd = ?
    WHERE id = ?
  `).run(
    incident.state,
    incident.severity,
    incident.failureCode,
    JSON.stringify(incident.affectedLayers),
    JSON.stringify(incident.affectedRoles),
    incident.updatedAt,
    incident.acknowledgedAt ?? null,
    incident.resolvedAt ?? null,
    incident.fallbackCount,
    incident.knownCostUsd,
    incident.estimatedCostUsd,
    incident.id,
  );
}

function requireIncidentRow(
  db: SqliteDriver,
  logger: LocalAiRepositoryLogger,
  incidentId: string,
): LocalAiIncident {
  const row = db.prepareCached('SELECT * FROM local_ai_incidents WHERE id = ?')
    .get<LocalAiIncidentRow>(incidentId);
  const incident = row ? mapLocalAiIncidentRow(row, logger) : undefined;
  if (!incident) throw new Error(`Local AI incident not found: ${incidentId}`);
  return incident;
}

function sameRoutingEventPayload(left: LocalAiRoutingEvent, right: LocalAiRoutingEvent): boolean {
  return JSON.stringify([
    left.slot, left.intendedRoute, left.actualRoute, left.policy, left.disposition, left.provider,
    left.decisionReason, left.model, left.inputTokens, left.outputTokens, left.knownCostUsd, left.estimatedCostUsd,
    left.createdAt, left.completedAt,
  ]) === JSON.stringify([
    right.slot, right.intendedRoute, right.actualRoute, right.policy, right.disposition, right.provider,
    right.decisionReason, right.model, right.inputTokens, right.outputTokens, right.knownCostUsd, right.estimatedCostUsd,
    right.createdAt, right.completedAt,
  ]);
}

function retryableNotificationState(
  state: LocalAiNotificationState,
  claimedAt: number | null,
  now: number,
  cutoff: number,
): boolean {
  return state === 'pending'
    || (state === 'failed' && (claimedAt ?? 0) <= now)
    || (state === 'claimed' && (claimedAt ?? 0) <= cutoff);
}

function earliestNotificationStateTimestamp(
  db: SqliteDriver,
  source: LocalAiNotificationDueSource,
  state: 'claimed' | 'failed',
): number | null | undefined {
  return db.prepareCached(`
    SELECT ${source.claimedAt} AS claimed_at
    FROM ${source.table} INDEXED BY ${source.index}
    WHERE ${source.state} = ?
    ORDER BY ${source.claimedAt} ASC, id ASC LIMIT 1
  `).get<{ claimed_at: number | null }>(state)?.claimed_at;
}

function safeNotificationTimestamp(value: number | null, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function addNotificationDeadline(timestamp: number, delayMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, timestamp + delayMs);
}

function addAccountingCost(current: number, incoming: number | undefined): number {
  const total = current + (incoming ?? 0);
  if (!Number.isFinite(total) || total < 0) throw new RangeError('Local AI incident cost is out of range');
  return total;
}

function sqliteBoolean(value: number): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new Error(`Expected SQLite boolean 0 or 1, received ${value}`);
}
