/**
 * Shared Claude/Codex account-route preflight (provider account pools).
 *
 * The adapter factory is synchronous but routing reads bindings, the ledger
 * and quota, so resolution happens before adapter construction. Every spawn
 * path calls this right beside `attachCopilotRoute()`. It is a NO-OP for every
 * other provider, so call sites adopt it unconditionally; the synchronous throw
 * in `createCliAdapter` is the backstop for a missed call site.
 */

import type { CliType } from '../../cli/cli-detection';
import type { UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory.types';
import type { Instance } from '../../../shared/types/instance.types';
import type {
  AccountInvocationOrigin,
  AccountRouteFailure,
  AccountRouteSource,
} from '../../../shared/types/provider-account.types';
import { LEGACY_ACCOUNT_PROFILE_ID, isPooledProvider } from '../../../shared/types/provider-account.types';
import {
  getProviderAccountRoutingService,
  type ProviderAccountRoutingService,
} from '../../providers/account-pool/provider-account-routing-service';
import { LOCAL_ACCOUNT_NODE_ID } from '../../providers/account-pool/provider-account-binding-service';

/** Thrown when a Claude or Codex account cannot be routed. Carries the typed code and remedy text. */
export class AccountRoutingError extends Error {
  readonly code: AccountRouteFailure['code'];
  readonly profileId?: string;

  constructor(failure: AccountRouteFailure) {
    super(failure.detail);
    this.name = 'AccountRoutingError';
    this.code = failure.code;
    this.profileId = failure.profileId;
  }
}

export function isAccountRoutingError(error: unknown): error is AccountRoutingError {
  return error instanceof AccountRoutingError;
}

/**
 * Record the resolved account on the instance before the adapter spawns, as
 * first-class fields (not `metadata`), so hibernate/wake and restore keep it.
 */
export function stampAccountRouteOnInstance(
  instance: Pick<Instance, 'accountProfileId' | 'accountRoutingSource'>,
  options: Pick<UnifiedSpawnOptions, 'accountRoute'>,
): void {
  const route = options.accountRoute;
  if (!route?.profileId) return;
  instance.accountProfileId = route.profileId;
  instance.accountRoutingSource = route.source;
}

/**
 * The profile a respawn must keep: the stamped one, or — for an unstamped
 * session resuming a native thread, which was created before pools — legacy.
 */
export function persistedAccountProfileId(
  instance: Pick<Instance, 'accountProfileId'> | undefined,
  resume: boolean | undefined,
): string | undefined {
  return instance?.accountProfileId ?? (resume ? LEGACY_ACCOUNT_PROFILE_ID : undefined);
}

/** Restore the account-pool stamp from persisted session state (wake). */
export function restoreAccountStamp(
  instance: Pick<Instance, 'accountProfileId' | 'accountRoutingSource' | 'accountSwitches'>,
  state: { accountProfileId?: string; accountRoutingSource?: Instance['accountRoutingSource']; accountSwitches?: number },
): void {
  if (!state.accountProfileId) return;
  instance.accountProfileId = state.accountProfileId;
  instance.accountRoutingSource = state.accountRoutingSource;
  instance.accountSwitches = state.accountSwitches;
}

export interface AttachAccountRouteOptions {
  /** Explicit user-selected profile for this session. */
  explicitProfileId?: string;
  /** Profile stamped on the session being restored, respawned or resumed. */
  persistedProfileId?: string;
  /** Execution node. Defaults to the local controller. */
  executionNodeId?: string;
  /** Profiles that must not be chosen. */
  exclude?: readonly string[];
  /** Source stamped when the default selection runs on behalf of a handoff. */
  defaultSource?: Extract<AccountRouteSource, 'default' | 'failover' | 'preemptive'>;
  instanceId?: string;
  routingService?: ProviderAccountRoutingService;
}

/**
 * Resolve the Claude/Codex account for this spawn and return options with the
 * safe route attached. No-op for every other provider, for a provider with no
 * pool (only the legacy profile), and when a route is already attached (a
 * respawn of a stamped session).
 *
 * @throws {AccountRoutingError} when no account can be resolved or admitted.
 */
export async function attachAccountRoute(
  cliType: CliType | string,
  options: UnifiedSpawnOptions,
  origin: AccountInvocationOrigin,
  attachOptions: AttachAccountRouteOptions = {},
): Promise<UnifiedSpawnOptions> {
  if (!isPooledProvider(cliType)) {
    return options;
  }
  if (options.accountRoute?.profileId && options.accountRoute.provider === cliType) {
    return options;
  }
  const service = attachOptions.routingService ?? getProviderAccountRoutingService();
  const outcome = await service.resolveRouteForSpawn({
    provider: cliType,
    model: options.model ?? null,
    explicitProfileId: attachOptions.explicitProfileId,
    persistedProfileId: attachOptions.persistedProfileId,
    origin,
    executionNodeId: attachOptions.executionNodeId ?? LOCAL_ACCOUNT_NODE_ID,
    newSession: !options.resume && !attachOptions.persistedProfileId,
    exclude: attachOptions.exclude,
    defaultSource: attachOptions.defaultSource,
    instanceId: attachOptions.instanceId ?? options.instanceId,
  });
  if (!outcome.ok) {
    throw new AccountRoutingError(outcome);
  }
  // No pool: leave the options exactly as they were before pools existed.
  if (outcome.route.source === 'legacy') {
    return options;
  }
  return { ...options, accountRoute: outcome.route };
}
