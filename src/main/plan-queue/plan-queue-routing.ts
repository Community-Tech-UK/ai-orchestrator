/**
 * Plan Queue routing — which providers and accounts the queue's sessions use.
 *
 * A run fixes its routing when it starts (`config.routing`). For each role,
 * James's saved `planQueueRouting` list wins; a per-run choice from
 * `plan_queue_start` applies only where that saved list is empty; with neither,
 * workers take the parent session's provider, model and account and checkers
 * are automatic. Workers are a ranked list: each new worker session starts on
 * the first choice with usage left (`plan-queue-route-usage.ts`). An optional
 * step-up choice takes over a document, once, when its worker fails every
 * verification round (`plan-queue-step-up.ts`). Explicit
 * choices are validated up front so a bad choice refuses the run with a plain
 * reason instead of parking every item later.
 *
 * Queue sessions are unattended work, so every one of them routes with an
 * automatic origin: account automation policies (`manual-only`, `disabled`),
 * the paid-credit preference for the first account pick and the "never
 * auto-pick" list apply to workers, triage and checkers alike. A provider on
 * that list refuses the run at start rather than failing each spawn later,
 * unless the run relaxes that list (`relaxSettings`).
 */

import {
  DEFAULT_PLAN_QUEUE_ACCOUNT_RULES, DEFAULT_PLAN_QUEUE_ROUTING, type PlanQueueAccountRules, type PlanQueueRole,
  type PlanQueueRouteChoice, type PlanQueueRouteChoiceArgs, type PlanQueueRouting,
} from '@contracts/schemas/plan-queue';
import type { CopilotAccountProfile, CopilotInvocationOrigin } from '../../shared/types/copilot-account.types';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import { isLogicalMiMoModel, isPooledProvider, type ProviderAccountProfile } from '../../shared/types/provider-account.types';
import { AUTOMATION_PROVIDER_IDS } from '../../shared/types/automation-provider.types';
import { REMOTE_REVIEWER_PROVIDER_IDS } from '../../shared/types/reviewer-provider.types';
import { upgradePlanQueueRouting } from '../../shared/utils/plan-queue-routing-upgrade';
import { sameFamily } from '../../shared/models/model-family';
import { sameProviderCheckerCanDiffer } from '../../shared/models/multi-maker-providers';
import { detectAvailableClis } from '../cli/cli-detection';
import { getSettingsManager } from '../core/config/settings-manager';
import { isProviderExcludedFromAutomation } from '../providers/automation-provider-exclusions';
import { getCopilotAccountRoutingService } from '../providers/copilot/copilot-account-routing-service';
import { getLogger } from '../logging/logger';
import { classifyCheckerScope } from '../review/checker-plan';
import { pickRouteChoice, type PlanQueueRouteUsageCheck } from './plan-queue-route-usage';
import {
  accountPreferencesFor, accountRuleTier, choiceBlockedByNeverUse, copilotLabel, poolLabel,
} from './plan-queue-account-rules';
import type { PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueRouting');

export interface PlanQueueRoutingDeps {
  listInstalledProviders?: () => Promise<string[]>;
  readSaved: () => PlanQueueRouting;
  poolProfiles: () => readonly ProviderAccountProfile[];
  copilotProfiles: () => readonly CopilotAccountProfile[];
  isProviderExcluded: (provider: string) => boolean;
  /** The `defaultCli` setting when it names a provider; null for 'auto'. */
  defaultProvider: () => string | null;
  /** The workspace's work-Copilot licence scope kind ('none' = no protected rule applies). */
  checkerScopeKind: (workspaceCwd: string) => string;
  /** James's never-use and use-last account lists, read live. */
  readAccountRules: () => PlanQueueAccountRules;
  /** The Copilot profile a session in this folder would get, or null when none would. */
  copilotProfileFor: (workspaceCwd: string, origin: CopilotInvocationOrigin) => string | null;
  /** Usage left for a choice; defaults to the account pools and the limit ledger. */
  routeUsage?: PlanQueueRouteUsageCheck;
}

export function defaultPlanQueueRoutingDeps(): PlanQueueRoutingDeps {
  return {
    listInstalledProviders: async () => (await detectAvailableClis()).filter((cli) => cli.installed).map((cli) => cli.name),
    readSaved: () => upgradePlanQueueRouting(getSettingsManager().getAll().planQueueRouting ?? DEFAULT_PLAN_QUEUE_ROUTING),
    poolProfiles: () => getSettingsManager().getAll().providerAccountProfiles ?? [],
    copilotProfiles: () => getSettingsManager().getAll().copilotAccountProfiles ?? [],
    isProviderExcluded: isProviderExcludedFromAutomation,
    defaultProvider: () => {
      const configured = getSettingsManager().getAll().defaultCli;
      return configured && configured !== 'auto' ? configured : null;
    },
    checkerScopeKind: (workspaceCwd) => classifyCheckerScope(workspaceCwd).kind,
    readAccountRules: () => getSettingsManager().getAll().planQueueAccountRules ?? DEFAULT_PLAN_QUEUE_ACCOUNT_RULES,
    copilotProfileFor: (workspaceCwd, origin) => getCopilotAccountRoutingService().previewProfileFor(workspaceCwd, origin),
  };
}

/** What the run inherits from the session that starts it. */
export interface PlanQueueParentRoute {
  provider?: string;
  currentModel?: string;
  accountProfileId?: string;
  copilotAccountProfileId?: string;
}

/** An agent's per-run choices; each applies only where James's saved list for that role is empty. */
export interface PlanQueueRoutingOverride {
  workers?: PlanQueueRouteChoice[];
  verifiers?: PlanQueueRouteChoice[];
  stepUp?: PlanQueueRouteChoice;
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
/** A session with no provider has no account list to apply James's never-use rules to. */
const NO_PROVIDER_FOR_NEVER_USE = 'This run has no worker provider, so the queue cannot apply your never-use list to it. Choose a worker provider on the Plan Queue page, or start the run from a session on a provider.';

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
  role: 'worker' | 'step-up' | 'verifier',
  deps: PlanQueueRoutingDeps,
  relaxExclusions = false,
  /** 1-based place in a list of more than one choice, named in the reason. */
  position?: number,
): void {
  const asGiven = choice.provider.trim().toLowerCase();
  const provider = canonicalProvider(choice.provider);
  const label = `Plan Queue ${role === 'verifier' ? 'checker' : role === 'step-up' ? 'step-up worker' : 'worker'}${position ? ` choice ${position}` : ''}`;
  const known = role === 'verifier' ? CHECKER_PROVIDERS : KNOWN_PROVIDERS;
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
  // James's never-use list beats every choice, including a run that relaxes the auto-pick list.
  const blocked = choiceBlockedByNeverUse(choice, provider, deps.readAccountRules(), deps.poolProfiles(), deps.copilotProfiles());
  if (blocked) {
    throw new PlanQueueRoutingError(`${label}: ${blocked}. Untick it, or take it off the never-use list on the Plan Queue page.`);
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
function inheritedWorker(
  parent: PlanQueueParentRoute,
  deps: PlanQueueRoutingDeps,
  relaxExclusions: boolean,
): { choice: PlanQueueRouteChoice; note: string | null } | null {
  const fromParent = parent.provider && parent.provider !== 'auto' ? parent.provider : null;
  const configured = fromParent ?? deps.defaultProvider();
  if (!configured) return null;
  const provider = canonicalProvider(configured);
  const rules = deps.readAccountRules();
  const choice: PlanQueueRouteChoice = { provider, ...(fromParent && parent.currentModel ? { model: parent.currentModel } : {}) };
  let note: string | null = null;
  const ruleNote = (tier: 'never' | 'last', label: string) => `The starting session's account "${label}" is on your ${tier === 'never' ? 'never-use' : 'use-last'} list, so the run picks its own account.`;
  if (isPooledProvider(provider) && parent.accountProfileId) {
    const profile = deps.poolProfiles().find((p) => p.provider === provider && p.id === parent.accountProfileId);
    const tier = accountRuleTier(rules, provider, parent.accountProfileId);
    if (tier) note = ruleNote(tier, poolLabel(deps.poolProfiles(), provider, parent.accountProfileId));
    else if (!poolAccountProblem(profile, parent.accountProfileId, provider)) choice.accountProfileIds = [parent.accountProfileId];
  }
  if (provider === 'copilot' && parent.copilotAccountProfileId) {
    const profile = deps.copilotProfiles().find((p) => p.id === parent.copilotAccountProfileId);
    const tier = accountRuleTier(rules, 'copilot', parent.copilotAccountProfileId);
    if (tier) note = ruleNote(tier, copilotLabel(deps.copilotProfiles(), parent.copilotAccountProfileId));
    else if (!copilotAccountProblem(profile, parent.copilotAccountProfileId)) choice.copilotProfileId = parent.copilotAccountProfileId;
  }
  // A non-MiMo OpenCode model ignores pool accounts; recording one would only mislead.
  if (provider === 'opencode' && !isLogicalMiMoModel(choice.model)) delete choice.accountProfileIds;
  try {
    assertRouteChoice({ ...choice, provider: configured }, 'worker', deps, relaxExclusions);
  } catch (error) {
    if (!(error instanceof PlanQueueRoutingError)) throw error;
    throw new PlanQueueRoutingError(`${error.message} The run took this provider from ${fromParent ? 'the session that started it' : 'the default provider setting'}; choose Workers on the Plan Queue page, or start it from another session.`);
  }
  return { choice, note };
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

/** Every worker choice, and the step-up worker, needs a checker that can judge its work. */
function assertCheckersCanDiffer(workers: readonly PlanQueueRouteChoice[], verifiers: readonly PlanQueueRouteChoice[], stepUp: PlanQueueRouteChoice | undefined): void {
  if (verifiers.length === 0) return;
  if (stepUp && !checkersCanDiffer(stepUp, verifiers)) {
    throw new PlanQueueRoutingError(
      `None of the chosen checkers can check the step-up worker: they all use ${stepUp.provider}, its provider, without a model from a different maker. `
      + 'Add a checker on another provider, give one a model from a different maker, or choose a step-up worker on another provider.',
    );
  }
  const index = workers.findIndex((worker) => !checkersCanDiffer(worker, verifiers));
  if (index < 0) return;
  const worker = workers[index]!;
  const which = workers.length > 1 ? `worker choice ${index + 1}'s provider` : 'the workers\' provider';
  throw new PlanQueueRoutingError(
    `None of the chosen checkers can check ${workers.length > 1 ? 'every worker choice' : 'this run'}: they all use ${worker.provider}, ${which}, without a model from a different maker. `
    + 'Add a checker on another provider, or give one a model from a different maker (on OpenCode, also name the workers\' model).',
  );
}

export interface ResolvedRunRouting {
  routing: PlanQueueRouting;
  /** Roles whose per-run choice was not used because James saved a choice for them. */
  setAside: ('workers' | 'checkers' | 'step-up')[];
  /** Account-rule effects James should know about (a starting account that was not inherited). */
  accountNotes: string[];
}

function assertChoices(choices: readonly PlanQueueRouteChoice[], role: 'worker' | 'step-up' | 'verifier', deps: PlanQueueRoutingDeps, relax: boolean): void {
  choices.forEach((choice, index) => assertRouteChoice(choice, role, deps, relax, choices.length > 1 ? index + 1 : undefined));
}

/** The routing a new run fixes. Throws `PlanQueueRoutingError` for an explicit choice it cannot honour. */
export function resolveRunRouting(
  parent: PlanQueueParentRoute,
  override: PlanQueueRoutingOverride | undefined,
  deps: PlanQueueRoutingDeps = defaultPlanQueueRoutingDeps(),
): ResolvedRunRouting {
  const saved = deps.readSaved();
  const relax = override?.relaxExclusions === true;
  const savedWorkers = saved.workers.length > 0;
  const savedCheckers = saved.verifiers.length > 0;
  const setAside: ResolvedRunRouting['setAside'] = [
    ...(savedWorkers && override?.workers !== undefined ? ['workers' as const] : []),
    ...(savedCheckers && override?.verifiers !== undefined ? ['checkers' as const] : []),
    ...(saved.stepUp && override?.stepUp ? ['step-up' as const] : []),
  ];
  const chosenVerifiers = savedCheckers ? saved.verifiers : override?.verifiers ?? [];
  assertChoices(chosenVerifiers, 'verifier', deps, relax);
  const verifiers = chosenVerifiers.map(normalizeChoice);
  const perRunCheckers = !savedCheckers && verifiers.length > 0;
  if (perRunCheckers && override?.workspaceCwd && deps.checkerScopeKind(override.workspaceCwd) !== 'none') {
    throw new PlanQueueRoutingError(
      'This repository is covered by a protected work Copilot rule (or its rule could not be worked out), so checkers given for one run cannot replace the work seat here. '
      + 'Choose the checkers on the Plan Queue page instead, or start the run without a checker list.',
    );
  }
  const checkersChosenBy = verifiers.length === 0 ? {} : { checkersChosenBy: perRunCheckers ? 'run' as const : 'saved' as const };
  const explicitWorkers = savedWorkers ? saved.workers : override?.workers ?? [];
  let workers: PlanQueueRouteChoice[];
  const accountNotes: string[] = [];
  if (explicitWorkers.length > 0) {
    assertChoices(explicitWorkers, 'worker', deps, relax);
    workers = explicitWorkers.map(normalizeChoice);
  } else {
    const inherited = inheritedWorker(parent, deps, relax);
    workers = inherited ? [inherited.choice] : [];
    if (inherited?.note) accountNotes.push(inherited.note);
  }
  if (workers.length === 0 && deps.readAccountRules().never.length > 0) throw new PlanQueueRoutingError(NO_PROVIDER_FOR_NEVER_USE);
  const chosenStepUp = saved.stepUp ?? override?.stepUp;
  if (chosenStepUp) assertRouteChoice(chosenStepUp, 'step-up', deps, relax);
  const stepUp = chosenStepUp ? normalizeChoice(chosenStepUp) : undefined;
  if (override?.workspaceCwd) assertWorkerCopilotSeat(workers, override.workspaceCwd, deps, stepUp);
  assertCheckersCanDiffer(workers, verifiers, stepUp);
  return { routing: { workers, verifiers, ...(stepUp ? { stepUp } : {}), ...checkersChosenBy }, setAside, accountNotes };
}

/**
 * A Copilot worker with no account named takes the folder's rule-matched seat.
 * When that seat is on the never-use list the run is refused now, rather than
 * every worker session failing later.
 */
function assertWorkerCopilotSeat(workers: readonly PlanQueueRouteChoice[], workspaceCwd: string, deps: PlanQueueRoutingDeps, stepUp?: PlanQueueRouteChoice): void {
  const rules = deps.readAccountRules();
  const seatBlocked = (choice: PlanQueueRouteChoice): string | null => {
    if (canonicalProvider(choice.provider) !== 'copilot' || choice.copilotProfileId) return null;
    const seat = deps.copilotProfileFor(workspaceCwd, 'automation');
    return seat && accountRuleTier(rules, 'copilot', seat) === 'never' ? copilotLabel(deps.copilotProfiles(), seat) : null;
  };
  workers.forEach((worker, index) => {
    const seat = seatBlocked(worker);
    if (seat) {
      const which = workers.length > 1 ? `Plan Queue worker choice ${index + 1}` : 'The Plan Queue worker';
      throw new PlanQueueRoutingError(`${which}: this folder's Copilot account ("${seat}") is on your never-use list. Name another Copilot account for the workers, or take it off the list.`);
    }
  });
  const stepUpSeat = stepUp ? seatBlocked(stepUp) : null;
  if (stepUpSeat) {
    throw new PlanQueueRoutingError(`The Plan Queue step-up worker: this folder's Copilot account ("${stepUpSeat}") is on your never-use list. Name another Copilot account for it, or take it off the list.`);
  }
}

function isTriageRetry(config: InstanceCreateConfig): boolean {
  return config.metadata?.['planQueueRole'] === 'triage' && config.metadata?.['planQueueTriageRetry'] === true;
}

/**
 * The run's ranked worker choices when this spawn takes the worker route
 * (workers and first triage), with choices since added to the "never
 * auto-pick" list left out; empty for any other spawn. A worker for a document
 * handed to the step-up worker (`planQueueSteppedUp`) takes the run's step-up
 * choice instead, or the ordinary list once that choice has been removed. When
 * every choice is on that list the first stays, so `routeQueueSpawn` refuses
 * with the reason.
 */
export function queueWorkerChoices(
  config: InstanceCreateConfig,
  run: PlanQueueRun | null | undefined,
  isExcluded: (provider: string) => boolean = isProviderExcludedFromAutomation,
): PlanQueueRouteChoice[] {
  const role = config.metadata?.['planQueueRole'];
  if ((role !== 'worker' && role !== 'triage') || isTriageRetry(config)) return [];
  const stepUp = role === 'worker' && config.metadata?.['planQueueSteppedUp'] === true ? run?.config.routing?.stepUp : undefined;
  const choices = stepUp ? [stepUp] : run?.config.routing?.workers ?? [];
  if (run?.config.relaxSettings) return choices;
  const allowed = choices.filter((choice) => !isExcluded(choice.provider));
  return allowed.length > 0 ? allowed : choices.slice(0, 1);
}

/** Which ranked worker choice a new session takes: the first with usage left (see `pickRouteChoice`). */
export async function chooseQueueWorker(
  choices: readonly PlanQueueRouteChoice[],
  usage: PlanQueueRouteUsageCheck,
  runId: string,
  workingDirectory?: string,
): Promise<PlanQueueRouteChoice | null> {
  // One choice has nothing to move to; never spend a usage check on it.
  if (choices.length <= 1) return choices[0] ?? null;
  const picked = await pickRouteChoice(choices, 'automation', usage, workingDirectory);
  if (picked && (picked.index > 0 || !picked.usable)) {
    logger.info('Plan queue: worker choice picked by usage left', {
      runId, provider: picked.choice.provider, model: picked.choice.model ?? null, usable: picked.usable,
    });
  }
  return picked?.choice ?? null;
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
  /** The ranked worker choice this session takes (`chooseQueueWorker`); null when the run has none. */
  worker: PlanQueueRouteChoice | null,
  isExcluded: (provider: string) => boolean,
  /** James's account lists as they stand now; the session carries the ones for its provider. */
  accountRules: PlanQueueAccountRules,
): InstanceCreateConfig {
  const role = config.metadata?.['planQueueRole'] as PlanQueueRole | undefined;
  const runId = config.metadata?.['planQueueRunId'];
  if (!role || typeof runId !== 'string') return config;
  // Queue sessions never hop to another provider after failures: that would leave James's choice.
  if (role === 'verifier') {
    return withAccountPreferences({ ...config, accountRouteOrigin: 'verification', failoverProviders: [] }, config.provider, accountRules);
  }
  const run = getRun(runId);
  // Workers and first triage use the chosen worker route atomically. A triage retry
  // has already selected a checker (and its account fence), so retain that choice.
  const retry = isTriageRetry(config);
  const providerChoice = retry ? config.provider : run?.config.routing
    ? worker?.provider
    : run?.workerProvider ?? config.provider;
  const given = providerChoice?.trim().toLowerCase();
  const provider = given ? canonicalProvider(given) : null;
  if (!provider && accountRules.never.length > 0) throw new PlanQueueRoutingError(NO_PROVIDER_FOR_NEVER_USE);
  if (given && provider && !run?.config.relaxSettings && (isExcluded(provider) || isExcluded(given))) {
    throw new PlanQueueRoutingError(`${provider} has been added to the "never auto-pick these providers" list since this run started, so the queue will not start another session on it.`);
  }
  const routed: InstanceCreateConfig = { ...config, accountRouteOrigin: 'automation', failoverProviders: [] };
  if (retry) return withAccountPreferences(routed, provider, accountRules);
  // Remove a stale caller snapshot before filling every route field from the chosen route.
  delete routed.provider;
  delete routed.modelOverride;
  delete routed.allowedAccountProfileIds;
  delete routed.copilotAccountProfileId;
  if (provider) routed.provider = provider as InstanceCreateConfig['provider'];
  const model = worker?.model ?? (run?.config.routing ? undefined : run?.workerModel ?? config.modelOverride);
  if (model) routed.modelOverride = model;
  if (worker?.accountProfileIds?.length) routed.allowedAccountProfileIds = [...worker.accountProfileIds];
  if (worker?.copilotProfileId) routed.copilotAccountProfileId = worker.copilotProfileId;
  return withAccountPreferences(routed, provider, accountRules);
}

/**
 * The session's account preferences for its provider, from the lists as they
 * are now. A copy left on the config by an earlier spawn is dropped first, so
 * a list James has emptied no longer applies.
 */
function withAccountPreferences(config: InstanceCreateConfig, provider: string | null | undefined, rules: PlanQueueAccountRules): InstanceCreateConfig {
  const next: InstanceCreateConfig = { ...config };
  delete next.accountPreferences;
  const preferences = provider ? accountPreferencesFor(rules, canonicalProvider(provider)) : null;
  if (preferences) next.accountPreferences = preferences;
  return next;
}

/**
 * Every chosen CLI must be installed: a spawn on a missing CLI silently falls
 * back to another provider. Checked when a run starts and when its route
 * changes, using the same canonical IDs.
 */
export async function assertRoutingInstalled(routing: PlanQueueRouting, deps: Pick<PlanQueueRoutingDeps, 'listInstalledProviders'>): Promise<void> {
  const installed = new Set((await (deps.listInstalledProviders ?? defaultPlanQueueRoutingDeps().listInstalledProviders!)()).map(canonicalProvider));
  for (const choice of [...routing.workers, ...routing.verifiers, ...(routing.stepUp ? [routing.stepUp] : [])]) {
    if (!installed.has(canonicalProvider(choice.provider))) {
      throw new PlanQueueRoutingError(`Plan Queue: ${choice.provider} is not installed. Install its CLI or choose another provider.`);
    }
  }
}

/** One choice as "provider / model (accounts: …)", for status output, logs and messages. */
export function describeRouteChoice(choice: PlanQueueRouteChoice): string {
  const accounts = choice.accountProfileIds?.length ? ` (accounts: ${choice.accountProfileIds.join(', ')})` : '';
  const copilot = choice.copilotProfileId ? ` (account: ${choice.copilotProfileId})` : '';
  return `${choice.provider}${choice.model ? ` / ${choice.model}` : ''}${accounts}${copilot}`;
}

/** One line per role, for status output and logs. */
export function describeRouting(routing: PlanQueueRouting | undefined): { workers: string; checkers: string; stepUp: string } {
  return {
    workers: routing?.workers.length ? routing.workers.map(describeRouteChoice).join(', then ') : 'the default provider',
    checkers: routing?.verifiers.length ? routing.verifiers.map(describeRouteChoice).join('; ') : 'automatic',
    stepUp: routing?.stepUp ? describeRouteChoice(routing.stepUp) : 'stop and wait',
  };
}
