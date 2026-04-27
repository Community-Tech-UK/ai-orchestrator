/**
 * Hybrid Memory Retrieval System
 *
 * Implements advanced retrieval combining:
 * - Semantic similarity (70% weight)
 * - BM25 lexical search (30% weight)
 * - Boost for keyword overlap
 * - Trajectory learning for successful patterns
 * - Memory distillation before answering
 */

import { EventEmitter } from 'events';
import type { MemoryEntry } from '../../shared/types/memory-r1.types';
import { MemoryManagerAgent, getMemoryManager } from './r1-memory-manager';
import { getTokenCounter, TokenCounter } from '../rlm/token-counter';

/**
 * Hybrid retrieval configuration
 */
export interface HybridRetrievalConfig {
  /** Weight for semantic similarity (0-1) */
  semanticWeight: number;
  /** Weight for BM25 lexical score (0-1) */
  lexicalWeight: number;
  /** Boost for keyword overlap (multiplier) */
  keywordBoost: number;
  /** Maximum candidates to retrieve before filtering */
  maxCandidates: number;
  /** Final top-K after distillation */
  topK: number;
  /** Enable memory distillation */
  enableDistillation: boolean;
  /** Distillation quality threshold (0-1) */
  distillationThreshold: number;
  /** Enable trajectory learning */
  enableTrajectoryLearning: boolean;
  /** BM25 parameters */
  bm25: {
    k1: number; // Term frequency saturation
    b: number;  // Length normalization
  };
}

/**
 * Default configuration
 */
export const DEFAULT_HYBRID_RETRIEVAL_CONFIG: HybridRetrievalConfig = {
  semanticWeight: 0.7,
  lexicalWeight: 0.3,
  keywordBoost: 1.2,
  maxCandidates: 60,
  topK: 6,
  enableDistillation: true,
  distillationThreshold: 0.5,
  enableTrajectoryLearning: true,
  bm25: {
    k1: 1.2,
    b: 0.75,
  },
};

/**
 * Scored retrieval result
 */
export interface ScoredRetrievalResult {
  entry: MemoryEntry;
  semanticScore: number;
  lexicalScore: number;
  keywordOverlap: number;
  hybridScore: number;
  distillationScore?: number;
  trajectoryBoost?: number;
}

/**
 * Trajectory record for learning
 */
export interface TrajectoryRecord {
  id: string;
  query: string;
  queryTerms: string[];
  retrievedIds: string[];
  selectedIds: string[];
  taskSuccess: boolean;
  timestamp: number;
}

/**
 * BM25 document index
 */
interface BM25Index {
  documentFrequency: Map<string, number>;
  documentLengths: Map<string, number>;
  averageDocLength: number;
  totalDocuments: number;
  termFrequencies: Map<string, Map<string, number>>;
}

/**
 * Hybrid Retrieval Manager
 */
export class HybridRetrievalManager extends EventEmitter {
  private static instance: HybridRetrievalManager | null = null;

  private config: HybridRetrievalConfig;
  private memoryManager: MemoryManagerAgent;
  private tokenCounter: TokenCounter;
  private bm25Index: BM25Index;
  private indexDirty = false;
  private trajectories: TrajectoryRecord[] = [];
  private readonly maxTrajectories = 1000;
  private readonly markIndexDirty = (): void => {
    this.indexDirty = true;
  };

  private constructor() {
    super();
    this.config = { ...DEFAULT_HYBRID_RETRIEVAL_CONFIG };
    this.memoryManager = getMemoryManager();
    this.tokenCounter = getTokenCounter();
    this.bm25Index = this.createEmptyIndex();
    this.bindMemoryEvents();

    // Build initial index
    this.rebuildIndex();
  }

  static getInstance(): HybridRetrievalManager {
    if (!HybridRetrievalManager.instance) {
      HybridRetrievalManager.instance = new HybridRetrievalManager();
    }
    return HybridRetrievalManager.instance;
  }

  static _resetForTesting(): void {
    if (HybridRetrievalManager.instance) {
      HybridRetrievalManager.instance.unbindMemoryEvents();
      HybridRetrievalManager.instance.removeAllListeners();
    }
    HybridRetrievalManager.instance = null;
  }

