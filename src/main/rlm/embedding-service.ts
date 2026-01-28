/**
 * Embedding Service
 * Generates embeddings for semantic search using multiple providers
 *
 * Provider Priority:
 * 1. Ollama (local, if available)
 * 2. OpenAI (cloud, if API key configured)
 * 3. Local fallback (simple TF-IDF based)
 */

import { EventEmitter } from 'events';

export interface EmbeddingConfig {
  provider: 'ollama' | 'openai' | 'voyage' | 'local' | 'auto';
  model?: string;
  dimensions?: number;
  batchSize?: number;
  ollamaHost?: string;
  openaiApiKey?: string;
  voyageApiKey?: string;
  cacheEnabled?: boolean;
  maxCacheSize?: number;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokens: number;
  cached: boolean;
  provider: string;
}

interface CacheEntry {
  embedding: number[];
  model: string;
  timestamp: number;
}

const DEFAULT_CONFIG: EmbeddingConfig = {
  provider: 'auto',
  model: 'nomic-embed-text',
  dimensions: 384,
  batchSize: 32,
  ollamaHost: 'http://localhost:11434',
  cacheEnabled: true,
  maxCacheSize: 10000,
};

export class EmbeddingService extends EventEmitter {
  private static instance: EmbeddingService;
  private config: EmbeddingConfig;
  private cache = new Map<string, CacheEntry>();
  private ollamaAvailable: boolean | null = null;
  private openaiAvailable: boolean | null = null;
  private voyageAvailable: boolean | null = null;

  private constructor(config: Partial<EmbeddingConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static getInstance(config?: Partial<EmbeddingConfig>): EmbeddingService {
    if (!this.instance) {
      this.instance = new EmbeddingService(config);
    }
    return this.instance;
  }

  /**
   * Configure the embedding service
   */
  configure(config: Partial<EmbeddingConfig>): void {
    this.config = { ...this.config, ...config };
    // Reset availability checks when config changes
    if (config.ollamaHost) this.ollamaAvailable = null;
    if (config.openaiApiKey) this.openaiAvailable = null;
    if (config.voyageApiKey) this.voyageAvailable = null;
  }

  getConfig(): EmbeddingConfig {
    return { ...this.config };
  }

  /**
   * Generate embedding for text
   */
  async embed(text: string): Promise<EmbeddingResult> {
    // Check cache first
    if (this.config.cacheEnabled) {
      const cacheKey = this.getCacheKey(text);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return {
          embedding: cached.embedding,
          model: cached.model,
          tokens: 0,
          cached: true,
          provider: 'cache',
        };
      }
    }

    let result: EmbeddingResult;

    if (this.config.provider === 'auto') {
      // Try providers in order of preference
      result = await this.embedWithAutoProvider(text);
    } else {
      switch (this.config.provider) {
        case 'ollama':
          result = await this.embedWithOllama(text);
          break;
        case 'openai':
          result = await this.embedWithOpenAI(text);
          break;
        case 'voyage':
          result = await this.embedWithVoyage(text);
          break;
        default:
          result = await this.embedWithLocal(text);
      }
    }

    // Cache the result
    if (this.config.cacheEnabled && !result.cached) {
      this.addToCache(text, result);
    }

    return result;
  }

