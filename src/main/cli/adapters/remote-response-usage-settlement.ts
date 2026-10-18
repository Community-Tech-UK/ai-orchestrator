import type { CliResponse } from './base-cli-adapter.types';
import { deferResponseUsage } from './deferred-response-usage';

const USAGE_SETTLEMENT_MARKER = 'aioRemoteUsageSettlement';
type SettlementState = 'pending' | 'settled';

export function isRemoteUsageFinalization(response: CliResponse): boolean {
  return response.metadata?.[USAGE_SETTLEMENT_MARKER] === 'settled';
}

/** A transport marker carries lifecycle timing, never an in-process callback. */
export function markRemoteUsageSettlement(response: CliResponse, state: SettlementState): CliResponse {
  return { ...response, ...(response.usage ? { usage: { ...response.usage } } : {}),
    metadata: { ...response.metadata, [USAGE_SETTLEMENT_MARKER]: state } };
}

/** One semantic completion, with a later numeric update to that same response. */
export class RemoteResponseUsageSettlement {
  private readonly pending = new Map<string, { response: CliResponse; settle: () => void }>();

  get hasPending(): boolean { return this.pending.size > 0; }

  accept(response: CliResponse): CliResponse | undefined {
    const state = response.metadata?.[USAGE_SETTLEMENT_MARKER];
    if (state === 'settled') {
      const entry = this.pending.get(response.id);
      if (entry) {
        this.pending.delete(response.id);
        entry.response.usage = response.usage;
        entry.settle();
      }
      return undefined;
    }
    if (state === 'pending') {
      if (this.pending.has(response.id)) return undefined;
      // Strip the internal transport marker from semantic provider output.
      const metadata = { ...response.metadata };
      delete metadata[USAGE_SETTLEMENT_MARKER];
      const semantic = { ...response, metadata };
      this.pending.set(response.id, { response: semantic, settle: deferResponseUsage(semantic) });
      return semantic;
    }
    return response;
  }

  /** A stopped remote instance cannot leave billing observers pending forever. */
  settleAll(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.settle();
  }
}
