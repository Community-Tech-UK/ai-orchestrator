/**
 * Just-in-Time Context Loader
 *
 * Implements on-demand context loading that mirrors human cognition:
 * - Maintains lightweight identifiers (file paths, queries, URLs)
 * - Loads full content only when needed via tools
 * - Tracks loaded content to avoid duplicate fetches
 * - Provides intelligent prefetching based on access patterns
 *
 * Based on Anthropic's context engineering principles:
 * https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';

const logger = getLogger('JITLoader');

/**
 * Types of context resources that can be loaded JIT
 */
export type ResourceType = 'file' | 'url' | 'query' | 'memory' | 'tool_output';

/**
 * Resource identifier - lightweight reference to loadable content
 */
export interface ResourceIdentifier {
  id: string;
  type: ResourceType;
  path: string; // File path, URL, or query string
  metadata?: {
    language?: string;
    mimeType?: string;
    estimatedTokens?: number;
    lastModified?: number;
    checksum?: string;
  };
}

/**
 * Loaded resource with full content
 */
export interface LoadedResource {
  identifier: ResourceIdentifier;
  content: string;
  tokens: number;
  loadedAt: number;
  loadDurationMs: number;
  source: 'cache' | 'disk' | 'network' | 'memory';
}

/**
 * Access record for pattern tracking
 */
export interface AccessRecord {
  resourceId: string;
  timestamp: number;
  accessType: 'prefetch' | 'demand' | 'revalidate';
  hit: boolean; // Was it in cache?
}

/**
 * JIT Loader configuration
 */
export interface JITLoaderConfig {
  /** Maximum number of resources to keep in memory */
  maxCachedResources: number;
  /** Maximum tokens to keep in cache */
  maxCachedTokens: number;
  /** Cache TTL in milliseconds */
  cacheTTLMs: number;
  /** Enable prefetching based on access patterns */
  enablePrefetching: boolean;
  /** Number of access records to keep for pattern analysis */
  maxAccessRecords: number;
  /** Minimum access frequency for prefetch consideration */
  prefetchThreshold: number;
  /** Maximum concurrent loads */
  maxConcurrentLoads: number;
  /** Load timeout in milliseconds */
  loadTimeoutMs: number;
}

/**
 * Default configuration
 */
export const DEFAULT_JIT_LOADER_CONFIG: JITLoaderConfig = {
  maxCachedResources: 50,
  maxCachedTokens: 100000,
  cacheTTLMs: 300000, // 5 minutes
  enablePrefetching: true,
  maxAccessRecords: 500,
  prefetchThreshold: 3,
  maxConcurrentLoads: 5,
  loadTimeoutMs: 10000,
};

/**
 * Cache entry with metadata
 */
interface CacheEntry {
  resource: LoadedResource;
  accessCount: number;
  lastAccessed: number;
  expiresAt: number;
}

/**
 * Pending load tracker
 */
interface PendingLoad {
  promise: Promise<LoadedResource | null>;
  startedAt: number;
}

/**
 * JIT Context Loader - manages on-demand loading of context resources
 */
export class JITContextLoader extends EventEmitter {
  private static instance: JITContextLoader | null = null;

  private config: JITLoaderConfig;
  private identifiers: Map<string, ResourceIdentifier> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private pendingLoads: Map<string, PendingLoad> = new Map();
  private accessHistory: AccessRecord[] = [];
  private totalCachedTokens: number = 0;

  // Custom loaders for different resource types
  private loaders: Map<ResourceType, ResourceLoader> = new Map();

  private constructor() {
    super();
    this.config = { ...DEFAULT_JIT_LOADER_CONFIG };

    // Start cache cleanup interval
    this.startCacheCleanup();
  }

  static getInstance(): JITContextLoader {
    if (!JITContextLoader.instance) {
      JITContextLoader.instance = new JITContextLoader();
    }
    return JITContextLoader.instance;
  }

  /**
   * Configure the loader
   */
  configure(config: Partial<JITLoaderConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configured', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): JITLoaderConfig {
    return { ...this.config };
  }

  /**
   * Register a custom loader for a resource type
   */
  registerLoader(type: ResourceType, loader: ResourceLoader): void {
    this.loaders.set(type, loader);
    this.emit('loader:registered', { type });
  }

  /**
   * Register a resource identifier (lightweight reference)
   */
  register(identifier: ResourceIdentifier): void {
    this.identifiers.set(identifier.id, identifier);
    this.emit('resource:registered', { id: identifier.id, type: identifier.type });
  }

  /**
   * Register multiple identifiers at once
   */
  registerBatch(identifiers: ResourceIdentifier[]): void {
    for (const id of identifiers) {
      this.identifiers.set(id.id, id);
    }
    this.emit('resources:registered', { count: identifiers.length });
  }

