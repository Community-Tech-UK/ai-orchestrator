/**
 * Which account-pool route an adapter was created with. Recorded by
 * `ProviderRuntimeService.createAdapter` so paths that only hold the adapter
 * (loop iterations) can tell which account a turn ran on. Weakly held: the
 * entry disappears with the adapter.
 */

import type { ResolvedAccountRoute } from '../../../shared/types/provider-account.types';

const routes = new WeakMap<object, ResolvedAccountRoute>();

export function rememberAdapterAccountRoute(adapter: unknown, route: ResolvedAccountRoute | undefined): void {
  if (route && adapter && typeof adapter === 'object') routes.set(adapter, route);
}

export function getAdapterAccountRoute(adapter: unknown): ResolvedAccountRoute | null {
  return adapter && typeof adapter === 'object' ? routes.get(adapter) ?? null : null;
}
