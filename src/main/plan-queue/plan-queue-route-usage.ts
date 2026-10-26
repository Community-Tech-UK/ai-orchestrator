/**
 * Plan Queue ranked choices: does a provider/model/account choice have usage
 * left for a new session, and which choice of a ranked list to use.
 *
 * Usage evidence is what Harness already routes on. For an account pool, the
 * pool's own selection, fenced to the choice's accounts: the choice has usage
 * when the pool finds an account with no usage veto (parked, exhausted,
 * credits-only). Otherwise the provider-limit ledger: an active limit for the
 * provider and the model a new session would start on means no usage, unless
 * the provider has said since that the account can run again (as the send
 * path accepts). A provider Harness cannot see usage for counts as having
 * usage until a session hits its limit and the ledger records it.
 */

import type { PlanQueueRouteChoice } from '@contracts/schemas/plan-queue';
import {
  LEGACY_ACCOUNT_PROFILE_ID,
  isLogicalMiMoModel,
  isPooledProvider,
  type AccountInvocationOrigin,
} from '../../shared/types/provider-account.types';
import type { ProviderId } from '../../shared/types/provider-quota.types';
import type { CliType } from '../cli/cli-detection';
import { COPILOT_RATE_LIMIT_SOURCE } from '../cli/copilot-limit-messages';
import { getSettingsManager } from '../core/config/settings-manager';
import { getProviderLimitLedgerPort, type ProviderLimitLedgerPort } from '../core/system/provider-limit-ledger';
import { getProviderQuotaService } from '../core/system/provider-quota-service';
import { instanceProviderLimitScope } from '../instance/instance-provider-limit-scope';
import { ModelSelectionResolver } from '../instance/lifecycle/model-selection-resolver';
import { quotaEvidenceFromSnapshot } from '../providers/account-pool/account-quota-evidence';
import {
  getProviderAccountRoutingService,
  type AccountRoutePreview,
  type AccountRouteRequest,
} from '../providers/account-pool/provider-account-routing-service';
import { evidenceLiftsPark, type AccountQuotaEvidence } from '../providers/account-pool/provider-account-selector';

export interface PlanQueueRouteUsage {
  usable: boolean;
  /** When a known limit lifts (epoch ms); null when usable or unknown. */
  resumeAt: number | null;
}

export type PlanQueueRouteUsageCheck = (choice: PlanQueueRouteChoice, origin: AccountInvocationOrigin) => Promise<PlanQueueRouteUsage>;

export interface PlanQueueRouteUsageDeps {
  previewAccountRoute: (request: AccountRouteRequest) => Promise<AccountRoutePreview>;
  ledger: Pick<ProviderLimitLedgerPort, 'getActive' | 'getParkedSince'>;
  /** The model a new session on this choice starts on, resolved exactly as the spawn resolves it. */
  spawnModel: (choice: PlanQueueRouteChoice) => Promise<string | null>;
  /** The provider's latest usage evidence for one account (null = the pre-pools sign-in). */
  quotaEvidence: (provider: string, accountProfileId: string | null) => AccountQuotaEvidence | null;
  now: () => number;
}