  /**
   * Generate embeddings for multiple texts (batch)
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    const uncached: { index: number; text: string }[] = [];

    // Check cache for each text
    for (let i = 0; i < texts.length; i++) {
      if (this.config.cacheEnabled) {
        const cacheKey = this.getCacheKey(texts[i]);
        const cached = this.cache.get(cacheKey);
        if (cached) {
          results[i] = {
            embedding: cached.embedding,
            model: cached.model,
            tokens: 0,
            cached: true,
            provider: 'cache',
          };
          continue;
        }
      }
      uncached.push({ index: i, text: texts[i] });
    }

    // Process uncached texts in batches
    const batchSize = this.config.batchSize || 32;
    for (let i = 0; i < uncached.length; i += batchSize) {
      const batch = uncached.slice(i, i + batchSize);
      // TODO: Use batchTexts when provider supports batch embedding
      // const batchTexts = batch.map(b => b.text);

      // For now, process individually (can be optimized for providers that support batching)
      for (const item of batch) {
        const result = await this.embed(item.text);
        results[item.index] = result;
      }
    }

    return results;
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (normA * normB);
  }

  /**
   * Find most similar embeddings
   */
  findSimilar(
    queryEmbedding: number[],
    candidates: { id: string; embedding: number[] }[],
    topK = 10,
    minSimilarity = 0.5
  ): { id: string; similarity: number }[] {
    const results = candidates
      .map(candidate => ({
        id: candidate.id,
        similarity: this.cosineSimilarity(queryEmbedding, candidate.embedding),
      }))
      .filter(r => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    return results;
  }

  // ============================================
  // Provider Implementations
  // ============================================

  private async embedWithAutoProvider(text: string): Promise<EmbeddingResult> {
    // Try Ollama first
    if (this.ollamaAvailable !== false) {
      try {
        const result = await this.embedWithOllama(text);
        this.ollamaAvailable = true;
        return result;
      } catch (error) {
        this.ollamaAvailable = false;
        this.emit('provider:unavailable', { provider: 'ollama', error });
      }
    }

    // Try OpenAI if configured
    if (this.config.openaiApiKey && this.openaiAvailable !== false) {
      try {
        const result = await this.embedWithOpenAI(text);
        this.openaiAvailable = true;
        return result;
      } catch (error) {
        this.openaiAvailable = false;
        this.emit('provider:unavailable', { provider: 'openai', error });
      }
    }

    // Try Voyage if configured (good for code embeddings)
    if (this.config.voyageApiKey && this.voyageAvailable !== false) {
      try {
        const result = await this.embedWithVoyage(text);
        this.voyageAvailable = true;
        return result;
      } catch (error) {
        this.voyageAvailable = false;
        this.emit('provider:unavailable', { provider: 'voyage', error });
      }
    }

    // Fall back to local
    return this.embedWithLocal(text);
  }

  private async embedWithOllama(text: string): Promise<EmbeddingResult> {
    const model = this.config.model || 'nomic-embed-text';
    const host = this.config.ollamaHost || 'http://localhost:11434';

    try {
      const response = await fetch(`${host}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
      });

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { embedding?: number[] };

      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Invalid Ollama response: missing embedding array');
      }

      return {
        embedding: data.embedding,
        model,
        tokens: Math.ceil(text.length / 4), // Rough estimate
        cached: false,
        provider: 'ollama',
      };
    } catch (error) {
      this.emit('error', { provider: 'ollama', error });
      throw error;
    }
  }

  private async embedWithOpenAI(text: string): Promise<EmbeddingResult> {
    if (!this.config.openaiApiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const model = this.config.model === 'nomic-embed-text'
      ? 'text-embedding-ada-002'
      : this.config.model || 'text-embedding-ada-002';

    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.openaiApiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as {
        data: { embedding: number[] }[];
        usage?: { total_tokens: number };
      };

      return {
        embedding: data.data[0].embedding,
        model,
        tokens: data.usage?.total_tokens || Math.ceil(text.length / 4),
        cached: false,
        provider: 'openai',
      };
    } catch (error) {
      this.emit('error', { provider: 'openai', error });
      throw error;
    }
  }

  /**
   * Voyage AI embeddings - specialized for code understanding
   * Uses the voyage-code-2 model which is optimized for code search
   */
  private async embedWithVoyage(text: string): Promise<EmbeddingResult> {
    if (!this.config.voyageApiKey) {
      throw new Error('Voyage API key not configured');
    }

    // Use voyage-code-2 for code, or allow custom model
    const model = this.config.model === 'nomic-embed-text' || !this.config.model
      ? 'voyage-code-2'
      : this.config.model;

    try {
      const response = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.voyageApiKey}`,
        },
        body: JSON.stringify({
          model,
          input: text,
          input_type: 'document', // Use 'query' for search queries
        }),
      });

      if (!response.ok) {
        throw new Error(`Voyage error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as {
        data: { embedding: number[] }[];
        usage?: { total_tokens: number };
      };

      if (!data.data || !data.data[0] || !data.data[0].embedding) {
        throw new Error('Invalid Voyage response: missing embedding array');
      }

      return {
        embedding: data.data[0].embedding,
        model,
        tokens: data.usage?.total_tokens || Math.ceil(text.length / 4),
        cached: false,
        provider: 'voyage',
      };
    } catch (error) {
      this.emit('error', { provider: 'voyage', error });
      throw error;
    }
  }

  /**
   * Local TF-IDF based embedding fallback
   * This is a simple implementation that doesn't require external services
   */
  private async embedWithLocal(text: string): Promise<EmbeddingResult> {
    const dimensions = this.config.dimensions || 384;
    const embedding = this.generateLocalEmbedding(text, dimensions);

    return {
      embedding,
      model: 'local-tfidf',
      tokens: Math.ceil(text.length / 4),
      cached: false,
      provider: 'local',
    };
  }

  /**
   * Generate a simple TF-IDF inspired embedding
   * Uses character n-grams and hash projection for consistent dimensions
   */
  private generateLocalEmbedding(text: string, dimensions: number): number[] {
    const embedding = new Array(dimensions).fill(0);

    // Normalize text
    const normalizedText = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const words = normalizedText.split(/\s+/).filter(w => w.length > 2);

    // Generate features from words and n-grams
    const features: string[] = [];

    // Word unigrams
    features.push(...words);

    // Word bigrams
    for (let i = 0; i < words.length - 1; i++) {
      features.push(`${words[i]}_${words[i + 1]}`);
    }

    // Character trigrams
    for (const word of words.slice(0, 50)) {
      for (let i = 0; i < word.length - 2; i++) {
        features.push(word.substring(i, i + 3));
      }
    }

    // Hash features into embedding dimensions
    for (const feature of features) {
      const hash = this.simpleHash(feature);
      const idx = Math.abs(hash) % dimensions;
      const sign = hash > 0 ? 1 : -1;
      embedding[idx] += sign * (1 / Math.sqrt(features.length));
    }

    // L2 normalize
    const norm = Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0));
    if (norm > 0) {
      for (let i = 0; i < dimensions; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  /**
   * Simple string hash function
   */
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash;
  }

  // ============================================
  // Cache Management
  // ============================================

  private getCacheKey(text: string): string {
    const hash = this.simpleHash(text);
    const prefix = this.config.provider === 'auto' ? 'auto' : this.config.provider;
    return `${prefix}:${this.config.model || 'default'}:${hash}`;
  }

  private addToCache(text: string, result: EmbeddingResult): void {
    const cacheKey = this.getCacheKey(text);

    // Enforce max cache size with LRU-like eviction
    if (this.cache.size >= (this.config.maxCacheSize || 10000)) {
      // Remove oldest entries (first 10%)
      const toRemove = Math.floor(this.cache.size * 0.1);
      const keys = Array.from(this.cache.keys()).slice(0, toRemove);
      for (const key of keys) {
        this.cache.delete(key);
      }
    }

    this.cache.set(cacheKey, {
      embedding: result.embedding,
      model: result.model,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear the embedding cache
   */
  clearCache(): void {
    this.cache.clear();
    this.emit('cache:cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.config.maxCacheSize || 10000,
    };
  }

  // ============================================
  // Provider Health Checks
  // ============================================

  /**
   * Check if Ollama is available
   */
  async checkOllamaAvailability(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.ollamaHost}/api/tags`, {
        method: 'GET',
      });
      this.ollamaAvailable = response.ok;
      return this.ollamaAvailable;
    } catch {
      this.ollamaAvailable = false;
      return false;
    }
  }

