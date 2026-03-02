/**
 * Verification Cache - Persists verification results for reuse
 *
 * This service caches multi-agent verification results to avoid
 * redundant expensive verifications. Results are keyed by prompt hash
 * and support TTL-based expiration.
 */

import ElectronStore from 'electron-store';
import * as crypto from 'crypto';
import { getLogger } from '../logging/logger';
import type { VerificationResult } from '../../shared/types/verification.types';

/**
 * Cached verification result with TTL metadata
 */
export interface CachedVerification {
  id: string;
  prompt: string;
  promptHash: string;
  result: VerificationResult;
  timestamp: number;
  expiresAt: number;
}

/**
 * Configuration for the cache service
 */
export interface VerificationCacheConfig {
  defaultTTL?: number; // Default TTL in milliseconds (default: 1 hour)
  maxCacheSize?: number; // Max number of cached results (default: 100)
  autoPrune?: boolean; // Auto-prune expired entries on get (default: true)
  pruneInterval?: number; // Auto-prune interval in ms (default: 5 minutes)
}

const DEFAULT_CONFIG: Required<VerificationCacheConfig> = {
  defaultTTL: 60 * 60 * 1000, // 1 hour
  maxCacheSize: 100,
  autoPrune: true,
  pruneInterval: 5 * 60 * 1000, // 5 minutes
};

/**
 * Store schema for type safety
 */
interface CacheStoreSchema {
  verifications: Record<string, CachedVerification>;
  metadata: {
    totalCached: number;
    totalHits: number;
    totalMisses: number;
    lastPruned: number;
  };
}

// Type for the internal store with the methods we need (ESM workaround)
interface Store<T> {
  store: T;
  path: string;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  set(object: Partial<T>): void;
  clear(): void;
}

const logger = getLogger('VerificationCache');

export class VerificationCache {
  private static instance: VerificationCache;
  private config: Required<VerificationCacheConfig>;
  private store: Store<CacheStoreSchema>;
  private pruneTimer?: NodeJS.Timeout;

  private constructor(config: VerificationCacheConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize electron-store with schema (cast to work around ESM type resolution)
    this.store = new ElectronStore<CacheStoreSchema>({
      name: 'verification-cache',
      defaults: {
        verifications: {},
        metadata: {
          totalCached: 0,
          totalHits: 0,
          totalMisses: 0,
          lastPruned: Date.now(),
        },
      },
    }) as unknown as Store<CacheStoreSchema>;

    // Start auto-prune if enabled
    if (this.config.autoPrune) {
      this.startAutoPrune();
    }
  }

  static getInstance(config?: VerificationCacheConfig): VerificationCache {
    if (!this.instance) {
      this.instance = new VerificationCache(config);
    }
    return this.instance;
  }

  /**
   * Hash a prompt to generate a cache key
   */
  hashPrompt(prompt: string): string {
    return crypto.createHash('sha256').update(prompt.trim()).digest('hex');
  }

  /**
   * Get a cached verification result if it exists and hasn't expired
   */
  async getCached(promptHash: string): Promise<CachedVerification | null> {
    const verifications = this.store.get('verifications');
    const cached = verifications[promptHash];

    if (!cached) {
      this.incrementMisses();
      return null;
    }

    // Check if expired
    const now = Date.now();
    if (now > cached.expiresAt) {
      // Expired - remove it
      await this.invalidate(promptHash);
      this.incrementMisses();
      return null;
    }

    // Cache hit
    this.incrementHits();
    logger.info('Cache hit', { promptHash: promptHash.slice(0, 8), ageSeconds: Math.round((now - cached.timestamp) / 1000), expiresInSeconds: Math.round((cached.expiresAt - now) / 1000) });

    return cached;
  }

