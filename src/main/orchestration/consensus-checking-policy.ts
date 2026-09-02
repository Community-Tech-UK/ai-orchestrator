/**
 * The cross-model checking policy as it applies to a consensus panel.
 *
 * Lives outside `consensus-coordinator.ts` only because that file is at its
 * size ceiling; it is otherwise part of the coordinator's provider resolution.
 */

import { getLogger } from '../logging/logger';
import { modelOverrideOptionFor, resolveCheckerPlan } from '../review/checker-plan';
import type { ConsensusProviderSpec } from './consensus.types';

const logger = getLogger('ConsensusCheckingPolicy');

/**
 * Consensus has no "implementer" to differ from — its value is breadth — so
 * nothing is ever excluded here. Inside a protected enterprise Copilot scope the
 * panel is instead re-pointed at that same seat with a different model family
 * per participant, which keeps employer code on the employer's licence while
 * preserving the diversity that makes consensus worth running at all.
 *
 * An empty result means the policy could not establish where the code may go
 * (an ambiguous or unreadable licence scope). The caller already treats "no
 * providers" as a reported failure, which is the correct fail-closed outcome.
 */
export interface ConsensusCheckingPlan {
  panel: ConsensusProviderSpec[];
  /** Copilot seat the panel is pinned to, for entitlement learning on failure. */
  copilotProfileId?: string;
}

export function applyConsensusCheckingPolicy(
  panel: ConsensusProviderSpec[],
  workingDirectory: string | undefined,
): ConsensusCheckingPlan {
  if (panel.length === 0) return { panel };

  const plan = resolveCheckerPlan(
    panel.map((spec) => spec.provider),
    {
      ...(workingDirectory ? { workingDirectory } : {}),
      context: 'consensus',
    },
  );

  if (plan.candidates.length === 0) {
    logger.warn('Consensus panel blocked by the checking policy', {
      blockedReason: plan.blockedReason ?? 'no eligible participants',
    });
    return { panel: [] };
  }

  const copilotProfileId = plan.candidates.find((c) => c.copilotProfileId)?.copilotProfileId;
  if (plan.candidates.length < panel.length) {
    // Should not happen now that licence-pinned models round-robin across
    // families, but a heavily-refused seat could still run short. Never let a
    // participant disappear silently — the positional map below would drop the
    // tail of the panel, weights and all.
    logger.warn('Consensus panel shortened by the checking policy', {
      requested: panel.length,
      planned: plan.candidates.length,
      copilotProfileId: copilotProfileId ?? null,
    });
  }
  const mapped = plan.candidates.map((candidate, index) => {
    const original = panel[index];
    // `weight` is the caller's, not the policy's, so it survives a re-point.
    //
    // The model is set ONLY when the policy actually chose one. Using
    // `candidate.model` directly would pin every participant to the
    // `crossModelReviewModelByProvider` setting — a reviewer setting silently
    // taking over general consensus queries, which callers never asked for.
    const override = modelOverrideOptionFor(candidate);
    return {
      ...(original ?? {}),
      provider: candidate.provider as ConsensusProviderSpec['provider'],
      ...('modelOverride' in override ? { model: override.modelOverride } : {}),
    };
  });
  return { panel: mapped, ...(copilotProfileId ? { copilotProfileId } : {}) };
}
