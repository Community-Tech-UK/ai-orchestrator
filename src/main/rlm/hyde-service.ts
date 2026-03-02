/**
 * HyDE Service - Hypothetical Document Embeddings
 *
 * Implementation based on "Precise Zero-Shot Dense Retrieval without Relevance Labels"
 * https://arxiv.org/abs/2212.10496
 *
 * Key Insight: When users ask vague questions, embedding the question directly often fails
 * because the embedding space doesn't align with how documents are written. HyDE generates
 * a hypothetical document that WOULD answer the question, then embeds that document.
 *
 * Example:
 * - Query: "how to handle errors"
 * - Hypothetical Doc: "The error handling pattern uses try-catch blocks with custom error
 *   classes. Errors are caught at the top level using ErrorBoundary components..."
 * - The hypothetical doc's embedding is closer to actual error handling code in the codebase
 *
 * Flow:
 * 1. User enters query → "how do I configure logging?"
 * 2. LLM generates hypothetical answer → "Logging is configured in config/logging.ts..."
 * 3. Embed the hypothetical answer (not the query)
 * 4. Search vector store with hypothetical answer embedding
 * 5. Return actual matching documents
 */

import { EventEmitter } from 'events';
import { LLMService, getLLMService } from './llm-service';
import { EmbeddingService, getEmbeddingService } from './embedding-service';

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

interface CacheEntry {
  embedding: number[];
  hypotheticalDocuments: string[];
  timestamp: number;
}

const DEFAULT_CONFIG: HyDEConfig = {
  enabled: true,
  minQueryLength: 10,
  maxHypotheticalTokens: 300,
  generationTimeout: 15000,
  cacheEnabled: true,
  cacheSize: 500,
  contextHints: 'auto',
  multiHypothetical: false,
  hypotheticalCount: 3
};

// System prompts for different context types
const HYDE_PROMPTS: Record<string, string> = {
  code: `You are a code documentation expert. Given a search query about code, generate a hypothetical code snippet or documentation that would answer the query.

Rules:
- Write actual code or technical documentation, not a meta-description
- Include realistic function/variable names, types, and patterns
- Keep it concise but representative of what real matching code would look like
- Don't explain what you're doing, just write the hypothetical matching content
- Use TypeScript/JavaScript unless the query suggests another language`,

  documentation: `You are a documentation expert. Given a search query, generate a hypothetical documentation section that would answer the query.

Rules:
- Write actual documentation content, not a meta-description
- Include realistic headings, explanations, and examples
- Keep it concise but representative of what real matching docs would look like
- Don't explain what you're doing, just write the hypothetical matching content`,

  mixed: `You are a technical writer. Given a search query, generate a hypothetical document (code, documentation, or config) that would answer the query.

Rules:
- Write actual content, not a meta-description
- If the query is about code, write code with comments
- If the query is about concepts, write documentation
- If the query is about configuration, write config examples
- Keep it concise but representative
- Don't explain what you're doing, just write the hypothetical matching content`
};

import { getLogger } from '../logging/logger';

const logger = getLogger('HyDEService');

export class HyDEService extends EventEmitter {
  private static instance: HyDEService;
  private config: HyDEConfig;
  private llmService: LLMService;
  private embeddingService: EmbeddingService;
  private cache = new Map<string, CacheEntry>();

  private constructor(config: Partial<HyDEConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.llmService = getLLMService();
    this.embeddingService = getEmbeddingService();
  }

  static getInstance(config?: Partial<HyDEConfig>): HyDEService {
    if (!this.instance) {
      this.instance = new HyDEService(config);
    }
    return this.instance;
  }

  /**
   * Configure the HyDE service
   */
  configure(config: Partial<HyDEConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configured', { config: this.config });
  }

  getConfig(): HyDEConfig {
    return { ...this.config };
  }

