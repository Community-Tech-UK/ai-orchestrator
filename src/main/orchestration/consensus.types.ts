/**
 * Consensus Types - Multi-model consensus query system
 */

export type ConsensusStrategy = 'majority' | 'weighted' | 'all';

export interface ConsensusProviderSpec {
  provider: 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor';
  model?: string;
  weight?: number;
}

export interface ConsensusOptions {
  providers?: ConsensusProviderSpec[];
  strategy?: ConsensusStrategy;
  timeout?: number;
  maxTokensPerQuery?: number;
  workingDirectory?: string;
  includeEdgeCases?: boolean;
}

export interface ConsensusProviderResponse {
  provider: string;
  model?: string;
  content: string;
  success: boolean;
  error?: string;
  durationMs: number;
  tokensUsed?: number;
  estimatedCost?: number;
}

export interface ConsensusResult {
  consensus: string;
  agreement: number;
  responses: ConsensusProviderResponse[];
  dissent: string[];
  edgeCases: string[];
  totalDurationMs: number;
  totalEstimatedCost: number;
  successCount: number;
  failureCount: number;
}

export interface ConsensusProgressEvent {
  queryId: string;
  phase: 'dispatching' | 'collecting' | 'synthesizing' | 'complete' | 'error';
  respondedProviders: string[];
  pendingProviders: string[];
  partialResult?: Partial<ConsensusResult>;
}
