/**
 * Claude Code / Codex / OpenCode account routing on a worker node (decision D10).
 *
 * The controller resolves an account profile and sends only safe metadata: the
 * provider, the profile ID, the identity it expects, the MiMo Token Plan
 * region and how the route was chosen. A sign-in is node-local, so the route is
 * a REQUEST until this node confirms the profile is signed in HERE as that
 * identity. The worker then derives its own profile home beneath its own state
 * root (Claude/Codex) or its own OpenCode key-store name (MiMo); controller
 * paths and credentials never travel.
 *
 * Dynamic imports throughout: the worker agent must not pull Electron in at
 * module load time, and these modules sit in the main-process tree.
 */

import { execFile } from 'child_process';
import { readdirSync } from 'fs';
import type {
  AccountBindingStatus,
  OpenCodeAccountRegion,
  PooledProvider,
  ProviderAccountProfile,
  ResolvedAccountRoute,
} from '../shared/types/provider-account.types';
import {
  LEGACY_ACCOUNT_PROFILE_ID,
  OPENCODE_ACCOUNT_REGIONS,
  OPENCODE_ACCOUNT_PROVIDER_PREFIX,
  POOLED_PROVIDERS,
  PROVIDER_ACCOUNT_PROFILE_ID_PATTERN,
  isPooledProvider,
  pooledProviderLabel,
} from '../shared/types/provider-account.types';
import { openCodeAuthNamesFor, parseOpenCodeAuthCredentialNames, parseOpenCodeAuthList } from '../main/providers/opencode-auth-status';
import { withOpenCodeProcessGate } from '../main/cli/adapters/opencode-process-gate';

/** The binding node ID a worker checks and stamps under. */
export const WORKER_ACCOUNT_NODE_ID = 'worker';

export interface WorkerAccountRouteParams {
  provider: PooledProvider;
  profileId: string;
  expectedIdentity?: string | null;
  source?: string;
  /** MiMo only: the Token Plan region the executing node needs (never a path/key). */
  region?: OpenCodeAccountRegion;
}

export type WorkerBindingCheck = (profile: ProviderAccountProfile, nodeId: string) => Promise<AccountBindingStatus>;

/** Reject malformed wire routes before any worker binding or native startup. */
export function validateWorkerAccountRoute(
  cliType: string,
  route: unknown,
): asserts route is WorkerAccountRouteParams {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    throw new Error('The account route carried invalid account metadata.');
  }
  const value = route as Record<string, unknown>;
  if (!isPooledProvider(value['provider'])) {
    throw new Error('The account route carried an invalid provider.');
  }
  if (value['provider'] !== cliType) {
    throw new Error(`A ${value['provider']} account route was sent with a ${cliType} spawn.`);
  }
  if (typeof value['profileId'] !== 'string' || !PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(value['profileId'])) {
    throw new Error('The account route carried an invalid profile ID.');
  }
  const region = value['region'];
  if (value['provider'] === 'opencode' && !region) {
    throw new Error('The account route carried no Token Plan region.');
  }
  if (region !== undefined && !OPENCODE_ACCOUNT_REGIONS.some((supported) => supported === region)) {
    throw new Error('The account route carried an invalid Token Plan region.');
  }
  const identity = value['expectedIdentity'];
  const source = value['source'];
  if ((identity !== undefined && identity !== null && (typeof identity !== 'string' || identity.length > 320))
    || (source !== undefined && (typeof source !== 'string' || source.length > 32))) {
    throw new Error('The account route carried invalid account metadata.');
  }
}

const defaultBindingCheck: WorkerBindingCheck = async (profile, nodeId) => {
  const { ProviderAccountBindingService } = await import(
    '../main/providers/account-pool/provider-account-binding-service'
  );
  return new ProviderAccountBindingService().checkBinding(profile, nodeId, { force: true });
};

/**
 * Independently re-validates the route, verifies this node's own binding and
 * returns the route the adapter factory runs under.
 *
 * @throws when the route does not match the spawn, or the profile is not signed
 *         in here as the expected identity.
 */