export async function planQueueRouteUsage(
  choice: PlanQueueRouteChoice,
  origin: AccountInvocationOrigin,
  deps: PlanQueueRouteUsageDeps,
): Promise<PlanQueueRouteUsage> {
  const provider = choice.provider;
  const model = await deps.spawnModel(choice);
  const now = deps.now();
  const limitFor = (accountProfileId: string | null): PlanQueueRouteUsage => {
    const scope = instanceProviderLimitScope(provider as ProviderId, model, accountProfileId);
    const active = deps.ledger.getActive({
      provider: provider as ProviderId, model: scope.model, accountProfileId: scope.accountProfileId, ...scope.ledgerOptions, now,
    });
    if (!active) return { usable: true, resumeAt: null };
    // A reset credit or top-up lifts a limit before its recorded reset, as the send path accepts.
    // Queue work is unattended, so purchased credits alone never count; and like the send path,
    // usage figures never lift a Copilot rate limit, which they do not measure.
    const quotaBlind = provider === 'copilot' && active.source === COPILOT_RATE_LIMIT_SOURCE;
    const since = deps.ledger.getParkedSince({ provider: provider as ProviderId, model: scope.model, anyModel: scope.model === null, now })
      .get(scope.accountProfileId ?? LEGACY_ACCOUNT_PROFILE_ID);
    if (scope.quotaApplies && !quotaBlind && evidenceLiftsPark(deps.quotaEvidence(provider, scope.accountProfileId), since, { allowCredits: false })) {
      return { usable: true, resumeAt: null };
    }
    return { usable: false, resumeAt: active.resumeAt };
  };
  // OpenCode accounts apply only to MiMo Token Plan models, exactly as at spawn.
  if (!isPooledProvider(provider) || (provider === 'opencode' && !isLogicalMiMoModel(model))) return limitFor(null);
  const preview = await deps.previewAccountRoute({
    provider, model, origin, newSession: true,
    ...(choice.accountProfileIds?.length ? { restrictTo: choice.accountProfileIds } : {}),
  });
  // No account can start here at all (signed out, removed, not allowed): no usage either.
  if (!preview.outcome.ok) return { usable: false, resumeAt: null };
  const route = preview.outcome.route;
  // A pool of only the pre-pools sign-in: the ledger alone knows its limits.
  if (route.source === 'legacy') return limitFor(null);
  // The pool's first pass picks an unvetoed account; with none it falls back to a vetoed one to wait on.
  if (!preview.considered.some((entry) => entry.profileId === route.profileId)) return { usable: true, resumeAt: null };
  const waiting = limitFor(route.profileId);
  return { usable: false, resumeAt: waiting.resumeAt };
}

const spawnModelResolver = new ModelSelectionResolver();

export function defaultPlanQueueRouteUsage(): PlanQueueRouteUsageCheck {
  return (choice, origin) => planQueueRouteUsage(choice, origin, {
    previewAccountRoute: (request) => getProviderAccountRoutingService().preview(request),
    ledger: getProviderLimitLedgerPort(),
    spawnModel: async (target) => {
      // Queue sessions spawn locally with no agent, so these are all the inputs the spawn's own resolver sees.
      const settings = getSettingsManager().getAll();
      const resolved = await spawnModelResolver.resolve({
        provider: target.provider as CliType, executionTarget: 'local', configModelOverride: target.model,
        defaultModelByProvider: settings.defaultModelByProvider, defaultModel: settings.defaultModel,
      });
      return resolved.model ?? null;
    },
    quotaEvidence: (provider, accountProfileId) => quotaEvidenceFromSnapshot(getProviderQuotaService().getSnapshot(provider as ProviderId, accountProfileId)),
    now: Date.now,
  });
}

export interface PickedRouteChoice {
  choice: PlanQueueRouteChoice;
  /** Position in the ranked list (0 = first choice). */
  index: number;
  usable: boolean;
}

/**
 * The first choice with usage left. With none, the choice whose known limit
 * lifts soonest (a choice with no known reset never wins that), else the first
 * choice; the session then waits there for its reset.
 */
export async function pickRouteChoice(
  choices: readonly PlanQueueRouteChoice[],
  origin: AccountInvocationOrigin,
  usage: PlanQueueRouteUsageCheck,
): Promise<PickedRouteChoice | null> {
  let soonest: { index: number; resumeAt: number } | null = null;
  for (const [index, choice] of choices.entries()) {
    const found = await usage(choice, origin);
    if (found.usable) return { choice, index, usable: true };
    if (found.resumeAt !== null && (soonest === null || found.resumeAt < soonest.resumeAt)) soonest = { index, resumeAt: found.resumeAt };
  }
  if (choices.length === 0) return null;
  const index = soonest?.index ?? 0;
  return { choice: choices[index], index, usable: false };
}
