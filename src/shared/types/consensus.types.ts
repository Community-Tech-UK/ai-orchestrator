/**
 * Consensus Types - Multi-model consensus query system
 *
 * Enables orchestrator instances to query multiple AI providers
 * and synthesize consensus responses, similar to how Claude Code
 * can consult Gemini/Copilot/Codex via MCP tools.
 */

/**
 * Strategy for determining consensus from multiple provider responses
 */
export type ConsensusStrategy = 'majority' | 'weighted' | 'all';

/**
 * Provider specification for a consensus query
 */
export interface ConsensusProviderSpec {
  /** CLI provider type */
  provider: 'claude' | 'codex' | 'gemini' | 'copilot';
  /** Optional model override */
  model?: string;
  /** Weight for weighted consensus (default: 1) */
  weight?: number;
}

/**
 * Options for a consensus query
 */
export interface ConsensusOptions {
  /** Which providers to consult (default: all available) */
  providers?: ConsensusProviderSpec[];
  /** Consensus strategy (default: 'majority') */
  strategy?: ConsensusStrategy;
  /** Timeout per provider in ms (default: 60000) */
  timeout?: number;
  /** Max tokens budget per provider query */
  maxTokensPerQuery?: number;
  /** Working directory for provider instances */
  workingDirectory?: string;
  /** Include edge cases in synthesis (default: true) */
  includeEdgeCases?: boolean;
}

/**
 * Individual response from a single provider
 */
export interface ConsensusProviderResponse {
  /** Provider that generated this response */
  provider: string;
  /** Model used */
  model?: string;
  /** The response content */
  content: string;
  /** Whether the query succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Response time in ms */
  durationMs: number;
  /** Token usage if available */
  tokensUsed?: number;
  /** Estimated cost in USD */
  estimatedCost?: number;
}

/**
 * Result of a consensus query
 */
export interface ConsensusResult {
  /** Synthesized consensus answer */
  consensus: string;
  /** Agreement score 0-1 (1 = perfect agreement) */
  agreement: number;
  /** Individual provider responses */
  responses: ConsensusProviderResponse[];
  /** Notable disagreements */
  dissent: string[];
  /** Edge cases identified across providers */
  edgeCases: string[];
  /** Total time for the consensus query */
  totalDurationMs: number;
  /** Total estimated cost */
  totalEstimatedCost: number;
  /** Number of providers that responded successfully */
  successCount: number;
  /** Number of providers that failed */
  failureCount: number;
}

/**
 * Consensus query event for tracking progress
 */
export interface ConsensusProgressEvent {
  /** Query ID */
  queryId: string;
  /** Current phase */
  phase: 'dispatching' | 'collecting' | 'synthesizing' | 'complete' | 'error';
  /** Providers that have responded so far */
  respondedProviders: string[];
  /** Providers still pending */
  pendingProviders: string[];
  /** Partial result if available */
  partialResult?: Partial<ConsensusResult>;
}
