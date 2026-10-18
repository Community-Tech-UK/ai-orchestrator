import type { Instance } from '../../shared/types/instance.types';
import type { OutputClassification } from './output-classifier';
import type { ReviewDispatchRequest } from './cross-model-review.types';
import { resolveReviewWorkingDirectory } from './cross-model-review-service.helpers';
import { normalizeReviewerCli } from './cross-model-review-service.constants';
import { resolveCheckerPlan, type CheckerCandidate } from '../review/checker-plan';
import { redactForEgress } from '../security/content-egress-gate';
import { truncateForReview } from './review-prompts';

export function buildCrossModelReviewDispatch(input: {
  instance: Instance; primaryProvider: string; content: string; taskDescription: string;
  classification: OutputClassification; reviewDepth: 'structured' | 'tiered';
  preferredReviewers: string[]; maxReviewers: number;
  selectReviewers: (primary: string, max: number, excluded: string[], preferred: string[]) => string[];
  changedFiles: string[]; turnSeq?: number; trigger: 'automatic' | 'manual';
}): { request: ReviewDispatchRequest; reviewers: CheckerCandidate[]; blockedReason?: string } {
  const { instance } = input;
  const workingDirectory = resolveReviewWorkingDirectory(instance.workingDirectory);
  const pooled = input.selectReviewers(normalizeReviewerCli(input.primaryProvider), input.maxReviewers, [], input.preferredReviewers);
  const plan = resolveCheckerPlan(pooled, { implementerProvider: input.primaryProvider,
    ...(instance.currentModel ? { implementerModel: instance.currentModel } : {}), workingDirectory,
    context: 'crossModelReview.inSession', minCheckers: 1 });
  const licencePinned = plan.candidates.some(checker => checker.rationale === 'licence-pinned');
  const copilotProfileId = plan.candidates.find(checker => checker.copilotProfileId)?.copilotProfileId;
  const timestamp = Date.now();
  return { reviewers: plan.candidates, blockedReason: plan.blockedReason,
    request: { id: `review-${timestamp}-${Math.random().toString(36).slice(2, 8)}`, instanceId: instance.id,
      primaryProvider: input.primaryProvider, workingDirectory, timestamp, trigger: input.trigger,
      changedFiles: input.changedFiles.slice(0, 50), turnSeq: input.turnSeq,
      ...(instance.modelRuntimeTarget ? { builderModelRuntimeTarget: instance.modelRuntimeTarget } : {}),
      ...(instance.currentModel ? { implementerModel: instance.currentModel } : {}),
      ...(licencePinned ? { licencePinned: true } : {}), ...(copilotProfileId ? { copilotProfileId } : {}),
      content: redactForEgress(truncateForReview(input.content), { kind: 'prompt', instanceId: instance.id }).content,
      taskDescription: redactForEgress(input.taskDescription.slice(0, 4000), { kind: 'prompt', instanceId: instance.id }).content,
      classification: input.classification, reviewDepth: input.reviewDepth,
    },
  };
}
