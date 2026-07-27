import type {
  LocalAiFallbackRequest,
  LocalAiFallbackResolution,
  LocalAiRoutingEvent,
} from '../../shared/types/local-ai-guard.types';
import {
  LocalAiFallbackRequestSchema,
  LocalAiFallbackResolutionSchema,
  LocalAiRoutingEventSchema,
} from '../../shared/validation/local-ai-guard.schemas';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  getLocalAiFallbackSpend,
  type LocalAiFallbackSpend,
} from './local-ai-fallback-spend';
import {
  accountLocalAiRoutingEvent,
  mapLocalAiFallbackRequestRow,
  mapLocalAiRoutingEventRow,
  type LocalAiFallbackRequestRow,
  type LocalAiRepositoryLogger,
  type LocalAiRoutingEventRow,
} from './local-ai-row-mappers';

export interface LocalAiFallbackReservationLimits {
  at: number;
  dayStart: number;
  globalDailyBudgetUsd?: number | null;
  targetDailyBudgetUsd?: number | null;
  incidentBudgetUsd?: number | null;
}

export interface LocalAiFallbackRoutingRequestCreation {
  event: LocalAiRoutingEvent;
  request?: LocalAiFallbackRequest;
}

export function reserveLocalAiFallbackRoutingEvent(
  db: SqliteDriver,
  logger: LocalAiRepositoryLogger,
  input: LocalAiRoutingEvent,
  limits: LocalAiFallbackReservationLimits,
): LocalAiRoutingEvent {
  const event = LocalAiRoutingEventSchema.parse(input);
  return runImmediateTransaction(db, logger, () => {
    const reason = hardCeilingReason(db, event, limits);
    const stored = reason
      ? {
          ...event,
          actualRoute: 'blocked' as const,
          policy: 'block-paid-fallback' as const,
          disposition: 'blocked' as const,
          decisionReason: reason,
        }
      : event;
    insertLocalAiRoutingEvent(db, stored);
    return stored;
  });
}

export function createLocalAiFallbackRoutingRequest(
  db: SqliteDriver,
  logger: LocalAiRepositoryLogger,
  eventInput: LocalAiRoutingEvent,
  requestInput: LocalAiFallbackRequest,
  limits: LocalAiFallbackReservationLimits,
): LocalAiFallbackRoutingRequestCreation {
  const event = LocalAiRoutingEventSchema.parse(eventInput);
  const request = LocalAiFallbackRequestSchema.parse(requestInput);
  assertLinkedPendingConfirmation(event, request);
  return runImmediateTransaction(db, logger, () => {
    const reason = hardCeilingReason(db, event, limits);
    const storedEvent = reason
      ? {
          ...event,
          actualRoute: 'blocked' as const,
          policy: 'block-paid-fallback' as const,
          disposition: 'blocked' as const,
          decisionReason: reason,
        }
      : event;
    insertLocalAiRoutingEvent(db, storedEvent);
    if (storedEvent.disposition !== 'pending-confirmation') {
      return { event: storedEvent };
    }
    insertLocalAiFallbackRequest(db, request);
    return { event: storedEvent, request };
  });
}

export function getLocalAiFallbackRequest(
  db: SqliteDriver,
  logger: LocalAiRepositoryLogger,
  requestId: string,
): LocalAiFallbackRequest | undefined {
  const row = db.prepareCached('SELECT * FROM local_ai_fallback_requests WHERE id = ?')
    .get<LocalAiFallbackRequestRow>(requestId);
  return row ? mapLocalAiFallbackRequestRow(row, logger) : undefined;
}

export function markLocalAiFallbackDispatched(
  db: SqliteDriver,
  logger: LocalAiRepositoryLogger,
  eventId: string,
  completedAt: number,
): LocalAiRoutingEvent | undefined {
  return db.transaction(() => {
    const row = db.prepareCached('SELECT * FROM local_ai_routing_events WHERE id = ?')
      .get<LocalAiRoutingEventRow>(eventId);
    const event = row ? mapLocalAiRoutingEventRow(row, logger) : undefined;
    if (!event || event.actualRoute !== 'frontier' || event.disposition !== 'allowed') {
      return undefined;
    }
    if (event.completedAt === undefined) {
      db.prepareCached(`
        UPDATE local_ai_routing_events SET completed_at = ?
        WHERE id = ? AND completed_at IS NULL
      `).run(completedAt, eventId);
    }
    const completedRow = db.prepareCached('SELECT * FROM local_ai_routing_events WHERE id = ?')
      .get<LocalAiRoutingEventRow>(eventId);
    const completed = completedRow ? mapLocalAiRoutingEventRow(completedRow, logger) : undefined;
    if (!completed) return undefined;
    const accounting = accountLocalAiRoutingEvent(db, logger, completed, completedAt);
    if (completed.incidentId && !accounting) {
      throw new Error(`Local AI dispatch incident accounting failed: ${eventId}`);
    }
    return completed;
  })();
}

