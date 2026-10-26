/**
 * Plan Queue verifier selection.
 *
 * The verifier runs on a DIFFERENT provider from the worker (spec decision 4),
 * and its model is chosen by `resolveCheckerPlan`, which adds model-family
 * diversity and Copilot licence containment on top. When the plan yields no
 * usable candidate the item parks as `no-diverse-verifier`; it never falls back
 * to the worker's own provider silently.
 */

import type { PlanQueueRouteChoice } from '@contracts/schemas/plan-queue';
import { sameFamily } from '../../shared/models/model-family';
import { sameProviderCheckerCanDiffer } from '../../shared/models/multi-maker-providers';
import { detectAvailableClis } from '../cli/cli-detection';
import { getLogger } from '../logging/logger';
import { filterProvidersForAutomation, isProviderExcludedFromAutomation } from '../providers/automation-provider-exclusions';
import { normalizeAgenticReviewerCliList, normalizeReviewerCli } from '../orchestration/cross-model-review-service.constants';
import { classifyCheckerScope, modelOverrideOptionFor, resolveCheckerPlan, type CheckerPlanDeps } from '../review/checker-plan';
import { defaultPlanQueueRouteUsage, pickRouteChoice, type PlanQueueRouteUsageCheck } from './plan-queue-route-usage';

const logger = getLogger('PlanQueueVerifierSelect');

/** Strongest general-purpose reviewers first; the rest follow in detection order. */
const VERIFIER_PREFERENCE: readonly string[] = ['codex', 'claude', 'copilot'];

export interface VerifierChoice {
  provider: string;
  modelOverride?: string;
  copilotProfileId?: string;
  /** Pool accounts the verifier may use (James's checker choice). */
  accountProfileIds?: string[];
}

export type VerifierSelection =
  | { ok: true; choice: VerifierChoice }
  | { ok: false; reason: string };

export interface VerifierSelectInput {
  workerProvider: string;
  workerModel?: string | null;
  workingDirectory: string;
  /** The run's checker choices, in order. Empty/absent = automatic selection. */
  choices?: readonly PlanQueueRouteChoice[];
  /**
   * True when the choices are James's saved setting, which may replace the
   * licence-pinned work Copilot seat in a protected folder. A per-run list
   * (an agent's tool call) may not: there the seat still checks the work.
   */
  choicesOverrideLicence?: boolean;
}

export interface VerifierSelectDeps extends CheckerPlanDeps {
  listInstalledProviders?: () => Promise<string[]>;
  isProviderExcluded?: (provider: string) => boolean;
  /** Usage left for a chosen checker; defaults to the account pools and the limit ledger. */
  routeUsage?: PlanQueueRouteUsageCheck;
}

async function installedProviders(): Promise<string[]> {
  const clis = await detectAvailableClis();
  return clis.filter((cli) => cli.installed).map((cli) => cli.name);
}