  /**
   * Configure the retrieval manager
   */
  configure(config: Partial<HybridRetrievalConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      bm25: { ...this.config.bm25, ...config.bm25 },
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): HybridRetrievalConfig {
    return { ...this.config };
  }

  /**
   * Perform hybrid retrieval
   */
  async retrieve(
    query: string,
    taskId: string,
    context?: string
  ): Promise<ScoredRetrievalResult[]> {
    // Tokenize query
    const queryTerms = this.tokenize(query);
    this.ensureIndexFresh();

    // Get all entries
    const allEntries = this.memoryManager.getAllEntries().filter(e => !e.isArchived);

    if (allEntries.length === 0) {
      return [];
    }

    // Compute hybrid scores
    const scored: ScoredRetrievalResult[] = [];

    // First pass: semantic + lexical scoring
    const semanticResults = await this.memoryManager.retrieve(query, taskId);
    const semanticScoreMap = new Map<string, number>();
    semanticResults.forEach((entry, index) => {
      // Higher rank = higher score (exponential decay)
      const score = 1 / (index + 1);
      semanticScoreMap.set(entry.id, score);
    });

    for (const entry of allEntries) {
      const semanticScore = semanticScoreMap.get(entry.id) || 0;
      const lexicalScore = this.computeBM25Score(queryTerms, entry.id);
      const keywordOverlap = this.computeKeywordOverlap(queryTerms, entry.content);

      // Apply trajectory boost if enabled
      let trajectoryBoost = 1.0;
      if (this.config.enableTrajectoryLearning) {
        trajectoryBoost = this.computeTrajectoryBoost(queryTerms, entry.id);
      }

      const hybridScore = (
        (semanticScore * this.config.semanticWeight) +
        (lexicalScore * this.config.lexicalWeight)
      ) * (keywordOverlap > 0 ? this.config.keywordBoost : 1.0) * trajectoryBoost;

      scored.push({
        entry,
        semanticScore,
        lexicalScore,
        keywordOverlap,
        hybridScore,
        trajectoryBoost,
      });
    }

    // Sort by hybrid score
    scored.sort((a, b) => b.hybridScore - a.hybridScore);

    // Take top candidates
    let candidates = scored.slice(0, this.config.maxCandidates);

    // Apply distillation if enabled
    if (this.config.enableDistillation && context) {
      candidates = await this.distillMemories(candidates, query, context);
    }

    // Take final top-K
    const results = candidates.slice(0, this.config.topK);

    // Record trajectory
    if (this.config.enableTrajectoryLearning) {
      this.recordTrajectory({
        id: `traj-${Date.now()}`,
        query,
        queryTerms,
        retrievedIds: results.map(r => r.entry.id),
        selectedIds: [], // Will be filled later
        taskSuccess: false, // Will be updated later
        timestamp: Date.now(),
      });
    }

    this.emit('retrieval:completed', {
      query,
      taskId,
      candidateCount: allEntries.length,
      resultCount: results.length,
      topScore: results[0]?.hybridScore || 0,
    });

    return results;
  }

  /**
   * Distill memories for relevance
   */
  private async distillMemories(
    candidates: ScoredRetrievalResult[],
    query: string,
    context: string
  ): Promise<ScoredRetrievalResult[]> {
    // Simple distillation: compute context relevance
    for (const candidate of candidates) {
      const contextTerms = this.tokenize(context);
      const entryTerms = this.tokenize(candidate.entry.content);

      // Compute overlap with context
      const overlap = this.computeSetOverlap(contextTerms, entryTerms);

      // Compute query-entry coherence
      const queryTerms = this.tokenize(query);
      const queryCoherence = this.computeSetOverlap(queryTerms, entryTerms);

      // Distillation score combines context relevance and query coherence
      candidate.distillationScore = (overlap * 0.4 + queryCoherence * 0.6);

      // Adjust hybrid score based on distillation
      if (candidate.distillationScore < this.config.distillationThreshold) {
        candidate.hybridScore *= 0.5; // Penalize low-quality matches
      } else {
        candidate.hybridScore *= (1 + candidate.distillationScore * 0.3);
      }
    }

    // Re-sort after distillation
    candidates.sort((a, b) => b.hybridScore - a.hybridScore);

    this.emit('distillation:completed', {
      inputCount: candidates.length,
      filteredCount: candidates.filter(c =>
        (c.distillationScore || 0) >= this.config.distillationThreshold
      ).length,
    });

    return candidates;
  }

