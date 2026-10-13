/**
 * Plan Queue routing — which providers and accounts the queue's sessions use.
 *
 * A run fixes its routing when it starts (`config.routing`): a per-run override
 * from `plan_queue_start`, else James's saved `planQueueRouting` setting, else
 * the parent session's provider, model and account. Explicit choices are
 * validated up front so a bad choice refuses the run with a plain reason
 * instead of parking every item later.
 *
 * Queue sessions are unattended work, so every one of them routes with an
 * automatic origin: account automation policies (`manual-only`, `disabled`),
 * the paid-credit preference for the first account pick and the "never
 * auto-pick" list apply to workers, triage and checkers alike. A provider on
 * that list refuses the run at start rather than failing each spawn later,
 * unless the run relaxes that list (`relaxSettings`).
 */

import type { PlanQueueRole, PlanQueueRouteChoice, PlanQueueRouteChoiceArgs, PlanQueueRouting } from '@contracts/schemas/plan-queue';
import type { CopilotAccountProfile } from '../../shared/types/copilot-account.types';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import { isLogicalMiMoModel, isPooledProvider, type ProviderAccountProfile } from '../../shared/types/provider-account.types';
import { AUTOMATION_PROVIDER_IDS } from '../../shared/types/automation-provider.types';
import { REMOTE_REVIEWER_PROVIDER_IDS } from '../../shared/types/reviewer-provider.types';
import { sameFamily } from '../../shared/models/model-family';
import { sameProviderCheckerCanDiffer } from '../../shared/models/multi-maker-providers';
import { getSettingsManager } from '../core/config/settings-manager';
import { isProviderExcludedFromAutomation } from '../providers/automation-provider-exclusions';
import { classifyCheckerScope } from '../review/checker-plan';
import type { PlanQueueRun } from './plan-queue.types';

export interface PlanQueueRoutingDeps {
  readSaved: () => PlanQueueRouting;
  poolProfiles: () => readonly ProviderAccountProfile[];
  copilotProfiles: () => readonly CopilotAccountProfile[];
  isProviderExcluded: (provider: string) => boolean;
  /** The `defaultCli` setting when it names a provider; null for 'auto'. */
  defaultProvider: () => string | null;
  /** The workspace's work-Copilot licence scope kind ('none' = no protected rule applies). */
  checkerScopeKind: (workspaceCwd: string) => string;
}

export function defaultPlanQueueRoutingDeps(): PlanQueueRoutingDeps {
  return {
    readSaved: () => getSettingsManager().getAll().planQueueRouting ?? { worker: null, verifiers: [] },
    poolProfiles: () => getSettingsManager().getAll().providerAccountProfiles ?? [],
    copilotProfiles: () => getSettingsManager().getAll().copilotAccountProfiles ?? [],
    isProviderExcluded: isProviderExcludedFromAutomation,
    defaultProvider: () => {
      const configured = getSettingsManager().getAll().defaultCli;
      return configured && configured !== 'auto' ? configured : null;
    },
    checkerScopeKind: (workspaceCwd) => classifyCheckerScope(workspaceCwd).kind,
  };
}

/** What the run inherits from the session that starts it. */
export interface PlanQueueParentRoute {
  provider?: string;
  currentModel?: string;
  accountProfileId?: string;
  copilotAccountProfileId?: string;
}

export interface PlanQueueRoutingOverride {
  worker?: PlanQueueRouteChoice;
  verifiers?: PlanQueueRouteChoice[];
  /** The run relaxes the "never auto-pick" list (`relaxSettings`), so it is not checked at start. */
  relaxExclusions?: boolean;
  /** The run's repository root; a per-run checker list is refused where a work Copilot rule applies. */
  workspaceCwd?: string;
}

/** Thrown when an explicit choice cannot be honoured; the message is for James. */
export class PlanQueueRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanQueueRoutingError';
  }
}

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(AUTOMATION_PROVIDER_IDS);

/**
 * Lowercase CLI id, with the same legacy aliasing as `mapSettingsToDetectionType`
 * (`openai` → codex, `gemini` → antigravity), so a choice is checked against the
 * "never auto-pick" list under the CLI that will actually run.
 */
