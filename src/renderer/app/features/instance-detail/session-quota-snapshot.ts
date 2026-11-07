import type { ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';
/** Never substitute a different account's provider-level quota for a named seat. */
export function sessionQuotaSnapshot(instance: { provider: string; accountProfileId?: string; copilotAccountProfileId?: string },
  snapshots: Partial<Record<string, ProviderQuotaSnapshot | null>>, accounts: readonly ProviderQuotaSnapshot[]): ProviderQuotaSnapshot | null {
  const profile = instance.provider === 'copilot' ? instance.copilotAccountProfileId : instance.accountProfileId;
  return profile && profile !== 'legacy'
    ? accounts.find(s => s.provider === instance.provider && s.accountProfileId === profile) ?? null
    : snapshots[instance.provider] ?? null;
}
