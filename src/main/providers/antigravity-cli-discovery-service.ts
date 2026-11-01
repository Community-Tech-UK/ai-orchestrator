/**
 * Antigravity CLI (`agy`) model discovery.
 *
 * Mirrors `GrokCliDiscoveryService`: periodically re-reads the installed CLI's
 * model list into the unified catalog, where `cli-discovered` outranks every
 * other source. Without it, Antigravity's only model source was the
 * hand-written `PROVIDER_MODEL_LIST.antigravity` row, which sat on agy 1.0.14's
 * labels long after agy dropped them — and agy 1.4 fails the turn outright on a
 * label it no longer lists.
 *
 * Fail-soft throughout: a missing CLI, a signed-out CLI, or unparseable output
 * leaves whatever the catalog already had.
 */

import { spawn } from 'child_process';
import { getLogger } from '../logging/logger';
import {
  ANTIGRAVITY_MODEL_DISCOVERY_INTERVAL_MS,
  discoverAntigravityModels,
} from '../cli/adapters/antigravity-cli-adapter.models';
import { buildCliSpawnOptions } from '../cli/cli-environment';
import { PosixSpawnCommandResolver } from '../cli/adapters/posix-spawn-command-resolver';
import type { ModelDisplayInfo } from '../../shared/types/provider.types';
import { getUnifiedModelCatalog } from './unified-model-catalog-service';

const logger = getLogger('AntigravityCliDiscovery');

const ANTIGRAVITY_PROVIDER = 'antigravity';

export interface AntigravityCatalogSink {
  onCliDiscoveryRefreshed(provider: string, models: ModelDisplayInfo[]): void;
}

export interface AntigravityCliDiscoveryServiceOptions {
  catalog?: AntigravityCatalogSink;
  intervalMs?: number;
  lister?: () => Promise<ModelDisplayInfo[]>;
}

/**
 * A packaged Electron app often starts with a stripped PATH, and agy installs
 * to ~/.local/bin, so the bare `agy` name is resolved against the augmented CLI
 * PATH before spawning.
 */
const commandResolver = new PosixSpawnCommandResolver();

function defaultLister(): Promise<ModelDisplayInfo[]> {
  return discoverAntigravityModels(() =>
    spawn(commandResolver.resolve('agy'), ['models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...buildCliSpawnOptions(),
    }),
  );
}

export class AntigravityCliDiscoveryService {
  private readonly catalog: AntigravityCatalogSink;
  private readonly intervalMs: number;
  private readonly lister: () => Promise<ModelDisplayInfo[]>;
  private refreshInFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AntigravityCliDiscoveryServiceOptions = {}) {
    this.catalog = options.catalog ?? getUnifiedModelCatalog();
    this.intervalMs = options.intervalMs ?? ANTIGRAVITY_MODEL_DISCOVERY_INTERVAL_MS;
    this.lister = options.lister ?? defaultLister;
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }

    void this.refreshOnce();
    this.timer = setInterval(() => {
      void this.refreshOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  refreshOnce(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    try {
      const models = await this.lister();
      if (models.length === 0) {
        logger.debug('Antigravity model discovery returned no live models; keeping existing catalog');
        return;
      }
      this.catalog.onCliDiscoveryRefreshed(ANTIGRAVITY_PROVIDER, models);
      logger.info('Antigravity CLI models refreshed into unified catalog', { count: models.length });
    } catch (error) {
      logger.warn('Antigravity CLI model discovery failed; keeping existing catalog', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

let antigravityCliDiscoveryService: AntigravityCliDiscoveryService | null = null;

export function getAntigravityCliDiscoveryService(): AntigravityCliDiscoveryService {
  antigravityCliDiscoveryService ??= new AntigravityCliDiscoveryService();
  return antigravityCliDiscoveryService;
}

export function _resetAntigravityCliDiscoveryServiceForTesting(): void {
  antigravityCliDiscoveryService?.stop();
  antigravityCliDiscoveryService = null;
}
