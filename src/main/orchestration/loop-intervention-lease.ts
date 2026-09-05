/**
 * L8 — lease / ack / re-queue for the loop intervention queue.
 *
 * The queue used to be an unbounded array that the coordinator emptied *before*
 * dispatching the child: `state.pendingInterventions = deferredFollowUps` ran,
 * then `invokeChild` was awaited. Two failure modes fell out of that:
 *
 *  1. **Silent loss.** A crash, cancel, or transport failure between the clear
 *     and the delivery threw the operator's steer away. Nothing re-queued it.
 *  2. **Double-apply.** A checkpoint written while the payload was still in the
 *     array replayed the same reviewer finding into the next prompt, which
 *     reads as the builder ignoring a finding and trips `builder-unreliable`.
 *
 * The lease makes delivery explicit. Items stay in the queue while leased to an
 * iteration; an ack drops them; a stale lease (the iteration ended without an
 * ack) returns them to the queue. Every step is pure and total, so the
 * coordinator seam stays a few lines.
 *
 * Overflow is sealed rather than truncated mid-payload: OpenClaw's
 * `MAX_MERGED_STEERING_CHARS`. What does not fit stays queued for the next
 * iteration with a visible note, so nothing is dropped without the child being
 * told there is more.
 */

import { coercePendingInput, type LoopPendingInput } from '../../shared/types/loop.types';

/** OpenClaw's merged steering budget. Beyond this the batch seals. */
export const MAX_MERGED_STEERING_CHARS = 24_000;

/**
 * Hard ceiling on queue length. A runaway producer (a reviewer emitting a
 * finding per round for hours) must not grow the checkpoint without bound.
 * The oldest entries are dropped first and the drop is reported, never silent.
 */
export const MAX_PENDING_INTERVENTIONS = 200;

/** A lease older than this is assumed dead and its payload re-queues. */
export const LEASE_STALE_MS = 30 * 60 * 1000;

export interface LeasedLoopPendingInput extends LoopPendingInput {
  /** Iteration sequence this payload was handed to. */
  leaseSeq?: number;
  /** When the lease was taken. */
  leasedAt?: number;
}

export interface LeaseResult {
  /** Payloads embedded in this iteration's prompt, in queue order. */
  leased: LeasedLoopPendingInput[];
  /**
   * The full queue to store on state: leased items (now carrying a lease) plus
   * everything held back — deferred follow-ups and anything the seal excluded.
   */
  queue: LeasedLoopPendingInput[];
  /** Payloads the merge budget could not fit this iteration. */
  sealed: LeasedLoopPendingInput[];
}

function messageCost(item: LoopPendingInput): number {
  // The rendered form is `N. [kind/source] message`; the prefix is small and
  // bounded, so the message length plus a fixed allowance is a fair estimate.
  return item.message.length + 32;
}

/**
 * Take a lease on the payloads that go into iteration `seq`'s prompt.
 *
 * `drainNow` decides which payloads are eligible (follow-ups are held for the
 * completion seam); this function decides how many of them fit and records the
 * lease. Items are never removed here — {@link ackLeasedInterventions} does
 * that once delivery is confirmed.
 */
export function leaseInterventionsForIteration(args: {
  pending: readonly (string | LoopPendingInput)[];
  seq: number;
  now?: number;
  maxMergedChars?: number;
  /** Predicate for "eligible for this prompt" (follow-ups are not). */
  isEligible?: (item: LoopPendingInput) => boolean;
}): LeaseResult {
  const now = args.now ?? Date.now();
  const budget = args.maxMergedChars ?? MAX_MERGED_STEERING_CHARS;
  const isEligible = args.isEligible ?? ((item) => item.kind !== 'follow-up');
  const coerced = args.pending.map((item) => coercePendingInput(item) as LeasedLoopPendingInput);

  const leased: LeasedLoopPendingInput[] = [];
  const sealed: LeasedLoopPendingInput[] = [];
  const queue: LeasedLoopPendingInput[] = [];
  let used = 0;
  let sealedByBudget = false;

  for (const item of coerced) {
    if (!isEligible(item)) {
      // Never carry a stale lease on a held item.
      const { leaseSeq: _seq, leasedAt: _at, ...rest } = item;
      queue.push(rest);
      continue;
    }
    const cost = messageCost(item);
    // Always admit the first eligible payload even when it alone exceeds the
    // budget: dropping it would starve the child of the only direction it has.
    const fits = !sealedByBudget && (leased.length === 0 || used + cost <= budget);
    if (!fits) {
      sealedByBudget = true;
      const { leaseSeq: _seq, leasedAt: _at, ...rest } = item;
      sealed.push(rest);
      queue.push(rest);
      continue;
    }
    used += cost;
    const withLease: LeasedLoopPendingInput = { ...item, leaseSeq: args.seq, leasedAt: now };
    leased.push(withLease);
    queue.push(withLease);
  }

  return { leased, queue, sealed };
}

