/**
 * Plan Queue routing — which providers and accounts the queue's sessions use.
 *
 * A run fixes its routing when it starts (`config.routing`). For each role,
 * James's saved `planQueueRouting` list wins; a per-run choice from
 * `plan_queue_start` applies only where that saved list is empty; with neither,
 * workers take the parent session's provider, model and account and checkers
 * are automatic. Workers are a ranked list: each new worker session starts on
 * the first choice with usage left (`plan-queue-route-usage.ts`). Explicit
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

import { DEFAULT_PLAN_QUEUE_ROUTING, type PlanQueueRole, type PlanQueueRouteChoice, type PlanQueueRouteChoiceArgs, type PlanQueueRouting } from '@contracts/schemas/plan-queue';
import type { CopilotAccountProfile } from '../../shared/types/copilot-account.types';
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
import { getLogger } from '../logging/logger';
import { classifyCheckerScope } from '../review/checker-plan';
import { pickRouteChoice, type PlanQueueRouteUsageCheck } from './plan-queue-route-usage';
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
  /** 1-based place in a list of more than one choice, named in the reason. */
  position?: number,
): void {
  const asGiven = choice.provider.trim().toLowerCase();
  const provider = canonicalProvider(choice.provider);
  const label = `${role === 'worker' ? 'Plan Queue worker' : 'Plan Queue checker'}${position ? ` choice ${position}` : ''}`;
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

/** Every worker choice needs a checker that can judge its work. */
function assertCheckersCanDiffer(workers: readonly PlanQueueRouteChoice[], verifiers: readonly PlanQueueRouteChoice[]): void {
  if (verifiers.length === 0) return;
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
  /** Roles whose per-run choice was not used because James saved a list for them. */
  setAside: ('workers' | 'checkers')[];
}

function assertChoices(choices: readonly PlanQueueRouteChoice[], role: 'worker' | 'verifier', deps: PlanQueueRoutingDeps, relax: boolean): void {
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
  if (explicitWorkers.length > 0) {
    assertChoices(explicitWorkers, 'worker', deps, relax);
    workers = explicitWorkers.map(normalizeChoice);
  } else {
    const inherited = inheritedWorker(parent, deps, relax);
    workers = inherited ? [inherited] : [];
  }
  assertCheckersCanDiffer(workers, verifiers);
  return { routing: { workers, verifiers, ...checkersChosenBy }, setAside };
}

function isTriageRetry(config: InstanceCreateConfig): boolean {
  return config.metadata?.['planQueueRole'] === 'triage' && config.metadata?.['planQueueTriageRetry'] === true;
}

/**
 * The run's ranked worker choices when this spawn takes the worker route
 * (workers and first triage), with choices since added to the "never
 * auto-pick" list left out; empty for any other spawn. When every choice is
 * on that list the first stays, so `routeQueueSpawn` refuses with the reason.
 */
export function queueWorkerChoices(
  config: InstanceCreateConfig,
  run: PlanQueueRun | null | undefined,
  isExcluded: (provider: string) => boolean = isProviderExcludedFromAutomation,
): PlanQueueRouteChoice[] {
  const role = config.metadata?.['planQueueRole'];
  if ((role !== 'worker' && role !== 'triage') || isTriageRetry(config)) return [];
  const choices = run?.config.routing?.workers ?? [];
  if (run?.config.relaxSettings) return choices;
  const allowed = choices.filter((choice) => !isExcluded(choice.provider));
  return allowed.length > 0 ? allowed : choices.slice(0, 1);
}

/** Which ranked worker choice a new session takes: the first with usage left (see `pickRouteChoice`). */
export async function chooseQueueWorker(
  choices: readonly PlanQueueRouteChoice[],
  usage: PlanQueueRouteUsageCheck,
  runId: string,
): Promise<PlanQueueRouteChoice | null> {
  // One choice has nothing to move to; never spend a usage check on it.
  if (choices.length <= 1) return choices[0] ?? null;
  const picked = await pickRouteChoice(choices, 'automation', usage);
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
  isExcluded: (provider: string) => boolean = isProviderExcludedFromAutomation,
): InstanceCreateConfig {
  const role = config.metadata?.['planQueueRole'] as PlanQueueRole | undefined;
  const runId = config.metadata?.['planQueueRunId'];
  if (!role || typeof runId !== 'string') return config;
  // Queue sessions never hop to another provider after failures: that would leave James's choice.
  if (role === 'verifier') return { ...config, accountRouteOrigin: 'verification', failoverProviders: [] };
  const run = getRun(runId);
  // Workers and first triage use the chosen worker route atomically. A triage retry
  // has already selected a checker (and its account fence), so retain that choice.
  const retry = isTriageRetry(config);
  const providerChoice = retry ? config.provider : run?.config.routing
    ? worker?.provider
    : run?.workerProvider ?? config.provider;
  const given = providerChoice?.trim().toLowerCase();
  const provider = given ? canonicalProvider(given) : null;
  if (given && provider && !run?.config.relaxSettings && (isExcluded(provider) || isExcluded(given))) {
    throw new PlanQueueRoutingError(`${provider} has been added to the "never auto-pick these providers" list since this run started, so the queue will not start another session on it.`);
  }
  const routed: InstanceCreateConfig = { ...config, accountRouteOrigin: 'automation', failoverProviders: [] };
  if (retry) return routed;
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
  return routed;
}

/**
 * Every chosen CLI must be installed: a spawn on a missing CLI silently falls
 * back to another provider. Checked when a run starts and when its route
 * changes, using the same canonical IDs.
 */
export async function assertRoutingInstalled(routing: PlanQueueRouting, deps: Pick<PlanQueueRoutingDeps, 'listInstalledProviders'>): Promise<void> {
  const installed = new Set((await (deps.listInstalledProviders ?? defaultPlanQueueRoutingDeps().listInstalledProviders!)()).map(canonicalProvider));
  for (const choice of [...routing.workers, ...routing.verifiers]) {
    if (!installed.has(canonicalProvider(choice.provider))) {
      throw new PlanQueueRoutingError(`Plan Queue: ${choice.provider} is not installed. Install its CLI or choose another provider.`);
    }
  }
}

/** One line per role, for status output and logs. */
export function describeRouting(routing: PlanQueueRouting | undefined): { workers: string; checkers: string } {
  const describe = (choice: PlanQueueRouteChoice): string => {
    const accounts = choice.accountProfileIds?.length ? ` (accounts: ${choice.accountProfileIds.join(', ')})` : '';
    const copilot = choice.copilotProfileId ? ` (account: ${choice.copilotProfileId})` : '';
    return `${choice.provider}${choice.model ? ` / ${choice.model}` : ''}${accounts}${copilot}`;
  };
  return {
    workers: routing?.workers.length ? routing.workers.map(describe).join(', then ') : 'the default provider',
    checkers: routing?.verifiers.length ? routing.verifiers.map(describe).join('; ') : 'automatic',
  };
}
