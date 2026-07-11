import type {
  LocalModelInventoryEntry,
  ModelRuntimeTarget,
} from '../../shared/types/local-model-runtime.types';
import {
  LocalReviewerCapabilityService,
  type LocalReviewerQualification,
} from './local-reviewer-capability-service';

type LocalTarget = Extract<ModelRuntimeTarget, { kind: 'local-model' }>;

interface InventoryLike {
  list(): LocalModelInventoryEntry[];
  resolveTarget(selectorId: string): ModelRuntimeTarget;
}

interface CapabilityLike {
  retry(target: LocalTarget): Promise<LocalReviewerQualification>;
}

export class LocalReviewerQualificationController {
  constructor(
    private readonly inventory: InventoryLike,
    private readonly capability: CapabilityLike = new LocalReviewerCapabilityService(),
  ) {}

  async qualify(selectorId: string): Promise<LocalReviewerQualification> {
    const entry = this.inventory.list().find((candidate) => candidate.selectorId === selectorId);
    if (!entry) {
      return { status: 'unverified', reason: 'Local model is no longer available.' };
    }
    const ineligibleReason = qualificationIneligibility(entry);
    if (ineligibleReason) return { status: 'unverified', reason: ineligibleReason };

    try {
      const target = this.inventory.resolveTarget(selectorId);
      if (target.kind !== 'local-model') {
        return { status: 'unverified', reason: 'Selected target is not a local model.' };
      }
      return await this.capability.retry(target);
    } catch (error) {
      return {
        status: 'unverified',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function qualificationIneligibility(entry: LocalModelInventoryEntry): string | undefined {
  if (entry.source !== 'this-device') return 'Only this-device models can be verified.';
  if (!entry.healthy) return 'The local model endpoint must be healthy before verification.';
  if (entry.modelId.toLowerCase().includes(':cloud')) {
    return 'Cloud-backed local models cannot be verified for local review.';
  }
  return undefined;
}