/** The note appended to the prompt when the merge budget sealed the batch. */
export function renderSealNote(sealedCount: number): string {
  if (sealedCount <= 0) return '';
  return `\n(${sealedCount} further queued message${sealedCount === 1 ? '' : 's'} did not fit this `
    + 'iteration and will be delivered next iteration — do not treat this list as complete.)';
}

/**
 * Delivery confirmed: drop everything leased to `seq`. Payloads leased to a
 * different iteration, and unleased payloads, are untouched.
 */
export function ackLeasedInterventions(
  pending: readonly (string | LoopPendingInput)[],
  seq: number,
): LeasedLoopPendingInput[] {
  return pending
    .map((item) => coercePendingInput(item) as LeasedLoopPendingInput)
    .filter((item) => item.leaseSeq !== seq);
}

/**
 * The iteration ended without an ack (crash, cancel, transport failure, or a
 * process restart). Return its payloads to the queue so the next prompt carries
 * them instead of losing the operator's direction.
 *
 * `staleMs` also releases leases from a previous app boot, whose iteration
 * sequence may collide with a fresh one.
 */
export function releaseStaleLeases(
  pending: readonly (string | LoopPendingInput)[],
  args: { seq?: number; beforeSeq?: number; now?: number; staleMs?: number } = {},
): { queue: LeasedLoopPendingInput[]; released: number } {
  const now = args.now ?? Date.now();
  const staleMs = args.staleMs ?? LEASE_STALE_MS;
  const noSelector = args.seq === undefined && args.beforeSeq === undefined;
  let released = 0;
  const queue = pending.map((item) => {
    const coerced = coercePendingInput(item) as LeasedLoopPendingInput;
    if (coerced.leaseSeq === undefined) return coerced;
    const matchesSeq = args.seq !== undefined && coerced.leaseSeq === args.seq;
    // A lease held by an earlier iteration belongs to a turn that has already
    // ended without acking — that is exactly the crash/cancel case.
    const abandoned = args.beforeSeq !== undefined && coerced.leaseSeq < args.beforeSeq;
    const expired = now - (coerced.leasedAt ?? 0) > staleMs;
    if (!(noSelector || matchesSeq || abandoned || expired)) return coerced;
    released += 1;
    const { leaseSeq: _seq, leasedAt: _at, ...rest } = coerced;
    return rest;
  });
  return { queue, released };
}

/**
 * Bound the queue. Oldest first, because a stale hint is worth less than the
 * direction the operator just typed, and the caller reports the drop.
 */
export function boundInterventionQueue(
  pending: readonly (string | LoopPendingInput)[],
  max = MAX_PENDING_INTERVENTIONS,
): { queue: LeasedLoopPendingInput[]; dropped: LeasedLoopPendingInput[] } {
  const coerced = pending.map((item) => coercePendingInput(item) as LeasedLoopPendingInput);
  if (coerced.length <= max) return { queue: coerced, dropped: [] };
  const overflow = coerced.length - max;
  return { queue: coerced.slice(overflow), dropped: coerced.slice(0, overflow) };
}

export interface PreparedIterationInterventions {
  /** Payloads embedded in this iteration's prompt. */
  leased: LeasedLoopPendingInput[];
  /** The queue to store on state until the ack. */
  queue: LeasedLoopPendingInput[];
  /** Prompt suffix naming what the merge budget held back; '' when nothing was. */
  sealNote: string;
  /** Payloads returned to the queue because an earlier iteration never acked. */
  released: number;
  /** Payloads dropped because the queue exceeded its ceiling. */
  dropped: LeasedLoopPendingInput[];
}

/**
 * The whole per-iteration lease step in one call: release abandoned leases,
 * bound the queue, take this iteration's lease, and render the seal note.
 * Keeps the coordinator seam to a few lines.
 */
export function prepareIterationInterventions(
  pending: readonly (string | LoopPendingInput)[],
  seq: number,
  now = Date.now(),
): PreparedIterationInterventions {
  const released = releaseStaleLeases(pending, { beforeSeq: seq, now });
  const bounded = boundInterventionQueue(released.queue);
  const lease = leaseInterventionsForIteration({ pending: bounded.queue, seq, now });
  return {
    leased: lease.leased,
    queue: lease.queue,
    sealNote: renderSealNote(lease.sealed.length),
    released: released.released,
    dropped: bounded.dropped,
  };
}
