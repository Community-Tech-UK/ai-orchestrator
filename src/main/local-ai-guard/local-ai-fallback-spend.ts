import type { SqliteDriver } from '../db/sqlite-driver';

export interface LocalAiFallbackSpend {
  knownCostUsd: number;
  estimatedCostUsd: number;
  unknownReservations: number;
}

export interface LocalAiFallbackSpendQuery {
  since: number;
  until: number;
  targetId?: string;
  incidentId?: string;
  reservationsOnly?: boolean;
  excludeEventId?: string;
}

/**
 * Step 7 (A0-H): an unresolved reservation with NO cost at all (neither known
 * nor estimated) counts as an unknown-cost reservation only within 24 hours of
 * its creation. Older ones are dispatch bookkeeping that never completed: at
 * five cents each they pile up without bound (13,124 on one real machine, which
 * is $656 against a $2 limit) and would block every paid helper call for good.
 * Completed rows are never age-bounded, and an unresolved reservation that
 * carries an estimate or a known cost keeps counting, because it may still be
 * charged. An unknown cost is never treated as zero while it is inside the bound.
 */
const UNKNOWN_RESERVATION_FRESH_MS = 24 * 60 * 60 * 1000;

export function getLocalAiFallbackSpend(
  db: SqliteDriver,
  query: LocalAiFallbackSpendQuery,
): LocalAiFallbackSpend {
  const conditions = [
    "disposition IN ('allowed', 'pending-confirmation')",
  ];
  const params: unknown[] = [];
  if (query.reservationsOnly) {
    conditions.push('completed_at IS NULL', 'created_at <= ?');
    params.push(query.until);
  } else {
    conditions.push(`(
      (completed_at IS NOT NULL AND completed_at >= ? AND completed_at <= ?)
      OR (completed_at IS NULL AND created_at <= ?)
    )`);
    params.push(query.since, query.until, query.until);
  }
  if (query.targetId) {
    conditions.push('target_id = ?');
    params.push(query.targetId);
  }
  if (query.incidentId) {
    conditions.push('incident_id = ?');
    params.push(query.incidentId);
  }
  if (query.excludeEventId) {
    conditions.push('id <> ?');
    params.push(query.excludeEventId);
  }
  const row = db.prepareCached(`
    SELECT
      COALESCE(SUM(known_cost_usd), 0) AS known_cost_usd,
      COALESCE(SUM(CASE WHEN known_cost_usd IS NULL THEN estimated_cost_usd ELSE 0 END), 0)
        AS estimated_cost_usd,
      COALESCE(SUM(CASE
        WHEN known_cost_usd IS NULL AND estimated_cost_usd IS NULL
          AND (completed_at IS NOT NULL OR created_at >= ?)
        THEN 1 ELSE 0
      END), 0) AS unknown_reservations
    FROM local_ai_routing_events
    WHERE ${conditions.join(' AND ')}
  `).get<{
    known_cost_usd: number;
    estimated_cost_usd: number;
    unknown_reservations: number;
  }>(query.until - UNKNOWN_RESERVATION_FRESH_MS, ...params);
  return {
    knownCostUsd: row?.known_cost_usd ?? 0,
    estimatedCostUsd: row?.estimated_cost_usd ?? 0,
    unknownReservations: row?.unknown_reservations ?? 0,
  };
}