  /**
   * Cache a verification result
   */
  async cache(result: VerificationResult, ttlMs?: number): Promise<void> {
    const prompt = result.request.prompt;
    const promptHash = this.hashPrompt(prompt);
    const now = Date.now();
    const ttl = ttlMs ?? this.config.defaultTTL;

    const cached: CachedVerification = {
      id: result.id,
      prompt,
      promptHash,
      result,
      timestamp: now,
      expiresAt: now + ttl,
    };

    // Get current verifications
    const verifications = this.store.get('verifications');

    // Check if we need to evict old entries (LRU-style)
    const entries = Object.entries(verifications) as [string, CachedVerification][];
    if (entries.length >= this.config.maxCacheSize) {
      // Sort by timestamp and remove oldest
      const sorted = entries.sort(([, a], [, b]) => a.timestamp - b.timestamp);
      const toRemove = sorted.slice(0, entries.length - this.config.maxCacheSize + 1);
      for (const [hash] of toRemove) {
        delete verifications[hash];
      }
      logger.info('Evicted old cache entries', { evictedCount: toRemove.length, maxCacheSize: this.config.maxCacheSize });
    }

    // Add new entry
    verifications[promptHash] = cached;

    // Save to store
    this.store.set('verifications', verifications);

    // Update metadata
    const metadata = this.store.get('metadata');
    this.store.set('metadata', {
      ...metadata,
      totalCached: metadata.totalCached + 1,
    });

    logger.info('Cached verification result', { resultId: result.id, promptHash: promptHash.slice(0, 8), ttlSeconds: Math.round(ttl / 1000), agentCount: result.responses.length, totalTokens: result.totalTokens });
  }

  /**
   * Invalidate (remove) a cached result
   */
  async invalidate(promptHash: string): Promise<void> {
    const verifications = this.store.get('verifications');

    if (verifications[promptHash]) {
      delete verifications[promptHash];
      this.store.set('verifications', verifications);
      logger.info('Invalidated cache entry', { promptHash: promptHash.slice(0, 8) });
    }
  }

  /**
   * Prune all expired entries
   */
  async pruneExpired(): Promise<number> {
    const verifications = this.store.get('verifications');
    const now = Date.now();
    let pruned = 0;

    for (const [hash, cached] of Object.entries(verifications) as [string, CachedVerification][]) {
      if (now > cached.expiresAt) {
        delete verifications[hash];
        pruned++;
      }
    }

    if (pruned > 0) {
      this.store.set('verifications', verifications);
      const metadata = this.store.get('metadata');
      this.store.set('metadata', {
        ...metadata,
        lastPruned: now,
      });
      logger.info('Pruned expired cache entries', { prunedCount: pruned });
    }

    return pruned;
  }

  /**
   * Clear all cached verifications
   */
  async clear(): Promise<void> {
    this.store.set('verifications', {});
    logger.info('Cleared all cached verifications');
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    cached: number;
    totalHits: number;
    totalMisses: number;
    hitRate: number;
    lastPruned: number;
  } {
    const verifications = this.store.get('verifications');
    const metadata = this.store.get('metadata');

    const total = metadata.totalHits + metadata.totalMisses;
    const hitRate = total > 0 ? metadata.totalHits / total : 0;

    return {
      cached: Object.keys(verifications).length,
      totalHits: metadata.totalHits,
      totalMisses: metadata.totalMisses,
      hitRate,
      lastPruned: metadata.lastPruned,
    };
  }

  /**
   * Stop auto-pruning
   */
  dispose(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }

  // ============================================
  // Private Methods
  // ============================================

  private startAutoPrune(): void {
    this.pruneTimer = setInterval(
      () => {
        this.pruneExpired().catch((err) => {
          logger.error('Auto-prune failed', err instanceof Error ? err : undefined);
        });
      },
      this.config.pruneInterval
    );

    // Don't keep process alive
    this.pruneTimer.unref();
  }

  private incrementHits(): void {
    const metadata = this.store.get('metadata');
    this.store.set('metadata', {
      ...metadata,
      totalHits: metadata.totalHits + 1,
    });
  }

  private incrementMisses(): void {
    const metadata = this.store.get('metadata');
    this.store.set('metadata', {
      ...metadata,
      totalMisses: metadata.totalMisses + 1,
    });
  }
}

/**
 * Get the singleton instance
 */
export function getVerificationCache(config?: VerificationCacheConfig): VerificationCache {
  return VerificationCache.getInstance(config);
}
