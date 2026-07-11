import type {
  ReviewParticipantStatus,
  ReviewResult,
} from '../../shared/types/cross-model-review.types';
import type {
  LocalModelInventoryEntry,
  ModelRuntimeTarget,
} from '../../shared/types/local-model-runtime.types';
import type {
  LocalReviewOutcome,
  LocalReviewerLimits,
  LocalReviewRequest,
} from '../review/local-reviewer';

export interface ReviewExecutionBatchInput {
  collectRemoteReviews: () => Promise<ReviewResult[]>;
  runLocalReview: () => Promise<LocalReviewOutcome>;
}

export interface ReviewExecutionBatchResult {
  remoteReviews: ReviewResult[];
  remoteError?: string;
  localOutcome: LocalReviewOutcome;
}

export interface LocalReviewTargetInput {
  enabled: boolean;
  selectorId: string;
  auxiliaryQualityModel?: string;
  builderSelectorId?: string;
  inventory: readonly LocalModelInventoryEntry[];
}

export type LocalReviewTargetResolution =
  | { status: 'ready'; target: Extract<ModelRuntimeTarget, { kind: 'local-model' }> }
  | { status: 'skipped'; reason: string; selectorId?: string; modelId?: string };

interface LocalReviewerLike {
  review(
    request: LocalReviewRequest,
    target: ModelRuntimeTarget,
    limits: LocalReviewerLimits,
  ): Promise<LocalReviewOutcome>;
}

export interface LocalReviewExecutionPlanInput {
  enabled: boolean;
  selectorId: string;
  auxiliaryQualityModel?: string;
  timeoutSeconds: number;
  maxToolRounds: number;
  inventory: readonly LocalModelInventoryEntry[];
  resolveTarget?: (selectorId: string) => ModelRuntimeTarget;
  reviewer: LocalReviewerLike;
  request: LocalReviewRequest;
  builderSelectorId?: string;
  signal: AbortSignal;
}

export interface LocalReviewExecutionPlan {
  run: () => Promise<LocalReviewOutcome>;
  participant(outcome: LocalReviewOutcome): ReviewParticipantStatus;
}

export function resolveLocalReviewTarget(input: LocalReviewTargetInput): LocalReviewTargetResolution {
  if (!input.enabled) return { status: 'skipped', reason: 'Local review is disabled.' };
  const selectorId = (input.selectorId ?? '').trim();
  const qualityModel = (input.auxiliaryQualityModel ?? '').trim();
  const entry = selectorId
    ? input.inventory.find((candidate) => candidate.selectorId === selectorId)
    : input.inventory.find((candidate) => isEligibleQualityFallback(candidate, qualityModel));
  if (!selectorId && !entry) {
    return {
      status: 'skipped',
      reason: qualityModel
        ? 'No healthy this-device local quality reviewer is available.'
        : 'No local reviewer model is selected and no local quality model is configured.',
    };
  }
  if (!entry) return { status: 'skipped', reason: 'The selected local reviewer is unavailable.', selectorId };
  if (!entry.healthy) {
    return { status: 'skipped', reason: 'The selected local reviewer is unhealthy.', selectorId, modelId: entry.modelId };
  }
  if (entry.modelId.toLowerCase().includes(':cloud')) {
    return { status: 'skipped', reason: 'Cloud-backed local models cannot run the local reviewer.', selectorId, modelId: entry.modelId };
  }
  if (entry.source === 'worker-node') {
    return {
      status: 'skipped',
      reason: 'Worker-node local review is unsupported until normalized tool turns are available.',
      selectorId,
      modelId: entry.modelId,
    };
  }
  if (input.builderSelectorId === entry.selectorId) {
    return {
      status: 'skipped',
      reason: 'The selected local reviewer is the in-session builder model.',
      selectorId,
      modelId: entry.modelId,
    };
  }
  return {
    status: 'ready',
    target: {
      kind: 'local-model',
      selectorId: entry.selectorId,
      source: entry.source,
      endpointProvider: entry.endpointProvider,
      endpointId: entry.endpointId,
      modelId: entry.modelId,
      ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
      ...(entry.nodeName ? { nodeName: entry.nodeName } : {}),
    },
  };
}

export function createLocalReviewExecutionPlan(
  input: LocalReviewExecutionPlanInput,
): LocalReviewExecutionPlan {
  const selection = resolveLocalReviewTarget(input);
  if (selection.status === 'skipped') {
    return {
      run: async () => ({ status: 'skipped', reason: selection.reason }),
      participant: (outcome) => participantForOutcome(outcome, selection.selectorId, selection.modelId),
    };
  }
  let target = selection.target;
  if (input.resolveTarget) {
    try {
      const resolved = input.resolveTarget(target.selectorId);
      if (resolved.kind !== 'local-model') {
        throw new Error('Selected inventory target is not a local model.');
      }
      target = resolved;
    } catch (error) {
      const reason = `The selected local reviewer could not be resolved: ${errorMessage(error)}`;
      return {
        run: async () => ({ status: 'skipped', reason }),
        participant: (outcome) => participantForOutcome(
          outcome,
          selection.target.selectorId,
          selection.target.modelId,
        ),
      };
    }
  }
  return {
    run: () => input.reviewer.review(input.request, target, {
      timeoutMs: Math.max(1, input.timeoutSeconds || 120) * 1_000,
      maxToolRounds: input.maxToolRounds || 12,
      signal: input.signal,
    }),
    participant: (outcome) => participantForOutcome(outcome, target.selectorId, target.modelId),
  };
}

function isEligibleQualityFallback(
  entry: LocalModelInventoryEntry,
  qualityModel: string,
): boolean {
  if (!qualityModel || !entry.healthy || entry.source !== 'this-device') return false;
  if (entry.modelId.toLowerCase().includes(':cloud')) return false;
  return entry.modelId === qualityModel || entry.modelId.startsWith(`${qualityModel}:`);
}

/**
 * Starts the normal remote collection and the additional local pass together.
 * Each side is settled independently so one transport cannot erase the other
 * side's useful result.
 */
export async function runReviewExecutionBatch(
  input: ReviewExecutionBatchInput,
): Promise<ReviewExecutionBatchResult> {
  const [remote, local] = await Promise.allSettled([
    input.collectRemoteReviews(),
    input.runLocalReview(),
  ]);

  const remoteError = remote.status === 'rejected' ? errorMessage(remote.reason) : undefined;
  const localOutcome: LocalReviewOutcome = local.status === 'fulfilled'
    ? local.value
    : { status: 'failed', reason: `Local review failed: ${errorMessage(local.reason)}` };

  return {
    remoteReviews: remote.status === 'fulfilled' ? remote.value : [],
    ...(remoteError ? { remoteError } : {}),
    localOutcome,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function participantForOutcome(
  outcome: LocalReviewOutcome,
  selectorId?: string,
  model?: string,
): ReviewParticipantStatus {
  return {
    reviewerId: outcome.status === 'used' ? outcome.review.reviewerId : 'local-model',
    source: 'local',
    status: outcome.status,
    ...(selectorId ? { selectorId } : {}),
    ...(model ? { model } : {}),
    ...(outcome.status === 'used' ? {} : { reason: outcome.reason }),
  };
}
