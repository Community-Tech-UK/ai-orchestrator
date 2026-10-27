/**
 * James's never-use and use-last account lists (`planQueueAccountRules`, set on
 * the Plan Queue page) apply to automation sessions as they do to Plan Queue
 * sessions. A fresh automation session carries the lists for the provider it
 * will run on, so the account pools never start, switch or wake it on a
 * never-use account, and use a use-last account only when no other can run.
 *
 * The lists are read when each run starts (retries included). When any rule is
 * set the session carries lists, empty if none name its provider's accounts, so
 * a later move to another provider takes that provider's lists
 * (`accountPreferencesAfterProviderSwap`). Thread wake-ups continue an existing
 * session on its own account, and loop actions route through the loop engine;
 * neither carries the lists.
 */

import { DEFAULT_PLAN_QUEUE_ACCOUNT_RULES, type PlanQueueAccountRules } from '@contracts/schemas/plan-queue';
import type { AccountPreferences } from '../../shared/types/instance.types';
import { resolveCliType } from '../cli/adapters/adapter-factory';
import { getSettingsManager } from '../core/config/settings-manager';
import { accountPreferencesFor } from '../plan-queue/plan-queue-account-rules';
import type { AutomationSpawnTarget } from './automation-model-defaults';

export type AutomationAccountPreferencesResolver = (
  target: AutomationSpawnTarget,
  forceNodeId: string | undefined,
) => Promise<AccountPreferences | undefined>;

export interface AutomationAccountRulesDeps {
  readRules: () => PlanQueueAccountRules;
  /** The CLI a session asking for `provider` gets, resolved as instance creation resolves it. */
  resolveProvider: (provider: AutomationSpawnTarget['provider']) => Promise<string>;
}

function defaultDeps(): AutomationAccountRulesDeps {
  return {
    readRules: () => getSettingsManager().getAll().planQueueAccountRules ?? DEFAULT_PLAN_QUEUE_ACCOUNT_RULES,
    resolveProvider: (provider) => resolveCliType(
      provider as Parameters<typeof resolveCliType>[0],
      getSettingsManager().getAll().defaultCli,
    ),
  };
}

/**
 * The account preferences a fresh automation session carries: its provider's
 * lists (empty when they name none of its accounts), or undefined when no rule
 * is set at all. Pool and Copilot profile ids are separate namespaces, so the
 * provider the session will actually run on is resolved first: a forced worker
 * node keeps a named provider as given, and anything else resolves the way
 * instance creation does ("auto", or a named CLI that is not installed, falls
 * back to the default).
 */
export async function automationAccountPreferences(
  target: AutomationSpawnTarget,
  forceNodeId: string | undefined,
  deps: AutomationAccountRulesDeps = defaultDeps(),
): Promise<AccountPreferences | undefined> {
  const rules = deps.readRules();
  if (rules.never.length === 0 && rules.last.length === 0) return undefined;
  const named = target.provider && target.provider !== 'auto' ? target.provider : undefined;
  const provider = forceNodeId && named ? named : await deps.resolveProvider(target.provider);
  return accountPreferencesFor(rules, provider) ?? { avoid: [], last: [] };
}
