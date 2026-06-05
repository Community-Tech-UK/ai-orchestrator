/**
 * Runtime receipt helpers (backlog A6: "awaitReceipt/drainRuntime test helpers
 * — kill sleeps").
 *
 * Adapter/runtime tests historically waited on `await sleep(500)` and hoped the
 * event they cared about had fired by then — slow and flaky. These helpers turn
 * the adapter's typed lifecycle events ({@link CliAdapterEvents}) into awaitable
 * "receipts" so a test can deterministically block until *exactly* the event it
 * expects arrives (or a real timeout elapses), with a useful failure message
 * listing what actually happened.
 *
 * Works against any {@link EventEmitter} that emits the canonical adapter event
 * names — {@link ScriptedCliAdapter}, a real adapter, or a plain emitter.
 */

import type { EventEmitter } from 'events';

/** The canonical adapter lifecycle event names (mirror of CliAdapterEvents keys). */
export const RUNTIME_EVENT_TYPES = [
  'spawned',
  'output',
  'tool_use',
  'tool_result',
  'status',
  'error',
  'complete',
  'exit',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

/** A recorded lifecycle event with ordering + timing metadata. */
export interface Receipt {
  /** Monotonic sequence number across this recorder (0-based). */
  seq: number;
  type: RuntimeEventType;
  /** The raw listener arguments for the event. */
  args: unknown[];
  /** ms timestamp when the event was observed. */
  at: number;
}

/** Match a receipt by type and an optional predicate over its args. */
export interface ReceiptMatch {
  type: RuntimeEventType;
  predicate?: (args: unknown[]) => boolean;
}

/**
 * Records every lifecycle event emitted by an adapter into an ordered log.
 * Attach once at the start of a test; read {@link receipts} afterwards or use
 * {@link awaitReceipt}/{@link drainRuntime}. Call {@link dispose} to detach.
 */
export class ReceiptRecorder {
  private readonly log: Receipt[] = [];
  private seq = 0;
  private readonly bound = new Map<RuntimeEventType, (...args: unknown[]) => void>();
  private readonly waiters = new Set<(receipt: Receipt) => void>();

  constructor(private readonly emitter: EventEmitter) {
    for (const type of RUNTIME_EVENT_TYPES) {
      const listener = (...args: unknown[]): void => {
        const receipt: Receipt = { seq: this.seq++, type, args, at: Date.now() };
        this.log.push(receipt);
        // Notify live waiters (awaitReceipt/drainRuntime). Waiters only ever
        // remove themselves here (never add), so iterating the Set directly is
        // safe — Set iteration tolerates deletion of visited entries.
        for (const waiter of this.waiters) waiter(receipt);
      };
      this.bound.set(type, listener);
      emitter.on(type, listener);
    }
  }

  /** All receipts so far, in emission order. */
  receipts(): Receipt[] {
    return [...this.log];
  }

  /** Receipts of a single type. */
  ofType(type: RuntimeEventType): Receipt[] {
    return this.log.filter((r) => r.type === type);
  }

  /** Internal: register/unregister a live waiter. */
  _addWaiter(fn: (receipt: Receipt) => void): () => void {
    this.waiters.add(fn);
    return () => this.waiters.delete(fn);
  }

  /** Detach all listeners. */
  dispose(): void {
    for (const [type, listener] of this.bound) {
      this.emitter.off(type, listener);
    }
    this.bound.clear();
    this.waiters.clear();
  }
}

function describeReceipts(receipts: Receipt[]): string {
  if (receipts.length === 0) return '(no events observed)';
  return receipts.map((r) => r.type).join(' → ');
}

export interface AwaitReceiptOptions {
  timeoutMs?: number;
  /**
   * A recorder to also scan for an ALREADY-emitted matching receipt before
   * waiting — avoids a race when the event may have fired before the await.
   */
  recorder?: ReceiptRecorder;
}

/**
 * Resolve with the first receipt matching `match`. If a `recorder` is supplied
 * and a matching receipt was already recorded, resolve immediately with it;
 * otherwise listen forward. Rejects after `timeoutMs` (default 2000) with a
 * message listing the events seen so far.
 */
export function awaitReceipt(
  emitter: EventEmitter,
  match: ReceiptMatch | RuntimeEventType,
  options: AwaitReceiptOptions = {},
): Promise<Receipt> {
  const m: ReceiptMatch = typeof match === 'string' ? { type: match } : match;
  const timeoutMs = options.timeoutMs ?? 2000;
  const matches = (r: Receipt): boolean => r.type === m.type && (!m.predicate || m.predicate(r.args));

  return new Promise<Receipt>((resolve, reject) => {
    // Fast path: already recorded?
    if (options.recorder) {
      const existing = options.recorder.receipts().find(matches);
      if (existing) {
        resolve(existing);
        return;
      }
    }

    let settled = false;
    let removeWaiter: (() => void) | null = null;
    let seq = 0;

    const listener = (...args: unknown[]): void => {
      const receipt: Receipt = { seq: seq++, type: m.type, args, at: Date.now() };
      if (matches(receipt)) finish(receipt);
    };

    const timer = setTimeout(() => {
      const seen = options.recorder ? describeReceipts(options.recorder.receipts()) : '(no recorder)';
      finishError(
        new Error(`awaitReceipt timed out after ${timeoutMs}ms waiting for '${m.type}'. Events seen: ${seen}`),
      );
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      emitter.off(m.type, listener);
      if (removeWaiter) removeWaiter();
    }
    function finish(receipt: Receipt): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(receipt);
    }
    function finishError(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    // Prefer the recorder's waiter channel (carries proper seq/args); also bind
    // directly so it works without a recorder.
    if (options.recorder) {
      removeWaiter = options.recorder._addWaiter((r) => {
        if (matches(r)) finish(r);
      });
    } else {
      emitter.on(m.type, listener);
    }
  });
}

export interface DrainOptions {
  /** Resolve once no new event has arrived for this long. Default 50ms. */
  idleMs?: number;
  /** Hard cap; reject if neither idle nor a terminal event by then. Default 2000ms. */
  timeoutMs?: number;
  /** Treat these event types as terminal (resolve immediately). Default ['complete','exit']. */
  terminalTypes?: RuntimeEventType[];
}

/**
 * Wait until the runtime goes quiet: resolves with all receipts seen once a
 * terminal event ('complete'/'exit' by default) is observed, or after `idleMs`
 * with no new event. Replaces `await sleep(...)` at the end of a test.
 *
 * Requires a {@link ReceiptRecorder} so it can both read already-seen receipts
 * and react to new ones.
 */
export function drainRuntime(recorder: ReceiptRecorder, options: DrainOptions = {}): Promise<Receipt[]> {
  const idleMs = options.idleMs ?? 50;
  const timeoutMs = options.timeoutMs ?? 2000;
  const terminalTypes = options.terminalTypes ?? ['complete', 'exit'];

  return new Promise<Receipt[]>((resolve, reject) => {
    let settled = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let removeWaiter: (() => void) | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      if (removeWaiter) removeWaiter();
      resolve(recorder.receipts());
    };

    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, idleMs);
      if (idleTimer && typeof idleTimer === 'object' && 'unref' in idleTimer) idleTimer.unref();
    };

    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (removeWaiter) removeWaiter();
      reject(new Error(`drainRuntime timed out after ${timeoutMs}ms. Events seen: ${describeReceipts(recorder.receipts())}`));
    }, timeoutMs);

    // Already terminal?
    if (recorder.receipts().some((r) => terminalTypes.includes(r.type))) {
      finish();
      return;
    }

    removeWaiter = recorder._addWaiter((r) => {
      if (terminalTypes.includes(r.type)) {
        finish();
        return;
      }
      armIdle();
    });

    // Start the idle clock in case nothing else ever arrives.
    armIdle();
  });
}
