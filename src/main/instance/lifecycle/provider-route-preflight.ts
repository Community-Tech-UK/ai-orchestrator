/**
 * Both account preflights in one call: GitHub Copilot account routing and
 * Claude/Codex account pools. Each is a no-op for providers it does not own, so
 * one-shot and orchestration spawn paths call this unconditionally right before
 * adapter construction.
 */

import type { CliType } from '../../cli/cli-detection';
import type { UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory.types';
import type { CopilotInvocationOrigin } from '../../../shared/types/copilot-account.types';
import { attachCopilotRoute, type AttachCopilotRouteOptions } from './copilot-route-preflight';
import { attachAccountRoute } from './account-route-preflight';

export async function attachProviderRoutes(
  cliType: CliType,
  options: UnifiedSpawnOptions,
  origin: CopilotInvocationOrigin,
  copilotOptions: AttachCopilotRouteOptions = {},
): Promise<UnifiedSpawnOptions> {
  const copilotRouted = await attachCopilotRoute(cliType, options, origin, copilotOptions);
  return attachAccountRoute(cliType, copilotRouted, origin, {
    ...(copilotOptions.executionNodeId ? { executionNodeId: copilotOptions.executionNodeId } : {}),
    ...(copilotOptions.instanceId ? { instanceId: copilotOptions.instanceId } : {}),
  });
}
