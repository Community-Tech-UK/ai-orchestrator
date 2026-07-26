import { createHash } from 'node:crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  localAiNotificationColumns,
  mapLocalAiIncidentRow,
  mapLocalAiRoutingEventRow,
  type LocalAiIncidentRow,
  type LocalAiNotificationClaim,
  type LocalAiNotificationColumns,
  type LocalAiNotificationReference,
  type LocalAiRepositoryLogger,
  type LocalAiRoutingEventRow,
} from './local-ai-row-mappers';

type LocalAiNotificationDiscardReason =
  | 'malformed-incident'
  | 'malformed-routing-event'
  | 'missing-incident-ownership'
  | 'target-incident-mismatch';

type NotificationOwnership =
  | { kind: 'claimable'; incident: LocalAiNotificationClaim['incident'] }
  | { kind: 'discard'; reason: LocalAiNotificationDiscardReason }
  | { kind: 'missing-row' };

const SILENT_ROW_LOGGER: LocalAiRepositoryLogger = { warn: () => undefined };

export function claimLocalAiNotification(
  db: SqliteDriver,
  logger: LocalAiRepositoryLogger,
  reference: LocalAiNotificationReference,
  claimToken: string,
  at: number,
  leaseMs: number,
): LocalAiNotificationClaim | undefined {
  const columns = localAiNotificationColumns(reference);
  const cutoff = Math.max(0, at - Math.max(0, leaseMs));
  return db.transaction(() => {
    const ownership = loadNotificationOwnership(db, reference);
    if (ownership.kind === 'missing-row') return undefined;
    if (ownership.kind === 'discard') {
      discardNotification(db, logger, reference, columns, ownership.reason, at, cutoff);
      return undefined;
    }
    const result = db.prepareCached(`
      UPDATE ${columns.table} SET
        ${columns.state} = 'claimed', ${columns.token} = ?, ${columns.claimedAt} = ?,
        ${columns.attempts} = ${columns.attempts} + 1
      WHERE id = ? AND (${retryableStatePredicate(columns)})
    `).run(claimToken, at, reference.entityId, at, cutoff);
    return result.changes === 1
      ? { reference, incident: ownership.incident }
      : undefined;
  })();
}

function loadNotificationOwnership(
  db: SqliteDriver,
  reference: LocalAiNotificationReference,
): NotificationOwnership {
  if (reference.entity === 'incident') {
    const incidentRow = db.prepareCached('SELECT * FROM local_ai_incidents WHERE id = ?')
      .get<LocalAiIncidentRow>(reference.entityId);
    if (!incidentRow) return { kind: 'missing-row' };
    const incident = mapLocalAiIncidentRow(incidentRow, SILENT_ROW_LOGGER);
    return incident
      ? { kind: 'claimable', incident }
      : { kind: 'discard', reason: 'malformed-incident' };
  }

  const eventRow = db.prepareCached('SELECT * FROM local_ai_routing_events WHERE id = ?')
    .get<LocalAiRoutingEventRow>(reference.entityId);
  if (!eventRow) return { kind: 'missing-row' };
  const event = mapLocalAiRoutingEventRow(eventRow, SILENT_ROW_LOGGER);
  if (!event) return { kind: 'discard', reason: 'malformed-routing-event' };
  if (!event.incidentId) return { kind: 'discard', reason: 'missing-incident-ownership' };
  const incidentRow = db.prepareCached('SELECT * FROM local_ai_incidents WHERE id = ?')
    .get<LocalAiIncidentRow>(event.incidentId);
  if (!incidentRow) return { kind: 'discard', reason: 'missing-incident-ownership' };
  const incident = mapLocalAiIncidentRow(incidentRow, SILENT_ROW_LOGGER);
  if (!incident) return { kind: 'discard', reason: 'malformed-incident' };
  if (event.targetId && event.targetId !== incident.targetId) {
    return { kind: 'discard', reason: 'target-incident-mismatch' };
  }
  return { kind: 'claimable', incident };
}

function discardNotification(
  db: SqliteDriver,
  logger: LocalAiRepositoryLogger,
  reference: LocalAiNotificationReference,
  columns: LocalAiNotificationColumns,
  reason: LocalAiNotificationDiscardReason,
  at: number,
  cutoff: number,
): void {
  const result = db.prepareCached(`
    UPDATE ${columns.table} SET
      ${columns.state} = 'discarded', ${columns.token} = NULL, ${columns.claimedAt} = NULL
    WHERE id = ? AND (${retryableStatePredicate(columns)})
  `).run(reference.entityId, at, cutoff);
  if (result.changes !== 1) return;
  logger.warn('Discarding unclaimable Local AI Guard notification', {
    notificationIdHash: hashPersistedId(reference.entityId),
    entity: reference.entity,
    transitionKind: reference.transitionKind,
    reason,
  });
}

function hashPersistedId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

function retryableStatePredicate(columns: LocalAiNotificationColumns): string {
  return `
    ${columns.state} = 'pending'
    OR (${columns.state} = 'failed'
      AND (${columns.claimedAt} IS NULL OR ${columns.claimedAt} <= ?))
    OR (${columns.state} = 'claimed'
      AND (${columns.claimedAt} IS NULL OR ${columns.claimedAt} <= ?))
  `;
}
