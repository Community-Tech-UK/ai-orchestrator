/**
 * The cross-model checking policy as it applies to the ping-pong reviewer.
 *
 * Ping-pong's normal rule is "the reviewer is a DIFFERENT PROVIDER than the
 * builder" — a provider rule, and a good proxy for a different model most of
 * the time. Inside a protected enterprise Copilot scope that rule is actively
 * wrong: switching provider means taking employer code off the employer's seat.
 * There, the reviewer stays on the same seat and the diversity comes from a
 * different model family instead, so the provider rule must be suspended.
 *
 * Lives outside `agentic-pingpong-reviewer.ts` because that file is close to
 * the 700-line hard cap.
 */

import { getLogger } from '../logging/logger';
import { resolveCheckerPlan } from '../review/checker-plan';

const logger = getLogger('PingPongCheckingPolicy');

export type PingPongCheckerDecision =
  /** No licence constraint — use the normal different-provider resolver. */
  | { kind: 'open' }
  /** Stay on this Copilot seat, with this model. */
  | { kind: 'licence-pinned'; provider: 'copilot'; model: string; profileId?: string }
  /** Licence scope could not be established; run no reviewer at all. */
  | { kind: 'blocked'; reason: string };

export function resolvePingPongChecker(input: {
  builderProvider: string;
  builderModel?: string;
  workspaceCwd: string;
}): PingPongCheckerDecision {
  const plan = resolveCheckerPlan([''], {
    implementerProvider: input.builderProvider,
    ...(input.builderModel ? { implementerModel: input.builderModel } : {}),
    workingDirectory: input.workspaceCwd,
    context: 'pingPongReviewer',
  });

  if (plan.blockedReason) {
    return { kind: 'blocked', reason: plan.blockedReason };
  }

  const pinned = plan.candidates.find((candidate) => candidate.rationale === 'licence-pinned');
  if (pinned?.model) {
    logger.info('Ping-pong reviewer pinned to the enterprise Copilot seat', {
      profileId: pinned.copilotProfileId,
      model: pinned.model,
      builderProvider: input.builderProvider,
      builderModel: input.builderModel ?? null,
    });
    return {
      kind: 'licence-pinned',
      provider: 'copilot',
      model: pinned.model,
      ...(pinned.copilotProfileId ? { profileId: pinned.copilotProfileId } : {}),
    };
  }

  return { kind: 'open' };
}

/**
 * The model an OPEN (non-licence-pinned) ping-pong reviewer should run.
 *
 * Ping-pong's own resolver only guarantees reviewer CLI != builder CLI, which is
 * a PROVIDER rule. That is not enough: Cursor serves Claude, Codex/GPT and
 * Composer models from one CLI, so a Tier-2 widen to Cursor could quietly run
 * the builder's own model family — self-review wearing another badge. Running
 * the chosen provider back through the plan applies the same family-diversity
 * re-model the other three checking surfaces get.
 */
export function resolveOpenCheckerModel(
  provider: string,
  input: { builderModel?: string; workspaceCwd: string },
): string | undefined {
  const plan = resolveCheckerPlan([provider], {
    ...(input.builderModel ? { implementerModel: input.builderModel } : {}),
    workingDirectory: input.workspaceCwd,
    context: 'pingPongReviewer.open',
  });
  const candidate = plan.candidates.find((entry) => entry.provider === provider);
  if (candidate?.rationale === 'family-diverse' && candidate.model) {
    logger.info('Ping-pong reviewer re-modelled to avoid the builder family', {
      provider,
      builderModel: input.builderModel ?? null,
      model: candidate.model,
    });
    return candidate.model;
  }
  return candidate?.model ?? resolveModelOverride(provider);
}

/**
 * The user's configured reviewer model for a provider, or undefined.
 *
 * Moved verbatim from `agentic-pingpong-reviewer.ts`, which was sitting at the
 * 700-line hard cap. The lazy `require` + swallow-everything `catch` is the
 * original author's; it is kept as-is because changing failure behaviour was not
 * part of this task. It now targets the `reviewer-model-override` leaf rather
 * than the whole review-execution host, so the required graph is smaller than
 * before.
 */
export function resolveModelOverride(provider: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveReviewerModelOverride } = require('../review/reviewer-model-override') as typeof import('../review/reviewer-model-override');
    return resolveReviewerModelOverride(provider);
  } catch {
    return undefined;
  }
}
