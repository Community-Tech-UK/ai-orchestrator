/**
 * Research scouts (Oct-2 Phase D Step 4 item 4).
 *
 * A research fan-out runs its scouts on the balanced model at high effort; the lead and the final
 * synthesis stay on the session's own model and effort (the guide tells the lead to synthesise itself).
 * A lead marks a read-only research helper with `"role":"scout"` on `spawn_child`. The default only
 * fills a gap: a model the lead named, or one the chosen agent defines, always wins.
 */

import type { ReasoningEffort } from '../../shared/types/provider.types';
import type { RoutingDecision } from '../routing/model-router';
import type { SpawnChildCommand } from './orchestration-protocol.types';

export const SCOUT_ROLE = 'scout';
/** Model tier a scout gets when nobody named a model. */
export const SCOUT_TIER = 'balanced';
export const SCOUT_REASONING_EFFORT: ReasoningEffort = 'high';
export const SCOUT_ROUTING_REASON = 'Scout default: balanced tier at high effort';

export function isScoutSpawn(command: Pick<SpawnChildCommand, 'role'>): boolean {
  return command.role === SCOUT_ROLE;
}

/** The tier to request for this spawn, or undefined when it is no scout or a model is already chosen. */
export function scoutModelRequest(
  command: Pick<SpawnChildCommand, 'role' | 'model'>,
  agentModelOverride?: string,
): typeof SCOUT_TIER | undefined {
  return isScoutSpawn(command) && !command.model?.trim() && !agentModelOverride ? SCOUT_TIER : undefined;
}

/**
 * Routing for a `spawn_child` command: a scout takes the balanced tier (and says why) unless the lead named
 * a model or the agent defines one. `route` is the ordinary router, given the model request to use.
 */
export function routeSpawnCommand(
  command: Pick<SpawnChildCommand, 'role' | 'model'>,
  agentModelOverride: string | undefined,
  route: (explicitModel: string | undefined) => RoutingDecision,
): RoutingDecision {
  const tier = scoutModelRequest(command, agentModelOverride);
  const decision = route(tier ?? command.model);
  return tier ? { ...decision, reason: SCOUT_ROUTING_REASON } : decision;
}

/** High effort for a scout. The lifecycle drops it for a provider or model that has no effort setting. */
export function scoutReasoningEffort(command: Pick<SpawnChildCommand, 'role'>): ReasoningEffort | undefined {
  return isScoutSpawn(command) ? SCOUT_REASONING_EFFORT : undefined;
}
