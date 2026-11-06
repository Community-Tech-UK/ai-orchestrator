/**
 * Running cost of a session's helper fan-out (Oct-2 Phase D Step 4 item 4).
 *
 * The header already shows the session's own cost. A session that starts helpers (scouts included)
 * spends more through them, so this totals the helper sessions below it. A helper that has not
 * reported a cost yet is counted but not priced: the total is only ever what was reported.
 */

export interface FanoutInstance {
  id: string;
  parentId: string | null;
  contextUsage: { costEstimate?: number };
}

export interface FanoutCost {
  /** Helper sessions below this one, children and their children. */
  count: number;
  /** Helpers that reported a cost greater than zero. */
  pricedCount: number;
  unpricedCount: number;
  costUsd: number;
}

/** The fan-out below `rootId`, or null when the session has started no helpers. */
export function summariseFanoutCost(rootId: string, instances: readonly FanoutInstance[]): FanoutCost | null {
  const childrenOf = new Map<string, FanoutInstance[]>();
  for (const instance of instances) {
    if (instance.parentId) childrenOf.set(instance.parentId, [...(childrenOf.get(instance.parentId) ?? []), instance]);
  }
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  let count = 0;
  let priced = 0;
  let costUsd = 0;
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
      count += 1;
      const cost = child.contextUsage.costEstimate;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) { priced += 1; costUsd += cost; }
    }
  }
  return count === 0 ? null : { count, pricedCount: priced, unpricedCount: count - priced, costUsd };
}

export const FANOUT_COST_TOOLTIP =
  'Running cost of the helper sessions this session started, scouts included. A helper that has not reported a cost yet is not in the total.';
