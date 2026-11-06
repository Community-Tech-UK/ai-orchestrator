/** Discard keeps the job parked but takes it off the Set aside list. */
export function planQueueIsDiscarded(item: { discardedAt?: number | null }): boolean {
  return Boolean(item.discardedAt);
}
