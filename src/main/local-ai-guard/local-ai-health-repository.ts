import { randomUUID } from 'node:crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import type {
  LocalAiEffectivenessSummary,
  LocalAiFallbackRequest,
  LocalAiFallbackResolution,
  LocalAiHealthSample,
  LocalAiIncident,
  LocalAiIncidentMutation,
  LocalAiIncidentQuery,
  LocalAiRetentionReport,
  LocalAiRoutingEvent,
  LocalAiRoutingEventPatch,
} from '../../shared/types/local-ai-guard.types';
import {
  LocalAiEffectivenessSummarySchema,
  LocalAiFallbackRequestSchema,
  LocalAiFallbackResolutionSchema,
  LocalAiHealthSampleSchema,
  LocalAiIncidentMutationSchema,
  LocalAiIncidentQuerySchema,
  LocalAiRoutingEventPatchSchema,
  LocalAiRoutingEventSchema,
} from '../../shared/validation/local-ai-guard.schemas';
import {
  accountLocalAiRoutingEvent,
  listRetryableLocalAiNotifications,
  localAiNotificationColumns,
  mapLocalAiFallbackRequestRow,
  mapLocalAiHealthSampleRow,
  mapLocalAiIncidentRow,
  mapLocalAiRoutingEventRow,
  nextLocalAiNotificationDueAt,
  type LocalAiFallbackRequestRow,
  type LocalAiHealthSampleRow,
  type LocalAiIncidentRow,
  type LocalAiNotificationClaim,
  type LocalAiNotificationReference,
  type LocalAiRepositoryLogger,
  type LocalAiRoutingAccountingResult,
  type LocalAiRoutingEventRow,
} from './local-ai-row-mappers';
import { claimLocalAiNotification } from './local-ai-notification-outbox';
export type {
  LocalAiNotificationClaim,
  LocalAiNotificationReference,
  LocalAiRoutingAccountingResult,
} from './local-ai-row-mappers';