export function resolveLocalAiFallbackRequest(
  db: SqliteDriver,
  logger: LocalAiRepositoryLogger,
  requestId: string,
  resolution: LocalAiFallbackResolution,
  now: number,
  limits?: LocalAiFallbackReservationLimits,
): LocalAiFallbackRequest | undefined {
  const parsedResolution = LocalAiFallbackResolutionSchema.parse(resolution);
  return runImmediateTransaction(db, logger, () => {
    expireLocalAiFallbackRequests(db, now);
    const existing = getLocalAiFallbackRequest(db, logger, requestId);
    if (!existing || existing.status !== 'pending') return existing;
    let appliedResolution = parsedResolution;
    let hardReason: 'daily-budget' | 'incident-budget' | undefined;
    if ((parsedResolution === 'allow-once' || parsedResolution === 'allow-incident') && limits) {
      const eventRow = db.prepareCached('SELECT * FROM local_ai_routing_events WHERE id = ?')
        .get<LocalAiRoutingEventRow>(existing.routingEventId);
      const event = eventRow ? mapLocalAiRoutingEventRow(eventRow, logger) : undefined;
      if (!event) throw new Error(`Local AI routing event not found: ${existing.routingEventId}`);
      hardReason = hardCeilingReason(db, event, limits, event.id);
      if (hardReason) appliedResolution = 'block';
    }
    const status = resolutionStatus(appliedResolution);
    const result = db.prepareCached(`
      UPDATE local_ai_fallback_requests
      SET status = ?, resolution = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ?
    `).run(status, appliedResolution, now, requestId, now);
    if (result.changes !== 1) return getLocalAiFallbackRequest(db, logger, requestId);
    updateLinkedRoutingEvent(db, existing.routingEventId, appliedResolution, hardReason);
    return getLocalAiFallbackRequest(db, logger, requestId);
  });
}

export function expireLocalAiFallbackRequests(db: SqliteDriver, now: number): number {
  const rows = db.prepareCached(`
    SELECT id, routing_event_id FROM local_ai_fallback_requests
    WHERE status = 'pending' AND expires_at <= ?
  `).all<{ id: string; routing_event_id: string }>(now);
  if (!rows.length) return 0;
  const ids = new Set(rows.map((row) => row.routing_event_id));
  for (const routingEventId of ids) updateLinkedRoutingEvent(db, routingEventId, 'block');
  return db.prepareCached(`
    UPDATE local_ai_fallback_requests
    SET status = 'expired', resolution = 'block', resolved_at = ?
    WHERE status = 'pending' AND expires_at <= ?
  `).run(now, now).changes;
}

function updateLinkedRoutingEvent(
  db: SqliteDriver,
  routingEventId: string,
  resolution: LocalAiFallbackResolution,
  hardReason?: 'daily-budget' | 'incident-budget',
): void {
  const allowed = resolution === 'allow-once' || resolution === 'allow-incident';
  const deferred = resolution === 'defer';
  db.prepareCached(`
    UPDATE local_ai_routing_events SET actual_route = ?, disposition = ? WHERE id = ?
  `).run(
    allowed ? 'frontier' : deferred ? 'deferred' : 'blocked',
    allowed ? 'allowed' : deferred ? 'deferred' : 'blocked',
    routingEventId,
  );
  if (hardReason) {
    db.prepareCached(`
      UPDATE local_ai_routing_events
      SET policy = 'block-paid-fallback', decision_reason = ?
      WHERE id = ?
    `).run(hardReason, routingEventId);
  }
}

