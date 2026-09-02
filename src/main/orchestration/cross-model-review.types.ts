import type { OutputClassification } from './output-classifier';
import type { ModelRuntimeTarget } from '../../shared/types/local-model-runtime.types';

/** Internal request dispatched to a reviewer */
export interface ReviewDispatchRequest {
  id: string;
  instanceId: string;
  primaryProvider: string;
  builderModelRuntimeTarget?: ModelRuntimeTarget;
  workingDirectory: string;
  content: string;
  taskDescription: string;
  classification: OutputClassification;
  reviewDepth: 'structured' | 'tiered';
  sourceUserMessageId?: string;
  sourceUserMessageTimestamp?: number;
  timestamp: number;
  /**
   * Model the implementing session ran on, when known. Needed so a checker
   * pulled in by fallback WIDENING is planned for family diversity too, not
   * just the checkers chosen up front.
   */
  implementerModel?: string;
  /**
   * True when the workspace sits in a protected enterprise Copilot scope and
   * the plan is therefore pinned to that seat. Fallback widening is suppressed:
   * the plan is the entire permitted universe, so reaching into the general
   * reviewer pool would take employer code off its own licence.
   */
  licencePinned?: boolean;
  /** Copilot account the licence-pinned checkers run on, for entitlement learning. */
  copilotProfileId?: string;
}

export interface BufferedReviewMessage {
  id: string;
  content: string;
}

/** Buffered output waiting for aggregation */
export interface OutputBuffer {
  instanceId: string;
  messages: BufferedReviewMessage[];
  primaryProvider: string;
  firstUserPrompt: string;
  lastUpdated: number;
}
