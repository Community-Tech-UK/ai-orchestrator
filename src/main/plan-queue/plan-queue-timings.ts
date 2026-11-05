/**
 * Plan Queue timings: the measurements "Queue health" is computed from.
 *
 * Each one is a row in `plan_queue_item_events` with its own `reason`, so no new table exists. The row's states are
 * the item's current state (like `checklist-run`), which is why decision code that reads event history skips these
 * reasons (`NOT_TIMING_SQL`): a timing row is a measurement, never a state change. Measurement is best effort: a
 * failed write is logged and never changes what the queue does.
 */
import os from 'node:os';
import { getLogger } from '../logging/logger';
import type { PlanQueueItemState } from '@contracts/schemas/plan-queue';
import type { PlanQueueHistoryStore } from './plan-queue-history-store';
import type { PlanQueueFlowHost } from './plan-queue-host';

const logger = getLogger('PlanQueueTimings');

/** Event reasons that carry a timing. Payloads are JSON in `detail_head` (bounded, path-free). */
export const TIMING_REASONS = {
  /** `{ role: 'worker' | 'checker', instanceId, provider, model }` */
  sessionStart: 'session-start',
  /** `{ role, instanceId }` */
  sessionEnd: 'session-end',
  /** `{ kind: 'worker' | 'check', waitedMs, freeToStartMs }`: time an item was ready but every slot was taken. */
  slotWait: 'slot-wait',
  /** `{ kind: 'worker' | 'check', waitedMs }`: time an item waited for provider usage to come back. */
  usageWait: 'usage-wait',
  /** `{ outcome, syncMs?, mergeCheckMs?, commitCheckMs?, publishMs?, totalMs, loadStart?, loadEnd? }` (loads are the 1-minute average) */
  landing: 'landing-timing',
  /** `{}`: the item's turn in the one-at-a-time landing line began; until then it was waiting behind another landing. */
  landingStart: 'landing-start',
} as const;
export type PlanQueueTimingReason = (typeof TIMING_REASONS)[keyof typeof TIMING_REASONS];

const TIMING_REASON_LIST = Object.values(TIMING_REASONS);
const SQL_LIST = TIMING_REASON_LIST.map(reason => `'${reason}'`).join(', ');
/** Condition for queries that read state history: a timing row is not a state change. */
export const notTimingSql = (column = 'reason') => `(${column} IS NULL OR ${column} NOT IN (${SQL_LIST}))`;
export const NOT_TIMING_SQL = notTimingSql();
export const IS_TIMING_SQL = `reason IN (${SQL_LIST})`;

type TimedItem = { id: string; runId: string; state: PlanQueueItemState; round: number };