function resolutionStatus(
  resolution: LocalAiFallbackResolution,
): LocalAiFallbackRequest['status'] {
  switch (resolution) {
    case 'allow-once':
    case 'allow-incident':
      return 'allowed';
    case 'defer':
      return 'deferred';
    case 'block':
      return 'blocked';
  }
}

function hardCeilingReason(
  db: SqliteDriver,
  event: LocalAiRoutingEvent,
  limits: LocalAiFallbackReservationLimits,
  excludeEventId?: string,
): 'daily-budget' | 'incident-budget' | undefined {
  if (exceedsConfiguredCeiling(
    limits.globalDailyBudgetUsd,
    event.estimatedCostUsd,
    getLocalAiFallbackSpend(db, {
      since: limits.dayStart,
      until: limits.at,
      ...(excludeEventId ? { excludeEventId } : {}),
    }),
  )) {
    return 'daily-budget';
  }
  if (event.targetId && exceedsConfiguredCeiling(
    limits.targetDailyBudgetUsd,
    event.estimatedCostUsd,
    getLocalAiFallbackSpend(db, {
      since: limits.dayStart,
      until: limits.at,
      targetId: event.targetId,
      ...(excludeEventId ? { excludeEventId } : {}),
    }),
  )) {
    return 'daily-budget';
  }
  if (!event.incidentId || limits.incidentBudgetUsd === null
    || limits.incidentBudgetUsd === undefined) {
    return undefined;
  }
  const incidentSpend = getLocalAiFallbackSpend(db, {
    since: 0,
    until: limits.at,
    incidentId: event.incidentId,
    ...(excludeEventId ? { excludeEventId } : {}),
  });
  return exceedsConfiguredCeiling(
    limits.incidentBudgetUsd,
    event.estimatedCostUsd,
    incidentSpend,
  )
    ? 'incident-budget'
    : undefined;
}

function exceedsConfiguredCeiling(
  ceiling: number | null | undefined,
  estimate: number | undefined,
  spend: LocalAiFallbackSpend,
): boolean {
  if (ceiling === null || ceiling === undefined) return false;
  if (estimate === undefined || spend.unknownReservations > 0) return true;
  return spend.knownCostUsd + spend.estimatedCostUsd + estimate > ceiling;
}

export function insertLocalAiRoutingEvent(db: SqliteDriver, event: LocalAiRoutingEvent): void {
  db.prepareCached(`
    INSERT INTO local_ai_routing_events (
      id, target_id, incident_id, slot, intended_route, actual_route, policy, disposition,
      decision_reason, provider, model, input_tokens, output_tokens, known_cost_usd,
      estimated_cost_usd, created_at, completed_at
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

export function insertLocalAiFallbackRequest(
  db: SqliteDriver,
  request: LocalAiFallbackRequest,
): void {
  db.prepareCached(`
    INSERT INTO local_ai_fallback_requests (
      id, routing_event_id, incident_id, slot, status, estimated_input_tokens,
      estimated_cost_usd, created_at, expires_at, resolved_at, resolution
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    request.id,
    request.routingEventId,
    request.incidentId ?? null,
    request.slot,
    request.status,
    request.estimatedInputTokens,
    request.estimatedCostUsd ?? null,
    request.createdAt,
    request.expiresAt,
    request.resolvedAt ?? null,
    request.resolution ?? null,
  );
}

function assertLinkedPendingConfirmation(
  event: LocalAiRoutingEvent,
  request: LocalAiFallbackRequest,
): void {
  const coherent = event.policy === 'require-confirmation'
    && event.disposition === 'pending-confirmation'
    && event.actualRoute === 'deferred'
    && request.status === 'pending'
    && request.resolution === undefined
    && request.resolvedAt === undefined
    && request.routingEventId === event.id
    && request.incidentId === event.incidentId
    && request.slot === event.slot
    && request.estimatedInputTokens === event.inputTokens
    && request.estimatedCostUsd === event.estimatedCostUsd;
  if (!coherent) {
    throw new Error('Local AI fallback request does not match its pending confirmation event');
  }
}

function runImmediateTransaction<T>(
  db: SqliteDriver,
  logger: LocalAiRepositoryLogger,
  operation: () => T,
): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      logger.warn('Failed to roll back Local AI fallback reservation transaction', {
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
    throw error;
  }
}
