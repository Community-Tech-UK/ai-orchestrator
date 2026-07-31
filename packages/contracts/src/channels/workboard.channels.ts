/**
 * IPC channels for the Workboard's cross-domain operational-decision timeline
 * (WS-C1). Read-only: no persistence, no subscriptions — the main process
 * assembles `OperationalDecision[]` on demand from existing authoritative
 * stores (provider-limit ledger, loop store, compaction coordinator,
 * automation store, session-admission store).
 */
export const WORKBOARD_CHANNELS = {
  WORKBOARD_DECISIONS_FOR_ITEM: 'workboard:decisions-for-item',
} as const;