  /**
   * Get a registered identifier
   */
  getIdentifier(id: string): ResourceIdentifier | undefined {
    return this.identifiers.get(id);
  }

  /**
   * List all registered identifiers
   */
  listIdentifiers(type?: ResourceType): ResourceIdentifier[] {
    const all = Array.from(this.identifiers.values());
    return type ? all.filter(i => i.type === type) : all;
  }

  /**
   * Check if a resource is cached
   */
  isCached(id: string): boolean {
    const entry = this.cache.get(id);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.evictFromCache(id);
      return false;
    }
    return true;
  }

  /**
   * Load a resource on demand
   */
  async load(id: string, force: boolean = false): Promise<LoadedResource | null> {
    const identifier = this.identifiers.get(id);
    if (!identifier) {
      this.emit('load:error', { id, error: 'Identifier not found' });
      return null;
    }

    // Check cache first (unless forced reload)
    if (!force) {
      const cached = this.getFromCache(id);
      if (cached) {
        this.recordAccess(id, 'demand', true);
        this.emit('load:cache-hit', { id });
        return cached;
      }
    }

    // Check if already loading
    const pending = this.pendingLoads.get(id);
    if (pending) {
      return pending.promise;
    }

    // Check concurrent load limit
    if (this.pendingLoads.size >= this.config.maxConcurrentLoads) {
      // Wait for one to complete
      await Promise.race(Array.from(this.pendingLoads.values()).map(p => p.promise));
    }

    // Start loading
    const loadPromise = this.executeLoad(identifier);
    this.pendingLoads.set(id, { promise: loadPromise, startedAt: Date.now() });

    try {
      const result = await loadPromise;
      this.pendingLoads.delete(id);

      if (result) {
        this.addToCache(result);
        this.recordAccess(id, 'demand', false);
        this.emit('load:completed', { id, tokens: result.tokens });

        // Trigger prefetch analysis
        if (this.config.enablePrefetching) {
          this.analyzePrefetchOpportunities(id);
        }
      }

      return result;
    } catch (error) {
      this.pendingLoads.delete(id);
      this.emit('load:error', { id, error });
      throw error;
    }
  }

  /**
   * Load multiple resources in parallel
   */
  async loadBatch(ids: string[]): Promise<Map<string, LoadedResource | null>> {
    const results = new Map<string, LoadedResource | null>();

    // Separate cached and uncached
    const toLoad: string[] = [];
    for (const id of ids) {
      const cached = this.getFromCache(id);
      if (cached) {
        results.set(id, cached);
        this.recordAccess(id, 'demand', true);
      } else if (this.identifiers.has(id)) {
        toLoad.push(id);
      } else {
        results.set(id, null);
      }
    }

    // Load uncached in parallel (respecting concurrency limit)
    if (toLoad.length > 0) {
      const loadResults = await Promise.all(
        toLoad.map(id => this.load(id).catch(() => null))
      );
      toLoad.forEach((id, index) => {
        results.set(id, loadResults[index]);
      });
    }

    return results;
  }

  /**
   * Prefetch resources based on access patterns
   */
  async prefetch(ids: string[]): Promise<void> {
    const toPrefetch = ids.filter(id => !this.isCached(id) && this.identifiers.has(id));

    for (const id of toPrefetch) {
      // Don't wait for prefetch, just start it
      this.load(id)
        .then(result => {
          if (result) {
            this.recordAccess(id, 'prefetch', false);
          }
        })
        .catch(() => {
          // Silently ignore prefetch errors
        });
    }

    this.emit('prefetch:started', { count: toPrefetch.length });
  }

  /**
   * Invalidate cached resource
   */
  invalidate(id: string): void {
    this.evictFromCache(id);
    this.emit('cache:invalidated', { id });
  }

  /**
   * Invalidate multiple resources
   */
  invalidateBatch(ids: string[]): void {
    for (const id of ids) {
      this.evictFromCache(id);
    }
    this.emit('cache:invalidated-batch', { count: ids.length });
  }

  /**
   * Invalidate all resources matching a pattern
   */
  invalidateByPattern(pattern: RegExp): number {
    let count = 0;
    for (const [id, entry] of this.cache) {
      if (pattern.test(entry.resource.identifier.path)) {
        this.evictFromCache(id);
        count++;
      }
    }
    this.emit('cache:invalidated-pattern', { pattern: pattern.source, count });
    return count;
  }

  /**
   * Get related resources based on access patterns
   */
  getRelatedResources(id: string, limit: number = 5): string[] {
    // Find resources commonly accessed around the same time
    const targetAccesses = this.accessHistory.filter(a => a.resourceId === id);
    if (targetAccesses.length === 0) return [];

    const coAccessCounts = new Map<string, number>();
    const windowMs = 60000; // 1 minute window

    for (const access of targetAccesses) {
      const nearbyAccesses = this.accessHistory.filter(
        a =>
          a.resourceId !== id &&
          Math.abs(a.timestamp - access.timestamp) < windowMs
      );

      for (const nearby of nearbyAccesses) {
        coAccessCounts.set(
          nearby.resourceId,
          (coAccessCounts.get(nearby.resourceId) || 0) + 1
        );
      }
    }

    // Sort by co-access frequency
    const sorted = Array.from(coAccessCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([resourceId]) => resourceId);

    return sorted;
  }

  /**
   * Get loader statistics
   */
  getStats(): {
    registeredCount: number;
    cachedCount: number;
    cachedTokens: number;
    pendingLoads: number;
    accessHistorySize: number;
    cacheHitRate: number;
    averageLoadTime: number;
  } {
    const hits = this.accessHistory.filter(a => a.hit).length;
    const total = this.accessHistory.length;
    const cacheHitRate = total > 0 ? hits / total : 0;

    // Calculate average load time from recent loads
    const recentLoads = Array.from(this.cache.values())
      .filter(e => e.resource.source !== 'cache')
      .slice(-20);
    const avgLoadTime =
      recentLoads.length > 0
        ? recentLoads.reduce((sum, e) => sum + e.resource.loadDurationMs, 0) / recentLoads.length
        : 0;

    return {
      registeredCount: this.identifiers.size,
      cachedCount: this.cache.size,
      cachedTokens: this.totalCachedTokens,
      pendingLoads: this.pendingLoads.size,
      accessHistorySize: this.accessHistory.length,
      cacheHitRate,
      averageLoadTime: avgLoadTime,
    };
  }

  /**
   * Clear all caches and identifiers
   */
  clear(): void {
    this.identifiers.clear();
    this.cache.clear();
    this.pendingLoads.clear();
    this.accessHistory = [];
    this.totalCachedTokens = 0;
    this.emit('cleared');
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.clear();
    this.loaders.clear();
    this.removeAllListeners();
    JITContextLoader.instance = null;
  }

  // ============================================
  // Private Methods
  // ============================================

  private async executeLoad(identifier: ResourceIdentifier): Promise<LoadedResource | null> {
    const loader = this.loaders.get(identifier.type);
    if (!loader) {
      // Use default loaders
      return this.defaultLoad(identifier);
    }

    const startTime = Date.now();

    try {
      const result = await this.withTimeout(
        loader.load(identifier),
        this.config.loadTimeoutMs
      );

      if (!result) return null;

      return {
        identifier,
        content: result.content,
        tokens: this.estimateTokens(result.content),
        loadedAt: Date.now(),
        loadDurationMs: Date.now() - startTime,
        source: result.source || 'disk',
      };
    } catch (error) {
      logger.error('Failed to load resource', error instanceof Error ? error : undefined, { id: identifier.id });
      return null;
    }
  }

  private async defaultLoad(identifier: ResourceIdentifier): Promise<LoadedResource | null> {
    const startTime = Date.now();

    try {
      let content: string;
      let source: LoadedResource['source'];

      switch (identifier.type) {
        case 'file':
          // Load from filesystem
          const fs = await import('fs/promises');
          content = await fs.readFile(identifier.path, 'utf-8');
          source = 'disk';
          break;

        case 'url':
          // Load from network
          const response = await fetch(identifier.path, {
            signal: AbortSignal.timeout(this.config.loadTimeoutMs),
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          content = await response.text();
          source = 'network';
          break;

        case 'memory':
          // Memory references should be loaded via custom loader
          return null;

        case 'query':
          // Query references should be loaded via custom loader
          return null;

        case 'tool_output':
          // Tool outputs should be loaded via custom loader
          return null;

        default:
          return null;
      }

      return {
        identifier,
        content,
        tokens: this.estimateTokens(content),
        loadedAt: Date.now(),
        loadDurationMs: Date.now() - startTime,
        source,
      };
    } catch (error) {
      logger.error('Default load failed for resource', error instanceof Error ? error : undefined, { id: identifier.id });
      return null;
    }
  }

  private getFromCache(id: string): LoadedResource | null {
    const entry = this.cache.get(id);
    if (!entry) return null;

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.evictFromCache(id);
      return null;
    }

    // Update access info
    entry.accessCount++;
    entry.lastAccessed = Date.now();

    return entry.resource;
  }

  private addToCache(resource: LoadedResource): void {
    // Evict if over limits
    this.enforceResourceLimit();
    this.enforceTokenLimit(resource.tokens);

    const entry: CacheEntry = {
      resource,
      accessCount: 1,
      lastAccessed: Date.now(),
      expiresAt: Date.now() + this.config.cacheTTLMs,
    };

    this.cache.set(resource.identifier.id, entry);
    this.totalCachedTokens += resource.tokens;
  }

  private evictFromCache(id: string): void {
    const entry = this.cache.get(id);
    if (entry) {
      this.totalCachedTokens -= entry.resource.tokens;
      this.cache.delete(id);
    }
  }

  private enforceResourceLimit(): void {
    while (this.cache.size >= this.config.maxCachedResources) {
      // Find LRU entry
      let lruId: string | null = null;
      let lruTime = Infinity;

      for (const [id, entry] of this.cache) {
        if (entry.lastAccessed < lruTime) {
          lruTime = entry.lastAccessed;
          lruId = id;
        }
      }

      if (lruId) {
        this.evictFromCache(lruId);
      } else {
        break;
      }
    }
  }

  private enforceTokenLimit(newTokens: number): void {
    while (this.totalCachedTokens + newTokens > this.config.maxCachedTokens) {
      // Find LRU entry
      let lruId: string | null = null;
      let lruTime = Infinity;

      for (const [id, entry] of this.cache) {
        if (entry.lastAccessed < lruTime) {
          lruTime = entry.lastAccessed;
          lruId = id;
        }
      }

      if (lruId) {
        this.evictFromCache(lruId);
      } else {
        break;
      }
    }
  }

  private recordAccess(resourceId: string, accessType: AccessRecord['accessType'], hit: boolean): void {
    this.accessHistory.push({
      resourceId,
      timestamp: Date.now(),
      accessType,
      hit,
    });

    // Trim history if needed
    if (this.accessHistory.length > this.config.maxAccessRecords) {
      this.accessHistory = this.accessHistory.slice(-this.config.maxAccessRecords);
    }
  }

  private analyzePrefetchOpportunities(loadedId: string): void {
    const related = this.getRelatedResources(loadedId);
    const toPrefetch = related.filter(id => {
      // Count how often this resource is accessed after loadedId
      const accessCount = this.accessHistory.filter(a => a.resourceId === id).length;
      return accessCount >= this.config.prefetchThreshold && !this.isCached(id);
    });

    if (toPrefetch.length > 0) {
      this.prefetch(toPrefetch);
    }
  }

  private startCacheCleanup(): void {
    // Clean expired entries every minute
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.cache) {
        if (now > entry.expiresAt) {
          this.evictFromCache(id);
        }
      }
    }, 60000);

    // Don't block process exit
    if (cleanupInterval.unref) {
      cleanupInterval.unref();
    }
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Load timeout')), timeoutMs)
      ),
    ]);
  }
}