function canonicalProvider(provider: string): string {
  const id = provider.trim().toLowerCase();
  return id === 'openai' ? 'codex' : id === 'gemini' ? 'antigravity' : id;
}
/** Checkers must be able to run as an agentic reviewer. */
const CHECKER_PROVIDERS: ReadonlySet<string> = new Set(REMOTE_REVIEWER_PROVIDER_IDS);

/** The MCP tools' snake_case choice, as a stored choice. */
export function routeChoiceFromArgs(args: PlanQueueRouteChoiceArgs): PlanQueueRouteChoice {
  return {
    provider: args.provider,
    ...(args.model ? { model: args.model } : {}),
    ...(args.account_ids?.length ? { accountProfileIds: [...new Set(args.account_ids)] } : {}),
    ...(args.copilot_account_id ? { copilotProfileId: args.copilot_account_id } : {}),
  };
}

function poolAccountProblem(profile: ProviderAccountProfile | undefined, id: string, provider: string): string | null {
  if (!profile) return `there is no ${provider} account "${id}"`;
  if (!profile.enabled) return `the ${provider} account "${profile.label}" is turned off`;
  if (profile.automationPolicy !== 'allow-routed') {
    return `the ${provider} account "${profile.label}" is set to ${profile.automationPolicy === 'manual-only' ? '"manual only"' : '"never"'} for automatic work`;
  }
  return null;
}

function copilotAccountProblem(profile: CopilotAccountProfile | undefined, id: string): string | null {
  if (!profile) return `there is no Copilot account "${id}"`;
  if (profile.automationPolicy !== 'allow-routed') {
    return `the Copilot account "${profile.label}" is set to ${profile.automationPolicy === 'manual-only' ? '"manual only"' : '"never"'} for automatic work`;
  }
  return null;
}

/**
 * Refuse a choice the queue could not honour, with a reason James can act on.
 * Takes the choice as given (before `normalizeChoice`): the "never auto-pick"
 * list is checked under both the id James chose and the CLI that will run, so
 * listing either `gemini` or `antigravity` keeps a Gemini choice out.
 */
export function assertRouteChoice(
  choice: PlanQueueRouteChoice,
  role: 'worker' | 'verifier',
  deps: PlanQueueRoutingDeps,
  relaxExclusions = false,
): void {
  const asGiven = choice.provider.trim().toLowerCase();
  const provider = canonicalProvider(choice.provider);
  const label = role === 'worker' ? 'Plan Queue worker' : 'Plan Queue checker';
  const known = role === 'worker' ? KNOWN_PROVIDERS : CHECKER_PROVIDERS;
  if (!known.has(provider)) {
    throw new PlanQueueRoutingError(`${label}: "${choice.provider}" is not a provider the queue can use here (${[...known].join(', ')}).`);
  }
  const listed = [asGiven, provider].find((id) => deps.isProviderExcluded(id));
  if (!relaxExclusions && listed) {
    throw new PlanQueueRoutingError(`${label}: ${listed} is on the "never auto-pick these providers" list, so queue sessions cannot use it. Remove it from that list, or choose another provider for the queue.`);
  }
  if (choice.accountProfileIds?.length) {
    if (!isPooledProvider(provider)) {
      throw new PlanQueueRoutingError(`${label}: ${provider} has no account pool, so it cannot be limited to accounts.`);
    }
    if (provider === 'opencode' && !isLogicalMiMoModel(choice.model)) {
      throw new PlanQueueRoutingError(`${label}: OpenCode accounts only apply to MiMo Token Plan models (xiaomi-token-plan/…). Choose one, or untick the accounts.`);
    }
    const profiles = deps.poolProfiles().filter((profile) => profile.provider === provider);
    for (const id of choice.accountProfileIds) {
      const problem = poolAccountProblem(profiles.find((profile) => profile.id === id), id, provider);
      if (problem) throw new PlanQueueRoutingError(`${label}: ${problem}.`);
    }
  }
  if (choice.copilotProfileId) {
    if (provider !== 'copilot') {
      throw new PlanQueueRoutingError(`${label}: a Copilot account was chosen for ${provider}.`);
    }
    const problem = copilotAccountProblem(deps.copilotProfiles().find((profile) => profile.id === choice.copilotProfileId), choice.copilotProfileId);
    if (problem) throw new PlanQueueRoutingError(`${label}: ${problem}.`);
  }
}

