/**
 * Claude Code / Codex account routing on a worker node (decision D10).
 *
 * The controller resolves an account profile and sends only safe metadata: the
 * provider, the profile ID, the identity it expects and how the route was
 * chosen. A sign-in is node-local, so the route is a REQUEST until this node
 * confirms the profile is signed in HERE as that identity. The worker then
 * derives its own profile home beneath its own state root; controller paths and
 * credentials never travel.
 *
 * Dynamic imports throughout: the worker agent must not pull Electron in at
 * module load time, and these modules sit in the main-process tree.
 */

import { readdirSync } from 'fs';
import type {
  AccountBindingStatus,
  PooledProvider,
  ProviderAccountProfile,
  ResolvedAccountRoute,
} from '../shared/types/provider-account.types';
import {
  LEGACY_ACCOUNT_PROFILE_ID,
  POOLED_PROVIDERS,
  PROVIDER_ACCOUNT_PROFILE_ID_PATTERN,
  pooledProviderLabel,
} from '../shared/types/provider-account.types';

/** The binding node ID a worker checks and stamps under. */
export const WORKER_ACCOUNT_NODE_ID = 'worker';

export interface WorkerAccountRouteParams {
  provider: PooledProvider;
  profileId: string;
  expectedIdentity?: string | null;
  source?: string;
}

export type WorkerBindingCheck = (profile: ProviderAccountProfile, nodeId: string) => Promise<AccountBindingStatus>;

const defaultBindingCheck: WorkerBindingCheck = async (profile, nodeId) => {
  const { ProviderAccountBindingService } = await import(
    '../main/providers/account-pool/provider-account-binding-service'
  );
  return new ProviderAccountBindingService().checkBinding(profile, nodeId, { force: true });
};

/**
 * Re-validates the wire route (the worker dispatcher casts rather than
 * re-parsing), verifies this node's own binding and returns the route the
 * adapter factory runs under.
 *
 * @throws when the route does not match the spawn, or the profile is not signed
 *         in here as the expected identity.
 */
export async function materializeWorkerAccountRoute(
  cliType: string,
  route: WorkerAccountRouteParams,
  checkBinding: WorkerBindingCheck = defaultBindingCheck,
): Promise<ResolvedAccountRoute> {
  if (route.provider !== cliType) {
    throw new Error(`A ${route.provider} account route was sent with a ${cliType} spawn.`);
  }
  if (!PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(route.profileId)) {
    throw new Error('The account route carried an invalid profile ID.');
  }
  const expectedIdentity = route.expectedIdentity ?? null;
  const isLegacy = route.profileId === LEGACY_ACCOUNT_PROFILE_ID;
  const status = await checkBinding(
    {
      id: route.profileId,
      provider: route.provider,
      label: route.profileId,
      expectedIdentity,
      expectedAccountKey: null,
      planLabel: null,
      priority: 0,
      enabled: true,
      automationPolicy: 'allow-routed',
      isLegacy,
      createdAt: 0,
      updatedAt: 0,
    },
    WORKER_ACCOUNT_NODE_ID,
  );
  if (status.state !== 'authenticated') {
    const provider = pooledProviderLabel(route.provider);
    const remedy = status.state === 'identity-mismatch'
      ? 'it is signed in as a different account on this node'
      : status.state === 'unauthenticated'
        ? 'it is not signed in on this node'
        : `its sign-in could not be read on this node (${status.errorCode ?? 'unavailable'})`;
    throw new Error(
      `${provider} account "${route.profileId}" cannot run on this node: ${remedy}. `
      + 'Sign in for that account on this node, or place the session elsewhere.',
    );
  }
  return {
    provider: route.provider,
    profileId: route.profileId,
    source: 'persisted',
    executionNodeId: WORKER_ACCOUNT_NODE_ID,
    ...(expectedIdentity ? { expectedIdentity } : {}),
  };
}

/**
 * Profiles that have a home on this node, per provider. A placement HINT only:
 * a home can exist without a valid sign-in, and the spawn-time binding check
 * above is what actually decides. Never includes paths.
 */
export function listWorkerAccountProfileIds(
  profilesRoot: (provider: PooledProvider) => string,
): Partial<Record<PooledProvider, string[]>> {
  const result: Partial<Record<PooledProvider, string[]>> = {};
  for (const provider of POOLED_PROVIDERS) {
    let entries: string[];
    try {
      entries = readdirSync(profilesRoot(provider), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .slice(0, 16);
    } catch {
      continue;
    }
    if (entries.length > 0) result[provider] = entries;
  }
  return result;
}
