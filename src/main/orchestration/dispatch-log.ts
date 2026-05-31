/**
 * Dispatch log / mailbox (claude2_todo #21).
 *
 * Models agent→agent handoffs as an idempotent, replayable state machine:
 *
 *     pending ──notify──▶ notified ──deliver──▶ delivered
 *        │                   │
 *        └──────fail─────────┴──────────────▶ failed ──retry──▶ pending
 *
 * "Did this handoff land?" is answered by construction. `create` is idempotent
 * by message id (re-creating returns the existing record), and `pending()` /
 * `replayable()` let a supervisor re-drive undelivered messages after a crash.
 *
 * Pure and in-memory; `now` is injectable for deterministic tests. A persistent
 * backing store can wrap this by replaying records on load.
 */

export type DispatchStatus = 'pending' | 'notified' | 'delivered' | 'failed';

export interface DispatchRecord {
  id: string;
  from: string;
  to: string;
  payload?: unknown;
  status: DispatchStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

/** Allowed transitions. Re-applying a current state is a no-op (idempotent). */
const TRANSITIONS: Record<DispatchStatus, DispatchStatus[]> = {
  pending: ['notified', 'failed'],
  notified: ['delivered', 'failed'],
  delivered: [],
  failed: ['pending'], // retry
};

export class DispatchTransitionError extends Error {
  constructor(public readonly id: string, from: DispatchStatus, to: DispatchStatus) {
    super(`Invalid dispatch transition for "${id}": ${from} → ${to}`);
    this.name = 'DispatchTransitionError';
  }
}

export class DispatchLog {
  private readonly records = new Map<string, DispatchRecord>();

  /** Create a handoff. Idempotent: an existing id returns its current record. */
  create(
    id: string,
    from: string,
    to: string,
    payload?: unknown,
    now: number = Date.now(),
  ): DispatchRecord {
    const existing = this.records.get(id);
    if (existing) return existing;
    const record: DispatchRecord = {
      id, from, to, payload, status: 'pending', attempts: 0, createdAt: now, updatedAt: now,
    };
    this.records.set(id, record);
    return record;
  }

  private transition(
    id: string,
    to: DispatchStatus,
    now: number,
    mutate?: (r: DispatchRecord) => void,
  ): DispatchRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown dispatch: ${id}`);
    if (record.status === to) return record; // idempotent
    if (!TRANSITIONS[record.status].includes(to)) {
      throw new DispatchTransitionError(id, record.status, to);
    }
    record.status = to;
    record.updatedAt = now;
    mutate?.(record);
    return record;
  }

  markNotified(id: string, now: number = Date.now()): DispatchRecord {
    return this.transition(id, 'notified', now, (r) => { r.attempts += 1; });
  }

  markDelivered(id: string, now: number = Date.now()): DispatchRecord {
    return this.transition(id, 'delivered', now, (r) => { r.error = undefined; });
  }

  markFailed(id: string, error: string, now: number = Date.now()): DispatchRecord {
    return this.transition(id, 'failed', now, (r) => { r.error = error; });
  }

  /** Move a failed message back to pending for another attempt. */
  retry(id: string, now: number = Date.now()): DispatchRecord {
    return this.transition(id, 'pending', now);
  }

  get(id: string): DispatchRecord | undefined {
    return this.records.get(id);
  }

  list(status?: DispatchStatus): DispatchRecord[] {
    const all = [...this.records.values()];
    return status ? all.filter((r) => r.status === status) : all;
  }

  /** Messages not yet delivered or failed (i.e. still in flight). */
  pending(): DispatchRecord[] {
    return this.list().filter((r) => r.status === 'pending' || r.status === 'notified');
  }

  /** Records a supervisor should re-drive after a restart (in-flight + failed). */
  replayable(): DispatchRecord[] {
    return this.list().filter((r) => r.status !== 'delivered');
  }
}
