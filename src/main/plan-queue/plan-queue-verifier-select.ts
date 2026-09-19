/**
 * Plan Queue verifier selection.
 *
 * The verifier runs on a DIFFERENT provider from the worker (spec decision 4),
 * and its model is chosen by `resolveCheckerPlan`, which adds model-family
 * diversity and Copilot licence containment on top. When the plan yields no
 * usable candidate the item parks as `no-diverse-verifier`; it never falls back
 * to the worker's own provider silently.
 */

import { detectAvailableClis } from '../cli/cli-detection';
import { getLogger } from '../logging/logger';
import { filterProvidersForAutomation } from '../providers/automation-provider-exclusions';
import { normalizeAgenticReviewerCliList, normalizeReviewerCli } from '../orchestration/cross-model-review-service.constants';
import { modelOverrideOptionFor, resolveCheckerPlan, type CheckerPlanDeps } from '../review/checker-plan';

const logger = getLogger('PlanQueueVerifierSelect');

/** Strongest general-purpose reviewers first; the rest follow in detection order. */
const VERIFIER_PREFERENCE: readonly string[] = ['codex', 'claude', 'copilot'];

export interface VerifierChoice {
  provider: string;
  modelOverride?: string;
  copilotProfileId?: string;
}

export type VerifierSelection =
  | { ok: true; choice: VerifierChoice }
  | { ok: false; reason: string };

export interface VerifierSelectInput {
  workerProvider: string;
  workerModel?: string | null;
  workingDirectory: string;
}

export interface VerifierSelectDeps extends CheckerPlanDeps {
  listInstalledProviders?: () => Promise<string[]>;
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
