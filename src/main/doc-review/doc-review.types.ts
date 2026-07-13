import type {
  DocReviewItemDecision,
  DocReviewDeliveryAttempt,
  DocReviewDeliveryState,
  DocReviewOrigin,
  DocReviewOverall,
  DocReviewSession,
} from '@contracts/schemas/doc-review';

export type {
  DocReviewItemDecision,
  DocReviewDeliveryAttempt,
  DocReviewDeliveryState,
  DocReviewOrigin,
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
  /** Compatibility seam while the lifecycle-aware coordinator is being wired. */
  deliverReviewDecision?: (
    instanceId: string,
    message: string,
  ) => Promise<{
    status: DocReviewDeliveryState;
    mechanism: DocReviewDeliveryAttempt['mechanism'];
    targetInstanceId?: string;
    error?: string;
  }>;
}

/** A delivery implementation owns lifecycle policy; the service owns durable review state. */
export interface DocReviewDeliveryCoordinator {
  deliver(session: DocReviewSession, feedback: string): Promise<DocReviewDeliveryAttempt>;
  /** Release lifecycle listeners when application wiring replaces the coordinator. */
  dispose?(): void;
}

/** Fields an agent supplies when requesting a review. */
export interface CreateDocReviewSessionInput {
  instanceId: string;
  /** Stable conversation identity captured from the requesting instance. */
  historyThreadId?: string;
  sessionId?: string;
  /** Explicit loop provenance for a review created as a live loop gate. */
  origin?: DocReviewOrigin;
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
