import type { InstanceStatus } from '@contracts/types/instance-events';
import { attentionLevelForInstanceStatus } from './attention-level';

export type NeedsYouKind = 'answer' | 'check' | 'applied';
export type NeedsYouSource = 'session' | 'loop-run' | 'automation-run' | 'repo-job'
  | 'permission-request' | 'browser-approval' | 'paid-fallback' | 'plan-queue-question'
  | 'doc-review' | 'memory-review' | 'sidechat' | 'loop-question' | 'loop-decision' | 'tool-loop';

export interface NeedsYouEntry {
  key: string;
  source: NeedsYouSource;
  kind: NeedsYouKind;
  title: string;
  detail?: string;
  instanceId?: string;
  route?: string;
  deadlineAt?: number;
  since: number;
  version: string;
}

/** Only document reviews use this window; B5 owns loop question eligibility. */
export const NEEDS_YOU_RECENCY_MS = 7 * 24 * 60 * 60_000;

export function instanceNeedsYouKind(
  status: InstanceStatus,
  extras: { pendingApprovals?: number; toolLoopCritical?: boolean } = {},
): NeedsYouKind | null {
  const attention = attentionLevelForInstanceStatus(status);
  if (attention === 'blocked' || (extras.pendingApprovals ?? 0) > 0 || extras.toolLoopCritical) return 'answer';
  return attention === 'failed' ? 'check' : null;
}

export function sortNeedsYou(entries: readonly NeedsYouEntry[]): NeedsYouEntry[] {
  const rank = { answer: 0, applied: 1, check: 2 };
  return [...entries].sort((a, b) => rank[a.kind] - rank[b.kind]
    || (a.kind === 'answer'
      ? (a.deadlineAt ?? Infinity) - (b.deadlineAt ?? Infinity) || a.since - b.since
      : b.since - a.since)
    || a.key.localeCompare(b.key));
}