function normalizeChoice(choice: PlanQueueRouteChoice): PlanQueueRouteChoice {
  return { ...choice, provider: canonicalProvider(choice.provider) };
}

/**
 * The parent session's provider, model and account — the account only when it
 * may be used for automatic work, so inheriting never spends an account James
 * kept for himself. An "auto" session resolves to the `defaultCli` setting;
 * with that also "auto", the spawn's own automatic choice (which already skips
 * the "never auto-pick" list) decides.
 */
function inheritedWorker(parent: PlanQueueParentRoute, deps: PlanQueueRoutingDeps, relaxExclusions: boolean): PlanQueueRouteChoice | null {
  const fromParent = parent.provider && parent.provider !== 'auto' ? parent.provider : null;
  const configured = fromParent ?? deps.defaultProvider();
  if (!configured) return null;
  const provider = canonicalProvider(configured);
  const choice: PlanQueueRouteChoice = { provider, ...(fromParent && parent.currentModel ? { model: parent.currentModel } : {}) };
  if (isPooledProvider(provider) && parent.accountProfileId) {
    const profile = deps.poolProfiles().find((p) => p.provider === provider && p.id === parent.accountProfileId);
    if (!poolAccountProblem(profile, parent.accountProfileId, provider)) choice.accountProfileIds = [parent.accountProfileId];
  }
  if (provider === 'copilot' && parent.copilotAccountProfileId) {
    const profile = deps.copilotProfiles().find((p) => p.id === parent.copilotAccountProfileId);
    if (!copilotAccountProblem(profile, parent.copilotAccountProfileId)) choice.copilotProfileId = parent.copilotAccountProfileId;
  }
  // A non-MiMo OpenCode model ignores pool accounts; recording one would only mislead.
  if (provider === 'opencode' && !isLogicalMiMoModel(choice.model)) delete choice.accountProfileIds;
  try {
    assertRouteChoice({ ...choice, provider: configured }, 'worker', deps, relaxExclusions);
  } catch (error) {
    if (!(error instanceof PlanQueueRoutingError)) throw error;
    throw new PlanQueueRoutingError(`${error.message} The run took this provider from ${fromParent ? 'the session that started it' : 'the default provider setting'}; choose Workers on the Plan Queue page, or start it from another session.`);
  }
  return choice;
}

/**
 * Could any checker judge the workers' output? A checker on the workers' own
 * provider only can with a model from a different maker: when the workers'
 * model is named, the families must differ; when it is not, only a
 * multi-maker provider leaves room (the live model decides at verification).
 * Otherwise every item would do its work and then park with no checker.
 */
export function checkersCanDiffer(
  worker: Pick<PlanQueueRouteChoice, 'provider' | 'model'>,
  verifiers: readonly Pick<PlanQueueRouteChoice, 'provider' | 'model'>[],
): boolean {
  const workerProvider = canonicalProvider(worker.provider);
  return verifiers.some((checker) => {
    if (canonicalProvider(checker.provider) !== workerProvider) return true;
    return sameProviderCheckerCanDiffer(workerProvider, checker.model, worker.model, (a, b) => !sameFamily(a, b));
  });
}

function assertCheckersCanDiffer(worker: PlanQueueRouteChoice | null, verifiers: readonly PlanQueueRouteChoice[]): void {
  if (!worker || verifiers.length === 0) return;
  const usable = checkersCanDiffer(worker, verifiers);
  if (usable) return;
  throw new PlanQueueRoutingError(
    `None of the chosen checkers can check this run: they all use ${worker.provider}, the workers' provider, without a model from a different maker. `
    + 'Add a checker on another provider, or give one a model from a different maker (on OpenCode, also name the workers\' model).',
  );
}

