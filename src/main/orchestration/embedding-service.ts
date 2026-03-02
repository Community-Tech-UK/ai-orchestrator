/**
 * Embedding Service - Semantic similarity for multi-verification clustering
 * Supports multiple backends: simple (TF-IDF), local (placeholder), openai (placeholder)
 */

import { EventEmitter } from 'events';
import type { AgentResponse } from '../../shared/types/verification.types';
import { STORAGE_LIMITS } from '../../shared/constants/limits';

export interface SemanticClusterConfig {
  similarityThreshold: number; // 0.0-1.0
  embeddingModel: 'openai' | 'local' | 'simple';
  clusteringAlgorithm: 'hierarchical' | 'kmeans' | 'dbscan';
}

export interface ResponseCluster {
  id: string;
  centroid: number[];
  members: { agentId: string; response: AgentResponse; similarity: number }[];
  averageSimilarity: number;
}

export interface EmbeddingCacheEntry {
  text: string;
  embedding: number[];
  timestamp: number;
}

export class EmbeddingService extends EventEmitter {
  private static instance: EmbeddingService;
  private cache = new Map<string, EmbeddingCacheEntry>();
  private vocabulary = new Map<string, number>();
  private documentFrequency = new Map<string, number>();
  private vocabularyAccessOrder: string[] = []; // Track access order for LRU
  private documentCount = 0;
  private maxCacheSize: number = STORAGE_LIMITS.CACHE_ENTRIES;
  private maxVocabularySize: number = STORAGE_LIMITS.MAX_VOCABULARY_SIZE;
  private cacheExpiryMs: number = STORAGE_LIMITS.CACHE_TTL_LONG_MS;

  static getInstance(): EmbeddingService {
    if (!this.instance) {
      this.instance = new EmbeddingService();
    }
    return this.instance;
  }

