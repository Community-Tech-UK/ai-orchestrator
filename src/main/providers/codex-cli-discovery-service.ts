import { getLogger } from '../logging/logger';
import { CodexCliAdapter } from '../cli/adapters/codex-cli-adapter';
import { CODEX_MODEL_DISCOVERY_CACHE_TTL_MS } from '../cli/adapters/codex/model-list';
import type { ModelDisplayInfo } from '../../shared/types/provider.types';
import { getUnifiedModelCatalog } from './unified-model-catalog-service';

const logger = getLogger('CodexCliDiscovery');

export interface CodexCatalogSink {
  onCliDiscoveryRefreshed(provider: string, models: ModelDisplayInfo[]): void;
}

export interface CodexCliDiscoveryServiceOptions {
  catalog?: CodexCatalogSink;
  intervalMs?: number;
  lister?: () => Promise<ModelDisplayInfo[]>;
}

export class CodexCliDiscoveryService {
  private readonly catalog: CodexCatalogSink;
  private readonly intervalMs: number;
  private readonly lister: () => Promise<ModelDisplayInfo[]>;
  private refreshInFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CodexCliDiscoveryServiceOptions = {}) {
    this.catalog = options.catalog ?? getUnifiedModelCatalog();
    this.intervalMs = options.intervalMs ?? CODEX_MODEL_DISCOVERY_CACHE_TTL_MS;
    this.lister = options.lister ?? (() => new CodexCliAdapter().listAvailableModels({
      fallbackToStatic: false,
    }));
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
        logger.debug('Codex model discovery returned no live models; keeping existing catalog');
        return;
      }
      this.catalog.onCliDiscoveryRefreshed('codex', models);
      logger.info('Codex CLI models refreshed into unified catalog', { count: models.length });
    } catch (error) {
      logger.warn('Codex CLI model discovery failed; keeping existing catalog', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

let codexCliDiscoveryService: CodexCliDiscoveryService | null = null;

export function getCodexCliDiscoveryService(): CodexCliDiscoveryService {
  codexCliDiscoveryService ??= new CodexCliDiscoveryService();
  return codexCliDiscoveryService;
}

export function _resetCodexCliDiscoveryServiceForTesting(): void {
  codexCliDiscoveryService?.stop();
  codexCliDiscoveryService = null;
}