/** Write one timing row. Never throws: losing a measurement must not park or stall an item. */
export function recordTiming(history: Pick<PlanQueueHistoryStore, 'recordEvent'>, item: TimedItem, reason: PlanQueueTimingReason,
  detail: Record<string, string | number | null | undefined>): void {
  try {
    const clean = Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== undefined));
    history.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState: item.state, reason,
      detailHead: JSON.stringify(clean), round: item.round, tokens: 0 });
  } catch (error) {
    logger.warn('Plan queue: recording a timing failed', { itemId: item.id, reason, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Same, for a caller that has only the item's id. An item that is gone has nothing to measure. */
export function recordItemTiming(host: Pick<PlanQueueFlowHost, 'getItem' | 'history'>, itemId: string, reason: PlanQueueTimingReason,
  detail: Record<string, string | number | null | undefined>): void {
  let item: TimedItem;
  try { item = host.getItem(itemId); } catch { return; }
  recordTiming(host.history, item, reason, detail);
}

/** A worker or checker session began. `provider` and `model` are what the queue asked for or the session reported. */
export function recordSessionStart(host: Pick<PlanQueueFlowHost, 'getItem' | 'history'>, itemId: string, role: 'worker' | 'checker',
  instanceId: string, provider: string | null | undefined, model: string | null | undefined): void {
  recordItemTiming(host, itemId, TIMING_REASONS.sessionStart, { role, instanceId, provider: provider ?? null, model: model ?? null });
}

/** Runs while a session is being stopped, so like every timing write it must never throw into the stop. */
export function recordSessionEnd(host: Pick<PlanQueueFlowHost, 'getItem' | 'history' | 'roleOf'>, instanceId: string): void {
  try {
    const role = host.roleOf(instanceId);
    if (role?.role !== 'worker' && role?.role !== 'verifier') return;
    recordItemTiming(host, role.itemId, TIMING_REASONS.sessionEnd, { role: role.role === 'worker' ? 'worker' : 'checker', instanceId });
  } catch (error) {
    logger.warn('Plan queue: recording a session end failed', { instanceId, error: error instanceof Error ? error.message : String(error) });
  }
}

export type LandingPhase = 'sync' | 'mergeCheck' | 'commitCheck' | 'publish';

/**
 * Times the parts of one landing attempt: bringing the base branch in, the checks after that merge, the repository's
 * pre-commit check and the move onto the base branch. The machine's load is read at the start and end of the
 * pre-commit check, the step that times out when the machine is busy.
 */
export class LandingTimer {
  readonly phaseMs: Partial<Record<LandingPhase, number>> = {};
  hookLoad: { start: number; end: number } | null = null;
  private readonly startedAt: number;

  constructor(private readonly now: () => number = Date.now, private readonly load: () => number = () => os.loadavg()[0] ?? 0) {
    this.startedAt = now();
  }

  async measure<T>(phase: LandingPhase, run: () => Promise<T>): Promise<T> {
    const began = this.now();
    const loadStart = phase === 'commitCheck' ? this.load() : 0;
    try { return await run(); }
    finally {
      this.phaseMs[phase] = (this.phaseMs[phase] ?? 0) + Math.max(0, this.now() - began);
      if (phase === 'commitCheck') this.hookLoad = { start: loadStart, end: this.load() };
    }
  }

  /** Nothing measured means the attempt ended before any step ran (already landed, stray history): no row. */
  detail(outcome: string): Record<string, string | number> | null {
    if (!Object.keys(this.phaseMs).length) return null;
    const round = (value: number) => Math.round(value * 100) / 100;
    const phases = Object.fromEntries(Object.entries(this.phaseMs).map(([phase, ms]) => [`${phase}Ms`, ms]));
    return { outcome, ...phases, totalMs: Math.max(0, this.now() - this.startedAt),
      ...(this.hookLoad ? { loadStart: round(this.hookLoad.start), loadEnd: round(this.hookLoad.end) } : {}) };
  }
}

/**
 * Slot waits, in memory. An item is "waiting for a slot" only while the scheduler had it ready and no slot was free:
 * every item exists from the start of a run, so time since creation is not a wait. A wait in progress when the app
 * stops is not recorded; nothing else depends on it.
 *
 * `freeToStartMs` is how long after a slot freed up the waiting item started: the scheduler's own delay, which the
 * Plan Queue targets set at under a minute.
 */
export class PlanQueueSlotWaits {
  private readonly blockedSince = new Map<string, number>();
  private readonly freedAt: Record<'worker' | 'check', number> = { worker: 0, check: 0 };

  constructor(private readonly history: Pick<PlanQueueHistoryStore, 'recordEvent'>, private readonly now: () => number = Date.now) {}

  /** The scheduler had this item ready and no slot free. Only the first call starts the clock. */
  blocked(itemId: string): void { if (!this.blockedSince.has(itemId)) this.blockedSince.set(itemId, this.now()); }

  /** A slot of this kind opened: an item left the states that hold one. */
  freed(kind: 'worker' | 'check'): void { this.freedAt[kind] = this.now(); }

  /** The scheduler started this item. Records a wait only if it was blocked first. */
  started(item: TimedItem, kind: 'worker' | 'check'): void {
    const since = this.blockedSince.get(item.id);
    this.blockedSince.delete(item.id);
    if (since === undefined) return;
    const at = this.now();
    const freed = this.freedAt[kind];
    recordTiming(this.history, item, TIMING_REASONS.slotWait, { kind, waitedMs: Math.max(0, at - since),
      freeToStartMs: freed >= since ? Math.max(0, at - freed) : null });
  }

  /** Forget items that are no longer waiting for a start (parked, skipped, run ended). */
  prune(stillWaiting: ReadonlySet<string>): void {
    for (const id of this.blockedSince.keys()) if (!stillWaiting.has(id)) this.blockedSince.delete(id);
  }
}
