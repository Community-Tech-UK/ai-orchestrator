/**
 * The extension's own view of secret observation protection, as last returned
 * by a `report_inventory` command on this queue. Counts, never origins: the
 * tainted origins are exactly the sites a secret was typed into.
 */
export interface BrowserExtensionSecretObservationState {
  protectionEnabled: boolean;
  taintedOriginCount: number;
  taintedTabCount: number;
  observedAt: number;
}

function parseSecretObservationState(
  result: unknown,
): Omit<BrowserExtensionSecretObservationState, 'observedAt'> | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }
  const raw = (result as Record<string, unknown>)['secretObservation'];
  if (!raw || typeof raw !== 'object') {
    // Extensions before 0.2.34 do not report it.
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
  const taintedOriginCount = count(record['taintedOriginCount']);
  const taintedTabCount = count(record['taintedTabCount']);
  if (
    typeof record['protectionEnabled'] !== 'boolean'
    || taintedOriginCount === undefined
    || taintedTabCount === undefined
  ) {
    return undefined;
  }
  return { protectionEnabled: record['protectionEnabled'], taintedOriginCount, taintedTabCount };
}

/**
 * How long a sent `report_inventory` may still deliver its report. The
 * coordinator's refresh budget can expire before a real multi-tab inventory
 * finishes, and the late reply still carries the only protection report
 * (LT-617).
 */
const INVENTORY_REPORT_GRACE_MS = 5 * 60_000;

/** Last good report per extension queue. A malformed report never replaces it. */
export class SecretObservationTracker {
  private readonly byQueue = new Map<string, BrowserExtensionSecretObservationState>();
  /** Sent report_inventory command ids → queue and the time their report stops counting. */
  private readonly expectedReports = new Map<string, { queueKey: string; expiresAt: number }>();

  /** Remember a sent report_inventory so its reply is trusted even if it arrives late. */
  expectReport(commandId: string, queueKey: string, now = Date.now()): void {
    for (const [id, entry] of this.expectedReports) {
      if (entry.expiresAt <= now) this.expectedReports.delete(id);
    }
    this.expectedReports.set(commandId, { queueKey, expiresAt: now + INVENTORY_REPORT_GRACE_MS });
  }

  /**
   * Record the report carried by a command result, but only when that command
   * was a report_inventory sent on this queue. Other results can carry
   * page-controlled data (an evaluate result is whatever the page returns), so
   * a `secretObservation` key in one of those must never become health state.
   */
  recordReport(commandId: string, queueKey: string, result: unknown, now = Date.now()): void {
    const expected = this.expectedReports.get(commandId);
    if (!expected || expected.queueKey !== queueKey || expected.expiresAt <= now) return;
    this.expectedReports.delete(commandId);
    this.record(queueKey, result);
  }

  record(queueKey: string, result: unknown): void {
    const state = parseSecretObservationState(result);
    if (state) {
      this.byQueue.set(queueKey, { ...state, observedAt: Date.now() });
    }
  }

  get(queueKey: string): BrowserExtensionSecretObservationState | undefined {
    return this.byQueue.get(queueKey);
  }
}
