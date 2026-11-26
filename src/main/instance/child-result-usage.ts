/**
 * Helper-agent spend accounting (October follow-ups part 6a).
 *
 * `Instance.totalTokensUsed` is real lifetime spend only for adapters that
 * emit `cumulativeTokens`; for Claude it is context occupancy
 * (`instance-communication.ts` falls back to `usage.used`), which must never be
 * announced as "tokens used" — it can look wildly different from the Costs
 * page. This helper reports the child's recorded ledger token total: Phase 0
 * step 7b's per-turn cost ledger (written by `recordCompletionCost`, keyed by
 * the child's instance/session identity). The spend counters some adapters
 * publish (`contextUsage.cumulativeTokens`) are a secondary source when the
 * ledger holds no record; with neither, the announcement says "not measured".
 */

import { getCostTracker } from '../core/system/cost-tracker';

export type ChildSpendLookup =
  | string
  | {
      id?: string | undefined;
      sessionId?: string | undefined;
      contextUsage?: { cumulativeTokens?: number | undefined } | undefined;
    }
  | undefined;

export function childSpendTokens(child: ChildSpendLookup): number | undefined {
  const identity = typeof child === 'string'
    ? { instanceId: child }
    : { instanceId: child?.id, sessionId: child?.sessionId };
  if (identity.instanceId !== undefined || identity.sessionId !== undefined) {
    const ledger = getCostTracker().getSpendTokens(identity);
    if (ledger !== undefined) return ledger;
  }
  const spend = typeof child === 'string' ? undefined : child?.contextUsage?.cumulativeTokens;
  return typeof spend === 'number' && Number.isFinite(spend) ? spend : undefined;
}
