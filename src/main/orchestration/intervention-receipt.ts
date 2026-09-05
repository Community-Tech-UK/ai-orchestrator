/**
 * B3 — a receipt for every operator intervention.
 *
 * You send a hint and today you learn nothing. It might be in this iteration's
 * prompt, held back by the merge budget, returned to the queue because an
 * earlier lease was never acked, or dropped because the queue overflowed. All
 * four already happen inside `loop-intervention-lease.ts`; none of them is
 * reported, so "did the agent get my message?" has no answer.
 *
 * Pure: turns a lease outcome into an operator-facing record. Sits on top of
 * L8 rather than inside it, so the lease logic stays about leasing.
 */

import type { LeasedLoopPendingInput } from './loop-intervention-lease';

export type InterventionFate =
  /** In this iteration's prompt. */
  | 'delivered'
  /** Held back by the merge budget; will be offered again next iteration. */
  | 'held'
  /** Returned to the queue because an earlier iteration never acked its lease. */
  | 'returned'
  /** Discarded because the queue exceeded its ceiling. */
  | 'dropped';

export interface InterventionReceipt {
  id: string;
  kind: string;
  source: string;
  fate: InterventionFate;
  /** Iteration this receipt describes. */
  seq: number;
  /** How long the payload waited before this outcome, in ms. */
  waitedMs: number;
  /** Short excerpt so a log line is readable without joining tables. */
  excerpt: string;
  at: number;
}

const MAX_EXCERPT_CHARS = 80;

function excerptOf(message: string): string {
  const flat = (message ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_EXCERPT_CHARS ? flat : `${flat.slice(0, MAX_EXCERPT_CHARS - 1)}…`;
}

function receipt(
  item: LeasedLoopPendingInput,
  fate: InterventionFate,
  seq: number,
  now: number,
): InterventionReceipt {
  return {
    id: item.id,
    kind: item.kind,
    source: item.source,
    fate,
    seq,
    waitedMs: Math.max(0, now - (item.enqueuedAt ?? now)),
    excerpt: excerptOf(item.message),
    at: now,
  };
}

export interface ReceiptInput {
  /** Payloads embedded in this iteration's prompt. */
  leased: readonly LeasedLoopPendingInput[];
  /** Payloads the merge budget held back. */
  sealed?: readonly LeasedLoopPendingInput[];
  /** Payloads dropped by the queue ceiling. */
  dropped?: readonly LeasedLoopPendingInput[];
  /** Count of leases returned because a previous iteration never acked. */
  releasedCount?: number;
  seq: number;
  now: number;
}

/**
 * Build receipts for one iteration's lease step.
 *
 * `released` is a count rather than a list in `PreparedIterationInterventions`,
 * so it cannot produce per-payload receipts. Reporting a count as if it were
 * identified payloads would be a confident overstatement, so it is surfaced
 * separately by `summariseReceipts` instead of being faked here.
 */
export function buildInterventionReceipts(input: ReceiptInput): InterventionReceipt[] {
  return [
    ...input.leased.map((i) => receipt(i, 'delivered', input.seq, input.now)),
    ...(input.sealed ?? []).map((i) => receipt(i, 'held', input.seq, input.now)),
    ...(input.dropped ?? []).map((i) => receipt(i, 'dropped', input.seq, input.now)),
  ];
}

export interface ReceiptSummary {
  delivered: number;
  held: number;
  dropped: number;
  returned: number;
  /** Null when nothing needs saying, so callers can skip logging entirely. */
  line: string | null;
}

/** One log-friendly line. Silent when the only thing that happened is delivery. */
export function summariseReceipts(
  receipts: readonly InterventionReceipt[],
  releasedCount = 0,
): ReceiptSummary {
  const count = (fate: InterventionFate) => receipts.filter((r) => r.fate === fate).length;
  const delivered = count('delivered');
  const held = count('held');
  const dropped = count('dropped');

  const notable: string[] = [];
  if (held > 0) notable.push(`${held} held back by the merge budget`);
  if (dropped > 0) notable.push(`${dropped} dropped (queue full)`);
  if (releasedCount > 0) notable.push(`${releasedCount} returned from an unacked lease`);

  return {
    delivered,
    held,
    dropped,
    returned: releasedCount,
    // Plain delivery is the expected case and not worth a line; anything else
    // means an operator's message did not go where they assumed.
    line: notable.length === 0
      ? null
      : `${delivered} intervention${delivered === 1 ? '' : 's'} delivered; ${notable.join(', ')}.`,
  };
}

export interface ReportReceiptsInput {
  leased: readonly LeasedLoopPendingInput[];
  dropped?: readonly LeasedLoopPendingInput[];
  sealed?: readonly LeasedLoopPendingInput[];
  releasedCount?: number;
  seq: number;
  now?: number;
}

/**
 * Build, summarise and hand back a line to log — or `null` when nothing needs
 * saying. Lives here rather than at the call site because the coordinator is at
 * its LOC ceiling, and because "when is this worth reporting" is part of the
 * receipt policy rather than part of running an iteration.
 */
export function reportInterventionReceipts(input: ReportReceiptsInput): ReceiptSummary {
  return summariseReceipts(
    buildInterventionReceipts({
      leased: input.leased,
      sealed: input.sealed,
      dropped: input.dropped,
      seq: input.seq,
      now: input.now ?? Date.now(),
    }),
    input.releasedCount ?? 0,
  );
}
