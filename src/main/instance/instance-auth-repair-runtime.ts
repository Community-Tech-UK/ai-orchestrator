import type { Instance, InstanceProvider } from '../../shared/types/instance.types';
import { isPooledProvider } from '../../shared/types/provider-account.types';
import type { CommunicationDependencies } from './instance-communication.types';
import { getInstanceAuthRepairHandler, type AuthRepairTurn, type InstanceAuthRepairDeps } from './instance-auth-repair-handler';
import { accountFailoverNote } from './account-failover-notes';
import { getLogger } from '../logging/logger';
import {
  currentAccountProfileId,
  getAccountFailoverCoordinator,
  type AccountFailoverCoordinator,
} from '../providers/account-pool/account-failover-coordinator';
import {
  getProviderAccountBindingService,
  LOCAL_ACCOUNT_NODE_ID,
  type ProviderAccountBindingService,
} from '../providers/account-pool/provider-account-binding-service';
import { getProviderAccountStore, type ProviderAccountStore } from '../providers/account-pool/provider-account-store';
import { probeProviderAuth, type ProviderAuthState } from '../providers/provider-auth-status';

const logger = getLogger('InstanceAuthRepairRuntime');

/**
 * Builds the auth-failure callback for InstanceManager. Fire-and-forget by
 * contract: the confirming auth probe is async, and the caller is mid-way
 * through surfacing the turn's error — it must not wait on a CLI probe.
 */
export function createAuthRepairCommunicationCallbacks(
  getInstance: (instanceId: string) => Instance | undefined,
): Pick<CommunicationDependencies, 'onAuthFailureTurn'> {
  return {
    onAuthFailureTurn: (params) => {
      const instance = getInstance(params.instanceId);
      if (!instance) return;
      const reportedAccount = currentAccountProfileId(instance);
      void getInstanceAuthRepairHandler()
        .maybeBlockOnAuth({
          instanceId: params.instanceId,
          provider: instance.provider,
          reason: params.reason,
          resumeTurn: params.resumeTurn,
          authoritative: params.authoritative,
          stillCurrent: () => {
            const current = getInstance(params.instanceId);
            return current !== undefined && currentAccountProfileId(current) === reportedAccount;
          },
        })
        .catch((error) => {
          logger.warn('Auth-failure block attempt failed', {
            instanceId: params.instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  };
}

export interface AccountAuthDeps {
  store?: () => Pick<ProviderAccountStore, 'getProfile'>;
  bindings?: () => Pick<ProviderAccountBindingService, 'checkBinding'>;
  probeDefault?: (provider: InstanceProvider) => Promise<ProviderAuthState>;
}

/**
 * Auth state of the account this instance actually runs on. A pooled session
 * on a derived profile has its own config home, so the provider's default
 * sign-in says nothing about it. Remote sessions and unpooled providers keep
 * the default probe.
 */
export async function probeInstanceAccountAuth(
  provider: InstanceProvider,
  instance: Instance | undefined,
  deps: AccountAuthDeps = {},
): Promise<ProviderAuthState> {
  const probeDefault = deps.probeDefault ?? probeProviderAuth;
  const profileId = instance && instance.executionLocation?.type !== 'remote' ? currentAccountProfileId(instance) : null;
  if (!profileId || !isPooledProvider(provider)) return probeDefault(provider);
  const profile = (deps.store ?? getProviderAccountStore)().getProfile(provider, profileId);
  if (!profile) return probeDefault(provider);
  // Forced: a cached "authenticated" can be from before the sign-out.
  const status = await (deps.bindings ?? getProviderAccountBindingService)()
    .checkBinding(profile, LOCAL_ACCOUNT_NODE_ID, { force: true });
  switch (status.state) {
    case 'authenticated':
      return 'authenticated';
    case 'unauthenticated':
    case 'identity-mismatch':
      // Mismatch: the profile home is signed in, but not as this account.
      return 'unauthenticated';
    default:
      return 'unknown';
  }
}

export interface SignedOutSwitchDeps {
  getInstance: (instanceId: string) => Instance | undefined;
  emitSystemMessage: (instanceId: string, content: string, metadata: Record<string, unknown>) => void;
  coordinator?: () => Pick<AccountFailoverCoordinator, 'perform'> | null;
}

/**
 * The usage-limit account failover, applied to a confirmed sign-out: move the
 * session to another signed-in account with usage left and re-send its turn.
 * False means the caller shows the sign-in banner (no pool, pool off, no
 * candidate, cooldown, or the pool asks first — which notifies on its own).
 */
export async function switchAccountAfterSignOut(
  params: { instanceId: string; provider: InstanceProvider; reason: string; resumeTurn: AuthRepairTurn | null },
  deps: SignedOutSwitchDeps,
): Promise<boolean> {
  const instance = deps.getInstance(params.instanceId);
  const coordinator = (deps.coordinator ?? getAccountFailoverCoordinator)();
  if (!instance || !coordinator || !isPooledProvider(instance.provider)) return false;
  const profileId = currentAccountProfileId(instance);
  if (!profileId) return false;
  const outcome = await coordinator.perform({
    instanceId: params.instanceId,
    provider: instance.provider,
    model: instance.currentModel ?? null,
    exhaustedProfileId: profileId,
    resumeAt: null,
    resumePrompt: params.resumeTurn?.message ?? null,
    reason: params.reason,
    trigger: 'signed-out',
  });
  logger.info('Account switch after sign-out', {
    instanceId: params.instanceId,
    provider: instance.provider,
    fromProfileId: profileId,
    outcome: outcome.outcome,
    ...(outcome.outcome === 'not-switched' ? { reason: outcome.reason } : {}),
  });
  if (outcome.outcome === 'already-moved') {
    const note = accountFailoverNote(outcome, false);
    if (note) deps.emitSystemMessage(params.instanceId, note.content, note.metadata);
    return true;
  }
  return outcome.outcome === 'switched';
}

/** The handler's account-aware probe and sign-out switch, bound to InstanceManager. */
export function createAuthRepairAccountDeps(
  getInstance: SignedOutSwitchDeps['getInstance'],
  emitSystemMessage: SignedOutSwitchDeps['emitSystemMessage'],
): Pick<InstanceAuthRepairDeps, 'probeAuth' | 'switchAccount'> {
  return {
    probeAuth: (provider, instanceId) => probeInstanceAccountAuth(provider, getInstance(instanceId)),
    switchAccount: (params) => switchAccountAfterSignOut(params, { getInstance, emitSystemMessage }),
  };
}
