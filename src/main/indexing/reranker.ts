/**
 * Cross-Encoder Reranker
 *
 * Provides high-quality reranking of search results using cross-encoder models.
 * Supports Cohere, Voyage, and local TF-IDF fallback.
 */

import type {
  RerankerConfig,
  RerankResult,
  HybridSearchResult,
} from '../../shared/types/codebase.types';
import { DEFAULT_RERANKER_CONFIG } from './config';

// ============================================================================
// Types
// ============================================================================

interface RerankRequest {
  query: string;
  documents: string[];
  topK?: number;
}

// ============================================================================
// CrossEncoderReranker Class
// ============================================================================

export class CrossEncoderReranker {
  private config: RerankerConfig;
  private initialized: boolean = false;

  constructor(config: Partial<RerankerConfig> = {}) {
    this.config = { ...DEFAULT_RERANKER_CONFIG, ...config };
  }

  /**
   * Rerank a list of search results.
   */
  async rerank(
    query: string,
    results: HybridSearchResult[],
    topK?: number
  ): Promise<HybridSearchResult[]> {
    if (results.length === 0) {
      return [];
    }

    const limit = topK || results.length;
    const documents = results.map((r) => r.content);

    // Get rerank scores
    const rerankScores = await this.getRerankScores({
      query,
      documents,
      topK: limit,
    });

    // Apply rerank scores to results
    const rerankedResults = results.map((result, index) => {
      const scoreEntry = rerankScores.find((s) => s.index === index);
      return {
        ...result,
        rerankScore: scoreEntry?.score,
        score: scoreEntry?.score || result.score,
      };
    });

    // Sort by rerank score and limit
    return rerankedResults
      .sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0))
      .slice(0, limit);
  }

  /**
   * Configure the reranker.
   */
  configure(config: Partial<RerankerConfig>): void {
    this.config = { ...this.config, ...config };
    this.initialized = false;
  }

  /**
   * Check if the reranker is available.
   */
  async isAvailable(): Promise<boolean> {
    if (this.config.provider === 'local') {
      return true;
    }

    if (!this.config.apiKey) {
      return false;
    }

    // Could add provider health checks here
    return true;
  }

  // ==========================================================================
  // Private: Score Calculation
  // ==========================================================================

  private async getRerankScores(request: RerankRequest): Promise<RerankResult[]> {
    switch (this.config.provider) {
      case 'cohere':
        return this.rerankWithCohere(request);
      case 'voyage':
        return this.rerankWithVoyage(request);
      case 'local':
      default:
        return this.rerankWithLocal(request);
    }
  }

  private async rerankWithCohere(request: RerankRequest): Promise<RerankResult[]> {
    if (!this.config.apiKey) {
      console.warn('Cohere API key not configured, falling back to local reranking');
      return this.rerankWithLocal(request);
    }

    try {
      const response = await fetch('https://api.cohere.ai/v1/rerank', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model || 'rerank-english-v3.0',
          query: request.query,
          documents: request.documents,
          top_n: request.topK || request.documents.length,
        }),
      });

      if (!response.ok) {
        throw new Error(`Cohere API error: ${response.status}`);
      }

      const data = await response.json() as {
        results: Array<{ index: number; relevance_score: number }>;
      };

      return data.results.map((r) => ({
        index: r.index,
        score: r.relevance_score,
      }));
    } catch (error) {
      console.error('Cohere reranking failed:', error);
      return this.rerankWithLocal(request);
    }
  }

  private async rerankWithVoyage(request: RerankRequest): Promise<RerankResult[]> {
    if (!this.config.apiKey) {
      console.warn('Voyage API key not configured, falling back to local reranking');
      return this.rerankWithLocal(request);
    }

    try {
      const response = await fetch('https://api.voyageai.com/v1/rerank', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model || 'rerank-lite-1',
          query: request.query,
          documents: request.documents,
          top_k: request.topK || request.documents.length,
        }),
      });

      if (!response.ok) {
        throw new Error(`Voyage API error: ${response.status}`);
      }

      const data = await response.json() as {
        data: Array<{ index: number; relevance_score: number }>;
      };

      return data.data.map((r) => ({
        index: r.index,
        score: r.relevance_score,
      }));
    } catch (error) {
      console.error('Voyage reranking failed:', error);
      return this.rerankWithLocal(request);
    }
  }

  /**
   * Local TF-IDF based reranking fallback.
   */
  private rerankWithLocal(request: RerankRequest): RerankResult[] {
    const queryTerms = this.tokenize(request.query.toLowerCase());
    const queryVector = this.computeTFVector(queryTerms, queryTerms);

    const results: RerankResult[] = request.documents.map((doc, index) => {
      const docTerms = this.tokenize(doc.toLowerCase());
      const docVector = this.computeTFVector(docTerms, queryTerms);
      const score = this.cosineSimilarity(queryVector, docVector);

      return { index, score };
    });

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Limit to topK
    if (request.topK && request.topK < results.length) {
      return results.slice(0, request.topK);
    }

    return results;
  }

  // ==========================================================================
  // Private: TF-IDF Helpers
  // ==========================================================================

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  private computeTFVector(docTerms: string[], vocabularyTerms: string[]): number[] {
    const termCounts = new Map<string, number>();

    for (const term of docTerms) {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }

    // Create TF vector based on vocabulary
    return vocabularyTerms.map((term) => {
      const count = termCounts.get(term) || 0;
      // Use log-normalized TF
      return count > 0 ? 1 + Math.log(count) : 0;
    });
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) {
      return 0;
    }

    return dotProduct / denominator;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let crossEncoderRerankerInstance: CrossEncoderReranker | null = null;

export function getCrossEncoderReranker(
  config?: Partial<RerankerConfig>
): CrossEncoderReranker {
  if (!crossEncoderRerankerInstance) {
    crossEncoderRerankerInstance = new CrossEncoderReranker(config);
  }
  return crossEncoderRerankerInstance;
}

export function resetCrossEncoderReranker(): void {
  crossEncoderRerankerInstance = null;
}