export async function selectPlanQueueVerifier(
  input: VerifierSelectInput,
  deps: VerifierSelectDeps = {},
): Promise<VerifierSelection> {
  const worker = normalizeReviewerCli(input.workerProvider);
  let installed: string[];
  try {
    installed = normalizeAgenticReviewerCliList(await (deps.listInstalledProviders ?? installedProviders)());
  } catch (error) {
    return { ok: false, reason: `provider detection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (input.choices?.length) {
    const scope = input.choicesOverrideLicence ? null : classifyCheckerScope(input.workingDirectory, deps);
    if (!scope || scope.kind === 'none') return selectFromChoices(input, worker, installed, deps);
    // A protected (or unresolvable) work scope keeps its own rule below.
    logger.info('Plan queue checker choices set aside: this run\'s list cannot override the work Copilot scope', { scope: scope.kind });
  }
  const eligible = filterProvidersForAutomation(installed, 'planQueueVerifier').filter((p) => p !== worker);
  const ordered = [
    ...VERIFIER_PREFERENCE.filter((p) => eligible.includes(p)),
    ...eligible.filter((p) => !VERIFIER_PREFERENCE.includes(p)),
  ];

  const plan = resolveCheckerPlan(ordered, {
    implementerProvider: worker,
    ...(input.workerModel ? { implementerModel: input.workerModel } : {}),
    workingDirectory: input.workingDirectory,
    context: 'planQueueVerifier',
    // Inside a protected Copilot scope the plan replaces the list with a
    // same-seat, different-family checker; ask for at least one.
    minCheckers: 1,
  }, deps);

  if (plan.blockedReason) return { ok: false, reason: plan.blockedReason };
  const candidate = plan.candidates.find(
    (c) => c.rationale === 'licence-pinned' || normalizeReviewerCli(c.provider) !== worker,
  );
  if (!candidate) {
    return {
      ok: false,
      reason: `no installed provider other than ${worker} is available for verification`
        + (installed.length ? ` (installed: ${installed.join(', ')})` : ''),
    };
  }
  logger.info('Plan queue verifier selected', {
    workerProvider: worker,
    provider: candidate.provider,
    model: candidate.model ?? null,
    rationale: candidate.rationale,
  });
  return {
    ok: true,
    choice: {
      provider: candidate.provider,
      ...modelOverrideOptionFor(candidate),
      ...(candidate.copilotProfileId ? { copilotProfileId: candidate.copilotProfileId } : {}),
    },
  };
}

/**
 * The run names its checkers: use the first one that can run and has usage
 * left; with none left, the one whose known limit lifts soonest. Honoured as
 * given (in a protected work folder only when the list is James's saved
 * choice), but never on the worker's own provider unless the models are from
 * different families, and never on a provider since added to the "never
 * auto-pick" list.
 */
async function selectFromChoices(
  input: VerifierSelectInput,
  worker: string,
  installed: readonly string[],
  deps: VerifierSelectDeps,
): Promise<VerifierSelection> {
  const isExcluded = deps.isProviderExcluded ?? isProviderExcludedFromAutomation;
  const skipped: string[] = [];
  const eligible: PlanQueueRouteChoice[] = [];
  for (const choice of input.choices ?? []) {
    const provider = normalizeReviewerCli(choice.provider);
    if (!installed.includes(provider)) { skipped.push(`${provider} is not installed`); continue; }
    if (isExcluded(provider)) { skipped.push(`${provider} is on the "never auto-pick" list`); continue; }
    // The same rule the run's start check applied (multi-maker-providers.ts), so a list accepted there is not skipped here.
    if (provider === worker && !sameProviderCheckerCanDiffer(provider, choice.model, input.workerModel, (a, b) => !sameFamily(a, b))) {
      skipped.push(`${provider} is the worker's provider and no different-family model was chosen`);
      continue;
    }
    eligible.push({ ...choice, provider });
  }
  const picked = eligible.length > 1
    ? await pickRouteChoice(eligible, 'verification', deps.routeUsage ?? defaultPlanQueueRouteUsage())
    : null;
  const choice = picked?.choice ?? eligible[0];
  if (!choice) return { ok: false, reason: `none of the checkers chosen for this run can check it: ${skipped.join('; ')}` };
  const model = choice.model
    ? { modelOverride: choice.model }
    : checkerModelFor(choice.provider, input, worker, deps);
  logger.info('Plan queue verifier selected from James\'s choices', {
    workerProvider: worker, provider: choice.provider, model: model.modelOverride ?? null, ...(picked ? { usageLeft: picked.usable } : {}),
  });
  return {
    ok: true,
    choice: {
      provider: choice.provider,
      ...model,
      ...(choice.copilotProfileId ? { copilotProfileId: choice.copilotProfileId } : {}),
      ...(choice.accountProfileIds?.length ? { accountProfileIds: [...choice.accountProfileIds] } : {}),
    },
  };
}

/** The configured checker model, re-modelled away from the worker's family where the provider can. */
function checkerModelFor(
  provider: string,
  input: VerifierSelectInput,
  worker: string,
  deps: VerifierSelectDeps,
): { modelOverride?: string } {
  const plan = resolveCheckerPlan([provider], {
    implementerProvider: worker,
    ...(input.workerModel ? { implementerModel: input.workerModel } : {}),
    workingDirectory: input.workingDirectory,
    context: 'planQueueVerifier',
  // Copilot keeps its real scope so a work seat gets one of its own models;
  // other providers are James's choice and are only re-modelled for family.
  }, provider === 'copilot' ? deps : { ...deps, classifyScope: () => ({ kind: 'none' }) });
  const candidate = plan.candidates[0];
  return candidate ? modelOverrideOptionFor(candidate) : {};
}
