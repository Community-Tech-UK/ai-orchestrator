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
