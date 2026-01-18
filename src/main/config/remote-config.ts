/**
 * Remote Configuration - Load config from well-known endpoints (6.2)
 *
 * Supports loading organization-wide configuration from remote endpoints.
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { ProjectConfig } from '../../shared/types/settings.types';

/**
 * Remote config source
 */
export interface RemoteConfigSource {
  url: string;
  type: 'well-known' | 'direct' | 'github';
  lastFetched?: number;
  lastModified?: string;
  etag?: string;
}

/**
 * Remote config result
 */
export interface RemoteConfigResult {
  config: ProjectConfig | null;
  source: RemoteConfigSource;
  cached: boolean;
  error?: string;
}

/**
 * Remote config options
 */
export interface RemoteConfigOptions {
  timeout?: number;        // Request timeout in ms
  cacheTTL?: number;       // Cache time-to-live in ms
  maxRetries?: number;     // Max retry attempts
  useCache?: boolean;      // Whether to use cached values
}

const DEFAULT_OPTIONS: RemoteConfigOptions = {
  timeout: 10000,
  cacheTTL: 3600000,  // 1 hour
  maxRetries: 2,
  useCache: true,
};

/**
 * Well-known endpoint paths
 */
const WELL_KNOWN_PATHS = [
  '/.well-known/claude-orchestrator.json',
  '/.well-known/opencode.json',
  '/.claude-orchestrator.json',
];

/**
 * Remote Config Manager
 */
export class RemoteConfigManager {
  private cacheDir: string;
  private cache: Map<string, { data: ProjectConfig; fetchedAt: number; etag?: string }> = new Map();

  constructor() {
    this.cacheDir = path.join(app.getPath('userData'), 'remote-config-cache');
    this.ensureCacheDir();
    this.loadCacheFromDisk();
  }

  /**
   * Ensure cache directory exists
   */
  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Load cached configs from disk
   */
  private loadCacheFromDisk(): void {
    try {
      const cacheFile = path.join(this.cacheDir, 'cache.json');
      if (fs.existsSync(cacheFile)) {
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        this.cache = new Map(Object.entries(data));
      }
    } catch (error) {
      console.error('Failed to load remote config cache:', error);
    }
  }

  /**
   * Save cache to disk
   */
  private saveCacheToDisk(): void {
    try {
      const cacheFile = path.join(this.cacheDir, 'cache.json');
      const data = Object.fromEntries(this.cache);
      fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save remote config cache:', error);
    }
  }

  /**
   * Fetch config from URL
   */
  private fetchUrl(url: string, options: RemoteConfigOptions): Promise<{ data: string; etag?: string; lastModified?: string }> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const protocol = urlObj.protocol === 'https:' ? https : http;

      const req = protocol.get(url, {
        timeout: options.timeout,
        headers: {
          'User-Agent': 'Claude-Orchestrator/1.0',
          'Accept': 'application/json',
        },
      }, (res) => {
        if (res.statusCode === 304) {
          // Not modified, use cache
          reject({ code: 'NOT_MODIFIED' });
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({
            data,
            etag: res.headers['etag'] as string | undefined,
            lastModified: res.headers['last-modified'] as string | undefined,
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * Fetch config from a well-known endpoint
   */
  async fetchFromWellKnown(
    domain: string,
    options: RemoteConfigOptions = {}
  ): Promise<RemoteConfigResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    for (const wellKnownPath of WELL_KNOWN_PATHS) {
      const url = `https://${domain}${wellKnownPath}`;

      try {
        const result = await this.fetchFromUrl(url, opts);
        if (result.config) {
          return result;
        }
      } catch (error) {
        // Try next path
        continue;
      }
    }

    return {
      config: null,
      source: { url: `https://${domain}`, type: 'well-known' },
      cached: false,
      error: 'No well-known config found',
    };
  }

  /**
   * Fetch config from a direct URL
   */
  async fetchFromUrl(
    url: string,
    options: RemoteConfigOptions = {}
  ): Promise<RemoteConfigResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const cacheKey = url;

    // Check cache first
    if (opts.useCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < opts.cacheTTL!) {
        return {
          config: cached.data,
          source: { url, type: 'direct', lastFetched: cached.fetchedAt },
          cached: true,
        };
      }
    }

    // Fetch with retries
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= opts.maxRetries!; attempt++) {
      try {
        const response = await this.fetchUrl(url, opts);
        const config = JSON.parse(response.data) as ProjectConfig;

        // Validate basic structure
        if (typeof config !== 'object') {
          throw new Error('Invalid config format');
        }

        // Cache the result
        this.cache.set(cacheKey, {
          data: config,
          fetchedAt: Date.now(),
          etag: response.etag,
        });
        this.saveCacheToDisk();

        return {
          config,
          source: {
            url,
            type: 'direct',
            lastFetched: Date.now(),
            lastModified: response.lastModified,
            etag: response.etag,
          },
          cached: false,
        };
      } catch (error: any) {
        if (error.code === 'NOT_MODIFIED') {
          const cached = this.cache.get(cacheKey);
          if (cached) {
            return {
              config: cached.data,
              source: { url, type: 'direct', lastFetched: cached.fetchedAt },
              cached: true,
            };
          }
        }
        lastError = error;

        // Wait before retry (exponential backoff)
        if (attempt < opts.maxRetries!) {
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }

    return {
      config: null,
      source: { url, type: 'direct' },
      cached: false,
      error: lastError?.message || 'Failed to fetch config',
    };
  }

  /**
   * Fetch config from GitHub repository
   */
  async fetchFromGitHub(
    owner: string,
    repo: string,
    branch: string = 'main',
    options: RemoteConfigOptions = {}
  ): Promise<RemoteConfigResult> {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/.claude-orchestrator.json`;
    const result = await this.fetchFromUrl(url, options);
    result.source.type = 'github';
    return result;
  }

  /**
   * Discover remote config for a git repository
   */
  async discoverForGitRepo(
    gitRemoteUrl: string,
    options: RemoteConfigOptions = {}
  ): Promise<RemoteConfigResult> {
    // Parse git remote URL
    const match = gitRemoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      const [, owner, repo] = match;
      return this.fetchFromGitHub(owner, repo, 'main', options);
    }

    // Try to extract domain for well-known
    const domainMatch = gitRemoteUrl.match(/@([^:]+):|\/\/([^/]+)\//);
    if (domainMatch) {
      const domain = domainMatch[1] || domainMatch[2];
      return this.fetchFromWellKnown(domain, options);
    }

    return {
      config: null,
      source: { url: gitRemoteUrl, type: 'direct' },
      cached: false,
      error: 'Could not parse git remote URL',
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.saveCacheToDisk();
  }

  /**
   * Get cached configs
   */
  getCachedConfigs(): Array<{ url: string; fetchedAt: number }> {
    return Array.from(this.cache.entries()).map(([url, data]) => ({
      url,
      fetchedAt: data.fetchedAt,
    }));
  }

  /**
   * Invalidate cache for URL
   */
  invalidateCache(url: string): void {
    this.cache.delete(url);
    this.saveCacheToDisk();
  }
}

// Singleton instance
let remoteConfigInstance: RemoteConfigManager | null = null;

export function getRemoteConfigManager(): RemoteConfigManager {
  if (!remoteConfigInstance) {
    remoteConfigInstance = new RemoteConfigManager();
  }
  return remoteConfigInstance;
}
