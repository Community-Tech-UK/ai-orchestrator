/**
 * Grok CLI model discovery.
 *
 * Mirrors `CodexCliDiscoveryService`: periodically re-reads the installed CLI's
 * model list into the unified catalog, where `cli-discovered` outranks every
 * other source. Without it, Grok's only model source was the hand-written
 * `PROVIDER_MODEL_LIST.grok` row, which is how the picker stayed on `grok-4.5`
 * after xAI retired that id from the CLI (spawning it fails outright with
 * "unknown model id").
 *
 * Fail-soft throughout: a missing CLI, a signed-out CLI, or unparseable output
 * leaves whatever the catalog already had.
 */

import { spawn } from 'child_process';
import { getLogger } from '../logging/logger';
import {
  discoverGrokModels,
  GROK_MODEL_DISCOVERY_CACHE_TTL_MS,
} from '../cli/adapters/grok-cli-adapter.models';
import { buildCliSpawnOptions } from '../cli/cli-environment';
import { PosixSpawnCommandResolver } from '../cli/adapters/posix-spawn-command-resolver';
import type { ModelDisplayInfo } from '../../shared/types/provider.types';
import { getUnifiedModelCatalog } from './unified-model-catalog-service';

const logger = getLogger('GrokCliDiscovery');

const GROK_PROVIDER = 'grok';

export interface GrokCatalogSink {
  onCliDiscoveryRefreshed(provider: string, models: ModelDisplayInfo[]): void;
}

export interface GrokCliDiscoveryServiceOptions {
  catalog?: GrokCatalogSink;
  intervalMs?: number;
  lister?: () => Promise<ModelDisplayInfo[]>;
}

/**
 * A packaged Electron app often starts with a stripped PATH, so the bare
 * `grok` name is resolved against the augmented CLI PATH before spawning —
 * same reason `PosixSpawnCommandResolver` exists for the adapters.
 */
const commandResolver = new PosixSpawnCommandResolver();

function defaultLister(): Promise<ModelDisplayInfo[]> {
  return discoverGrokModels(() =>
    spawn(commandResolver.resolve('grok'), ['models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...buildCliSpawnOptions(),
    }),
  );
}

export class GrokCliDiscoveryService {
  private readonly catalog: GrokCatalogSink;
  private readonly intervalMs: number;
  private readonly lister: () => Promise<ModelDisplayInfo[]>;
  private refreshInFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: GrokCliDiscoveryServiceOptions = {}) {
    this.catalog = options.catalog ?? getUnifiedModelCatalog();
    this.intervalMs = options.intervalMs ?? GROK_MODEL_DISCOVERY_CACHE_TTL_MS;
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
        logger.debug('Grok model discovery returned no live models; keeping existing catalog');
        return;
      }
      this.catalog.onCliDiscoveryRefreshed(GROK_PROVIDER, models);
      logger.info('Grok CLI models refreshed into unified catalog', { count: models.length });
    } catch (error) {
      logger.warn('Grok CLI model discovery failed; keeping existing catalog', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

let grokCliDiscoveryService: GrokCliDiscoveryService | null = null;

export function getGrokCliDiscoveryService(): GrokCliDiscoveryService {
  grokCliDiscoveryService ??= new GrokCliDiscoveryService();
  return grokCliDiscoveryService;
}

export function _resetGrokCliDiscoveryServiceForTesting(): void {
  grokCliDiscoveryService?.stop();
  grokCliDiscoveryService = null;
}