  /**
   * Check if OpenAI is available (requires API key)
   */
  async checkOpenAIAvailability(): Promise<boolean> {
    if (!this.config.openaiApiKey) {
      this.openaiAvailable = false;
      return false;
    }

    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config.openaiApiKey}`,
        },
      });
      this.openaiAvailable = response.ok;
      return this.openaiAvailable;
    } catch {
      this.openaiAvailable = false;
      return false;
    }
  }

  /**
   * Check if Voyage AI is available (requires API key)
   */
  async checkVoyageAvailability(): Promise<boolean> {
    if (!this.config.voyageApiKey) {
      this.voyageAvailable = false;
      return false;
    }

    try {
      // Voyage doesn't have a simple health endpoint, so we try a minimal embedding
      const response = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.voyageApiKey}`,
        },
        body: JSON.stringify({
          model: 'voyage-code-2',
          input: 'test',
          input_type: 'document',
        }),
      });
      this.voyageAvailable = response.ok;
      return this.voyageAvailable;
    } catch {
      this.voyageAvailable = false;
      return false;
    }
  }

  /**
   * Get current provider status
   */
  getProviderStatus(): {
    ollama: boolean | null;
    openai: boolean | null;
    voyage: boolean | null;
    local: boolean;
  } {
    return {
      ollama: this.ollamaAvailable,
      openai: this.openaiAvailable,
      voyage: this.voyageAvailable,
      local: true, // Always available
    };
  }
}

// Export singleton getter
export function getEmbeddingService(config?: Partial<EmbeddingConfig>): EmbeddingService {
  return EmbeddingService.getInstance(config);
}
