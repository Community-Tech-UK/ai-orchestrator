/**
 * callWithDeadline — race an async operation against a wall-clock deadline so a
 * slow (or hung) call never blocks the caller.
 *
 * This generalizes the 500ms RLM-context race (instance-manager's
 * `resolveInputContextsBeforeDeadline`) into one reusable helper so every
 * worker/gateway migration in the main-thread-offload plan is non-blocking by
 * construction: a gateway RPC is wrapped in `callWithDeadline(...)`, and if the
 * worker is slow the caller gets a safe fallback (null / empty) and proceeds.
 *
 * Contract:
 * - Never rejects. On timeout OR on rejection of the operation, the configured
 *   `fallback` is returned.
 * - On timeout the underlying promise is left to settle in the background; its
 *   eventual rejection is swallowed so it never surfaces as an unhandled
 *   rejection.
 * - The deadline timer is `unref()`-ed so it never keeps the event loop alive,
 *   and is always cleared once the race settles.
 *
 * Usage:
 *   const ctx = await callWithDeadline(() => worker.buildContext(q), {
 *     ms: 500,
 *     fallback: null,
 *     onTimeout: () => logger.warn('context deadline exceeded'),
 *   });
 */

/** Unique sentinel resolved by the deadline timer — never collides with a real value. */
const TIMED_OUT: unique symbol = Symbol('callWithDeadline.timeout');

export interface CallWithDeadlineOptions<T> {
  /** Milliseconds to wait before giving up and returning the fallback. */
  ms: number;
  /** Value returned when the operation times out or rejects. */
  fallback: T;
  /** Invoked when the deadline is hit before the operation settled. */
  onTimeout?: () => void;
  /** Invoked when the operation rejected before the deadline. */
  onError?: (error: unknown) => void;
  /**
   * Invoked if the operation eventually resolves AFTER the deadline already
   * fired (i.e. we returned the fallback). Lets a caller use a slow result late
   * — e.g. defer it to the next turn — instead of discarding it. A late
   * rejection is swallowed and never reaches this callback.
   */
  onLateResult?: (value: T) => void;
}

/**
 * Run `operation` but give up after `options.ms`, returning `options.fallback`
 * instead of blocking. Accepts either a promise or a thunk; a thunk that throws
 * synchronously is treated the same as a rejected operation.
 */
export async function callWithDeadline<T>(
  operation: Promise<T> | (() => Promise<T>),
  options: CallWithDeadlineOptions<T>,
): Promise<T> {
  const { ms, fallback, onTimeout, onError, onLateResult } = options;

  let work: Promise<T>;
  try {
    work = typeof operation === 'function' ? operation() : operation;
  } catch (error) {
    onError?.(error);
    return fallback;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });

  try {
    const result = await Promise.race([work, deadline]);
    if (result === TIMED_OUT) {
      onTimeout?.();
      // The operation is still in flight. Surface a late success to onLateResult
      // (so the caller can still use it, e.g. defer to the next turn) and swallow
      // a late rejection so it never becomes an unhandled rejection.
      void Promise.resolve(work).then(
        (value) => onLateResult?.(value),
        () => undefined,
      );
      return fallback;
    }
    return result;
  } catch (error) {
    onError?.(error);
    return fallback;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
