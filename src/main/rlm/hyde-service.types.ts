/**
 * HyDE Service - Type definitions
 */

export interface HyDEConfig {
  enabled: boolean;
  /** Minimum query length to trigger HyDE (very short queries work fine with direct embedding) */
  minQueryLength: number;
  /** Maximum tokens for the hypothetical document */
  maxHypotheticalTokens: number;
  /** Timeout for hypothetical generation in ms */
  generationTimeout: number;
  /** Cache hypothetical documents to avoid repeated LLM calls */
  cacheEnabled: boolean;
  /** Number of hypothetical documents to cache */
  cacheSize: number;
  /** Context type hints to include in generation prompt */
  contextHints: 'code' | 'documentation' | 'mixed' | 'auto';
  /** Generate multiple hypothetical docs and average embeddings (more expensive but more robust) */
  multiHypothetical: boolean;
  /** Number of hypothetical docs when multiHypothetical is true */
  hypotheticalCount: number;
}

export interface HyDEResult {
  /** The embedding to use for search */
  embedding: number[];
  /** The generated hypothetical document(s) */
  hypotheticalDocuments: string[];
  /** Whether HyDE was used (false if disabled or query was too short) */
  hydeUsed: boolean;
  /** Time spent generating hypothetical document(s) in ms */
  generationTimeMs: number;
  /** Whether result was from cache */
  cached: boolean;
  /** Original query */
  query: string;
}

export interface CacheEntry {
  embedding: number[];
  hypotheticalDocuments: string[];
  timestamp: number;
}
