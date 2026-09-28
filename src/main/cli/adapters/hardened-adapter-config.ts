/**
 * WS13 hardened mode: configure the Seatbelt jail on a freshly built adapter.
 *
 * Split out of `adapter-factory.ts`. The per-instance hardened flag and the
 * provider allow-list are checked there; this module decides the writable
 * roots the jail grants.
 */

import { isLegacyAccountProfileId } from '../../../shared/types/provider-account.types';
import { getInstanceExtraWritableRoots } from '../../instance/lifecycle/hardened-mode-scoping';
import { defaultHardenedWritableRoots, providerHardenedWritableRoots } from '../../sandbox/seatbelt';
import type { CliAdapter, UnifiedSpawnOptions } from './adapter-factory.types';
import { BaseCliAdapter } from './base-cli-adapter';
import { ClaudeCliAdapter } from './claude-cli-adapter';

export function configureHardenedAdapter(
  adapter: CliAdapter,
  cliType: string,
  options: UnifiedSpawnOptions,
): void {
  if (!(adapter instanceof BaseCliAdapter)) {
    // Remote adapters spawn on a worker node, outside the local Seatbelt choke point. FAIL CLOSED.
    throw new Error(
      'Hardened mode is not supported for remote instances (Phase A is local macOS only).',
    );
  }
  // Account-pool homes live under Electron userData, outside the legacy
  // default roots. Only a resolved derived Claude route may add its exact
  // home; an arbitrary ambient or caller-supplied CLAUDE_CONFIG_DIR cannot.
  const derivedClaudeRoute = adapter instanceof ClaudeCliAdapter
    && options.accountRoute
    && !isLegacyAccountProfileId(options.accountRoute.profileId);
  const derivedClaudeHome = derivedClaudeRoute
    ? adapter.getConfig().env?.['CLAUDE_CONFIG_DIR']
    : undefined;
  if (derivedClaudeRoute && !derivedClaudeHome) {
    throw new Error('Hardened Claude account profile has no resolved config home; refusing to spawn.');
  }
  // A routed Copilot adapter pins COPILOT_HOME to its validated per-account
  // home (resolveCopilotProfileHome). An unrouted one uses ~/.copilot, which
  // is already a default root.
  const copilotHome = cliType === 'copilot' ? adapter.getConfig().env?.['COPILOT_HOME'] : undefined;
  adapter.configureHardenedMode({
    writableRoots: [
      ...defaultHardenedWritableRoots(options.workingDirectory),
      ...providerHardenedWritableRoots(cliType),
      ...(derivedClaudeHome ? [derivedClaudeHome] : []),
      ...(copilotHome ? [copilotHome] : []),
      // Session-scoped allow-and-retry grants (WS13 slice 3).
      ...getInstanceExtraWritableRoots(options.instanceId),
    ],
  });
}
