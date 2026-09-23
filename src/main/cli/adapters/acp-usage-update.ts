/**
 * ACP `usage_update` handling.
 *
 * OpenCode sends `{used, size, cost: {amount, currency}}` after each model
 * call. `used` is the latest call's input plus cache-read tokens, i.e. real
 * context-window occupancy, so it drives the context meter directly. `cost`
 * is the session's running total (OpenCode's `totalSessionCost`), not the
 * cost of one call, so a turn's cost is the change in that total.
 */

import type { AcpContextUsageEvent } from './acp-usage-estimator';

export interface AcpParsedUsageUpdate {
  used?: number;
  size?: number;
  /** Running session total in USD, when the agent reported one in USD. */
  sessionCostUsd?: number;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAcpUsageUpdate(raw: unknown): AcpParsedUsageUpdate {
  if (!isRecord(raw)) return {};
  const used = finiteNonNegative(raw['used']);
  const size = finiteNonNegative(raw['size']);
  const cost = isRecord(raw['cost']) ? raw['cost'] : undefined;
  const currency = typeof cost?.['currency'] === 'string' ? cost['currency'].toUpperCase() : 'USD';
  const sessionCostUsd = currency === 'USD' ? finiteNonNegative(cost?.['amount']) : undefined;
  return {
    ...(used !== undefined ? { used } : {}),
    ...(size !== undefined && size > 0 ? { size } : {}),
    ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}),
  };
}

/** A measured occupancy `context` event, or null when the update lacks `used`/`size`. */
export function buildAcpMeasuredContextEvent(
  update: AcpParsedUsageUpdate,
  cumulativeTokens: number,
): AcpContextUsageEvent | null {
  if (update.used === undefined || update.size === undefined) return null;
  return {
    used: update.used,
    total: update.size,
    percentage: Math.min((update.used / update.size) * 100, 100),
    cumulativeTokens,
  };
}

/**
 * Turns the agent's running session cost into per-turn costs.
 *
 * A new session starts from a known $0. A loaded session's baseline is unknown
 * until the agent reports a total outside a turn (for example while replaying
 * history); until then the first turn records no cost rather than billing the
 * whole resumed history to one turn.
 */
export class AcpSessionCostLedger {
  private baselineUsd: number | null = null;
  private turnTotalUsd: number | undefined;

  /** Call when a session opens. `fresh` is true for `session/new`. */
  reset(fresh: boolean): void {
    this.baselineUsd = fresh ? 0 : null;
    this.turnTotalUsd = undefined;
  }

  observe(sessionCostUsd: number | undefined, inTurn: boolean): void {
    if (sessionCostUsd === undefined) return;
    if (inTurn) {
      this.turnTotalUsd = sessionCostUsd;
    } else {
      this.baselineUsd = sessionCostUsd;
    }
  }

  /** The finished turn's cost in USD, or undefined when it cannot be known. */
  settleTurn(): number | undefined {
    const total = this.turnTotalUsd;
    this.turnTotalUsd = undefined;
    if (total === undefined) return undefined;
    const baseline = this.baselineUsd;
    this.baselineUsd = total;
    return baseline === null ? undefined : Math.max(0, total - baseline);
  }
}
