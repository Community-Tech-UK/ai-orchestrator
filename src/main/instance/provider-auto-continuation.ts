import type { InterruptOrigin } from '@contracts/types/instance-events';

interface AutoContinuingAdapter {
  /** Stops the provider restarting work by itself (Codex: pauses an active thread goal). */
  stopProviderAutoContinuation?(): Promise<boolean>;
}

/**
 * A stop must also stop the provider resuming the task by itself: an active
 * Codex thread goal starts a new turn as soon as the interrupted one ends. A
 * steer interrupts only to deliver the user's next message, so it keeps the goal.
 */
export function stopProviderAutoContinuation(adapter: unknown, origin: InterruptOrigin): void {
  if (origin === 'steer' || !adapter || typeof adapter !== 'object') return;
  const stop = (adapter as AutoContinuingAdapter).stopProviderAutoContinuation;
  if (typeof stop !== 'function') return;
  void stop.call(adapter).catch(() => false);
}
