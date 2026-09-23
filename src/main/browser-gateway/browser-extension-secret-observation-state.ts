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

/** Last good report per extension queue. A malformed report never replaces it. */
export class SecretObservationTracker {
  private readonly byQueue = new Map<string, BrowserExtensionSecretObservationState>();

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