  /**
   * Compute BM25 score for a document
   */
  private computeBM25Score(queryTerms: string[], docId: string): number {
    const { k1, b } = this.config.bm25;
    const docLength = this.bm25Index.documentLengths.get(docId) || 0;
    const avgDocLength = this.bm25Index.averageDocLength;
    const totalDocs = this.bm25Index.totalDocuments;

    if (docLength === 0 || totalDocs === 0) return 0;

    let score = 0;

    for (const term of queryTerms) {
      const df = this.bm25Index.documentFrequency.get(term) || 0;
      const termFreqs = this.bm25Index.termFrequencies.get(term);
      const tf = termFreqs?.get(docId) || 0;

      if (tf === 0 || df === 0) continue;

      // IDF component
      const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);

      // TF component with saturation
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));

      score += idf * tfNorm;
    }

    return score;
  }

  /**
   * Compute keyword overlap between query and content
   */
  private computeKeywordOverlap(queryTerms: string[], content: string): number {
    const contentTerms = new Set(this.tokenize(content));
    let overlap = 0;

    for (const term of queryTerms) {
      if (contentTerms.has(term)) {
        overlap++;
      }
    }

    return queryTerms.length > 0 ? overlap / queryTerms.length : 0;
  }

  /**
   * Compute set overlap ratio
   */
  private computeSetOverlap(set1: string[], set2: string[]): number {
    const s1 = new Set(set1);
    const s2 = new Set(set2);
    let intersection = 0;

    for (const item of s1) {
      if (s2.has(item)) intersection++;
    }

    const union = s1.size + s2.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Compute trajectory-based boost
   */
  private computeTrajectoryBoost(queryTerms: string[], entryId: string): number {
    // Find similar successful trajectories
    let totalBoost = 0;
    let matchCount = 0;

    for (const traj of this.trajectories) {
      if (!traj.taskSuccess) continue;

      // Check query similarity
      const querySimilarity = this.computeSetOverlap(queryTerms, traj.queryTerms);
      if (querySimilarity < 0.3) continue;

      // Check if this entry was in successful trajectory
      if (traj.selectedIds.includes(entryId)) {
        totalBoost += querySimilarity;
        matchCount++;
      }
    }

    return matchCount > 0 ? 1 + (totalBoost / matchCount) * 0.5 : 1.0;
  }

  /**
   * Record a trajectory for learning
   */
  private recordTrajectory(trajectory: TrajectoryRecord): void {
    this.trajectories.push(trajectory);

    // Keep bounded
    if (this.trajectories.length > this.maxTrajectories) {
      // Remove oldest unsuccessful trajectories first
      const unsuccessful = this.trajectories.filter(t => !t.taskSuccess);
      if (unsuccessful.length > this.maxTrajectories / 2) {
        this.trajectories = [
          ...unsuccessful.slice(unsuccessful.length - this.maxTrajectories / 4),
          ...this.trajectories.filter(t => t.taskSuccess),
        ];
      } else {
        this.trajectories = this.trajectories.slice(-this.maxTrajectories);
      }
    }
  }

  /**
   * Mark selected memories for a retrieval
   */
  markSelected(retrievalId: string, selectedIds: string[]): void {
    // Find most recent trajectory without selection
    const traj = [...this.trajectories].reverse().find(t => t.selectedIds.length === 0);
    if (traj) {
      traj.selectedIds = selectedIds;
    }
  }

  /**
   * Record task outcome for trajectory learning
   */
  recordTaskOutcome(taskId: string, success: boolean): void {
    // Find recent trajectories for this task
    const cutoff = Date.now() - 3600000; // Last hour
    for (const traj of this.trajectories) {
      if (traj.timestamp > cutoff && traj.selectedIds.length > 0) {
        traj.taskSuccess = success;
      }
    }

    this.emit('trajectory:outcome', { taskId, success });
  }

  /**
   * Rebuild the BM25 index
   */
  rebuildIndex(): void {
    this.bm25Index = this.createEmptyIndex();

    const entries = this.memoryManager.getAllEntries();

    for (const entry of entries) {
      this.indexDocument(entry.id, entry.content);
    }

    // Calculate average document length
    if (this.bm25Index.totalDocuments > 0) {
      let totalLength = 0;
      for (const length of this.bm25Index.documentLengths.values()) {
        totalLength += length;
      }
      this.bm25Index.averageDocLength = totalLength / this.bm25Index.totalDocuments;
    }

    this.emit('index:rebuilt', {
      documents: this.bm25Index.totalDocuments,
      uniqueTerms: this.bm25Index.documentFrequency.size,
    });
    this.indexDirty = false;
  }

  private ensureIndexFresh(): void {
    if (this.indexDirty) {
      this.rebuildIndex();
    }
  }

  private bindMemoryEvents(): void {
    this.memoryManager.on('entry:added', this.markIndexDirty);
    this.memoryManager.on('entry:updated', this.markIndexDirty);
    this.memoryManager.on('entry:deleted', this.markIndexDirty);
    this.memoryManager.on('state:loaded', this.markIndexDirty);
  }

  private unbindMemoryEvents(): void {
    this.memoryManager.off('entry:added', this.markIndexDirty);
    this.memoryManager.off('entry:updated', this.markIndexDirty);
    this.memoryManager.off('entry:deleted', this.markIndexDirty);
    this.memoryManager.off('state:loaded', this.markIndexDirty);
  }

  /**
   * Index a single document
   */
  private indexDocument(docId: string, content: string): void {
    const terms = this.tokenize(content);

    this.bm25Index.documentLengths.set(docId, terms.length);
    this.bm25Index.totalDocuments++;

    const termCounts = new Map<string, number>();
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }

    for (const [term, count] of termCounts) {
      // Update document frequency
      const df = this.bm25Index.documentFrequency.get(term) || 0;
      this.bm25Index.documentFrequency.set(term, df + 1);

      // Update term frequency
      let termDocs = this.bm25Index.termFrequencies.get(term);
      if (!termDocs) {
        termDocs = new Map();
        this.bm25Index.termFrequencies.set(term, termDocs);
      }
      termDocs.set(docId, count);
    }
  }

  /**
   * Tokenize text for indexing/searching
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2); // Min 3 chars
  }

  /**
   * Create empty index
   */
  private createEmptyIndex(): BM25Index {
    return {
      documentFrequency: new Map(),
      documentLengths: new Map(),
      averageDocLength: 0,
      totalDocuments: 0,
      termFrequencies: new Map(),
    };
  }

  /**
   * Get retrieval statistics
   */
  getStats(): {
    indexedDocuments: number;
    uniqueTerms: number;
    trajectoryCount: number;
    successfulTrajectories: number;
    averageRetrievalSize: number;
  } {
    const successfulTrajs = this.trajectories.filter(t => t.taskSuccess).length;

    return {
      indexedDocuments: this.bm25Index.totalDocuments,
      uniqueTerms: this.bm25Index.documentFrequency.size,
      trajectoryCount: this.trajectories.length,
      successfulTrajectories: successfulTrajs,
      averageRetrievalSize: this.trajectories.length > 0
        ? this.trajectories.reduce((sum, t) => sum + t.retrievedIds.length, 0) / this.trajectories.length
        : 0,
    };
  }

  /**
   * Clear all data
   */
  reset(): void {
    this.bm25Index = this.createEmptyIndex();
    this.trajectories = [];
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.unbindMemoryEvents();
    this.reset();
    this.removeAllListeners();
    HybridRetrievalManager.instance = null;
  }
}

export default HybridRetrievalManager;

export function getHybridRetrievalManager(): HybridRetrievalManager {
  return HybridRetrievalManager.getInstance();
}