/** The routing a new run fixes. Throws `PlanQueueRoutingError` for an explicit choice it cannot honour. */
export function resolveRunRouting(
  parent: PlanQueueParentRoute,
  override: PlanQueueRoutingOverride | undefined,
  deps: PlanQueueRoutingDeps = defaultPlanQueueRoutingDeps(),
): PlanQueueRouting {
  const saved = deps.readSaved();
  const explicitWorker = override?.worker ?? saved.worker;
  const relax = override?.relaxExclusions === true;
  const chosenVerifiers = override?.verifiers ?? saved.verifiers;
  for (const choice of chosenVerifiers) assertRouteChoice(choice, 'verifier', deps, relax);
  const verifiers = chosenVerifiers.map(normalizeChoice);
  const perRunCheckers = Boolean(override?.verifiers?.length);
  if (perRunCheckers && override?.workspaceCwd && deps.checkerScopeKind(override.workspaceCwd) !== 'none') {
    throw new PlanQueueRoutingError(
      'This repository is covered by a protected work Copilot rule (or its rule could not be worked out), so checkers given for one run cannot replace the work seat here. '
      + 'Choose the checkers on the Plan Queue page instead, or start the run without a checker list.',
    );
  }
  const checkersChosenBy = verifiers.length === 0 ? {} : { checkersChosenBy: perRunCheckers ? 'run' as const : 'saved' as const };
  let worker: PlanQueueRouteChoice | null;
  if (explicitWorker) {
    assertRouteChoice(explicitWorker, 'worker', deps, relax);
    worker = normalizeChoice(explicitWorker);
  } else {
    worker = inheritedWorker(parent, deps, relax);
  }
  assertCheckersCanDiffer(worker, verifiers);
  return { worker, verifiers, ...checkersChosenBy };
}

/**
 * Account routing for one queue spawn: who it acts for, and the accounts it
 * may use. Applied at the coordinator's single `createInstance` chokepoint, so
 * every worker, triage and verifier spawn (first start, respawn, resume after
 * a restart) gets it. A config without queue metadata passes through.
 */
export function routeQueueSpawn(
  config: InstanceCreateConfig,
  getRun: (runId: string) => PlanQueueRun | null | undefined,
  isExcluded: (provider: string) => boolean = isProviderExcludedFromAutomation,
): InstanceCreateConfig {
  const role = config.metadata?.['planQueueRole'] as PlanQueueRole | undefined;
  const runId = config.metadata?.['planQueueRunId'];
  if (!role || typeof runId !== 'string') return config;
  // Queue sessions never hop to another provider after failures: that would leave James's choice.
  if (role === 'verifier') return { ...config, accountRouteOrigin: 'verification', failoverProviders: [] };
  const run = getRun(runId);
  // The list may have changed since the run started; a new worker obeys it (the verifier re-checks at selection).
  const given = config.provider?.trim().toLowerCase();
  const provider = given ? canonicalProvider(given) : null;
  if (given && provider && !run?.config.relaxSettings && (isExcluded(provider) || isExcluded(given))) {
    throw new PlanQueueRoutingError(`${provider} has been added to the "never auto-pick these providers" list since this run started, so the queue will not start another session on it.`);
  }
  const worker = run?.config.routing?.worker;
  return {
    ...config,
    accountRouteOrigin: 'automation',
    failoverProviders: [],
    ...(worker?.accountProfileIds?.length ? { allowedAccountProfileIds: [...worker.accountProfileIds] } : {}),
    ...(worker?.copilotProfileId && !config.copilotAccountProfileId ? { copilotAccountProfileId: worker.copilotProfileId } : {}),
  };
}

/** One line per role, for status output and logs. */
export function describeRouting(routing: PlanQueueRouting | undefined): { workers: string; checkers: string } {
  const describe = (choice: PlanQueueRouteChoice): string => {
    const accounts = choice.accountProfileIds?.length ? ` (accounts: ${choice.accountProfileIds.join(', ')})` : '';
    const copilot = choice.copilotProfileId ? ` (account: ${choice.copilotProfileId})` : '';
    return `${choice.provider}${choice.model ? ` / ${choice.model}` : ''}${accounts}${copilot}`;
  };
  return {
    workers: routing?.worker ? describe(routing.worker) : 'the default provider',
    checkers: routing?.verifiers.length ? routing.verifiers.map(describe).join('; ') : 'automatic',
  };
}
