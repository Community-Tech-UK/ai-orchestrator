/**
 * Plan Queue account rules: James's "never use" and "use last" lists, applied
 * to the account choices a queue session can be given.
 *
 * `never` is a hard rule: no queue session starts on, switches onto, or wakes
 * on a never-use account. `last` is a preference: the queue uses a last-tier
 * account only when every other option it has for that job cannot run. The
 * lists are read live (see the coordinator), so this module only holds the
 * pure decisions; the routing, usage and verifier code applies them.
 * Automation sessions carry the same lists (`automation-account-rules.ts`).
 */

import type { PlanQueueAccountRules, PlanQueueRouteChoice } from '@contracts/schemas/plan-queue';
import type { AccountPreferences } from '../../shared/types/instance.types';
import type { CopilotAccountProfile } from '../../shared/types/copilot-account.types';
import { isLogicalMiMoModel, type ProviderAccountProfile } from '../../shared/types/provider-account.types';

export type AccountRuleTier = 'never' | 'last';

/** The note a session on a never-use account is held with. It is not an instruction, and it is cleared when the work restarts. */
export const NEVER_USE_HOLD_REASON = 'Restarting on another account: this account is on your Plan Queue never-use list.';

export function accountRuleTier(rules: PlanQueueAccountRules, provider: string, accountId: string): AccountRuleTier | null {
  if (rules.never.some((ref) => ref.provider === provider && ref.accountId === accountId)) return 'never';
  if (rules.last.some((ref) => ref.provider === provider && ref.accountId === accountId)) return 'last';
  return null;
}

function idsInTier(rules: PlanQueueAccountRules, provider: string, tier: AccountRuleTier): string[] {
  return rules[tier]
    .filter((ref) => ref.provider === provider)
    .map((ref) => ref.accountId);
}

/**
 * The preferences a session of one provider carries, or null when the lists
 * name none of its accounts. Only that provider's ids are included: pool and
 * Copilot profile ids are separate namespaces.
 */
export function accountPreferencesFor(rules: PlanQueueAccountRules, provider: string): AccountPreferences | null {
  const avoid = idsInTier(rules, provider, 'never');
  const last = idsInTier(rules, provider, 'last');
  return avoid.length || last.length ? { avoid, last } : null;
}

/**
 * Why a route choice cannot run because of the never-use list, or null when it
 * can. `provider` is the choice's canonical CLI id. A pooled choice with no
 * accounts ticked is blocked only when every enabled, automation-allowed
 * account of that provider is on the list.
 */
export function choiceBlockedByNeverUse(
  choice: PlanQueueRouteChoice,
  provider: string,
  rules: PlanQueueAccountRules,
  poolProfiles: readonly ProviderAccountProfile[],
  copilotProfiles: readonly CopilotAccountProfile[],
): string | null {
  if (choice.copilotProfileId && accountRuleTier(rules, 'copilot', choice.copilotProfileId) === 'never') {
    return `the Copilot account "${copilotLabel(copilotProfiles, choice.copilotProfileId)}" is on your never-use list`;
  }
  if (choice.accountProfileIds?.length) {
    for (const id of choice.accountProfileIds) {
      if (accountRuleTier(rules, provider, id) === 'never') {
        return `the ${provider} account "${poolLabel(poolProfiles, provider, id)}" is on your never-use list`;
      }
    }
    return null;
  }
  if (provider === 'opencode' && !isLogicalMiMoModel(choice.model)) return null;
  const usable = poolProfiles.filter((profile) => profile.provider === provider && profile.enabled && profile.automationPolicy === 'allow-routed');
  if (usable.length > 0 && usable.every((profile) => accountRuleTier(rules, provider, profile.id) === 'never')) {
    return `every ${provider} account this choice can use is on your never-use list`;
  }
  return null;
}

/**
 * A checker or worker choice as it can run with the never-use accounts taken
 * out, or the reason it cannot run at all. A list that ticks some never-use
 * accounts still runs on the others; only a list with none left is blocked.
 */
export function choiceWithoutNeverUse(
  choice: PlanQueueRouteChoice,
  provider: string,
  rules: PlanQueueAccountRules,
  poolProfiles: readonly ProviderAccountProfile[],
  copilotProfiles: readonly CopilotAccountProfile[],
): { choice: PlanQueueRouteChoice } | { blocked: string } {
  if (choice.copilotProfileId && accountRuleTier(rules, 'copilot', choice.copilotProfileId) === 'never') {
    return { blocked: `the Copilot account "${copilotLabel(copilotProfiles, choice.copilotProfileId)}" is on your never-use list` };
  }
  if (choice.accountProfileIds?.length) {
    const left = choice.accountProfileIds.filter((id) => accountRuleTier(rules, provider, id) !== 'never');
    if (left.length === 0) {
      const [only] = choice.accountProfileIds;
      return { blocked: choice.accountProfileIds.length === 1 && only !== undefined
        ? `the ${provider} account "${poolLabel(poolProfiles, provider, only)}" is on your never-use list`
        : 'every account this choice ticks is on your never-use list' };
    }
    return { choice: { ...choice, accountProfileIds: left } };
  }
  const blocked = choiceBlockedByNeverUse(choice, provider, rules, poolProfiles, copilotProfiles);
  return blocked ? { blocked } : { choice };
}

/** An account's label for a reason James reads; falls back to the id when the account is gone. */
export function poolLabel(profiles: readonly ProviderAccountProfile[], provider: string, id: string): string {
  return profiles.find((profile) => profile.provider === provider && profile.id === id)?.label ?? id;
}

export function copilotLabel(profiles: readonly CopilotAccountProfile[], id: string): string {
  return profiles.find((profile) => profile.id === id)?.label ?? id;
}

/** One line for status output: "never use: A, B; use last: C", or null when no rule is set. */
export function describeAccountRules(
  rules: PlanQueueAccountRules,
  labelOf: (ref: PlanQueueAccountRules['never'][number]) => string,
): string | null {
  const never = rules.never.map(labelOf);
  const last = rules.last.map(labelOf);
  if (never.length === 0 && last.length === 0) return null;
  const parts = [
    ...(never.length ? [`never use: ${never.join(', ')}`] : []),
    ...(last.length ? [`use last: ${last.join(', ')}`] : []),
  ];
  return parts.join('; ');
}
