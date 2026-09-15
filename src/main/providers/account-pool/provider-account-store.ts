/**
 * Profile and pool-policy mutation for provider account pools.
 *
 * The single write path for `providerAccountProfiles` and
 * `providerAccountPools`. Both settings are operator-only
 * (`PRIVILEGED_CLI_OPERATOR_ONLY_KEYS`), so this is reached from the Settings
 * UI over IPC, never from an agent tool or the repair CLI.
 *
 * Every mutation re-validates the WHOLE resulting array through the shared Zod
 * schema before persisting, so a pool invariant (unique priority, legacy id,
 * profile cap) cannot be broken by a partial update that looked locally fine.
 */

import { randomBytes } from 'crypto';
import {
  ProviderAccountPoolsSchema,
  ProviderAccountProfilesSchema,
} from '@contracts/schemas/provider-account';
import type {
  AccountAutomationPolicy,
  PooledProvider,
  ProviderAccountPoolPolicy,
  ProviderAccountPools,
  ProviderAccountProfile,
} from '../../../shared/types/provider-account.types';
import {
  LEGACY_ACCOUNT_PROFILE_ID,
  MAX_PROFILES_PER_PROVIDER,
  POOLED_PROVIDERS,
  PROVIDER_ACCOUNT_PROFILE_ID_PATTERN,
  clonePoolPolicy,
  DEFAULT_ACCOUNT_POOL_POLICY,
  pooledProviderLabel,
} from '../../../shared/types/provider-account.types';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';

const logger = getLogger('ProviderAccountStore');

export interface ProviderAccountStoreDeps {
  read?: () => { profiles: ProviderAccountProfile[]; pools: Partial<ProviderAccountPools> };
  write?: (update: { profiles?: ProviderAccountProfile[]; pools?: ProviderAccountPools }) => void;
  now?: () => number;
  /** Suffix that keeps a derived profile id (and so its home) never reused. */
  randomSuffix?: () => string;
}

type ChangeListener = () => void;
const changeListeners = new Set<ChangeListener>();

/**
 * Subscribe to profile/pool changes. The routing and binding services use this
 * to drop cached decisions, which avoids an import cycle with the store.
 */