export async function materializeWorkerAccountRoute(
  cliType: string,
  route: unknown,
  checkBinding: WorkerBindingCheck = defaultBindingCheck,
): Promise<ResolvedAccountRoute> {
  validateWorkerAccountRoute(cliType, route);
  const isLegacy = route.profileId === LEGACY_ACCOUNT_PROFILE_ID;
  const expectedIdentity = route.expectedIdentity ?? null;
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
      ...(route.region ? { region: route.region } : {}),
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
    ...(route.region ? { region: route.region } : {}),
  };
}

/**
 * Profiles that have a home on this node, per provider. A placement HINT only:
 * a home can exist without a valid sign-in, and the spawn-time binding check
 * above is what actually decides. Never includes paths. OpenCode/MiMo has no
 * per-account homes at all — see `listWorkerOpenCodeAccountProfileIds`.
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
      // OpenCode/MiMo resolves no profile root at all: skipped here and
      // advertised from its key store instead.
      continue;
    }
    if (entries.length > 0) result[provider] = entries;
  }
  return result;
}

const OPENCODE_AUTH_CACHE_MS = 60_000;
let openCodeAuthCache: { at: number; ids: string[] } | null = null;
let openCodeAuthInFlight: Promise<string[]> | null = null;

function defaultReadOpenCodeAuthList(): Promise<string | null> {
  // `opencode auth list` opens OpenCode's shared database, so it takes the same
  // gate as every other OpenCode process AIO starts (probe 0.3).
  return withOpenCodeProcessGate(() => new Promise<string | null>((resolve) => {
    execFile('opencode', ['auth', 'list'], { timeout: 8_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      // Partial output from a failed process cannot advertise a sign-in.
      resolve(error ? null : typeof stdout === 'string' ? stdout : String(stdout ?? ''));
    });
  }));
}

/**
 * MiMo accounts logged in on this node, derived from `opencode auth list`
 * (names only — the `aio-mimo-*` credential names are the profile ids). OpenCode
 * keeps ONE key store for every account, so there is no profile home to scan
 * and nothing to path-derive. A placement HINT only: the spawn-time binding
 * check decides. Cached briefly because heartbeats run every 10 s and
 * `opencode auth list` opens OpenCode's database.
 */
export async function listWorkerOpenCodeAccountProfileIds(
  readAuthList: () => Promise<string | null> = defaultReadOpenCodeAuthList,
  now: () => number = Date.now,
): Promise<string[]> {
  if (openCodeAuthCache && now() - openCodeAuthCache.at < OPENCODE_AUTH_CACHE_MS) {
    return openCodeAuthCache.ids;
  }
  // One gated `opencode auth list` per window, even for concurrent heartbeats.
  if (openCodeAuthInFlight) return openCodeAuthInFlight;
  openCodeAuthInFlight = (async () => {
    let ids: string[] = [];
    try {
      const output = await readAuthList();
      const names = output !== null && parseOpenCodeAuthList(output) !== null
        ? parseOpenCodeAuthCredentialNames(output)
        : [];
      const mapped = names.map((name) => {
        if (name.startsWith(OPENCODE_ACCOUNT_PROVIDER_PREFIX)) {
          return name.slice(OPENCODE_ACCOUNT_PROVIDER_PREFIX.length);
        }
        // The legacy account's credential is the built-in region provider, which
        // `auth list` prints as either its id or its catalog display label.
        return regionOf(name) !== null ? 'legacy' : null;
      });
      ids = [...new Set(mapped)]
        .filter((id): id is string => id !== null && PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(id))
        .sort()
        .slice(0, 16);
    } catch {
      ids = [];
    }
    openCodeAuthCache = { at: now(), ids };
    return ids;
  })().finally(() => {
    openCodeAuthInFlight = null;
  });
  return openCodeAuthInFlight;
}

/** The region whose provider prints this credential name, else null. */
function regionOf(name: string): 'ams' | 'sgp' | 'cn' | null {
  for (const region of ['ams', 'sgp', 'cn'] as const) {
    if (openCodeAuthNamesFor(`xiaomi-token-plan-${region}`).includes(name)) return region;
  }
  return null;
}

export function _resetWorkerOpenCodeAccountCacheForTesting(): void {
  openCodeAuthCache = null;
}
