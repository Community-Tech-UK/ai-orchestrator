/**
 * Fail-closed guards for Copilot adapter construction.
 *
 * Extracted from `adapter-factory.ts` so the factory stays inside its LOC
 * budget and these two security checks are unit-testable on their own.
 */

import type { UnifiedSpawnOptions } from '../adapter-factory.types';
import type { ResolvedCopilotAccountRoute } from '../../../../shared/types/copilot-account.types';
import { getCopilotAccountRoutingService } from '../../../providers/copilot/copilot-account-routing-service';

/**
 * Fail-closed gate for Copilot adapter construction.
 *
 * Routing needs git and filesystem I/O, and this factory is synchronous, so
 * resolution happens earlier (`attachCopilotRoute()`), and the factory only
 * enforces. Missing route means the spawn escaped the resolver — that is a
 * routing bug, and running Copilot under an unknown account is exactly what
 * must not happen, so it throws rather than falling back to a default account.
 */
export function requireCopilotAccountRoute(
  options: UnifiedSpawnOptions,
  where: 'local' | 'remote',
): ResolvedCopilotAccountRoute {
  const route = options.copilotAccountRoute;
  if (!route?.profileId) {
    throw new Error(
      `GitHub Copilot cannot start without a resolved account profile (${where} spawn). ` +
        'This is an internal routing error: every Copilot spawn path must call attachCopilotRoute() first.',
    );
  }
  return route;
}

/**
 * `gh copilot --` authenticates through GitHub CLI's HOST-WIDE account, which
 * no `COPILOT_HOME` can override — so under multiple profiles it is an
 * unrouted account. Blocked once more than one profile exists; a single-profile
 * install keeps working exactly as before.
 */
export function assertRoutableCopilotLaunchShape(launch: { displayCommand: string; argsPrefix: string[] }): void {
  if (launch.argsPrefix.length === 0) {
    return;
  }
  let profileCount = 0;
  try {
    profileCount = getCopilotAccountRoutingService().listProfiles().length;
  } catch {
    profileCount = 0;
  }
  if (profileCount > 1) {
    throw new Error(
      'GitHub Copilot is only reachable through the `gh copilot` wrapper on this machine, which signs in with the host-wide GitHub CLI account and cannot be pinned to a Copilot account profile. ' +
        'Install the standalone Copilot CLI (`npm install -g @github/copilot`) to use multiple accounts.',
    );
  }
}
