import { machineSessionReasonForOrigin } from '../../../shared/utils/machine-session';
import { sessionKindOf } from '../../../shared/types/session-kind.types';
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
  const reason = machineSessionReasonForOrigin(origin);
  const stamped = { ...options, machineSession: options.machineSession ?? reason ?? undefined, sessionKind: options.sessionKind ?? sessionKindOf(reason) };
  const copilotRouted = await attachCopilotRoute(cliType, stamped, origin, copilotOptions);
  return attachAccountRoute(cliType, copilotRouted, origin, {
    ...(copilotOptions.executionNodeId ? { executionNodeId: copilotOptions.executionNodeId } : {}),
    ...(copilotOptions.instanceId ? { instanceId: copilotOptions.instanceId } : {}),
  });
}
