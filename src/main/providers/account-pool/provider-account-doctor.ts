/**
 * Doctor reporting for Claude/Codex account pools (spec §11).
 *
 * Per-profile binding and identity, priority and policy, pool acknowledgement,
 * whether the pool has any usable default, the NAMES (never values) of ambient
 * auth variables that profile-routed spawns strip, and Codex profiles that
 * resolve to the same ChatGPT account id (a shared workspace limit, so
 * failover between them buys nothing).
 */

import type {
  AccountBindingStatus,
  PooledProvider,
  ProviderAccountPoolPolicy,
  ProviderAccountProfile,
} from '../../../shared/types/provider-account.types';
import { pooledProviderLabel } from '../../../shared/types/provider-account.types';
import {
  CLAUDE_STRIPPED_AUTH_ENV_VARS,
  CODEX_STRIPPED_AUTH_ENV_VARS,
} from '../../cli/adapters/adapter-spawn-helpers';
import {
  LOCAL_ACCOUNT_NODE_ID,
  getProviderAccountBindingService,
  type ProviderAccountBindingService,
} from './provider-account-binding-service';
import { getProviderAccountStore, type ProviderAccountStore } from './provider-account-store';

export interface ProviderAccountDoctorEntry {
  profileId: string;
  label: string;
  priority: number;
  enabled: boolean;
  automationPolicy: ProviderAccountProfile['automationPolicy'];
  isLegacy: boolean;
  expectedIdentity: string | null;
  planLabel: string | null;
  bindingState: AccountBindingStatus['state'];
  bindingErrorCode?: string;
  observedIdentity?: string;
}

export interface ProviderAccountDoctorReport {
  provider: PooledProvider;
  nodeId: string;
  poolActive: boolean;
  policy: ProviderAccountPoolPolicy;
  ownershipAcknowledged: boolean;
  profiles: ProviderAccountDoctorEntry[];
  /** Enabled, signed-in profiles a new session could use. */
  usableProfileIds: string[];
  /** Ambient auth variables present in this process, by name only. */
  ambientAuthVariablesPresent: string[];
  /** Codex profile ids that share one ChatGPT account id with another profile. */
  sharedWorkspaceProfileIds: string[];
  warnings: string[];
}

export function detectAmbientAccountAuthVariables(
  provider: PooledProvider,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const names = provider === 'claude' ? CLAUDE_STRIPPED_AUTH_ENV_VARS : CODEX_STRIPPED_AUTH_ENV_VARS;
  return names.filter((name) => typeof env[name] === 'string' && env[name]!.trim().length > 0);
}

export async function buildProviderAccountDoctorReport(
  provider: PooledProvider,
  deps: { store?: ProviderAccountStore; bindings?: ProviderAccountBindingService; env?: NodeJS.ProcessEnv } = {},
): Promise<ProviderAccountDoctorReport> {
  const store = deps.store ?? getProviderAccountStore();
  const bindings = deps.bindings ?? getProviderAccountBindingService();
  const profiles = store.listProfiles(provider);
  const policy = store.getPoolPolicy(provider);
  const poolActive = profiles.some((profile) => !profile.isLegacy);
  const label = pooledProviderLabel(provider);

  const entries = await Promise.all(profiles.map(async (profile): Promise<ProviderAccountDoctorEntry> => {
    const status = await bindings.checkBinding(profile, LOCAL_ACCOUNT_NODE_ID);
    return {
      profileId: profile.id,
      label: profile.label,
      priority: profile.priority,
      enabled: profile.enabled,
      automationPolicy: profile.automationPolicy,
      isLegacy: profile.isLegacy,
      expectedIdentity: profile.expectedIdentity,
      planLabel: profile.planLabel,
      bindingState: status.state,
      ...(status.errorCode ? { bindingErrorCode: status.errorCode } : {}),
      ...(status.observedIdentity ? { observedIdentity: status.observedIdentity } : {}),
    };
  }));

  const usableProfileIds = entries
    .filter((entry) => entry.enabled && entry.bindingState === 'authenticated')
    .map((entry) => entry.profileId);

  const byAccountKey = new Map<string, string[]>();
  if (provider === 'codex') {
    for (const profile of profiles) {
      const key = profile.expectedAccountKey
        ?? bindings.getObservedIdentity('codex', profile.id)?.accountKey
        ?? null;
      if (!key) continue;
      byAccountKey.set(key, [...(byAccountKey.get(key) ?? []), profile.id]);
    }
  }
  const sharedWorkspaceProfileIds = [...byAccountKey.values()].filter((ids) => ids.length > 1).flat();

  const ambient = detectAmbientAccountAuthVariables(provider, deps.env);
  const warnings: string[] = [];
  if (poolActive && usableProfileIds.length === 0) {
    warnings.push(`No enabled ${label} account is signed in, so new ${label} sessions cannot start.`);
  }
  if (poolActive && policy.acknowledgedOwnershipAt === null) {
    warnings.push(`Confirm in Settings → Accounts that every ${label} account is yours before a second account can be enabled.`);
  }
  for (const entry of entries) {
    if (entry.enabled && entry.bindingState !== 'authenticated') {
      warnings.push(`${entry.label} needs attention: ${entry.bindingState}${entry.bindingErrorCode ? ` (${entry.bindingErrorCode})` : ''}.`);
    }
  }
  if (sharedWorkspaceProfileIds.length > 0) {
    warnings.push('Some Codex accounts share one ChatGPT workspace, so they share its usage limit; switching between them does not add quota.');
  }
  if (poolActive && ambient.length > 0) {
    warnings.push(`${ambient.join(', ')} ${ambient.length === 1 ? 'is' : 'are'} set in Harness's environment and removed from ${label} account sessions.`);
  }

  return {
    provider,
    nodeId: LOCAL_ACCOUNT_NODE_ID,
    poolActive,
    policy,
    ownershipAcknowledged: policy.acknowledgedOwnershipAt !== null,
    profiles: entries,
    usableProfileIds,
    ambientAuthVariablesPresent: ambient,
    sharedWorkspaceProfileIds,
    warnings,
  };
}

export function summarizeProviderAccountReport(report: ProviderAccountDoctorReport): string {
  const label = pooledProviderLabel(report.provider);
  if (!report.poolActive) return `${label}: single account (no pool configured).`;
  const head = `${label} pool: ${report.usableProfileIds.length} of ${report.profiles.length} accounts usable.`;
  return report.warnings.length > 0 ? `${head} ${report.warnings.join(' ')}` : head;
}