  /**
   * Generate an embedding for a query using HyDE
   * Returns the hypothetical document embedding (or direct embedding if HyDE disabled)
   */
  async embed(
    query: string,
    options?: {
      contextHints?: 'code' | 'documentation' | 'mixed';
      forceHyDE?: boolean;
    }
  ): Promise<HyDEResult> {
    const startTime = Date.now();

    // Check if we should use HyDE
    const useHyDE = this.shouldUseHyDE(query, options?.forceHyDE);

    if (!useHyDE) {
      // Just use direct embedding
      const directEmbedding = await this.embeddingService.embed(query);
      return {
        embedding: directEmbedding.embedding,
        hypotheticalDocuments: [],
        hydeUsed: false,
        generationTimeMs: Date.now() - startTime,
        cached: false,
        query
      };
    }

    // Check cache
    const cacheKey = this.getCacheKey(query, options?.contextHints);
    if (this.config.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.emit('cache:hit', { query, cacheKey });
        return {
          embedding: cached.embedding,
          hypotheticalDocuments: cached.hypotheticalDocuments,
          hydeUsed: true,
          generationTimeMs: Date.now() - startTime,
          cached: true,
          query
        };
      }
    }

    try {
      // Determine context type
      const contextType =
        options?.contextHints || this.detectContextType(query);

      let embedding: number[];
      let hypotheticalDocuments: string[];

      if (this.config.multiHypothetical) {
        // Generate multiple hypothetical documents and average their embeddings
        const results = await this.generateMultipleHypotheticals(
          query,
          contextType
        );
        hypotheticalDocuments = results.documents;
        embedding = results.averageEmbedding;
      } else {
        // Generate single hypothetical document
        const hypotheticalDoc = await this.generateHypotheticalDocument(
          query,
          contextType
        );
        hypotheticalDocuments = [hypotheticalDoc];

        // Embed the hypothetical document
        const embeddingResult =
          await this.embeddingService.embed(hypotheticalDoc);
        embedding = embeddingResult.embedding;
      }

      const generationTimeMs = Date.now() - startTime;

      // Cache the result
      if (this.config.cacheEnabled) {
        this.addToCache(cacheKey, embedding, hypotheticalDocuments);
      }

      this.emit('generated', {
        query,
        hypotheticalDocuments,
        generationTimeMs
      });

      return {
        embedding,
        hypotheticalDocuments,
        hydeUsed: true,
        generationTimeMs,
        cached: false,
        query
      };
    } catch (error) {
      logger.error('Failed to generate hypothetical document', error instanceof Error ? error : undefined, { query });
      this.emit('error', { query, error });

      // Fall back to direct embedding on error
      const directEmbedding = await this.embeddingService.embed(query);
      return {
        embedding: directEmbedding.embedding,
        hypotheticalDocuments: [],
        hydeUsed: false,
        generationTimeMs: Date.now() - startTime,
        cached: false,
        query
      };
    }
  }

  /**
   * Generate a hypothetical document that would answer the query
   */
  private async generateHypotheticalDocument(
    query: string,
    contextType: 'code' | 'documentation' | 'mixed'
  ): Promise<string> {
    const systemPrompt = HYDE_PROMPTS[contextType];
    const userPrompt = `Search query: "${query}"

Generate a hypothetical document that would perfectly match this query:`;

    // Use the LLMService's internal generate method through completion
    const response = await this.generateWithTimeout(systemPrompt, userPrompt);

    // Clean up the response - remove any meta-commentary
    return this.cleanHypotheticalDoc(response);
  }

  /**
   * Generate multiple hypothetical documents and average their embeddings
   */
  private async generateMultipleHypotheticals(
    query: string,
    contextType: 'code' | 'documentation' | 'mixed'
  ): Promise<{ documents: string[]; averageEmbedding: number[] }> {
    const documents: string[] = [];
    const embeddings: number[][] = [];

    // Generate hypotheticals in parallel
    const promises = Array(this.config.hypotheticalCount)
      .fill(null)
      .map(async () => {
        const doc = await this.generateHypotheticalDocument(query, contextType);
        const embedding = await this.embeddingService.embed(doc);
        return { doc, embedding: embedding.embedding };
      });

    const results = await Promise.all(promises);

    for (const result of results) {
      documents.push(result.doc);
      embeddings.push(result.embedding);
    }

    // Average the embeddings
    const averageEmbedding = this.averageEmbeddings(embeddings);

    return { documents, averageEmbedding };
  }

  /**
   * Average multiple embeddings into a single embedding
   */
  private averageEmbeddings(embeddings: number[][]): number[] {
    if (embeddings.length === 0) {
      throw new Error('Cannot average empty embeddings array');
    }

    const dimensions = embeddings[0].length;
    const averaged: number[] = new Array(dimensions).fill(0);

    for (const embedding of embeddings) {
      for (let i = 0; i < dimensions; i++) {
        averaged[i] += embedding[i];
      }
    }

    // Divide by count and normalize
    const count = embeddings.length;
    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
      averaged[i] /= count;
      norm += averaged[i] * averaged[i];
    }

    // L2 normalize
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dimensions; i++) {
        averaged[i] /= norm;
      }
    }

    return averaged;
  }

  /**
   * Generate completion with timeout
   */
  private async generateWithTimeout(
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('HyDE generation timed out'));
      }, this.config.generationTimeout);

      // Execute async operation
      this.callLLM(systemPrompt, userPrompt)
        .then((response) => {
          clearTimeout(timeoutId);
          resolve(response);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Call the LLM service for completion
   * Uses the LLMService's internal mechanisms
   */
  private async callLLM(
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    // We need to call the LLM through an exposed interface
    // The LLMService has a generateSubQueries method we can piggyback on
    // But for HyDE, we need a more general interface

    // Use fetch to call the appropriate provider directly
    const config = this.llmService.getConfig();

    // Try Anthropic first if configured
    if (config.anthropicApiKey) {
      try {
        return await this.callAnthropic(
          systemPrompt,
          userPrompt,
          config.anthropicApiKey
        );
      } catch (error) {
        logger.warn('Anthropic call failed', { error: String(error) });
      }
    }

    // Try OpenAI
    if (config.openaiApiKey) {
      try {
        return await this.callOpenAI(
          systemPrompt,
          userPrompt,
          config.openaiApiKey
        );
      } catch (error) {
        logger.warn('OpenAI call failed', { error: String(error) });
      }
    }

    // Try Ollama
    try {
      return await this.callOllama(
        systemPrompt,
        userPrompt,
        config.ollamaHost || 'http://localhost:11434'
      );
    } catch (error) {
      logger.warn('Ollama call failed', { error: String(error) });
    }

    // Fall back to simple query expansion
    return this.fallbackHypothetical(userPrompt);
  }

  private async callAnthropic(
    systemPrompt: string,
    userPrompt: string,
    apiKey: string
  ): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307', // Use fast model for HyDE
        max_tokens: this.config.maxHypotheticalTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      content?: { text?: string }[];
    };
    return data.content?.[0]?.text || '';
  }

  private async callOpenAI(
    systemPrompt: string,
    userPrompt: string,
    apiKey: string
  ): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo', // Use fast model for HyDE
        max_tokens: this.config.maxHypotheticalTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content || '';
  }

  private async callOllama(
    systemPrompt: string,
    userPrompt: string,
    host: string
  ): Promise<string> {
    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama2', // Or another fast model
        prompt: `${systemPrompt}\n\nUser: ${userPrompt}\n\nAssistant:`,
        stream: false,
        options: {
          num_predict: this.config.maxHypotheticalTokens
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = (await response.json()) as { response?: string };
    return data.response || '';
  }

  /**
   * Fallback: expand query into a simple hypothetical
   */
  private fallbackHypothetical(query: string): string {
    // Extract key terms and generate a simple template
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);

    // Detect if it's a code query
    const codeKeywords = [
      'function',
      'class',
      'method',
      'variable',
      'import',
      'export',
      'type',
      'interface',
      'error',
      'exception',
      'handler',
      'async',
      'await',
      'promise'
    ];
    const isCodeQuery = terms.some((t) => codeKeywords.includes(t));

    if (isCodeQuery) {
      return `// ${query}
// Implementation for ${terms.slice(0, 3).join(' ')}

export function ${this.camelCase(terms.slice(0, 2).join('-'))}() {
  // ${terms.join(' ')} implementation
  // handles ${terms.slice(-2).join(' and ')}
  return {
    ${terms[0]}: true,
    ${terms[1] || 'result'}: null,
  };
}`;
    }

    // Documentation style
    return `# ${this.titleCase(terms.slice(0, 3).join(' '))}

This document describes ${query}.

## Overview

The ${terms[0]} component handles ${terms.slice(1, 3).join(' and ')}.
${terms.length > 3 ? `It provides functionality for ${terms.slice(3).join(', ')}.` : ''}

## Usage

To use this feature:
1. Configure the ${terms[0]} settings
2. Initialize the ${terms[1] || 'component'}
3. Call the appropriate ${terms[2] || 'methods'}`;
  }

  /**
   * Clean up hypothetical document response
   */
  private cleanHypotheticalDoc(doc: string): string {
    // Remove any meta-commentary the LLM might have added
    const lines = doc.split('\n');
    const cleaned: string[] = [];

    for (const line of lines) {
      // Skip lines that are clearly meta-commentary
      if (
        line.match(/^(here|this|the following|i've|i would|let me)/i) ||
        line.match(/^(note:|disclaimer:|explanation:)/i)
      ) {
        continue;
      }
      cleaned.push(line);
    }

    return cleaned.join('\n').trim() || doc;
  }

  /**
   * Determine if we should use HyDE for this query
   */
  private shouldUseHyDE(query: string, forceHyDE?: boolean): boolean {
    if (forceHyDE) return true;
    if (!this.config.enabled) return false;
    if (query.length < this.config.minQueryLength) return false;

    // Check if query is already very specific (contains file paths, function names, etc.)
    // In these cases, direct embedding might work better
    const specificPatterns = [
      /\b[\w-]+\.(ts|js|tsx|jsx|py|rs|go|java|cpp|c|h)\b/, // File paths
      /\b[A-Z][a-z]+[A-Z][a-z]+\b/, // CamelCase (class/function names)
      /\b[a-z]+_[a-z]+\b/, // snake_case
      /"[^"]{10,}"/ // Quoted strings (likely specific search terms)
    ];

    const isSpecific = specificPatterns.some((p) => p.test(query));

    // For very specific queries, HyDE may not help much
    // But still use it if query is somewhat vague
    if (isSpecific && query.length < 30) {
      return false;
    }

    return true;
  }

  /**
   * Auto-detect the context type from the query
   */
  private detectContextType(query: string): 'code' | 'documentation' | 'mixed' {
    const queryLower = query.toLowerCase();

    // Code indicators
    const codeKeywords = [
      'function',
      'class',
      'method',
      'variable',
      'import',
      'export',
      'type',
      'interface',
      'error',
      'exception',
      'handler',
      'async',
      'await',
      'promise',
      'return',
      'implement',
      'fix',
      'bug',
      'code',
      'typescript',
      'javascript',
      'python',
      'rust',
      'component'
    ];

    // Documentation indicators
    const docKeywords = [
      'explain',
      'describe',
      'what is',
      'how to',
      'why',
      'overview',
      'guide',
      'tutorial',
      'documentation',
      'readme',
      'concept',
      'architecture',
      'design',
      'pattern',
      'best practice'
    ];

    const codeScore = codeKeywords.filter((k) => queryLower.includes(k)).length;
    const docScore = docKeywords.filter((k) => queryLower.includes(k)).length;

    if (codeScore > docScore * 1.5) return 'code';
    if (docScore > codeScore * 1.5) return 'documentation';
    return 'mixed';
  }

  /**
   * Get cache key for a query
   */
  private getCacheKey(query: string, contextHints?: string): string {
    const normalized = query.toLowerCase().trim();
    return `${contextHints || 'auto'}:${normalized}`;
  }

  /**
   * Add result to cache
   */
  private addToCache(
    key: string,
    embedding: number[],
    hypotheticalDocuments: string[]
  ): void {
    // Evict oldest entries if cache is full
    while (this.cache.size >= this.config.cacheSize) {
      const oldestKey = this.findOldestCacheKey();
      if (oldestKey) {
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    this.cache.set(key, {
      embedding,
      hypotheticalDocuments,
      timestamp: Date.now()
    });
  }

  /**
   * Find the oldest cache entry
   */
  private findOldestCacheKey(): string | null {
    let oldest: { key: string; timestamp: number } | null = null;

    for (const [key, entry] of this.cache) {
      if (!oldest || entry.timestamp < oldest.timestamp) {
        oldest = { key, timestamp: entry.timestamp };
      }
    }

    return oldest?.key ?? null;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
    this.emit('cache:cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number; hitRate: number } {
    return {
      size: this.cache.size,
      maxSize: this.config.cacheSize,
      hitRate: 0 // Would need to track hits/misses
    };
  }

  // Utility methods
  private camelCase(str: string): string {
    return str
      .split(/[-_\s]+/)
      .map((word, i) =>
        i === 0
          ? word.toLowerCase()
          : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      )
      .join('');
  }

  private titleCase(str: string): string {
    return str
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }
}

// Export singleton getter
export function getHyDEService(config?: Partial<HyDEConfig>): HyDEService {
  return HyDEService.getInstance(config);
}
