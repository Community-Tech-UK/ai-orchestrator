/**
 * Shared Copilot account-route preflight.
 *
 * The adapter factory is synchronous but routing needs git and filesystem
 * I/O, so resolution has to happen before adapter construction. This helper is
 * the one place every spawn path calls to do it.
 *
 * It is a NO-OP for non-Copilot CLI types, so call sites can adopt it
 * unconditionally — `await attachCopilotRoute(cliType, options, origin)` right
 * before `createAdapter(...)`. That is deliberate: an `if (cliType ===
 * 'copilot')` at each call site is a condition a later edit can get wrong,
 * and a missed call site means a Copilot spawn under an unresolved account.
 * The synchronous throw in `createCliAdapter` is the runtime backstop for
 * exactly that mistake.
 */

import type { CliType } from '../../cli/cli-detection';
import type { UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory.types';
import type { Instance } from '../../../shared/types/instance.types';
import type {
  CopilotInvocationOrigin,
  CopilotRouteFailure,
} from '../../../shared/types/copilot-account.types';
import {
  getCopilotAccountRoutingService,
  type CopilotAccountRoutingService,
} from '../../providers/copilot/copilot-account-routing-service';
import { LOCAL_COPILOT_NODE_ID } from '../../providers/copilot/copilot-account-binding-service';

/**
 * Thrown when Copilot cannot be routed. Carries the typed failure code so the
 * renderer, background surfaces, and Doctor can render an actionable state
 * rather than a generic "Copilot unavailable".
 */
export class CopilotRoutingError extends Error {
  readonly code: CopilotRouteFailure['code'];
  readonly profileId?: string;

  constructor(failure: CopilotRouteFailure) {
    super(failure.detail);
    this.name = 'CopilotRoutingError';
    this.code = failure.code;
    this.profileId = failure.profileId;
  }
}

export function isCopilotRoutingError(error: unknown): error is CopilotRoutingError {
  return error instanceof CopilotRoutingError;
}

/**
 * Record the resolved account on the instance, before the adapter spawns.
 *
 * Writes three first-class fields rather than a `metadata` entry — see the
 * comment on `Instance.copilotAccountProfileId` for why that distinction is
 * load-bearing across hibernate/wake. No-op when the spawn carried no route
 * (every non-Copilot provider).
 */
export function stampCopilotRouteOnInstance(
  instance: Pick<
    Instance,
    'copilotAccountProfileId' | 'copilotRoutingSource' | 'copilotRoutingRuleId'
  >,
  options: Pick<UnifiedSpawnOptions, 'copilotAccountRoute'>,
): void {
  const route = options.copilotAccountRoute;
  if (!route?.profileId) {
    return;
  }
  instance.copilotAccountProfileId = route.profileId;
  instance.copilotRoutingSource = route.source;
  instance.copilotRoutingRuleId = route.ruleId;
}

/**
 * Default Copilot invocation origin for an orchestration routing intent.
 * Every one of these is an automatic surface, so `internal` is the safe
 * fallback rather than `interactive`: a profile marked `manual-only` must not
 * be reachable from a path that picked Copilot on the user's behalf.
 */
export function copilotOriginForRoutingIntent(
  intent?: 'loop' | 'workflow' | 'scaffolding' | 'synthesis',
): CopilotInvocationOrigin {
  switch (intent) {
    case 'loop':
      return 'loop';
    case 'workflow':
      return 'workflow';
    default:
      return 'internal';
  }
}

export interface AttachCopilotRouteOptions {
  /** Explicit user-selected profile for this session. */
  explicitProfileId?: string;
  /** The user confirmed an override that leaves a protected scope. */
  confirmProtectedOverride?: boolean;
  /** Profile stamped on the session being restored, respawned, or resumed. */
  persistedProfileId?: string;
  /** Execution node. Defaults to the local controller. */
  executionNodeId?: string;
  /** Correlation only. */
  instanceId?: string;
  /** Injected for tests. */
  routingService?: CopilotAccountRoutingService;
}

/**
 * Resolve the Copilot account for this spawn and return options with the safe
 * route attached. No-op for every other provider.
 *
 * @throws {CopilotRoutingError} when no account can be resolved, verified, or
 *         admitted. Never falls back to another Copilot account.
 */
export async function attachCopilotRoute(
  cliType: CliType,
  options: UnifiedSpawnOptions,
  origin: CopilotInvocationOrigin,
  attachOptions: AttachCopilotRouteOptions = {},
): Promise<UnifiedSpawnOptions> {
  if (cliType !== 'copilot') {
    return options;
  }
  // An already-attached route is a respawn of a stamped session; keep it
  // rather than re-resolving, so changed rules cannot move a live thread.
  if (options.copilotAccountRoute?.profileId) {
    return options;
  }

  const service = attachOptions.routingService ?? getCopilotAccountRoutingService();
  const outcome = await service.resolveRouteForSpawn({
    workingDirectory: options.workingDirectory,
    explicitProfileId: attachOptions.explicitProfileId,
    confirmProtectedOverride: attachOptions.confirmProtectedOverride,
    persistedProfileId: attachOptions.persistedProfileId,
    origin,
    executionNodeId: attachOptions.executionNodeId ?? LOCAL_COPILOT_NODE_ID,
    instanceId: attachOptions.instanceId ?? options.instanceId,
  });

  if (!outcome.ok) {
    throw new CopilotRoutingError(outcome);
  }
  return { ...options, copilotAccountRoute: outcome.route };
}
