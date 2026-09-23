/**
 * Copilot model discovery across every configured account profile.
 *
 * The picker's Copilot vocabulary is provider-wide (spec §14.4), but what a
 * seat serves is not: on 2026-09-23 the personal default seat lacked
 * `claude-opus-5.5` and `gpt-6-sol`, which the enterprise seat served. Each
 * profile is listed through its own routed adapter, so every authenticated
 * roster is fetched under that profile's home and cached under its id, and the
 * vocabulary is their union.
 *
 * The union only ever ADDS ids, so one seat's refusal or outage never hides a
 * model from another. The cost is that the picker can offer a model the
 * routed seat will refuse; the turn then fails with the seat's own "model not
 * available" error, which is the same outcome `help config`'s static roster
 * already produced for seats it over-reports (see copilot-model-entitlements).
 */

import { CopilotCliAdapter } from '../cli/adapters/copilot-cli-adapter';
import type { CopilotModelInfo } from '../cli/adapters/copilot-cli-adapter.types';
import { getLogger } from '../logging/logger';
import { COPILOT_LEGACY_PROFILE_ID, type CopilotAccountProfile } from '../../shared/types/copilot-account.types';
import { getCopilotAccountRoutingService } from './copilot/copilot-account-routing-service';

const logger = getLogger('CopilotProfileModelDiscovery');

export interface CopilotProfileDiscoveryTarget {
  profileId: string;
  isLegacy: boolean;
  host?: string;
}

export interface CopilotProfileModelDiscoveryDeps {
  listProfiles?: () => CopilotAccountProfile[];
  listForProfile?: (target: CopilotProfileDiscoveryTarget) => Promise<CopilotModelInfo[]>;
}

/**
 * Default profile first, so its roster order leads the merged list. With no
 * profiles configured, the legacy home stands in, as it does for quota —
 * never the ambient `~/.copilot`.
 */
export function copilotDiscoveryTargets(
  profiles: readonly CopilotAccountProfile[],
): CopilotProfileDiscoveryTarget[] {
  if (profiles.length === 0) {
    return [{ profileId: COPILOT_LEGACY_PROFILE_ID, isLegacy: true }];
  }
  return [...profiles]
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map((profile) => ({
      profileId: profile.id,
      isLegacy: profile.isLegacy === true || profile.id === COPILOT_LEGACY_PROFILE_ID,
      ...(profile.host ? { host: profile.host } : {}),
    }));
}

function defaultListProfiles(): CopilotAccountProfile[] {
  return getCopilotAccountRoutingService().listProfiles();
}

async function defaultListForProfile(target: CopilotProfileDiscoveryTarget): Promise<CopilotModelInfo[]> {
  const adapter = new CopilotCliAdapter({
    accountProfileId: target.profileId,
    accountIsLegacy: target.isLegacy,
    ...(target.host ? { accountHost: target.host } : {}),
  });
  return adapter.listAvailableModels({ fallbackToStatic: false });
}

/**
 * Union of every profile's roster, deduped by id in first-seen order. Rejects
 * only when no profile produced a roster, so the catalog keeps its last good
 * state instead of publishing nothing.
 */
export async function listCopilotModelsAcrossProfiles(
  deps: CopilotProfileModelDiscoveryDeps = {},
): Promise<CopilotModelInfo[]> {
  const targets = copilotDiscoveryTargets((deps.listProfiles ?? defaultListProfiles)());
  const listForProfile = deps.listForProfile ?? defaultListForProfile;
  const results = await Promise.allSettled(
    // async wrapper: a synchronous throw (e.g. an unsafe profile id rejected by
    // the home resolver) must become this profile's rejection, not abort all.
    targets.map(async (target) => listForProfile(target)),
  );

  const merged: CopilotModelInfo[] = [];
  const seen = new Set<string>();
  let firstError: unknown;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      firstError ??= result.reason;
      logger.warn('Copilot model discovery failed for one profile; using the others', {
        profileId: targets[index]?.profileId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      return;
    }
    for (const model of result.value) {
      const key = model.id.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(model);
    }
  });

  if (merged.length === 0 && firstError !== undefined) {
    throw firstError;
  }
  return merged;
}
