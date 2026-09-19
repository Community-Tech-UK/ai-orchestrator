/**
 * Reclaim holds — instances a coordinator is still counting on while they sit
 * idle (a Plan Queue worker waiting for its verifier, for example).
 *
 * A hold does NOT exempt the instance: under memory pressure the governor may
 * still hibernate it, which is safe because its work is checkpointed and a
 * later send wakes it. The hold only moves it behind every unheld candidate,
 * so the governor reclaims someone else first. Deliberately separate from the
 * async-work inhibitor, which means "background provider work is in flight".
 */

const holds = new Map<string, string>();

export function holdFromReclaim(instanceId: string, owner: string): void {
  holds.set(instanceId, owner);
}

export function releaseReclaimHold(instanceId: string): void {
  holds.delete(instanceId);
}

export function hasReclaimHold(instanceId: string): boolean {
  return holds.has(instanceId);
}

export function _resetReclaimHoldsForTesting(): void {
  holds.clear();
}
