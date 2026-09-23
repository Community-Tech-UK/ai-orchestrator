import type { CliAdapter } from '../cli/adapters/adapter-factory.types';

export type StatelessExecProviderPredicate = (
  provider: string | undefined,
  instanceId?: string,
) => boolean;

/**
 * Should this instance's mid-turn context usage be withheld from the context
 * engine (and therefore from the shared ContextSafetyPolicy)?
 *
 * Gemini and Antigravity are exec-per-message, and so is Codex in exec mode.
 * Their `used` is cumulative turn spend, not window occupancy. Codex in
 * app-server mode is different: it runs a resident thread and reports current
 * occupancy mid-turn. An earlier version answered by provider name alone, so
 * every Codex instance was skipped. The policy then only saw Codex usage once
 * the turn had ended, which is too late to steer or interrupt it.
 *
 * Codex is therefore judged by its adapter's declared `occupancyReporting`.
 * It only counts as resident when that is `'current'`, which the adapter
 * declares only while app-server mode is live. A missing adapter, or a remote
 * adapter with no capability surface, keeps the conservative skip.
 */
export function isStatelessExecProviderInstance(
  provider: string | undefined,
  adapter: CliAdapter | undefined,
): boolean {
  if (provider === 'gemini' || provider === 'antigravity') return true;
  if (provider !== 'codex') return false;
  return !reportsCurrentOccupancy(adapter);
}

export function createStatelessExecProviderPredicate(
  getAdapter: (instanceId: string) => CliAdapter | undefined,
): StatelessExecProviderPredicate {
  return (provider, instanceId) => isStatelessExecProviderInstance(
    provider,
    instanceId ? getAdapter(instanceId) : undefined,
  );
}

function reportsCurrentOccupancy(adapter: CliAdapter | undefined): boolean {
  // Duck-typed for the same reason as `isAggregateOnlyOccupancy`: an
  // `instanceof BaseCliAdapter` check fails silently across module instances.
  const read = (adapter as { getContextCapabilities?: () => { occupancyReporting?: string } } | undefined)
    ?.getContextCapabilities;
  if (typeof read !== 'function') return false;
  return read.call(adapter).occupancyReporting === 'current';
}
