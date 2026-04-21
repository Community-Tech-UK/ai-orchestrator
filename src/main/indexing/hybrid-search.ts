/**
 * Hybrid Search Service
 *
 * Combines BM25 keyword search with vector semantic search using
 * Reciprocal Rank Fusion (RRF) for optimal retrieval quality.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  HybridSearchOptions,
  HybridSearchResult,
  SearchConfig,
} from '../../shared/types/codebase.types';
import { DEFAULT_SEARCH_CONFIG } from './config';
import { BM25Search, getBM25Search } from './bm25-search';
import { VectorStore, getVectorStore } from '../rlm/vector-store';
import { HyDEService, getHyDEService } from '../rlm/hyde-service';
import { getLogger } from '../logging/logger';

// ============================================================================
// Types
// ============================================================================

interface RankedResult {
  sectionId: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language?: string;
  chunkType?: string;
  symbolName?: string;
  bm25Rank?: number;
  vectorRank?: number;
  bm25Score?: number;
  vectorScore?: number;
}

// ============================================================================
// HybridSearchService Class
// ============================================================================

const logger = getLogger('HybridSearch');

export class HybridSearchService {
  private db: SqliteDriver;
  private config: SearchConfig;
  private bm25: BM25Search;
  private vectorStore: VectorStore;
  private hydeService: HyDEService;

  constructor(db: SqliteDriver, config: Partial<SearchConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_SEARCH_CONFIG, ...config };
    this.bm25 = getBM25Search(db);
    this.vectorStore = getVectorStore();
    this.hydeService = getHyDEService();
  }

  /**
   * Perform hybrid search combining BM25 and vector search.
   */
  async search(options: HybridSearchOptions): Promise<HybridSearchResult[]> {
    const {
      query,
      storeId,
      topK = this.config.defaultTopK,
      useHyDE = this.config.useHyDE,
      bm25Weight = this.config.bm25Weight,
      vectorWeight = this.config.vectorWeight,
      minScore = this.config.minScore,
      filePatterns,
    } = options;

    // Get 2x topK from each source for better fusion
    const sourceK = Math.min(topK * 2, this.config.maxTopK);

    // Run BM25 and vector searches in parallel
    const [bm25Results, vectorResults] = await Promise.all([
      this.searchBM25(query, storeId, sourceK, filePatterns),
      this.searchVector(query, storeId, sourceK, useHyDE),
    ]);

    // Fuse results using RRF
    const fusedResults = this.fuseWithRRF(bm25Results, vectorResults, bm25Weight, vectorWeight);

    // Filter by minimum score and limit to topK
    const filteredResults = fusedResults
      .filter((r) => r.score >= minScore)
      .slice(0, topK);

    // Add diversity if needed
    return this.applyDiversity(filteredResults);
  }

  /**
   * Configure the search service.
   */
  configure(config: Partial<SearchConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): SearchConfig {
    return { ...this.config };
  }

  // ==========================================================================
  // Private: Individual Search Methods
  // ==========================================================================

  private async searchBM25(
    query: string,
    storeId: string,
    limit: number,
    filePatterns?: string[]
  ): Promise<RankedResult[]> {
    const results = this.bm25.search({
      query,
      storeId,
      limit,
      filePatterns,
      boostSymbols: true,
    });

    // Get section metadata for each result
    return results.map((r, index) => {
      const metadata = this.getSectionMetadata(r.sectionId);

      return {
        sectionId: r.sectionId,
        filePath: r.filePath,
        content: r.content,
        startLine: metadata?.startLine || 0,
        endLine: metadata?.endLine || 0,
        language: metadata?.language,
        chunkType: metadata?.chunkType,
        symbolName: metadata?.symbolName,
        bm25Rank: index + 1,
        bm25Score: r.score,
      };
    });
  }

  private async searchVector(
    query: string,
    storeId: string,
    limit: number,
    useHyDE: boolean
  ): Promise<RankedResult[]> {
    // Optionally use HyDE for query expansion
    let searchEmbedding: number[] | undefined;
    if (useHyDE) {
      try {
        const hydeResult = await this.hydeService.embed(query, {
          contextHints: this.config.hydeContextHints === 'auto' ? 'code' : this.config.hydeContextHints as 'code' | 'documentation' | 'mixed',
        });
        if (hydeResult && hydeResult.hydeUsed) {
          searchEmbedding = hydeResult.embedding;
        }
      } catch (error) {
        logger.warn('HyDE generation failed, using original query', { error: String(error) });
      }
    }

    // Perform vector search
    const results = await this.vectorStore.search(storeId, query, {
      topK: limit,
      minSimilarity: 0.3,
    });

    return results.map((r, index) => {
      const metadata = this.getSectionMetadata(r.entry.sectionId);

      return {
        sectionId: r.entry.sectionId,
        filePath: metadata?.filePath || '',
        content: r.entry.contentPreview,
        startLine: metadata?.startLine || 0,
        endLine: metadata?.endLine || 0,
        language: metadata?.language,
        chunkType: metadata?.chunkType,
        symbolName: metadata?.symbolName,
        vectorRank: index + 1,
        vectorScore: r.similarity,
      };
    });
  }

  // ==========================================================================
  // Private: Rank Fusion
  // ==========================================================================

  /**
   * Reciprocal Rank Fusion (RRF) algorithm.
   *
   * RRF score = sum(1 / (k + rank_i)) for each ranking system i
   * where k is a constant (typically 60) to dampen the effect of high rankings.
   */
  private fuseWithRRF(
    bm25Results: RankedResult[],
    vectorResults: RankedResult[],
    bm25Weight: number,
    vectorWeight: number
  ): HybridSearchResult[] {
    const k = 60; // RRF constant
    const scoreMap = new Map<string, { result: RankedResult; rrfScore: number }>();

    // Process BM25 results
    for (const result of bm25Results) {
      const rrfScore = bm25Weight * (1 / (k + (result.bm25Rank || Infinity)));

      const existing = scoreMap.get(result.sectionId);
      if (existing) {
        existing.rrfScore += rrfScore;
        existing.result.bm25Rank = result.bm25Rank;
        existing.result.bm25Score = result.bm25Score;
      } else {
        scoreMap.set(result.sectionId, { result, rrfScore });
      }
    }

    // Process vector results
    for (const result of vectorResults) {
      const rrfScore = vectorWeight * (1 / (k + (result.vectorRank || Infinity)));

      const existing = scoreMap.get(result.sectionId);
      if (existing) {
        existing.rrfScore += rrfScore;
        existing.result.vectorRank = result.vectorRank;
        existing.result.vectorScore = result.vectorScore;
      } else {
        scoreMap.set(result.sectionId, {
          result: {
            ...result,
            vectorRank: result.vectorRank,
            vectorScore: result.vectorScore,
          },
          rrfScore,
        });
      }
    }

    // Convert to HybridSearchResult and sort by RRF score
    const fusedResults: HybridSearchResult[] = Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .map(({ result, rrfScore }) => ({
        sectionId: result.sectionId,
        filePath: result.filePath,
        content: result.content,
        startLine: result.startLine,
        endLine: result.endLine,
        score: rrfScore,
        bm25Score: result.bm25Score,
        vectorScore: result.vectorScore,
        matchType: this.determineMatchType(result.bm25Rank, result.vectorRank),
        language: result.language,
        chunkType: result.chunkType as HybridSearchResult['chunkType'],
        symbolName: result.symbolName,
      }));

    return fusedResults;
  }

  private determineMatchType(
    bm25Rank?: number,
    vectorRank?: number
  ): 'bm25' | 'vector' | 'hybrid' {
    if (bm25Rank && vectorRank) {
      return 'hybrid';
    } else if (bm25Rank) {
      return 'bm25';
    } else {
      return 'vector';
    }
  }

  // ==========================================================================
  // Private: Diversity
  // ==========================================================================

  /**
   * Apply diversity filtering to avoid too many results from the same file.
   */
  private applyDiversity(results: HybridSearchResult[]): HybridSearchResult[] {
    if (results.length <= 1) {
      return results;
    }

    const threshold = this.config.diversityThreshold;
    const fileCount = new Map<string, number>();
    const maxPerFile = Math.ceil(results.length * (1 - threshold));
    const diverse: HybridSearchResult[] = [];

    for (const result of results) {
      const count = fileCount.get(result.filePath) || 0;

      if (count < maxPerFile) {
        diverse.push(result);
        fileCount.set(result.filePath, count + 1);
      }
    }

    return diverse;
  }

  // ==========================================================================
  // Private: Metadata
  // ==========================================================================

  private getSectionMetadata(sectionId: string): {
    filePath?: string;
    startLine?: number;
    endLine?: number;
    language?: string;
    chunkType?: string;
    symbolName?: string;
  } | null {
    try {
      const stmt = this.db.prepare(`
        SELECT
          file_path,
          start_offset as start_line,
          end_offset as end_line,
          language,
          type as chunk_type,
          name as symbol_name
        FROM context_sections
        WHERE id = ?
      `);

      const row = stmt.get(sectionId) as {
        file_path?: string;
        start_line?: number;
        end_line?: number;
        language?: string;
        chunk_type?: string;
        symbol_name?: string;
      } | undefined;

      if (row) {
        return {
          filePath: row.file_path,
          startLine: row.start_line,
          endLine: row.end_line,
          language: row.language,
          chunkType: row.chunk_type,
          symbolName: row.symbol_name,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let hybridSearchInstance: HybridSearchService | null = null;

export function getHybridSearchService(
  db: SqliteDriver,
  config?: Partial<SearchConfig>
): HybridSearchService {
  if (!hybridSearchInstance) {
    hybridSearchInstance = new HybridSearchService(db, config);
  }
  return hybridSearchInstance;
}

export function resetHybridSearchService(): void {
  hybridSearchInstance = null;
}