  /**
   * Reset the singleton instance for testing.
   * Clears all caches, vocabulary, and state.
   */
  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.clearCache();
      this.instance.removeAllListeners();
      (this.instance as any) = undefined;
    }
  }

  private constructor() {
    super();
  }

  /**
   * Configure vocabulary size limit
   */
  setMaxVocabularySize(size: number): void {
    this.maxVocabularySize = size;
    this.evictVocabularyIfNeeded();
  }

  /**
   * Get current vocabulary statistics
   */
  getVocabularyStats(): { size: number; maxSize: number; documentCount: number } {
    return {
      size: this.vocabulary.size,
      maxSize: this.maxVocabularySize,
      documentCount: this.documentCount
    };
  }

  // ============ Public API ============

  /**
   * Get embeddings for multiple texts
   */
  async getEmbeddings(
    texts: string[],
    model: SemanticClusterConfig['embeddingModel'] = 'simple'
  ): Promise<number[][]> {
    switch (model) {
      case 'openai':
        return this.getOpenAIEmbeddings(texts);
      case 'local':
        return this.getLocalEmbeddings(texts);
      case 'simple':
      default:
        return this.getSimpleEmbeddings(texts);
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(a: number[], b: number[]): number {
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
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Cluster responses by semantic similarity
   */
  async clusterResponses(
    responses: AgentResponse[],
    config: SemanticClusterConfig
  ): Promise<ResponseCluster[]> {
    if (responses.length === 0) {
      return [];
    }

    // Get embeddings for all responses
    const texts = responses.map(r => r.response);
    const embeddings = await this.getEmbeddings(texts, config.embeddingModel);

    // Calculate similarity matrix
    const similarityMatrix = this.buildSimilarityMatrix(embeddings);

    // Cluster based on algorithm
    switch (config.clusteringAlgorithm) {
      case 'hierarchical':
        return this.hierarchicalClustering(responses, embeddings, similarityMatrix, config.similarityThreshold);
      case 'kmeans':
        return this.kmeansClustering(responses, embeddings, config.similarityThreshold);
      case 'dbscan':
      default:
        return this.dbscanClustering(responses, embeddings, similarityMatrix, config.similarityThreshold);
    }
  }

  /**
   * Find semantically similar responses
   */
  async findSimilar(
    query: string,
    responses: AgentResponse[],
    threshold = 0.7
  ): Promise<{ response: AgentResponse; similarity: number }[]> {
    const queryEmbedding = (await this.getEmbeddings([query]))[0];
    const responseEmbeddings = await this.getEmbeddings(responses.map(r => r.response));

    const results: { response: AgentResponse; similarity: number }[] = [];

    for (let i = 0; i < responses.length; i++) {
      const similarity = this.cosineSimilarity(queryEmbedding, responseEmbeddings[i]);
      if (similarity >= threshold) {
        results.push({ response: responses[i], similarity });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  // ============ Simple TF-IDF Embeddings ============

  private async getSimpleEmbeddings(texts: string[]): Promise<number[][]> {
    // Check cache for each text, compute only missing ones
    const results: number[][] = [];
    const uncachedTexts: { index: number; text: string }[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.getFromCache(texts[i]);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedTexts.push({ index: i, text: texts[i] });
      }
    }

    if (uncachedTexts.length > 0) {
      // Build vocabulary with uncached texts
      this.updateVocabulary(uncachedTexts.map(u => u.text));

      for (const { index, text } of uncachedTexts) {
        const embedding = this.textToTfIdfVector(text);
        this.addToCache(text, embedding);
        results[index] = embedding;
      }
    }

    return results;
  }

  private updateVocabulary(texts: string[]): void {
    for (const text of texts) {
      const tokens = this.tokenize(text);
      const uniqueTokens = new Set(tokens);

      for (const token of uniqueTokens) {
        if (!this.vocabulary.has(token)) {
          this.vocabulary.set(token, this.vocabulary.size);
          this.vocabularyAccessOrder.push(token);
        } else {
          // Move to end of access order (LRU update)
          this.updateAccessOrder(token);
        }
        this.documentFrequency.set(
          token,
          (this.documentFrequency.get(token) || 0) + 1
        );
      }
    }

    this.documentCount += texts.length;

    // Evict oldest vocabulary entries if over limit
    this.evictVocabularyIfNeeded();
  }

  /**
   * Update access order for LRU tracking
   */
  private updateAccessOrder(token: string): void {
    const idx = this.vocabularyAccessOrder.indexOf(token);
    if (idx !== -1) {
      this.vocabularyAccessOrder.splice(idx, 1);
      this.vocabularyAccessOrder.push(token);
    }
  }

  /**
   * Evict oldest vocabulary entries when over limit (LRU eviction)
   */
  private evictVocabularyIfNeeded(): void {
    while (this.vocabulary.size > this.maxVocabularySize && this.vocabularyAccessOrder.length > 0) {
      const oldestToken = this.vocabularyAccessOrder.shift();
      if (oldestToken) {
        this.vocabulary.delete(oldestToken);
        this.documentFrequency.delete(oldestToken);
      }
    }

    // Reindex vocabulary after eviction to keep indices contiguous
    if (this.vocabulary.size > 0 && this.vocabulary.size < this.maxVocabularySize / 2) {
      this.reindexVocabulary();
    }
  }

  /**
   * Reindex vocabulary to maintain contiguous indices
   */
  private reindexVocabulary(): void {
    let index = 0;
    for (const token of this.vocabulary.keys()) {
      this.vocabulary.set(token, index++);
    }
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 2 && token.length <= 30)
      .filter(token => !this.isStopWord(token));
  }

  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
      'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
      'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
      'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
      'we', 'us', 'you', 'your', 'he', 'she', 'him', 'her', 'i', 'me'
    ]);
    return stopWords.has(word);
  }

  private textToTfIdfVector(text: string): number[] {
    const tokens = this.tokenize(text);
    const termFrequency = new Map<string, number>();

    // Calculate term frequency
    for (const token of tokens) {
      termFrequency.set(token, (termFrequency.get(token) || 0) + 1);
    }

    // Build TF-IDF vector
    const vector = new Array(this.vocabulary.size).fill(0);

    for (const [term, tf] of termFrequency) {
      const index = this.vocabulary.get(term);
      if (index !== undefined) {
        const df = this.documentFrequency.get(term) || 1;
        const idf = Math.log(1 + this.documentCount / df);
        const normalizedTf = tf / tokens.length;
        vector[index] = normalizedTf * idf;
      }
    }

    // L2 normalize
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  // ============ Placeholder for OpenAI Embeddings ============

  private async getOpenAIEmbeddings(texts: string[]): Promise<number[][]> {
    // Placeholder - would call OpenAI embeddings API
    // For now, fall back to simple embeddings
    console.warn('[EmbeddingService] OpenAI embeddings not implemented, using simple embeddings');
    return this.getSimpleEmbeddings(texts);
  }

  // ============ Placeholder for Local Embeddings ============

  private async getLocalEmbeddings(texts: string[]): Promise<number[][]> {
    // Placeholder - would use a local embedding model
    // For now, fall back to simple embeddings
    console.warn('[EmbeddingService] Local embeddings not implemented, using simple embeddings');
    return this.getSimpleEmbeddings(texts);
  }

  // ============ Clustering Algorithms ============

  private buildSimilarityMatrix(embeddings: number[][]): number[][] {
    const n = embeddings.length;
    const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const sim = this.cosineSimilarity(embeddings[i], embeddings[j]);
        matrix[i][j] = sim;
        matrix[j][i] = sim;
      }
    }

    return matrix;
  }

  private hierarchicalClustering(
    responses: AgentResponse[],
    embeddings: number[][],
    similarityMatrix: number[][],
    threshold: number
  ): ResponseCluster[] {
    const n = responses.length;
    const clusters: Set<number>[] = responses.map((_, i) => new Set([i]));
    const active = new Set<number>(Array.from({ length: n }, (_, i) => i));

    // Agglomerative clustering
    while (active.size > 1) {
      let bestI = -1;
      let bestJ = -1;
      let bestSim = -1;

      // Find most similar pair of clusters
      const activeArray = Array.from(active);
      for (let i = 0; i < activeArray.length; i++) {
        for (let j = i + 1; j < activeArray.length; j++) {
          const sim = this.clusterSimilarity(
            clusters[activeArray[i]],
            clusters[activeArray[j]],
            similarityMatrix
          );
          if (sim > bestSim) {
            bestSim = sim;
            bestI = activeArray[i];
            bestJ = activeArray[j];
          }
        }
      }

      // Stop if best similarity is below threshold
      if (bestSim < threshold) {
        break;
      }

      // Merge clusters
      for (const idx of clusters[bestJ]) {
        clusters[bestI].add(idx);
      }
      active.delete(bestJ);
    }

    // Build result clusters
    return Array.from(active).map(clusterIdx => {
      const memberIndices = Array.from(clusters[clusterIdx]);
      const members = memberIndices.map(idx => ({
        agentId: responses[idx].agentId,
        response: responses[idx],
        similarity: 1 // Will be calculated relative to centroid
      }));

      // Calculate centroid
      const centroid = this.calculateCentroid(memberIndices.map(i => embeddings[i]));

      // Update similarities to centroid
      for (let i = 0; i < members.length; i++) {
        members[i].similarity = this.cosineSimilarity(centroid, embeddings[memberIndices[i]]);
      }

      // Calculate average similarity
      const avgSim = members.length > 1
        ? this.averageClusterSimilarity(memberIndices, similarityMatrix)
        : 1;

      return {
        id: `cluster-${clusterIdx}`,
        centroid,
        members,
        averageSimilarity: avgSim
      };
    });
  }

  private dbscanClustering(
    responses: AgentResponse[],
    embeddings: number[][],
    similarityMatrix: number[][],
    threshold: number
  ): ResponseCluster[] {
    const n = responses.length;
    const visited = new Set<number>();
    const clusters: Set<number>[] = [];
    const noise = new Set<number>();
    const minPts = 1; // Minimum points to form a cluster

    for (let i = 0; i < n; i++) {
      if (visited.has(i)) continue;
      visited.add(i);

      // Find neighbors
      const neighbors = this.getNeighbors(i, similarityMatrix, threshold);

      if (neighbors.length < minPts) {
        noise.add(i);
      } else {
        // Start new cluster
        const cluster = new Set<number>([i]);
        const queue = [...neighbors];

        while (queue.length > 0) {
          const j = queue.shift()!;
          if (!visited.has(j)) {
            visited.add(j);
            const jNeighbors = this.getNeighbors(j, similarityMatrix, threshold);
            if (jNeighbors.length >= minPts) {
              queue.push(...jNeighbors.filter(n => !visited.has(n)));
            }
          }
          cluster.add(j);
          noise.delete(j);
        }

        clusters.push(cluster);
      }
    }

    // Add noise points as singleton clusters
    for (const idx of noise) {
      clusters.push(new Set([idx]));
    }

    // Build result clusters
    return clusters.map((cluster, clusterIdx) => {
      const memberIndices = Array.from(cluster);
      const centroid = this.calculateCentroid(memberIndices.map(i => embeddings[i]));

      const members = memberIndices.map(idx => ({
        agentId: responses[idx].agentId,
        response: responses[idx],
        similarity: this.cosineSimilarity(centroid, embeddings[idx])
      }));

      const avgSim = memberIndices.length > 1
        ? this.averageClusterSimilarity(memberIndices, similarityMatrix)
        : 1;

      return {
        id: `cluster-${clusterIdx}`,
        centroid,
        members,
        averageSimilarity: avgSim
      };
    });
  }

  private kmeansClustering(
    responses: AgentResponse[],
    embeddings: number[][],
    threshold: number
  ): ResponseCluster[] {
    const n = responses.length;
    if (n <= 1) {
      return responses.length === 0 ? [] : [{
        id: 'cluster-0',
        centroid: embeddings[0] || [],
        members: [{ agentId: responses[0].agentId, response: responses[0], similarity: 1 }],
        averageSimilarity: 1
      }];
    }

    // Determine k based on threshold
    const estimatedK = Math.max(1, Math.min(n, Math.ceil(n * (1 - threshold))));
    const k = estimatedK;
    const maxIterations = 100;

    // Initialize centroids randomly
    const centroidIndices = this.selectRandomCentroids(n, k);
    const centroids = centroidIndices.map(i => [...embeddings[i]]);

    // Run k-means
    let assignments = new Array(n).fill(0);

    for (let iter = 0; iter < maxIterations; iter++) {
      // Assign points to nearest centroid
      const newAssignments = embeddings.map(emb => {
        let bestCluster = 0;
        let bestSim = -1;
        for (let c = 0; c < k; c++) {
          const sim = this.cosineSimilarity(emb, centroids[c]);
          if (sim > bestSim) {
            bestSim = sim;
            bestCluster = c;
          }
        }
        return bestCluster;
      });

      // Check for convergence
      const converged = newAssignments.every((a, i) => a === assignments[i]);
      assignments = newAssignments;

      if (converged) break;

      // Update centroids
      for (let c = 0; c < k; c++) {
        const clusterEmbeddings = embeddings.filter((_, i) => assignments[i] === c);
        if (clusterEmbeddings.length > 0) {
          centroids[c] = this.calculateCentroid(clusterEmbeddings);
        }
      }
    }

    // Build result clusters
    const clusterMap = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const cluster = assignments[i];
      if (!clusterMap.has(cluster)) {
        clusterMap.set(cluster, []);
      }
      clusterMap.get(cluster)!.push(i);
    }

    return Array.from(clusterMap.entries()).map(([clusterId, memberIndices]) => {
      const centroid = centroids[clusterId];
      const members = memberIndices.map(idx => ({
        agentId: responses[idx].agentId,
        response: responses[idx],
        similarity: this.cosineSimilarity(centroid, embeddings[idx])
      }));

      const avgSim = members.reduce((sum, m) => sum + m.similarity, 0) / members.length;

      return {
        id: `cluster-${clusterId}`,
        centroid,
        members,
        averageSimilarity: avgSim
      };
    });
  }

  // ============ Helper Methods ============

  private getNeighbors(
    idx: number,
    similarityMatrix: number[][],
    threshold: number
  ): number[] {
    const neighbors: number[] = [];
    for (let j = 0; j < similarityMatrix.length; j++) {
      if (j !== idx && similarityMatrix[idx][j] >= threshold) {
        neighbors.push(j);
      }
    }
    return neighbors;
  }

  private clusterSimilarity(
    cluster1: Set<number>,
    cluster2: Set<number>,
    similarityMatrix: number[][]
  ): number {
    // Average linkage
    let totalSim = 0;
    let count = 0;

    for (const i of cluster1) {
      for (const j of cluster2) {
        totalSim += similarityMatrix[i][j];
        count++;
      }
    }

    return count > 0 ? totalSim / count : 0;
  }

  private averageClusterSimilarity(
    indices: number[],
    similarityMatrix: number[][]
  ): number {
    if (indices.length <= 1) return 1;

    let totalSim = 0;
    let count = 0;

    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        totalSim += similarityMatrix[indices[i]][indices[j]];
        count++;
      }
    }

    return count > 0 ? totalSim / count : 0;
  }

  private calculateCentroid(embeddings: number[][]): number[] {
    if (embeddings.length === 0) return [];
    if (embeddings.length === 1) return [...embeddings[0]];

    const dim = embeddings[0].length;
    const centroid = new Array(dim).fill(0);

    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) {
        centroid[i] += emb[i];
      }
    }

    for (let i = 0; i < dim; i++) {
      centroid[i] /= embeddings.length;
    }

    // L2 normalize
    const norm = Math.sqrt(centroid.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        centroid[i] /= norm;
      }
    }

    return centroid;
  }

  private selectRandomCentroids(n: number, k: number): number[] {
    const indices: number[] = [];
    const available = Array.from({ length: n }, (_, i) => i);

    for (let i = 0; i < k && available.length > 0; i++) {
      const randomIdx = Math.floor(Math.random() * available.length);
      indices.push(available[randomIdx]);
      available.splice(randomIdx, 1);
    }

    return indices;
  }

  // ============ Cache Management ============

  private getCacheKey(text: string): string {
    // Simple hash for cache key
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `emb-${hash}`;
  }

  private getFromCache(text: string): number[] | null {
    const key = this.getCacheKey(text);
    const entry = this.cache.get(key);

    if (!entry) return null;

    // Check expiry
    if (Date.now() - entry.timestamp > this.cacheExpiryMs) {
      this.cache.delete(key);
      return null;
    }

    return entry.embedding;
  }

  private addToCache(text: string, embedding: number[]): void {
    // Evict if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const key = this.getCacheKey(text);
    this.cache.set(key, {
      text,
      embedding,
      timestamp: Date.now()
    });
  }

  clearCache(): void {
    this.cache.clear();
    this.vocabulary.clear();
    this.documentFrequency.clear();
    this.vocabularyAccessOrder = [];
    this.documentCount = 0;
  }
}

// Singleton getter
export function getEmbeddingService(): EmbeddingService {
  return EmbeddingService.getInstance();
}
