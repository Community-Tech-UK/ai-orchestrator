import type { OutputClassification } from './output-classifier';

/** Internal request dispatched to a reviewer */
export interface ReviewDispatchRequest {
  id: string;
  instanceId: string;
  primaryProvider: string;
  content: string;
  taskDescription: string;
  classification: OutputClassification;
  reviewDepth: 'structured' | 'tiered';
  timestamp: number;
}

/** Buffered output waiting for aggregation */
export interface OutputBuffer {
  instanceId: string;
  messages: string[];
  primaryProvider: string;
  firstUserPrompt: string;
  lastUpdated: number;
}