const RAW_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_LATEST_SAMPLES = 100;
const MAX_PENDING_FALLBACKS = 1_000;
const PAGE_SIZE = 1_000;
interface DailyAggregateRow {
  id: string;
  target_id: string | null;
  day: string;
  aggregate_json: string;
  created_at: number;
  updated_at: number;
}
class LocalAiSummaryRangeError extends RangeError {
  constructor(field: string) {
    super(`Local AI summary range error for ${field}`);
    this.name = 'LocalAiSummaryRangeError';
  }
}
export class LocalAiHealthRepository {
  constructor(
    private readonly db: SqliteDriver = getRLMDatabase().getRawDb(),
    private readonly logger: LocalAiRepositoryLogger = getLogger('LocalAiHealthRepository'),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  appendSample(sample: LocalAiHealthSample): void {
    const parsed = LocalAiHealthSampleSchema.parse(sample);
    this.db.prepareCached(`
      INSERT INTO local_ai_health_samples (
        id, target_id, layer, check_type, ok, required, affected_roles_json, checked_at, duration_ms,
        failure_code, message, evidence_json, origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.id,
      parsed.targetId,
      parsed.layer,
      parsed.checkType,
      parsed.ok ? 1 : 0,
      parsed.required ? 1 : 0,
      JSON.stringify(parsed.affectedRoles),
      parsed.checkedAt,
      parsed.durationMs,
      parsed.failureCode ?? null,
      parsed.message ?? null,
      JSON.stringify(parsed.evidence),
      parsed.origin,
    );
  }
  latestSamples(targetId: string): LocalAiHealthSample[] {
    const rows = this.db.prepareCached(`
      SELECT * FROM local_ai_health_samples WHERE target_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?
    `).all<LocalAiHealthSampleRow>(targetId, MAX_LATEST_SAMPLES);
    return rows.flatMap((row) => {
      const sample = mapLocalAiHealthSampleRow(row, this.logger);
      return sample ? [sample] : [];
    });
  }
  upsertIncident(input: LocalAiIncidentMutation): LocalAiIncident {
    const parsed = LocalAiIncidentMutationSchema.parse(input);
    if (parsed.kind === 'open-or-update') this.assertOpenIncidentMutation(parsed.incident);
    const operation = this.db.transaction(() => {
      if (parsed.kind === 'open-or-update') return this.openOrUpdateIncident(parsed.incident);

      const result = parsed.kind === 'acknowledge'
        ? this.db.prepareCached(`
            UPDATE local_ai_incidents SET state = 'acknowledged', updated_at = ?, acknowledged_at = ?
            WHERE id = ? AND state = 'open' AND opened_at <= ? AND updated_at <= ?
          `).run(parsed.at, parsed.at, parsed.incidentId, parsed.at, parsed.at)
        : this.db.prepareCached(`
            UPDATE local_ai_incidents SET
              state = 'resolved', updated_at = ?, resolved_at = ?, recovery_notification_state = 'pending'
            WHERE id = ? AND state IN ('open', 'acknowledged') AND opened_at <= ? AND updated_at <= ?
          `).run(parsed.at, parsed.at, parsed.incidentId, parsed.at, parsed.at);
      if (result.changes !== 1) throw new Error(`Local AI incident cannot be ${parsed.kind}: ${parsed.incidentId}`);
      return this.requireIncident(parsed.incidentId);
    });
    return operation();
  }
  listIncidents(query: LocalAiIncidentQuery): LocalAiIncident[] {
    const parsed = LocalAiIncidentQuerySchema.parse(query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (parsed.targetId) {
      conditions.push('target_id = ?');
      params.push(parsed.targetId);
    }
    if (parsed.state) {
      conditions.push('state = ?');
      params.push(parsed.state);
    }
    if (parsed.since !== undefined) {
      conditions.push('updated_at >= ?');
      params.push(parsed.since);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepareCached(`
      SELECT * FROM local_ai_incidents ${where} ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all<LocalAiIncidentRow>(...params, parsed.limit);
    return rows.flatMap((row) => {
      const incident = mapLocalAiIncidentRow(row, this.logger);
      return incident ? [incident] : [];
    });
  }
  appendRoutingEvent(event: LocalAiRoutingEvent): void {
    const parsed = LocalAiRoutingEventSchema.parse(event);
    this.insertRoutingEvent(parsed);
  }
  private insertRoutingEvent(parsed: LocalAiRoutingEvent): void {
    this.db.prepareCached(`
      INSERT INTO local_ai_routing_events (
        id, target_id, incident_id, slot, intended_route, actual_route, policy, disposition, decision_reason, provider, model,
        input_tokens, output_tokens, known_cost_usd, estimated_cost_usd, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.id,
      parsed.targetId ?? null,
      parsed.incidentId ?? null,
      parsed.slot,
      parsed.intendedRoute,
      parsed.actualRoute,
      parsed.policy,
      parsed.disposition,
      parsed.decisionReason,
      parsed.provider ?? null,
      parsed.model ?? null,
      parsed.inputTokens,
      parsed.outputTokens,
      parsed.knownCostUsd ?? null,
      parsed.estimatedCostUsd ?? null,
      parsed.createdAt,
      parsed.completedAt ?? null,
    );
  }
  getRoutingEvent(eventId: string): LocalAiRoutingEvent | undefined {
    const row = this.db.prepareCached('SELECT * FROM local_ai_routing_events WHERE id = ?').get<LocalAiRoutingEventRow>(eventId);
    return row ? mapLocalAiRoutingEventRow(row, this.logger) : undefined;
  }
  updateRoutingEvent(eventId: string, patch: LocalAiRoutingEventPatch): void {
    const parsed = LocalAiRoutingEventPatchSchema.parse(patch);
    const columns: string[] = [];
    const params: unknown[] = [];
    const values: [string, unknown][] = [
      ['actual_route', parsed.actualRoute],
      ['disposition', parsed.disposition],
      ['provider', parsed.provider],
      ['model', parsed.model],
      ['input_tokens', parsed.inputTokens],
      ['output_tokens', parsed.outputTokens],
      ['known_cost_usd', parsed.knownCostUsd],
      ['estimated_cost_usd', parsed.estimatedCostUsd],
      ['completed_at', parsed.completedAt],
    ];
    for (const [column, value] of values) {
      if (value !== undefined) {
        columns.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (!columns.length) return;
    const operation = this.db.transaction(() => {
      this.db.prepareCached(`UPDATE local_ai_routing_events SET ${columns.join(', ')} WHERE id = ?`)
        .run(...params, eventId);
    });
    operation();
  }
  accountRoutingEvent(input: LocalAiRoutingEvent, accountedAt = this.clock()): LocalAiRoutingAccountingResult | undefined {
    return accountLocalAiRoutingEvent(this.db, this.logger, input, accountedAt);
  }
  listRetryableNotifications(now: number, leaseMs: number, limit: number): LocalAiNotificationReference[] {
    return listRetryableLocalAiNotifications(this.db, now, leaseMs, limit);
  }
  nextOutboxDueAt(now: number, leaseMs: number): number | undefined {
    return nextLocalAiNotificationDueAt(this.db, now, leaseMs);
  }
  claimNotification(
    reference: LocalAiNotificationReference,
    claimToken: string,
    at: number,
    leaseMs: number,
  ): LocalAiNotificationClaim | undefined {
    return claimLocalAiNotification(this.db, this.logger, reference, claimToken, at, leaseMs);
  }
  markNotificationDelivered(
    reference: LocalAiNotificationReference,
    claimToken: string,
    at: number,
  ): boolean {
    return this.finishNotification(reference, claimToken, 'delivered', at);
  }
  markNotificationFailed(
    reference: LocalAiNotificationReference,
    claimToken: string,
    retryAt: number,
  ): boolean {
    // Failed rows reuse the cleared lease field as a durable retry-not-before timestamp.
    return this.finishNotification(reference, claimToken, 'failed', retryAt);
  }

  createFallbackRequest(request: LocalAiFallbackRequest): void {
    const parsed = LocalAiFallbackRequestSchema.parse(request);
    this.db.prepareCached(`
      INSERT INTO local_ai_fallback_requests (
        id, routing_event_id, incident_id, slot, status, estimated_input_tokens, estimated_cost_usd,
        created_at, expires_at, resolved_at, resolution
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.id,
      parsed.routingEventId,
      parsed.incidentId ?? null,
      parsed.slot,
      parsed.status,
      parsed.estimatedInputTokens,
      parsed.estimatedCostUsd ?? null,
      parsed.createdAt,
      parsed.expiresAt,
      parsed.resolvedAt ?? null,
      parsed.resolution ?? null,
    );
  }
  resolveFallbackRequest(requestId: string, resolution: LocalAiFallbackResolution): LocalAiFallbackRequest | undefined {
    const parsedResolution = LocalAiFallbackResolutionSchema.parse(resolution);
    const status = resolutionToStatus(parsedResolution);
    const now = this.clock();
    const operation = this.db.transaction(() => {
      this.expirePendingRequests(now);
      const result = this.db.prepareCached(`
        UPDATE local_ai_fallback_requests
        SET status = ?, resolution = ?, resolved_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ?
      `).run(status, parsedResolution, now, requestId, now);
      return result.changes === 1 ? this.getFallbackRequest(requestId) : undefined;
    });
    return operation();
  }
  listPendingFallbackRequests(): LocalAiFallbackRequest[] {
    const now = this.clock();
    const operation = this.db.transaction(() => {
      this.expirePendingRequests(now);
      const rows = this.db.prepareCached(`
        SELECT * FROM local_ai_fallback_requests INDEXED BY idx_local_ai_fallback_requests_pending_order
        WHERE status = 'pending' AND expires_at > ? ORDER BY created_at ASC, id ASC LIMIT ?
      `).all<LocalAiFallbackRequestRow>(now, MAX_PENDING_FALLBACKS);
      return rows.flatMap((row) => {
        const request = mapLocalAiFallbackRequestRow(row, this.logger);
        return request ? [request] : [];
      });
    });
    return operation();
  }
  summarize(window: '24h' | '7d' | '30d', now = Date.now()): LocalAiEffectivenessSummary {
    const start = now - windowDuration(window);
    const summary = emptySummary(window);
    this.forEachRoutingEventPage(start, now, (event) => addEvent(summary, event));
    this.forEachDailyAggregatePage(utcDay(start), utcDay(now), (aggregate) => addSummary(summary, aggregate));
    return LocalAiEffectivenessSummarySchema.parse(summary);
  }
  runRetention(now = Date.now()): LocalAiRetentionReport {
    const cutoff = now - RAW_RETENTION_MS;
    const operation = this.db.transaction(() => {
      const daysAggregated = this.db.prepareCached(`
        SELECT count(DISTINCT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')) AS count
        FROM local_ai_routing_events WHERE created_at < ?
      `).get<{ count: number }>(cutoff)?.count ?? 0;
      this.aggregateOldRoutingEvents(cutoff, now);
      const samplesDeleted = this.db.prepareCached('DELETE FROM local_ai_health_samples WHERE checked_at < ?').run(cutoff).changes;
      const routingEventsDeleted = this.db.prepareCached('DELETE FROM local_ai_routing_events WHERE created_at < ?').run(cutoff).changes;
      return { samplesDeleted, routingEventsDeleted, daysAggregated };
    });
    return operation();
  }
  private finishNotification(
    reference: LocalAiNotificationReference,
    claimToken: string,
    state: 'failed' | 'delivered',
    at: number,
  ): boolean {
    const columns = localAiNotificationColumns(reference);
    const delivered = state === 'delivered';
    const result = this.db.prepareCached(`
      UPDATE ${columns.table} SET
        ${columns.state} = ?, ${columns.token} = NULL, ${columns.claimedAt} = ?,
        ${columns.deliveredAt} = CASE WHEN ? = 1 THEN ? ELSE ${columns.deliveredAt} END
      WHERE id = ? AND ${columns.state} = 'claimed' AND ${columns.token} = ?
    `).run(
      state,
      delivered ? null : at,
      delivered ? 1 : 0,
      delivered ? at : null,
      reference.entityId,
      claimToken,
    );
    return result.changes === 1;
  }
  private openOrUpdateIncident(incoming: LocalAiIncident): LocalAiIncident {
    const row = this.db.prepareCached(`
      SELECT * FROM local_ai_incidents
      WHERE target_id = ? AND failure_code = ? AND state IN ('open', 'acknowledged')
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get<LocalAiIncidentRow>(incoming.targetId, incoming.failureCode);
    const existing = row ? mapLocalAiIncidentRow(row, this.logger) : undefined;
    if (!existing) {
      this.assertIncidentTimes(incoming);
      this.insertIncident(incoming);
      return incoming;
    }
    this.assertIncidentTimes(incoming, existing);
    const updated: LocalAiIncident = {
      ...incoming,
      id: existing.id,
      state: existing.state,
      openedAt: existing.openedAt,
      ...(existing.acknowledgedAt === undefined ? {} : { acknowledgedAt: existing.acknowledgedAt }),
    };
    this.updateIncident(updated);
    return updated;
  }
  private insertIncident(incident: LocalAiIncident): void {
    this.db.prepareCached(`
      INSERT INTO local_ai_incidents (
        id, target_id, state, severity, failure_code, affected_layers_json, affected_roles_json, opened_at,
        updated_at, acknowledged_at, resolved_at, fallback_count, known_cost_usd, estimated_cost_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...incidentValues(incident));
  }
  private updateIncident(incident: LocalAiIncident): void {
    this.db.prepareCached(`
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
  private requireIncident(incidentId: string): LocalAiIncident {
    const row = this.db.prepareCached('SELECT * FROM local_ai_incidents WHERE id = ?').get<LocalAiIncidentRow>(incidentId);
    const incident = row ? mapLocalAiIncidentRow(row, this.logger) : undefined;
    if (!incident) throw new Error(`Local AI incident not found: ${incidentId}`);
    return incident;
  }

  private getFallbackRequest(requestId: string): LocalAiFallbackRequest | undefined {
    const row = this.db.prepareCached('SELECT * FROM local_ai_fallback_requests WHERE id = ?')
      .get<LocalAiFallbackRequestRow>(requestId);
    return row ? mapLocalAiFallbackRequestRow(row, this.logger) : undefined;
  }

  private assertOpenIncidentMutation(incident: LocalAiIncident): void {
    if (incident.state !== 'open' || incident.acknowledgedAt !== undefined || incident.resolvedAt !== undefined) {
      throw new Error('Local AI open-or-update incidents must be open without acknowledgement or resolution timestamps');
    }
  }

  private assertIncidentTimes(incoming: LocalAiIncident, existing?: LocalAiIncident): void {
    if (incoming.openedAt > incoming.updatedAt) {
      throw new RangeError('Local AI incident openedAt must not be after updatedAt');
    }
    if (!existing) return;
    if (incoming.updatedAt < existing.updatedAt) {
      throw new RangeError('Local AI incident updatedAt must not precede the current updatedAt');
    }
    if (incoming.openedAt !== existing.openedAt) {
      throw new RangeError('Local AI incident openedAt must remain coherent across updates');
    }
  }

  private expirePendingRequests(now: number): void {
    this.db.prepareCached(`
      UPDATE local_ai_fallback_requests SET status = 'expired', resolved_at = ?
      WHERE status = 'pending' AND expires_at <= ?
    `).run(now, now);
  }

  private forEachRoutingEventPage(start: number, end: number, consume: (event: LocalAiRoutingEvent) => void): void {
    let lastCreatedAt = start;
    let lastId = '';
    for (;;) {
      const rows = this.db.prepareCached(`
        SELECT * FROM local_ai_routing_events
        WHERE created_at >= ? AND created_at <= ?
          AND (created_at > ? OR (created_at = ? AND id > ?))
        ORDER BY created_at ASC, id ASC LIMIT ?
      `).all<LocalAiRoutingEventRow>(start, end, lastCreatedAt, lastCreatedAt, lastId, PAGE_SIZE);
      if (!rows.length) return;
      for (const row of rows) {
        const event = mapLocalAiRoutingEventRow(row, this.logger);
        if (event) consume(event);
      }
      const last = rows.at(-1)!;
      lastCreatedAt = last.created_at;
      lastId = last.id;
      if (rows.length < PAGE_SIZE) return;
    }
  }

  private forEachDailyAggregatePage(startDay: string, endDay: string, consume: (aggregate: LocalAiEffectivenessSummary) => void): void {
    let lastDay = startDay;
    let lastId = '';
    for (;;) {
      const rows = this.db.prepareCached(`
        SELECT * FROM local_ai_daily_aggregates
        WHERE day >= ? AND day <= ? AND (day > ? OR (day = ? AND id > ?))
        ORDER BY day ASC, id ASC LIMIT ?
      `).all<DailyAggregateRow>(startDay, endDay, lastDay, lastDay, lastId, PAGE_SIZE);
      if (!rows.length) return;
      for (const row of rows) {
        const aggregate = this.mapDailyAggregate(row);
        if (aggregate) consume(aggregate);
      }
      const last = rows.at(-1)!;
      lastDay = last.day;
      lastId = last.id;
      if (rows.length < PAGE_SIZE) return;
    }
  }

  private aggregateOldRoutingEvents(cutoff: number, now: number): void {
    let current: {
      targetId: string | null;
      day: string;
      aggregate: LocalAiEffectivenessSummary;
    } | undefined;
    let rows = this.db.prepareCached(`
      SELECT * FROM local_ai_routing_events INDEXED BY idx_local_ai_routing_events_retention_stream
      WHERE created_at < ?
      ORDER BY retention_target_key ASC, created_at ASC, id ASC LIMIT ?
    `).all<LocalAiRoutingEventRow>(cutoff, PAGE_SIZE);
    while (rows.length) {
      for (const row of rows) {
        const day = utcDay(row.created_at);
        if (!current || current.targetId !== row.target_id || current.day !== day) {
          if (current) this.upsertDailyAggregate(current.targetId, current.day, current.aggregate, now);
          current = { targetId: row.target_id, day, aggregate: emptySummary('24h') };
        }
        const event = mapLocalAiRoutingEventRow(row, this.logger);
        if (event) addEvent(current.aggregate, event);
      }
      if (rows.length < PAGE_SIZE) break;
      const last = rows.at(-1)!;
      rows = this.db.prepareCached(`
        SELECT * FROM local_ai_routing_events INDEXED BY idx_local_ai_routing_events_retention_stream
        WHERE created_at < ?
          AND (retention_target_key, created_at, id) > (?, ?, ?)
        ORDER BY retention_target_key ASC, created_at ASC, id ASC LIMIT ?
      `).all<LocalAiRoutingEventRow>(
        cutoff,
        last.target_id ?? '',
        last.created_at,
        last.id,
        PAGE_SIZE,
      );
    }
    if (current) this.upsertDailyAggregate(current.targetId, current.day, current.aggregate, now);
  }

  private mapDailyAggregate(row: DailyAggregateRow): LocalAiEffectivenessSummary | undefined {
    try {
      const parsed = LocalAiEffectivenessSummarySchema.safeParse(JSON.parse(row.aggregate_json) as unknown);
      if (!parsed.success) throw new Error(parsed.error.message);
      return parsed.data;
    } catch (error) {
      this.logger.warn('Omitting malformed persisted Local AI Guard daily aggregate', {
        aggregateId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private upsertDailyAggregate(
    targetId: string | null,
    day: string,
    incoming: LocalAiEffectivenessSummary,
    now: number,
  ): void {
    const existingRow = this.db.prepareCached(`
      SELECT * FROM local_ai_daily_aggregates WHERE target_id IS ? AND day = ? ORDER BY created_at ASC LIMIT 1
    `).get<DailyAggregateRow>(targetId, day);
    const existing = existingRow ? this.mapDailyAggregate(existingRow) : undefined;
    const aggregate = existing ?? emptySummary('24h');
    addSummary(aggregate, incoming);
    const json = JSON.stringify(LocalAiEffectivenessSummarySchema.parse(aggregate));
    if (existingRow) {
      this.db.prepareCached(`
        UPDATE local_ai_daily_aggregates SET aggregate_json = ?, updated_at = ? WHERE id = ?
      `).run(json, now, existingRow.id);
      return;
    }
    this.db.prepareCached(`
      INSERT INTO local_ai_daily_aggregates (id, target_id, day, aggregate_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), targetId, day, json, now, now);
  }
}

function incidentValues(incident: LocalAiIncident): unknown[] {
  return [
    incident.id,
    incident.targetId,
    incident.state,
    incident.severity,
    incident.failureCode,
    JSON.stringify(incident.affectedLayers),
    JSON.stringify(incident.affectedRoles),
    incident.openedAt,
    incident.updatedAt,
    incident.acknowledgedAt ?? null,
    incident.resolvedAt ?? null,
    incident.fallbackCount,
    incident.knownCostUsd,
    incident.estimatedCostUsd,
  ];
}

function resolutionToStatus(resolution: LocalAiFallbackResolution): LocalAiFallbackRequest['status'] {
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

function windowDuration(window: LocalAiEffectivenessSummary['window']): number {
  switch (window) {
    case '24h': return 24 * 60 * 60 * 1_000;
    case '7d': return 7 * 24 * 60 * 60 * 1_000;
    case '30d': return 30 * 24 * 60 * 60 * 1_000;
  }
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function emptySummary(window: LocalAiEffectivenessSummary['window']): LocalAiEffectivenessSummary {
  return {
    window,
    localTasks: 0,
    localTokens: 0,
    proposedFallbacks: 0,
    allowedFallbacks: 0,
    deferredFallbacks: 0,
    blockedFallbacks: 0,
    knownCostUsd: 0,
    estimatedCostUsd: 0,
    avoidedEstimatedTokens: 0,
    avoidedEstimatedCostUsd: 0,
    byTarget: {},
    byModel: {},
    bySlot: {},
    byIncident: {},
  };
}

function addEvent(summary: LocalAiEffectivenessSummary, event: LocalAiRoutingEvent): void {
  const tokens = addSafeInteger('localTokens', event.inputTokens, event.outputTokens);
  increment(summary.bySlot, event.slot);
  if (event.targetId) increment(summary.byTarget, event.targetId);
  if (event.model) increment(summary.byModel, event.model);
  if (event.incidentId) increment(summary.byIncident, event.incidentId);
  if (event.actualRoute === 'local') {
    summary.localTasks = addSafeInteger('localTasks', summary.localTasks, 1);
    summary.localTokens = addSafeInteger('localTokens', summary.localTokens, tokens);
    summary.avoidedEstimatedTokens = addSafeInteger('avoidedEstimatedTokens', summary.avoidedEstimatedTokens, tokens);
    summary.avoidedEstimatedCostUsd = addFiniteCost('avoidedEstimatedCostUsd', summary.avoidedEstimatedCostUsd, event.estimatedCostUsd ?? 0);
    return;
  }
  summary.proposedFallbacks = addSafeInteger('proposedFallbacks', summary.proposedFallbacks, 1);
  if (event.disposition === 'allowed') summary.allowedFallbacks = addSafeInteger('allowedFallbacks', summary.allowedFallbacks, 1);
  if (event.disposition === 'deferred') summary.deferredFallbacks = addSafeInteger('deferredFallbacks', summary.deferredFallbacks, 1);
  if (event.disposition === 'blocked') summary.blockedFallbacks = addSafeInteger('blockedFallbacks', summary.blockedFallbacks, 1);
  summary.knownCostUsd = addFiniteCost('knownCostUsd', summary.knownCostUsd, event.knownCostUsd ?? 0);
  summary.estimatedCostUsd = addFiniteCost('estimatedCostUsd', summary.estimatedCostUsd, event.estimatedCostUsd ?? 0);
}

function addSummary(target: LocalAiEffectivenessSummary, source: LocalAiEffectivenessSummary): void {
  target.localTasks = addSafeInteger('localTasks', target.localTasks, source.localTasks);
  target.localTokens = addSafeInteger('localTokens', target.localTokens, source.localTokens);
  target.proposedFallbacks = addSafeInteger('proposedFallbacks', target.proposedFallbacks, source.proposedFallbacks);
  target.allowedFallbacks = addSafeInteger('allowedFallbacks', target.allowedFallbacks, source.allowedFallbacks);
  target.deferredFallbacks = addSafeInteger('deferredFallbacks', target.deferredFallbacks, source.deferredFallbacks);
  target.blockedFallbacks = addSafeInteger('blockedFallbacks', target.blockedFallbacks, source.blockedFallbacks);
  target.knownCostUsd = addFiniteCost('knownCostUsd', target.knownCostUsd, source.knownCostUsd);
  target.estimatedCostUsd = addFiniteCost('estimatedCostUsd', target.estimatedCostUsd, source.estimatedCostUsd);
  target.avoidedEstimatedTokens = addSafeInteger('avoidedEstimatedTokens', target.avoidedEstimatedTokens, source.avoidedEstimatedTokens);
  target.avoidedEstimatedCostUsd = addFiniteCost('avoidedEstimatedCostUsd', target.avoidedEstimatedCostUsd, source.avoidedEstimatedCostUsd);
  addCounters(target.byTarget, source.byTarget);
  addCounters(target.byModel, source.byModel);
  addCounters(target.bySlot, source.bySlot);
  addCounters(target.byIncident, source.byIncident);
}

function increment(counter: Record<string, number>, key: string): void {
  counter[key] = addSafeInteger(key, counter[key] ?? 0, 1);
}

function addCounters(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) target[key] = addSafeInteger(key, target[key] ?? 0, value);
}

function addSafeInteger(field: string, left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new LocalAiSummaryRangeError(field);
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new LocalAiSummaryRangeError(field);
  return total;
}

function addFiniteCost(field: string, left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) throw new LocalAiSummaryRangeError(field);
  const total = left + right;
  if (!Number.isFinite(total) || total < 0) throw new LocalAiSummaryRangeError(field);
  return total;
}
