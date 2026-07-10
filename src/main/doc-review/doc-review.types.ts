import type {
  DocReviewItemDecision,
  DocReviewOverall,
  DocReviewSession,
} from '@contracts/schemas/doc-review';

export type {
  DocReviewItemDecision,
  DocReviewOverall,
  DocReviewSession,
} from '@contracts/schemas/doc-review';

/** ElectronStore shape backing DocReviewService. */
export interface DocReviewStoreShape {
  version: number;
  sessions: DocReviewSession[];
}

/**
 * Minimal sink used to push the canonical feedback block back into the requesting
 * instance. Kept as a narrow interface (rather than importing InstanceManager) so the
 * service stays decoupled and unit-testable.
 */
export interface DocReviewInstanceSink {
  sendInput(instanceId: string, message: string): Promise<void>;
}

/** Fields an agent supplies when requesting a review. */
export interface CreateDocReviewSessionInput {
  instanceId: string;
  workspacePath: string;
  title: string;
  /** Path (absolute or workspace-relative) to the artifact HTML under `.aio-review/`. */
  artifactPath: string;
  sourcePath?: string;
}

/** Decision bundle submitted from the renderer. */
export interface SubmitDocReviewDecisionInput {
  overall: DocReviewOverall;
  decisions: DocReviewItemDecision[];
  generalComment?: string;
}