export function onProviderAccountsChanged(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function defaultRandomSuffix(): string {
  return randomBytes(3).toString('hex').slice(0, 4);
}

/**
 * Turn a user-facing label into a safe slug with a random suffix. The suffix is
 * deliberate: the id names the profile home, and `codex login` revokes whatever
 * a home already holds, so a removed-and-re-added account must never land on a
 * previous home (spec invariant 11).
 */
export function deriveProviderAccountProfileId(
  label: string,
  taken: readonly string[],
  randomSuffix: () => string = defaultRandomSuffix,
): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const seed = PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(base) && base !== LEGACY_ACCOUNT_PROFILE_ID
    ? base
    : 'account';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = `${seed}-${randomSuffix()}`;
    if (PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(candidate) && !taken.includes(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not derive a unique account profile ID.');
}

export interface CreateProviderAccountInput {
  provider: PooledProvider;
  label: string;
  automationPolicy?: AccountAutomationPolicy;
}

export interface UpdateProviderAccountInput {
  label?: string;
  enabled?: boolean;
  automationPolicy?: AccountAutomationPolicy;
}

export type ProviderAccountPoolPolicyPatch = Partial<Omit<ProviderAccountPoolPolicy, 'preemptive' | 'acknowledgedOwnershipAt'>> & {
  preemptive?: Partial<ProviderAccountPoolPolicy['preemptive']>;
};

export class ProviderAccountStore {
  constructor(private readonly deps: ProviderAccountStoreDeps = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private read(): { profiles: ProviderAccountProfile[]; pools: ProviderAccountPools } {
    const raw = this.deps.read
      ? this.deps.read()
      : (() => {
          const settings = getSettingsManager().getAll();
          return {
            profiles: Array.isArray(settings.providerAccountProfiles) ? settings.providerAccountProfiles : [],
            pools: (settings.providerAccountPools ?? {}) as Partial<ProviderAccountPools>,
          };
        })();
    return { profiles: [...raw.profiles], pools: normalizePools(raw.pools) };
  }

  private persist(update: { profiles?: ProviderAccountProfile[]; pools?: ProviderAccountPools }): void {
    const current = this.read();
    const profiles = update.profiles ?? current.profiles;
    const pools = update.pools ?? current.pools;

    const parsedProfiles = ProviderAccountProfilesSchema.safeParse(profiles);
    if (!parsedProfiles.success) {
      throw new Error(
        `Account profiles would become invalid: ${parsedProfiles.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }
    const parsedPools = ProviderAccountPoolsSchema.safeParse(pools);
    if (!parsedPools.success) {
      throw new Error(
        `Account pool policy would become invalid: ${parsedPools.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }

    if (this.deps.write) {
      this.deps.write({
        ...(update.profiles ? { profiles: parsedProfiles.data } : {}),
        ...(update.pools ? { pools: parsedPools.data } : {}),
      });
    } else {
      const manager = getSettingsManager();
      if (update.profiles) manager.set('providerAccountProfiles', parsedProfiles.data);
      if (update.pools) manager.set('providerAccountPools', parsedPools.data);
    }

    for (const listener of changeListeners) {
      try {
        listener();
      } catch (error) {
        logger.warn('Account pool change listener failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Profiles, optionally for one provider, in priority order. */
  listProfiles(provider?: PooledProvider): ProviderAccountProfile[] {
    return this.read().profiles
      .filter((profile) => !provider || profile.provider === provider)
      .sort((a, b) => a.priority - b.priority);
  }

  getProfile(provider: PooledProvider, profileId: string): ProviderAccountProfile | null {
    return this.read().profiles.find((profile) => profile.provider === provider && profile.id === profileId) ?? null;
  }

  /**
   * True when the provider has any profile other than the legacy one. This is
   * the condition under which a spawn without a resolved route is refused: with
   * only the legacy profile the app behaves exactly as it did before pools.
   */
  hasNonLegacyProfiles(provider: PooledProvider): boolean {
    return this.read().profiles.some((profile) => profile.provider === provider && !profile.isLegacy);
  }

  getPoolPolicy(provider: PooledProvider): ProviderAccountPoolPolicy {
    return clonePoolPolicy(this.read().pools[provider]);
  }

  getPools(): ProviderAccountPools {
    const { pools } = this.read();
    return { claude: clonePoolPolicy(pools.claude), codex: clonePoolPolicy(pools.codex) };
  }

  createProfile(input: CreateProviderAccountInput): ProviderAccountProfile {
    const { profiles, pools } = this.read();
    const own = profiles.filter((profile) => profile.provider === input.provider);
    if (own.length >= MAX_PROFILES_PER_PROVIDER) {
      throw new Error(`At most ${MAX_PROFILES_PER_PROVIDER} ${pooledProviderLabel(input.provider)} accounts are allowed.`);
    }
    const now = this.now();
    const id = deriveProviderAccountProfileId(
      input.label,
      own.map((profile) => profile.id),
      this.deps.randomSuffix,
    );
    const alreadyEnabled = own.some((profile) => profile.enabled);
    const profile: ProviderAccountProfile = {
      id,
      provider: input.provider,
      label: input.label.trim(),
      expectedIdentity: null,
      expectedAccountKey: null,
      planLabel: null,
      priority: own.reduce((max, existing) => Math.max(max, existing.priority), -1) + 1,
      // A second enabled account needs the ownership acknowledgement first, so
      // an unacknowledged pool gets the new profile disabled rather than a throw.
      enabled: !alreadyEnabled || pools[input.provider].acknowledgedOwnershipAt !== null,
      automationPolicy: input.automationPolicy ?? 'allow-routed',
      isLegacy: false,
      createdAt: now,
      updatedAt: now,
    };
    this.persist({ profiles: [...profiles, profile] });
    logger.info('Created a provider account profile', {
      provider: input.provider,
      profileId: id,
      enabled: profile.enabled,
    });
    return profile;
  }

  updateProfile(provider: PooledProvider, profileId: string, input: UpdateProviderAccountInput): ProviderAccountProfile {
    const { profiles, pools } = this.read();
    const target = this.requireProfile(profiles, provider, profileId);
    if (input.enabled === true && !target.enabled) {
      const otherEnabled = profiles.some((profile) => profile.provider === provider && profile.enabled && profile.id !== profileId);
      if (otherEnabled && pools[provider].acknowledgedOwnershipAt === null) {
        throw new Error(
          `Confirm that every ${pooledProviderLabel(provider)} account in this pool is one you personally pay for before enabling a second account.`,
        );
      }
    }
    if (input.enabled === false && target.enabled) {
      const otherEnabled = profiles.some((profile) => profile.provider === provider && profile.enabled && profile.id !== profileId);
      if (!otherEnabled) {
        throw new Error(`At least one ${pooledProviderLabel(provider)} account must stay enabled.`);
      }
    }
    return this.replaceProfile(profiles, {
      ...target,
      ...(input.label !== undefined ? { label: input.label.trim() } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.automationPolicy !== undefined ? { automationPolicy: input.automationPolicy } : {}),
    });
  }

  /**
   * Record the identity the binding check observed. This is how
   * `expectedIdentity` is first set, and the explicit resolution of an
   * `identity-mismatch`.
   */
  adoptObservedIdentity(
    provider: PooledProvider,
    profileId: string,
    observed: { identity: string; accountKey?: string | null; planLabel?: string | null },
  ): ProviderAccountProfile {
    const { profiles } = this.read();
    const target = this.requireProfile(profiles, provider, profileId);
    return this.replaceProfile(profiles, {
      ...target,
      expectedIdentity: observed.identity.trim(),
      ...(observed.accountKey !== undefined ? { expectedAccountKey: observed.accountKey?.trim() || null } : {}),
      ...(observed.planLabel !== undefined ? { planLabel: observed.planLabel?.trim() || null } : {}),
    });
  }

  /** Reorder a provider's pool. `profileIds` must name every profile of that provider exactly once. */
  setPriorityOrder(provider: PooledProvider, profileIds: readonly string[]): ProviderAccountProfile[] {
    const { profiles } = this.read();
    const own = profiles.filter((profile) => profile.provider === provider);
    const ownIds = new Set(own.map((profile) => profile.id));
    if (profileIds.length !== own.length || new Set(profileIds).size !== profileIds.length
      || profileIds.some((id) => !ownIds.has(id))) {
      throw new Error(`The new order must list every ${pooledProviderLabel(provider)} account exactly once.`);
    }
    const now = this.now();
    const next = profiles.map((profile) => {
      if (profile.provider !== provider) return profile;
      const priority = profileIds.indexOf(profile.id);
      return priority === profile.priority ? profile : { ...profile, priority, updatedAt: now };
    });
    this.persist({ profiles: next });
    return next.filter((profile) => profile.provider === provider).sort((a, b) => a.priority - b.priority);
  }

  /**
   * Remove a profile. Refused for the legacy profile (disable it instead) and
   * while a live instance uses it: that conversation belongs to this account
   * and would have nowhere to resume.
   */
  removeProfile(provider: PooledProvider, profileId: string, profilesInUse: readonly string[] = []): void {
    const { profiles } = this.read();
    const target = this.requireProfile(profiles, provider, profileId);
    if (target.isLegacy) {
      throw new Error('The existing account cannot be removed. Disable it instead.');
    }
    if (profilesInUse.includes(profileId)) {
      throw new Error('That account is in use by a running session. End or switch that session first.');
    }
    const remaining = profiles.filter((profile) => !(profile.provider === provider && profile.id === profileId));
    if (target.enabled && !remaining.some((profile) => profile.provider === provider && profile.enabled)) {
      throw new Error(`At least one ${pooledProviderLabel(provider)} account must stay enabled.`);
    }
    this.persist({ profiles: remaining });
    logger.info('Removed a provider account profile', { provider, profileId });
  }

  setPoolPolicy(provider: PooledProvider, patch: ProviderAccountPoolPolicyPatch): ProviderAccountPoolPolicy {
    const { pools } = this.read();
    const current = pools[provider];
    const next: ProviderAccountPoolPolicy = {
      ...current,
      ...(patch.failoverMode !== undefined ? { failoverMode: patch.failoverMode } : {}),
      ...(patch.continuation !== undefined ? { continuation: patch.continuation } : {}),
      ...(patch.switchCooldownMs !== undefined ? { switchCooldownMs: patch.switchCooldownMs } : {}),
      ...(patch.maxSwitchesPerTurn !== undefined ? { maxSwitchesPerTurn: patch.maxSwitchesPerTurn } : {}),
      preemptive: { ...current.preemptive, ...patch.preemptive },
    };
    this.persist({ pools: { ...pools, [provider]: next } });
    return clonePoolPolicy(next);
  }

  /**
   * One-time acknowledgement that every account in the pool is one the user
   * personally pays for (spec §5, D11). Decision D8: failover defaults to
   * `ask` before the acknowledgement and becomes `automatic` with it, unless
   * the user already chose `off`.
   */
  acknowledgeOwnership(provider: PooledProvider): ProviderAccountPoolPolicy {
    const { pools } = this.read();
    const current = pools[provider];
    if (current.acknowledgedOwnershipAt !== null) return clonePoolPolicy(current);
    const next: ProviderAccountPoolPolicy = {
      ...current,
      acknowledgedOwnershipAt: this.now(),
      failoverMode: current.failoverMode === 'ask' ? 'automatic' : current.failoverMode,
    };
    this.persist({ pools: { ...pools, [provider]: next } });
    logger.info('Account pool ownership acknowledged', { provider });
    return clonePoolPolicy(next);
  }

  private requireProfile(
    profiles: readonly ProviderAccountProfile[],
    provider: PooledProvider,
    profileId: string,
  ): ProviderAccountProfile {
    const target = profiles.find((profile) => profile.provider === provider && profile.id === profileId);
    if (!target) {
      throw new Error(`No ${pooledProviderLabel(provider)} account profile "${profileId}".`);
    }
    return target;
  }

  private replaceProfile(profiles: readonly ProviderAccountProfile[], updated: ProviderAccountProfile): ProviderAccountProfile {
    const stamped = { ...updated, updatedAt: this.now() };
    this.persist({
      profiles: profiles.map((profile) =>
        profile.provider === stamped.provider && profile.id === stamped.id ? stamped : profile),
    });
    return stamped;
  }
}

/** Fill missing providers/fields from the default policy so a partial settings value still reads. */
export function normalizePools(pools: Partial<ProviderAccountPools> | null | undefined): ProviderAccountPools {
  const result = {} as ProviderAccountPools;
  for (const provider of POOLED_PROVIDERS) {
    const stored = pools?.[provider];
    result[provider] = stored
      ? {
          ...clonePoolPolicy(DEFAULT_ACCOUNT_POOL_POLICY),
          ...stored,
          preemptive: { ...DEFAULT_ACCOUNT_POOL_POLICY.preemptive, ...stored.preemptive },
        }
      : clonePoolPolicy(DEFAULT_ACCOUNT_POOL_POLICY);
  }
  return result;
}

/**
 * True when the provider has an account pool (any profile besides legacy).
 * False for other providers and wherever no settings exist (worker agent).
 */
export function isAccountPoolActive(provider: string): boolean {
  if (provider !== 'claude' && provider !== 'codex') return false;
  try {
    return getProviderAccountStore().hasNonLegacyProfiles(provider);
  } catch {
    return false;
  }
}

let instance: ProviderAccountStore | null = null;

export function getProviderAccountStore(): ProviderAccountStore {
  if (!instance) {
    instance = new ProviderAccountStore();
  }
  return instance;
}

export function _resetProviderAccountStoreForTesting(next?: ProviderAccountStore): void {
  instance = next ?? null;
}
