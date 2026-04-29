export type ChildStateCategory = 'failed' | 'waiting' | 'active' | 'stale' | 'idle';

export interface ChildStateTimelineEntry {
  status: string;
  timestamp: number;
}

export interface ChildStateInput {
  status: string;
  statusTimeline?: ChildStateTimelineEntry[];
  lastActivityAt?: number;
  heartbeatAt?: number;
  createdAt?: number;
}

export interface ChildDerivedState {
  category: ChildStateCategory;
  isFailed: boolean;
  isWaiting: boolean;
  isActive: boolean;
  isStale: boolean;
  turnCount: number;
  churnCount: number;
  isChurning: boolean;
  lastActivityAt: number;
  heartbeatAt?: number;
  ageMs: number;
}

export interface ChildStateDeriverOptions {
  staleThresholdMs?: number;
  churnWindowMs?: number;
  churnThreshold?: number;
  now?: number;
}

export const FAILED_STATUSES: ReadonlySet<string> = new Set([
  'error',
  'crashed',
  'failed',
]);

export const WAITING_STATUSES: ReadonlySet<string> = new Set([
  'waiting_for_input',
  'waiting_for_permission',
]);

export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'busy',
  'initializing',
  'processing',
  'thinking_deeply',
  'respawning',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
  'hibernating',
  'waking',
]);

const DEFAULT_STALE_THRESHOLD_MS = 30_000;
const DEFAULT_CHURN_WINDOW_MS = 60_000;
const DEFAULT_CHURN_THRESHOLD = 5;

export function deriveChildState(
  child: ChildStateInput,
  options: ChildStateDeriverOptions = {},
): ChildDerivedState {
  const now = options.now ?? Date.now();
  const staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const churnWindowMs = options.churnWindowMs ?? DEFAULT_CHURN_WINDOW_MS;
  const churnThreshold = options.churnThreshold ?? DEFAULT_CHURN_THRESHOLD;
  const lastActivityAt = child.lastActivityAt ?? child.createdAt ?? now;
  const statusTimeline = child.statusTimeline ?? [
    { status: child.status, timestamp: lastActivityAt },
  ];
  const ageMs = Math.max(0, now - lastActivityAt);
  const turnCount = statusTimeline.length;
  const churnCount = statusTimeline.filter((entry) => now - entry.timestamp <= churnWindowMs).length;
  const isChurning = churnCount >= churnThreshold;

  let category: ChildStateCategory;
  if (FAILED_STATUSES.has(child.status)) {
    category = 'failed';
  } else if (WAITING_STATUSES.has(child.status)) {
    category = 'waiting';
  } else if (ACTIVE_STATUSES.has(child.status)) {
    category = 'active';
  } else if (ageMs > staleThresholdMs) {
    category = 'stale';
  } else {
    category = 'idle';
  }

  return {
    category,
    isFailed: category === 'failed',
    isWaiting: category === 'waiting',
    isActive: category === 'active',
    isStale: category === 'stale',
    turnCount,
    churnCount,
    isChurning,
    lastActivityAt,
    heartbeatAt: child.heartbeatAt,
    ageMs,
  };
}
