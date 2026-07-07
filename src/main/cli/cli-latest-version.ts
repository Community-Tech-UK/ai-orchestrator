import { request as httpsRequest } from 'https';
import { getLogger } from '../logging/logger';
import { CLI_UPDATE_SPECS } from './cli-update-service';
import type { CliType } from './cli-detection';

const logger = getLogger('CliLatestVersionService');

/**
 * Resolves the latest published version of a CLI provider so the update
 * poller can tell whether the installed copy is behind. Mirrors t3code's
 * `providerMaintenance.ts` approach:
 *
 *  - Reads the npm registry's `latest` dist-tag (avoids betas/prereleases).
 *  - Caches per package for 1 hour so frequent polls don't hammer the registry.
 *  - Times out fast and fails soft to `null` — a registry hiccup must never
 *    block the poll, delay startup, or produce a false "update available".
 *
 * Providers without an npm package (e.g. Cursor self-update, Ollama via
 * Homebrew) resolve to `null` ("unknown"), matching t3code, which only does
 * registry-backed latest detection for npm-managed providers.
 */

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_TIMEOUT_MS = 4000;
const NPM_REGISTRY_HOST = 'registry.npmjs.org';

interface CacheEntry {
  expiresAt: number;
  version: string | null;
}

export interface CliLatestVersionServiceDeps {
  /** Fetch the latest published version for an npm package, or null on failure. */
  fetchNpmLatestVersion?: (npmPackage: string, timeoutMs: number) => Promise<string | null>;
  /** Map a CLI to the npm package that publishes it (defaults to CLI_UPDATE_SPECS). */
  npmPackageFor?: (cli: CliType) => string | undefined;
  cacheTtlMs?: number;
  now?: () => number;
}

export class CliLatestVersionService {
  private static instance: CliLatestVersionService | null = null;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchNpmLatestVersion: NonNullable<CliLatestVersionServiceDeps['fetchNpmLatestVersion']>;
  private readonly npmPackageFor: NonNullable<CliLatestVersionServiceDeps['npmPackageFor']>;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;

  constructor(deps: CliLatestVersionServiceDeps = {}) {
    this.fetchNpmLatestVersion = deps.fetchNpmLatestVersion ?? defaultFetchNpmLatestVersion;
    this.npmPackageFor = deps.npmPackageFor ?? ((cli) => CLI_UPDATE_SPECS[cli]?.npmPackage);
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  static getInstance(): CliLatestVersionService {
    if (!this.instance) {
      this.instance = new CliLatestVersionService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Latest published version for a CLI, or `null` when unknown (no npm package
   * configured, or the registry could not be reached). Cached per package.
   */
  async resolveLatestVersion(cli: CliType, force = false): Promise<string | null> {
    const npmPackage = this.npmPackageFor(cli);
    if (!npmPackage) {
      return null;
    }

    const cached = this.cache.get(npmPackage);
    const now = this.now();
    if (!force && cached && cached.expiresAt > now) {
      return cached.version;
    }

    let version: string | null;
    try {
      version = await this.fetchNpmLatestVersion(npmPackage, DEFAULT_TIMEOUT_MS);
    } catch (error) {
      logger.warn('Failed to fetch latest CLI version', {
        cli,
        npmPackage,
        error: error instanceof Error ? error.message : String(error),
      });
      version = null;
    }

    this.cache.set(npmPackage, { expiresAt: now + this.cacheTtlMs, version });
    return version;
  }
}

function defaultFetchNpmLatestVersion(npmPackage: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const req = httpsRequest(
      {
        hostname: NPM_REGISTRY_HOST,
        // encodeURIComponent handles scoped packages
        // (e.g. @anthropic-ai/claude-code -> %40anthropic-ai%2Fclaude-code).
        path: `/${encodeURIComponent(npmPackage)}/latest`,
        method: 'GET',
        headers: { accept: 'application/json' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            finish(null);
            return;
          }
          try {
            const payload = JSON.parse(data) as { version?: unknown };
            finish(
              typeof payload.version === 'string' && payload.version.trim().length > 0
                ? payload.version.trim()
                : null,
            );
          } catch {
            finish(null);
          }
        });
      },
    );

    req.on('error', () => finish(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(null);
    });
    req.end();
  });
}

export function getCliLatestVersionService(): CliLatestVersionService {
  return CliLatestVersionService.getInstance();
}
