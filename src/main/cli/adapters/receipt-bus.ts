/**
 * ReceiptBus — typed, replay-friendly record of CLI adapter lifecycle events.
 *
 * Every event a {@link ScriptedCliAdapter} emits is mirrored into a `Receipt`
 * here, so deterministic tests can assert on *what happened* and synchronise on
 * *when* it happened — without arbitrary `await sleep(...)` calls.
 *
 * The two synchronisation primitives:
 *   - `awaitReceipt(predicate)` resolves as soon as a matching receipt exists
 *     (checking already-recorded receipts first, then future ones).
 *   - pair this with `drainRuntime(adapter)` (see scripted-cli-adapter) to wait
 *     for an in-flight scripted turn to finish playing.
 *
 * A6: "kill sleeps" — tests wait on receipts/turn-completion, never wall-clock.
 */

import type { CliEvent, CliResponse, CliToolCall, SpawnModeChange } from './base-cli-adapter.types';
import type { ContextUsage } from '../../../shared/types/instance.types';

/** Maps each adapter event name to the payload recorded for it. */
export interface ReceiptPayloadMap {
  output: string;
  tool_use: CliToolCall;
  tool_result: CliToolCall;
  status: string;
  context: ContextUsage;
  error: Error | string;
  complete: CliResponse;
  exit: { code: number | null; signal: string | null };
  spawned: number;
  spawn_mode: SpawnModeChange;
}

/** A single recorded lifecycle event. */
export interface Receipt<E extends CliEvent = CliEvent> {
  /** Monotonic sequence number (1-based), stable + deterministic across a run. */
  seq: number;
  /** Wall-clock timestamp (ms). Use `seq` for deterministic ordering assertions. */
  at: number;
  /** The event name. */
  type: E;
  /** The event payload, typed by `type`. */
  payload: ReceiptPayloadMap[E];
}

/** Predicate over a recorded receipt. */
export type ReceiptPredicate = (receipt: Receipt) => boolean;

interface Waiter {
  predicate: ReceiptPredicate;
  resolve: (receipt: Receipt) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface AwaitReceiptOptions {
  /** Reject after this many ms (omit/0 = wait indefinitely). */
  timeoutMs?: number;
  /** Also match receipts recorded BEFORE this call (default true). */
  includePast?: boolean;
}

export class ReceiptBus {
  private receipts: Receipt[] = [];
  private seqCounter = 0;
  private waiters = new Set<Waiter>();

  /** Record an event. Returns the created receipt and wakes matching waiters. */
  record<E extends CliEvent>(type: E, payload: ReceiptPayloadMap[E]): Receipt<E> {
    this.seqCounter += 1;
    const receipt: Receipt<E> = {
      seq: this.seqCounter,
      at: Date.now(),
      type,
      payload,
    };
    this.receipts.push(receipt);

    // Notify any waiters whose predicate now matches. Snapshot first so a
    // waiter that re-arms inside its resolver doesn't get processed twice here.
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.predicate(receipt)) {
        if (waiter.timer) clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(receipt);
      }
    }

    return receipt;
  }

  /** All receipts in record order (defensive copy). */
  all(): Receipt[] {
    return [...this.receipts];
  }

  /** Receipts of a specific event type, narrowed. */
  ofType<E extends CliEvent>(type: E): Receipt<E>[] {
    return this.receipts.filter((r): r is Receipt<E> => r.type === type);
  }

  /** First receipt matching the predicate, if any. */
  find(predicate: ReceiptPredicate): Receipt | undefined {
    return this.receipts.find(predicate);
  }

  /** Number of recorded receipts. */
  count(): number {
    return this.receipts.length;
  }

  /** Discard all receipts and reset the sequence counter. */
  clear(): void {
    this.receipts = [];
    this.seqCounter = 0;
  }

  /**
   * Resolve when a receipt matching `predicate` has been recorded.
   * Already-recorded receipts count by default (set `includePast: false` to
   * wait strictly for a future one).
   */
  awaitReceipt(predicate: ReceiptPredicate, opts: AwaitReceiptOptions = {}): Promise<Receipt> {
    const includePast = opts.includePast ?? true;
    if (includePast) {
      const existing = this.receipts.find(predicate);
      if (existing) return Promise.resolve(existing);
    }

    return new Promise<Receipt>((resolve, reject) => {
      const waiter: Waiter = { predicate, resolve, reject, timer: null };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`awaitReceipt timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
        // Don't keep the event loop alive purely for this timer.
        (waiter.timer as { unref?: () => void }).unref?.();
      }
      this.waiters.add(waiter);
    });
  }
}