/**
 * Resource loader interface for custom loaders
 */
export interface ResourceLoader {
  load(identifier: ResourceIdentifier): Promise<{
    content: string;
    source?: LoadedResource['source'];
  } | null>;
}

/**
 * File system resource loader with caching
 */
export class FileSystemLoader implements ResourceLoader {
  private checksumCache: Map<string, string> = new Map();

  async load(identifier: ResourceIdentifier): Promise<{
    content: string;
    source: LoadedResource['source'];
  } | null> {
    const fs = await import('fs/promises');
    const crypto = await import('crypto');

    try {
      // Check if file changed (by checksum)
      const content = await fs.readFile(identifier.path, 'utf-8');
      const checksum = crypto.createHash('md5').update(content).digest('hex');

      // If checksum matches cached, it's effectively from cache
      const cachedChecksum = this.checksumCache.get(identifier.path);
      const source: LoadedResource['source'] = cachedChecksum === checksum ? 'cache' : 'disk';

      this.checksumCache.set(identifier.path, checksum);

      return { content, source };
    } catch (error) {
      logger.error('Failed to load file', error instanceof Error ? error : undefined, { path: identifier.path });
      return null;
    }
  }
}

/**
 * Memory store loader for unified memory integration
 */
export class MemoryStoreLoader implements ResourceLoader {
  private memoryGetter: (query: string) => Promise<string | null>;

  constructor(memoryGetter: (query: string) => Promise<string | null>) {
    this.memoryGetter = memoryGetter;
  }

  async load(identifier: ResourceIdentifier): Promise<{
    content: string;
    source: LoadedResource['source'];
  } | null> {
    try {
      const content = await this.memoryGetter(identifier.path);
      if (!content) return null;

      return { content, source: 'memory' };
    } catch (error) {
      logger.error('Failed to load from memory store', error instanceof Error ? error : undefined, { path: identifier.path });
      return null;
    }
  }
}

/**
 * Get JIT loader singleton
 */
export function getJITLoader(): JITContextLoader {
  return JITContextLoader.getInstance();
}

export default JITContextLoader;
