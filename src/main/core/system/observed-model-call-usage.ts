import { hasProviderUsage, isProviderDispatchNotStarted } from '../../cli/adapters/provider-dispatch-status';
import type { EventEmitter } from 'node:events';
import type { CliUsage } from '../../cli/adapters/base-cli-adapter';

/** Per-dispatch snapshots, never sums: usage and complete can report the same bill. */
export function observeModelCallUsage(source: unknown) {
  let observed: CliUsage | undefined;
  let settled = false;
  let dispatched = true;
  const observe = (value: unknown): void => {
    if (settled || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const fields = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
    const cost = fields['cost'];
    // Partial token evidence (or invalid cost) cannot erase a reported paid amount.
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) delete fields['cost'];
    observed = { ...observed, ...fields };
  };
  const observeError = (error: unknown): void => {
    if (!error || typeof error !== 'object') return;
    if (isProviderDispatchNotStarted(error)) dispatched = false;
    const failure = error as { usage?: unknown; partialUsage?: unknown };
    observe(failure.usage);
    observe(failure.partialUsage);
  };
  const complete = (response: { usage?: unknown } | undefined): void => observe(response?.usage);
  const adapter = source as Partial<Pick<EventEmitter, 'on' | 'off'>> | undefined;
  const observes = typeof adapter?.on === 'function' && typeof adapter.off === 'function';
  if (observes) {
    adapter.on!('usage', observe);
    adapter.on!('complete', complete);
  }
  return {
    get dispatched(): boolean { return dispatched || hasProviderUsage(observed); },
    get usage(): CliUsage | undefined { return observed; },
    observe,
    observeError,
    dispose(): void {
      if (settled) return;
      settled = true;
      if (observes) {
        adapter.off!('usage', observe);
        adapter.off!('complete', complete);
      }
    },
  };
}

export function isModelCallCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { name?: unknown; message?: unknown };
  return failure.name === 'AbortError' || (typeof failure.message === 'string'
    && /\b(?:cancelled|canceled|interrupted)\b/i.test(failure.message));
}
